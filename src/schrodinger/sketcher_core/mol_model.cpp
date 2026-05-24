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
#include <functional>
#include <memory>
#include <utility>
#include <vector>

#include <Geometry/point.h>
#include <GraphMol/Atom.h>
#include <GraphMol/Bond.h>
#include <GraphMol/Conformer.h>

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
