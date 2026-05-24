/* -------------------------------------------------------------------------
 * Implementation of sketcher_core::MolModel.
 *
 * The undo pattern matches the original MolModel's doCommandUsingSnapshots:
 * deep-copy the RWMol before the mutation, apply the mutation, deep-copy
 * again, then push a command whose redo/undo restore the appropriate copy.
 * Snapshot-based undo is simple and robust for a skeleton; per-edit reverse
 * commands can come later if needed.
 *
 * Copyright Schrodinger LLC, All Rights Reserved.
 --------------------------------------------------------------------------- */

#include "schrodinger/sketcher_core/mol_model.h"

#include <algorithm>
#include <cmath>
#include <functional>
#include <memory>
#include <utility>
#include <vector>

#include <Geometry/point.h>
#include <GraphMol/Atom.h>
#include <GraphMol/Bond.h>
#include <GraphMol/Chirality.h>
#include <GraphMol/Conformer.h>
#include <GraphMol/MolOps.h>

#include "schrodinger/rdkit_extensions/convert.h"
#include "schrodinger/rdkit_extensions/coord_utils.h"
#include "schrodinger/rdkit_extensions/molops.h"
#include "schrodinger/sketcher_core/undo_stack.h"

namespace schrodinger
{
namespace sketcher_core
{

namespace
{

/**
 * Attach a fresh 2D conformer to `mol` so atom positions can be tracked.
 * RWMol::removeAtom updates conformers automatically; addAtom does not, so
 * callers must grow the position vector themselves when appending.
 */
void install_empty_2d_conformer(RDKit::RWMol& mol)
{
    auto conf = std::make_unique<RDKit::Conformer>(0);
    conf->set3D(false);
    mol.addConformer(conf.release(), /*assignId=*/true);
}

} // namespace

MolModel::MolModel(UndoStack* stack) : UndoableModel(stack)
{
    install_empty_2d_conformer(m_mol);
}

void MolModel::doMutation(const std::function<void()>& mutate,
                          std::string description)
{
    // Selection is transient: any mutation that may reindex atoms/bonds
    // resets it. Fire the selection signal eagerly so observers can react
    // before modelChanged.
    if (hasSelection()) {
        m_selected_atoms.clear();
        m_selected_bonds.clear();
        selectionChanged.emit();
    }

    RDKit::RWMol before(m_mol);
    mutate();
    // Refresh the implicit-valence / H-count property cache so render
    // description can read getTotalNumHs() without sanitizing the whole mol.
    // strict=false tolerates intermediate hypervalent atoms the user might
    // create while editing; on failure we just skip the refresh — render-
    // side properties may be stale but nothing crashes.
    try {
        m_mol.updatePropertyCache(/*strict=*/false);
    } catch (...) {
        // Swallow: leaves the prior cache in place rather than aborting.
    }
    RDKit::RWMol after(m_mol);

    auto redo = [this, after] {
        m_mol = after;
        emitSignal(modelChanged);
    };
    auto undo = [this, before] {
        m_mol = before;
        emitSignal(modelChanged);
    };
    doCommand(std::move(redo), std::move(undo), description);
}

void MolModel::addAtom(const std::string& element, double x, double y)
{
    doMutation(
        [this, element, x, y] {
            auto atom = std::make_unique<RDKit::Atom>(element);
            const auto idx = m_mol.addAtom(atom.release(),
                                           /*updateLabel=*/false,
                                           /*takeOwnership=*/true);
            auto& conf = m_mol.getConformer();
            auto& positions = conf.getPositions();
            // Conformer doesn't auto-grow on addAtom — extend it here.
            if (positions.size() < m_mol.getNumAtoms()) {
                positions.resize(m_mol.getNumAtoms(), RDGeom::Point3D(0, 0, 0));
            }
            conf.setAtomPos(idx, RDGeom::Point3D(x, y, 0));
        },
        "Add atom");
}

void MolModel::atomPos(unsigned int idx, double& x, double& y) const
{
    const auto& p = m_mol.getConformer().getAtomPos(idx);
    x = p.x;
    y = p.y;
}

void MolModel::addBond(unsigned int begin_idx, unsigned int end_idx,
                       RDKit::Bond::BondType type)
{
    doMutation([this, begin_idx, end_idx,
                type] { m_mol.addBond(begin_idx, end_idx, type); },
               "Add bond");
}

void MolModel::removeAtom(unsigned int idx)
{
    doMutation([this, idx] { m_mol.removeAtom(idx); }, "Remove atom");
}

void MolModel::removeBond(unsigned int begin_idx, unsigned int end_idx)
{
    doMutation(
        [this, begin_idx, end_idx] { m_mol.removeBond(begin_idx, end_idx); },
        "Remove bond");
}

void MolModel::clear()
{
    doMutation(
        [this] {
            m_mol = RDKit::RWMol();
            install_empty_2d_conformer(m_mol);
        },
        "Clear");
}

void MolModel::setAtomPos(unsigned int idx, double x, double y)
{
    if (idx >= m_mol.getNumAtoms()) {
        return;
    }
    m_mol.getConformer().setAtomPos(idx, RDGeom::Point3D(x, y, 0));
    // Direct emit (not emitSignal) — previews aren't commands and so don't
    // run inside AllowEditsScope. Observers must repaint anyway.
    modelChanged.emit();
}

void MolModel::moveAtomUndoable(unsigned int idx, double from_x, double from_y,
                                double to_x, double to_y)
{
    if (idx >= m_mol.getNumAtoms()) {
        return;
    }
    // Custom command (not snapshot-based) — a drag can leave the conformer
    // anywhere; redo restores the *destination* position regardless.
    // Deliberately does NOT clear selection: moving an atom doesn't reindex,
    // so existing atom/bond indices remain valid.
    auto redo = [this, idx, to_x, to_y] {
        m_mol.getConformer().setAtomPos(idx, RDGeom::Point3D(to_x, to_y, 0));
        emitSignal(modelChanged);
    };
    auto undo = [this, idx, from_x, from_y] {
        m_mol.getConformer().setAtomPos(idx, RDGeom::Point3D(from_x, from_y, 0));
        emitSignal(modelChanged);
    };
    doCommand(std::move(redo), std::move(undo), "Move atom");
}

void MolModel::moveAtomsUndoable(const std::vector<unsigned int>& indices,
                                 const std::vector<double>& from_xs,
                                 const std::vector<double>& from_ys,
                                 const std::vector<double>& to_xs,
                                 const std::vector<double>& to_ys)
{
    if (indices.empty()) {
        return;
    }
    // Caller bug — parallel arrays must agree. Silently no-op rather than
    // crash (the JS bridge would have a hard time recovering from a throw).
    if (from_xs.size() != indices.size() || from_ys.size() != indices.size() ||
        to_xs.size() != indices.size() || to_ys.size() != indices.size()) {
        return;
    }
    auto macro = createUndoMacro("Move atoms");
    for (size_t i = 0; i < indices.size(); ++i) {
        moveAtomUndoable(indices[i], from_xs[i], from_ys[i], to_xs[i],
                         to_ys[i]);
    }
}

void MolModel::setBondDirUndoable(unsigned int begin_idx, unsigned int end_idx,
                                  RDKit::Bond::BondDir dir)
{
    auto* bond = m_mol.getBondBetweenAtoms(begin_idx, end_idx);
    if (bond == nullptr) {
        return;
    }
    const auto old_dir = bond->getBondDir();
    if (old_dir == dir) {
        return;
    }
    const unsigned int bond_idx = bond->getIdx();
    // Custom command (not snapshot) — setting bond direction doesn't reindex
    // and selection should survive. By-index access in the closures stays
    // valid because no atoms/bonds are added or removed.
    auto redo = [this, bond_idx, dir] {
        m_mol.getBondWithIdx(bond_idx)->setBondDir(dir);
        emitSignal(modelChanged);
    };
    auto undo = [this, bond_idx, old_dir] {
        m_mol.getBondWithIdx(bond_idx)->setBondDir(old_dir);
        emitSignal(modelChanged);
    };
    doCommand(std::move(redo), std::move(undo), "Set bond stereo");
}

void MolModel::setBondDirForSelectedBonds(RDKit::Bond::BondDir dir)
{
    if (m_selected_bonds.empty()) {
        return;
    }
    // Snapshot indices before iterating (defensive — closures shouldn't
    // mutate the set, but a single macro keeps the undo step atomic).
    const std::vector<unsigned int> bonds(m_selected_bonds.begin(),
                                          m_selected_bonds.end());
    auto macro = createUndoMacro("Set stereo on selection");
    for (auto idx : bonds) {
        if (idx >= m_mol.getNumBonds()) {
            continue;
        }
        const auto* b = m_mol.getBondWithIdx(idx);
        setBondDirUndoable(b->getBeginAtomIdx(), b->getEndAtomIdx(), dir);
    }
}

void MolModel::addRing(unsigned int size, double cx, double cy, bool aromatic)
{
    if (size < 3) {
        return;
    }
    // Bond length matches the rest of the sketcher's 1.5-unit default so a
    // freshly inserted ring sits at the same scale as user-drawn bonds.
    // For a regular N-gon, the chord length is 2*r*sin(pi/N); solve for r so
    // adjacent vertices are 1.5 units apart.
    const double bond_len = 1.5;
    const double radius = bond_len / (2.0 * std::sin(M_PI / size));
    doMutation(
        [this, size, cx, cy, aromatic, radius] {
            const unsigned int first_idx = m_mol.getNumAtoms();
            auto& conf = m_mol.getConformer();
            for (unsigned int i = 0; i < size; ++i) {
                // -pi/2 phase puts the first vertex at the top of the ring,
                // matching the typical aromatic-ring rendering convention.
                const double angle =
                    2.0 * M_PI * static_cast<double>(i) / static_cast<double>(size) -
                    M_PI_2;
                const double x = cx + radius * std::cos(angle);
                const double y = cy + radius * std::sin(angle);
                auto atom = std::make_unique<RDKit::Atom>("C");
                const auto idx = m_mol.addAtom(atom.release(),
                                               /*updateLabel=*/false,
                                               /*takeOwnership=*/true);
                auto& positions = conf.getPositions();
                if (positions.size() < m_mol.getNumAtoms()) {
                    positions.resize(m_mol.getNumAtoms(),
                                     RDGeom::Point3D(0, 0, 0));
                }
                conf.setAtomPos(idx, RDGeom::Point3D(x, y, 0));
            }
            for (unsigned int i = 0; i < size; ++i) {
                const unsigned int a = first_idx + i;
                const unsigned int b = first_idx + ((i + 1) % size);
                // Kekulé alternation: odd-index ring positions get the double
                // bond. Caller is responsible for passing aromatic=true only
                // for even sizes; for odd sizes we fall back to all-single
                // since a clean Kekulé doesn't exist.
                const bool make_double = aromatic && (size % 2 == 0) &&
                                         (i % 2 == 1);
                const auto bt = make_double ? RDKit::Bond::BondType::DOUBLE
                                            : RDKit::Bond::BondType::SINGLE;
                m_mol.addBond(a, b, bt);
            }
        },
        aromatic ? "Add aromatic ring" : "Add ring");
}

void MolModel::adjustChargeOnSelectedAtoms(int delta)
{
    if (m_selected_atoms.empty() || delta == 0) {
        return;
    }
    // Capture (idx, old_charge) up front so redo can reset to old+delta
    // (not "current + delta", which would compound on re-redo) and undo can
    // restore exactly. Snapshot the selection too so the closures don't
    // depend on the live m_selected_atoms set, which could be mutated by
    // intervening operations between redos.
    std::vector<std::pair<unsigned int, int>> previous;
    previous.reserve(m_selected_atoms.size());
    for (auto idx : m_selected_atoms) {
        if (idx >= m_mol.getNumAtoms()) {
            continue;
        }
        previous.emplace_back(idx,
                              m_mol.getAtomWithIdx(idx)->getFormalCharge());
    }
    if (previous.empty()) {
        return;
    }
    auto refresh_cache = [this] {
        try {
            m_mol.updatePropertyCache(/*strict=*/false);
        } catch (...) {
        }
    };
    auto redo = [this, previous, delta, refresh_cache] {
        for (const auto& [idx, old_q] : previous) {
            m_mol.getAtomWithIdx(idx)->setFormalCharge(old_q + delta);
        }
        refresh_cache();
        emitSignal(modelChanged);
    };
    auto undo = [this, previous, refresh_cache] {
        for (const auto& [idx, old_q] : previous) {
            m_mol.getAtomWithIdx(idx)->setFormalCharge(old_q);
        }
        refresh_cache();
        emitSignal(modelChanged);
    };
    doCommand(std::move(redo), std::move(undo),
              delta > 0 ? "Increase charge" : "Decrease charge");
}

namespace
{

/**
 * Shared "absorb a parsed RWMol into our renderable conformer + wedges"
 * helper used by every text-import entry point. Caller has already done the
 * format-specific parse; this function normalizes the result.
 */
void prepare_loaded_mol(RDKit::RWMol& mol, bool needs_2d_coords)
{
    if (mol.getNumAtoms() == 0) {
        return;
    }
    if (needs_2d_coords || mol.getNumConformers() == 0) {
        rdkit_extensions::compute2DCoords(mol);
    }
    try {
        // wedgeMolBonds reads atom-level CIP chirality and writes 2D bond
        // dirs into the conformer-bound bonds, so chiral inputs render
        // with stereo bars instead of flat lines. Swallow on failure —
        // flat bonds are still readable.
        RDKit::Chirality::wedgeMolBonds(mol, &mol.getConformer());
    } catch (...) {
    }
}

} // namespace

void MolModel::loadFromSmiles(const std::string& smiles)
{
    // to_rdkit throws std::invalid_argument for malformed SMILES. Let it
    // propagate — the embind/UI layer decides how to surface the failure
    // (e.g. status text). Doing nothing on error would hide typos silently.
    auto parsed = rdkit_extensions::to_rdkit(
        smiles, rdkit_extensions::Format::SMILES);
    RDKit::RWMol new_mol(*parsed);
    // SMILES never carries coords — always compute fresh ones.
    prepare_loaded_mol(new_mol, /*needs_2d_coords=*/true);
    doMutation([this, new_mol] { m_mol = new_mol; }, "Load SMILES");
}

void MolModel::loadFromText(const std::string& text)
{
    // AUTO_DETECT walks the format list (SMILES, MOL V3000/V2000, etc.) and
    // returns the first successful parse. The lone exception that surfaces
    // is std::invalid_argument when nothing parses.
    auto parsed = rdkit_extensions::to_rdkit(text);
    RDKit::RWMol new_mol(*parsed);
    // MOL blocks carry their own conformer; we only need to compute when one
    // isn't present (typical for SMILES/InChI inputs).
    prepare_loaded_mol(new_mol, /*needs_2d_coords=*/false);
    doMutation([this, new_mol] { m_mol = new_mol; }, "Load");
}

std::string MolModel::toSmiles() const
{
    if (m_mol.getNumAtoms() == 0) {
        return "";
    }
    try {
        return rdkit_extensions::to_string(
            m_mol, rdkit_extensions::Format::SMILES);
    } catch (...) {
        // SMILES writers can throw on partly-built mols (e.g. unset
        // aromaticity flags after a degenerate edit). Return empty so the
        // UI shows "(no smiles)" instead of crashing.
        return "";
    }
}

void MolModel::addHydrogens()
{
    if (m_mol.getNumAtoms() == 0) {
        return;
    }
    doMutation([this] { rdkit_extensions::addHs(m_mol); }, "Add hydrogens");
}

void MolModel::removeHydrogens()
{
    if (m_mol.getNumAtoms() == 0) {
        return;
    }
    doMutation([this] { rdkit_extensions::removeHs(m_mol); },
               "Remove hydrogens");
}

void MolModel::aromatize()
{
    if (m_mol.getNumAtoms() == 0) {
        return;
    }
    doMutation(
        [this] {
            // setAromaticity needs the implicit-valence cache populated;
            // doMutation refreshes it after the lambda returns, but we
            // need it *before* perception runs. strict=false tolerates
            // hypervalent intermediates the user might construct.
            try {
                m_mol.updatePropertyCache(/*strict=*/false);
            } catch (...) {
                // perception will fail below; swallow there too.
            }
            try {
                RDKit::MolOps::setAromaticity(m_mol);
            } catch (...) {
                // Leave mol unchanged on perception failure — the snapshot
                // pre-image is still on the undo stack, so the user can
                // continue editing.
            }
        },
        "Aromatize");
}

void MolModel::kekulize()
{
    if (m_mol.getNumAtoms() == 0) {
        return;
    }
    doMutation(
        [this] {
            try {
                m_mol.updatePropertyCache(/*strict=*/false);
            } catch (...) {
            }
            try {
                // markAtomsBonds=true clears the aromatic flag on
                // atoms/bonds in addition to assigning Kekulé bond orders,
                // which is what users expect "kekulize" to do (otherwise
                // a benzene re-aromatizes the next time something pokes it).
                RDKit::MolOps::Kekulize(m_mol, /*markAtomsBonds=*/true);
            } catch (...) {
                // Unkekulizable mol (rare); leave as-is.
            }
        },
        "Kekulize");
}

std::string MolModel::toMolBlock(bool v3000) const
{
    if (m_mol.getNumAtoms() == 0) {
        return "";
    }
    try {
        const auto fmt = v3000 ? rdkit_extensions::Format::MDL_MOLV3000
                               : rdkit_extensions::Format::MDL_MOLV2000;
        return rdkit_extensions::to_string(m_mol, fmt);
    } catch (...) {
        return "";
    }
}

// -- Selection ------------------------------------------------------------
// Direct signal emission (rather than emitSignal) because selection changes
// are deliberately not commands — they shouldn't go through AllowEditsScope.

void MolModel::setAtomSelected(unsigned int atom_idx, bool selected)
{
    if (atom_idx >= m_mol.getNumAtoms()) {
        return;
    }
    const bool changed = selected ? m_selected_atoms.insert(atom_idx).second
                                  : (m_selected_atoms.erase(atom_idx) > 0);
    if (changed) {
        selectionChanged.emit();
    }
}

void MolModel::setBondSelected(unsigned int bond_idx, bool selected)
{
    if (bond_idx >= m_mol.getNumBonds()) {
        return;
    }
    const bool changed = selected ? m_selected_bonds.insert(bond_idx).second
                                  : (m_selected_bonds.erase(bond_idx) > 0);
    if (changed) {
        selectionChanged.emit();
    }
}

bool MolModel::isAtomSelected(unsigned int atom_idx) const
{
    return m_selected_atoms.count(atom_idx) > 0;
}

bool MolModel::isBondSelected(unsigned int bond_idx) const
{
    return m_selected_bonds.count(bond_idx) > 0;
}

bool MolModel::hasSelection() const
{
    return !m_selected_atoms.empty() || !m_selected_bonds.empty();
}

void MolModel::selectAll()
{
    const auto na = m_mol.getNumAtoms();
    const auto nb = m_mol.getNumBonds();
    const bool was_complete = m_selected_atoms.size() == na &&
                              m_selected_bonds.size() == nb;
    if (was_complete && na + nb > 0) {
        return;
    }
    m_selected_atoms.clear();
    m_selected_bonds.clear();
    for (unsigned int i = 0; i < na; ++i) {
        m_selected_atoms.insert(i);
    }
    for (unsigned int i = 0; i < nb; ++i) {
        m_selected_bonds.insert(i);
    }
    selectionChanged.emit();
}

void MolModel::clearSelection()
{
    if (!hasSelection()) {
        return;
    }
    m_selected_atoms.clear();
    m_selected_bonds.clear();
    selectionChanged.emit();
}

void MolModel::deleteSelected()
{
    if (!hasSelection()) {
        return;
    }
    // Snapshot the selection: doMutation clears it before invoking the
    // mutate lambda, so we capture indices first.
    const auto sel_atoms = m_selected_atoms;
    const auto sel_bonds = m_selected_bonds;
    doMutation(
        [this, sel_atoms, sel_bonds] {
            // Resolve selected bond indices to (begin, end) pairs *before*
            // any removal, since removeBond renumbers the bond array.
            std::vector<std::pair<unsigned int, unsigned int>> bond_endpoints;
            bond_endpoints.reserve(sel_bonds.size());
            for (auto idx : sel_bonds) {
                const auto* b = m_mol.getBondWithIdx(idx);
                bond_endpoints.emplace_back(b->getBeginAtomIdx(),
                                            b->getEndAtomIdx());
            }
            for (const auto& [a, b] : bond_endpoints) {
                if (m_mol.getBondBetweenAtoms(a, b) != nullptr) {
                    m_mol.removeBond(a, b);
                }
            }
            // Atoms in descending index order so earlier indices stay valid.
            // removeAtom drops incident bonds automatically.
            std::vector<unsigned int> atoms_desc(sel_atoms.begin(),
                                                 sel_atoms.end());
            std::sort(atoms_desc.begin(), atoms_desc.end(),
                      std::greater<unsigned int>());
            for (auto idx : atoms_desc) {
                if (idx < m_mol.getNumAtoms()) {
                    m_mol.removeAtom(idx);
                }
            }
        },
        "Delete selection");
}

} // namespace sketcher_core
} // namespace schrodinger
