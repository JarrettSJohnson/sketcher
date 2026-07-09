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
#include <cctype>
#include <cmath>
#include <functional>
#include <limits>
#include <memory>
#include <utility>
#include <vector>

#include <Geometry/point.h>
#include <GraphMol/Atom.h>
#include <GraphMol/Bond.h>
#include <GraphMol/Chirality.h>
#include <GraphMol/Conformer.h>
#include <GraphMol/MolOps.h>
#include <GraphMol/MonomerInfo.h>
#include <GraphMol/QueryAtom.h>
#include <GraphMol/QueryBond.h>
#include <GraphMol/QueryOps.h>

#include "schrodinger/rdkit_extensions/constants.h"
#include "schrodinger/rdkit_extensions/convert.h"
#include "schrodinger/rdkit_extensions/coord_utils.h"
#include "schrodinger/rdkit_extensions/dummy_atom.h"
#include "schrodinger/rdkit_extensions/helm.h"
#include "schrodinger/rdkit_extensions/helm/monomer_coordgen.h"
#include "schrodinger/rdkit_extensions/molops.h"
#include "schrodinger/rdkit_extensions/monomer_mol.h"
#include "schrodinger/rdkit_extensions/rgroup.h"
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
    auto arrow_before = m_rxn_arrow;
    auto pluses_before = m_rxn_pluses;
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
    auto arrow_after = m_rxn_arrow;
    auto pluses_after = m_rxn_pluses;

    auto redo = [this, after, arrow_after, pluses_after] {
        m_mol = after;
        m_rxn_arrow = arrow_after;
        m_rxn_pluses = pluses_after;
        emitSignal(modelChanged);
    };
    auto undo = [this, before, arrow_before, pluses_before] {
        m_mol = before;
        m_rxn_arrow = arrow_before;
        m_rxn_pluses = pluses_before;
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

void MolModel::addRGroup(unsigned int r_group_num, double x, double y,
                         int bound_to_atom_idx)
{
    // Validate up front so we throw outside the mutation (no half-applied
    // edit, no spurious undo step). rdkit_extensions::make_new_r_group also
    // throws for r_group_num == 0; mirror that contract here.
    if (r_group_num == 0) {
        throw std::invalid_argument("R-group number must be >= 1");
    }
    doMutation(
        [this, r_group_num, x, y, bound_to_atom_idx] {
            auto atom_sp = rdkit_extensions::make_new_r_group(r_group_num);
            // Clone into a raw pointer for addAtom(takeOwnership=true) — the
            // shared_ptr returned by make_new_r_group owns its copy, so a
            // deep copy via the Atom::copy() ctor keeps ownership clean.
            auto atom = std::make_unique<RDKit::Atom>(*atom_sp);
            const auto idx = m_mol.addAtom(atom.release(),
                                           /*updateLabel=*/false,
                                           /*takeOwnership=*/true);
            auto& conf = m_mol.getConformer();
            auto& positions = conf.getPositions();
            if (positions.size() < m_mol.getNumAtoms()) {
                positions.resize(m_mol.getNumAtoms(), RDGeom::Point3D(0, 0, 0));
            }
            conf.setAtomPos(idx, RDGeom::Point3D(x, y, 0));
            if (bound_to_atom_idx >= 0 &&
                static_cast<unsigned int>(bound_to_atom_idx) <
                    m_mol.getNumAtoms() &&
                static_cast<unsigned int>(bound_to_atom_idx) != idx) {
                m_mol.addBond(static_cast<unsigned int>(bound_to_atom_idx),
                              idx, RDKit::Bond::BondType::SINGLE);
            }
        },
        "Add R-group");
}

void MolModel::addAttachmentPoint(unsigned int ap_num, double x, double y,
                                  unsigned int bound_to_atom_idx)
{
    // Validate up front so we throw before opening the undo macro.
    if (ap_num == 0) {
        throw std::invalid_argument("Attachment-point number must be >= 1");
    }
    if (bound_to_atom_idx >= m_mol.getNumAtoms()) {
        throw std::invalid_argument(
            "addAttachmentPoint: bound_to_atom_idx out of range");
    }
    doMutation(
        [this, ap_num, x, y, bound_to_atom_idx] {
            // Mirrors sketcher::make_new_attachment_point (rdkit/rgroup.cpp:52):
            // dummy atom (atomic num 0, QueryAtom w/ null query) decorated
            // with atomLabel "_AP<n>". No isotope, no _MolFileRLabel.
            auto atom_sp = rdkit_extensions::create_dummy_atom();
            atom_sp->setProp(
                RDKit::common_properties::atomLabel,
                rdkit_extensions::ATTACHMENT_POINT_LABEL_PREFIX +
                    std::to_string(ap_num));
            auto atom = std::make_unique<RDKit::Atom>(*atom_sp);
            const auto idx = m_mol.addAtom(atom.release(),
                                           /*updateLabel=*/false,
                                           /*takeOwnership=*/true);
            auto& conf = m_mol.getConformer();
            auto& positions = conf.getPositions();
            if (positions.size() < m_mol.getNumAtoms()) {
                positions.resize(m_mol.getNumAtoms(), RDGeom::Point3D(0, 0, 0));
            }
            conf.setAtomPos(idx, RDGeom::Point3D(x, y, 0));
            // Attachment points are always bonded — is_attachment_point_dummy
            // requires totalDegree == 1. The bond is part of the visual
            // grammar (the squiggle is drawn perpendicular to it).
            m_mol.addBond(bound_to_atom_idx, idx,
                          RDKit::Bond::BondType::SINGLE);
        },
        "Add attachment point");
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

void MolModel::addBondWithDir(unsigned int begin_idx, unsigned int end_idx,
                              RDKit::Bond::BondType type,
                              RDKit::Bond::BondDir dir)
{
    if (dir == RDKit::Bond::BondDir::NONE) {
        addBond(begin_idx, end_idx, type);
        return;
    }
    // Two commands inside one macro: the user expects a single Ctrl+Z to
    // undo both the new bond and its stereo dir together.
    auto macro = createUndoMacro("Add bond with dir");
    addBond(begin_idx, end_idx, type);
    setBondDirUndoable(begin_idx, end_idx, dir);
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
            m_rxn_arrow.reset();
            m_rxn_pluses.clear();
        },
        "Clear");
}

void MolModel::addRxnArrow(double x, double y)
{
    // Qt: MolModel::addNonMolecularObject (model/mol_model.cpp:1116-1118)
    // throws "Only one arrow allowed" before opening the undo step. Mirror
    // that here so the bridge surfaces a friendly status instead of silently
    // dropping the second click.
    if (m_rxn_arrow.has_value()) {
        throw std::runtime_error("Only one arrow allowed");
    }
    doMutation(
        [this, x, y] { m_rxn_arrow = std::make_pair(x, y); },
        "Add reaction arrow");
}

void MolModel::addRxnPlus(double x, double y)
{
    doMutation(
        [this, x, y] { m_rxn_pluses.emplace_back(x, y); },
        "Add reaction plus");
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

void MolModel::setBondTypeUndoable(unsigned int begin_idx,
                                   unsigned int end_idx,
                                   RDKit::Bond::BondType type)
{
    // getBondBetweenAtoms invariant-checks both indices, so guard first.
    if (begin_idx >= m_mol.getNumAtoms() || end_idx >= m_mol.getNumAtoms()) {
        return;
    }
    auto* bond = m_mol.getBondBetweenAtoms(begin_idx, end_idx);
    if (bond == nullptr) {
        return;
    }
    const auto old_type = bond->getBondType();
    const bool old_arom = bond->getIsAromatic();
    const bool new_arom = (type == RDKit::Bond::AROMATIC);
    if (old_type == type && old_arom == new_arom) {
        return;
    }
    const unsigned int begin_atom_idx = bond->getBeginAtomIdx();
    const unsigned int end_atom_idx = bond->getEndAtomIdx();
    const bool old_begin_arom = m_mol.getAtomWithIdx(begin_atom_idx)->getIsAromatic();
    const bool old_end_arom = m_mol.getAtomWithIdx(end_atom_idx)->getIsAromatic();
    const unsigned int bond_idx = bond->getIdx();
    auto refresh_cache = [this] {
        try {
            m_mol.updatePropertyCache(/*strict=*/false);
        } catch (...) {
        }
    };
    auto redo = [this, bond_idx, type, new_arom, begin_atom_idx, end_atom_idx,
                 refresh_cache] {
        auto* b = m_mol.getBondWithIdx(bond_idx);
        b->setBondType(type);
        b->setIsAromatic(new_arom);
        if (new_arom) {
            m_mol.getAtomWithIdx(begin_atom_idx)->setIsAromatic(true);
            m_mol.getAtomWithIdx(end_atom_idx)->setIsAromatic(true);
        }
        refresh_cache();
        emitSignal(modelChanged);
    };
    auto undo = [this, bond_idx, old_type, old_arom, begin_atom_idx,
                 end_atom_idx, old_begin_arom, old_end_arom, refresh_cache] {
        auto* b = m_mol.getBondWithIdx(bond_idx);
        b->setBondType(old_type);
        b->setIsAromatic(old_arom);
        m_mol.getAtomWithIdx(begin_atom_idx)->setIsAromatic(old_begin_arom);
        m_mol.getAtomWithIdx(end_atom_idx)->setIsAromatic(old_end_arom);
        refresh_cache();
        emitSignal(modelChanged);
    };
    doCommand(std::move(redo), std::move(undo), "Change bond order");
}

void MolModel::setBondTypeForSelectedBonds(RDKit::Bond::BondType type)
{
    if (m_selected_bonds.empty()) {
        return;
    }
    // Snapshot indices up front (defensive — closures shouldn't mutate the
    // set, but a single macro keeps the undo step atomic). Same pattern as
    // setBondDirForSelectedBonds.
    const std::vector<unsigned int> bonds(m_selected_bonds.begin(),
                                          m_selected_bonds.end());
    auto macro = createUndoMacro("Change bond order on selection");
    for (auto idx : bonds) {
        if (idx >= m_mol.getNumBonds()) {
            continue;
        }
        const auto* b = m_mol.getBondWithIdx(idx);
        setBondTypeUndoable(b->getBeginAtomIdx(), b->getEndAtomIdx(), type);
    }
}

void MolModel::setBondTypeAndDirUndoable(unsigned int begin_idx,
                                         unsigned int end_idx,
                                         RDKit::Bond::BondType type,
                                         RDKit::Bond::BondDir dir)
{
    if (begin_idx >= m_mol.getNumAtoms() || end_idx >= m_mol.getNumAtoms()) {
        return;
    }
    if (m_mol.getBondBetweenAtoms(begin_idx, end_idx) == nullptr) {
        return;
    }
    auto macro = createUndoMacro("Change bond type and stereo");
    setBondTypeUndoable(begin_idx, end_idx, type);
    setBondDirUndoable(begin_idx, end_idx, dir);
}

void MolModel::setBondTypeAndDirForSelectedBonds(RDKit::Bond::BondType type,
                                                 RDKit::Bond::BondDir dir)
{
    if (m_selected_bonds.empty()) {
        return;
    }
    const std::vector<unsigned int> bonds(m_selected_bonds.begin(),
                                          m_selected_bonds.end());
    auto macro = createUndoMacro("Change bond type and stereo on selection");
    for (auto idx : bonds) {
        if (idx >= m_mol.getNumBonds()) {
            continue;
        }
        const auto* b = m_mol.getBondWithIdx(idx);
        setBondTypeUndoable(b->getBeginAtomIdx(), b->getEndAtomIdx(), type);
        setBondDirUndoable(b->getBeginAtomIdx(), b->getEndAtomIdx(), dir);
    }
}

namespace
{
// Maps a query-bond display label to its RDKit query maker + the base bond
// type Qt draws it as (Qt's BOND_TOOL_QUERY_MAP + get_bond_type_and_query_
// label). Returns query == nullptr for an unrecognized label; the caller owns
// the returned query pointer.
struct BondQuerySpec {
    RDKit::Bond::QUERYBOND_QUERY* query;
    RDKit::Bond::BondType base_type;
};
BondQuerySpec make_bond_query(const std::string& label)
{
    if (label == "Any") {
        return {RDKit::makeBondNullQuery(), RDKit::Bond::BondType::SINGLE};
    }
    if (label == "S/D") {
        return {RDKit::makeSingleOrDoubleBondQuery(),
                RDKit::Bond::BondType::SINGLE};
    }
    if (label == "S/A") {
        return {RDKit::makeSingleOrAromaticBondQuery(),
                RDKit::Bond::BondType::SINGLE};
    }
    if (label == "D/A") {
        return {RDKit::makeDoubleOrAromaticBondQuery(),
                RDKit::Bond::BondType::DOUBLE};
    }
    return {nullptr, RDKit::Bond::BondType::SINGLE};
}
} // namespace

void MolModel::mutateBondToQuery(unsigned int begin_idx, unsigned int end_idx,
                                 const std::string& label)
{
    if (begin_idx >= m_mol.getNumAtoms() || end_idx >= m_mol.getNumAtoms()) {
        return;
    }
    auto* bond = m_mol.getBondBetweenAtoms(begin_idx, end_idx);
    if (bond == nullptr) {
        return;
    }
    // Validate the label before opening the command (free the probe query).
    auto probe = make_bond_query(label);
    if (probe.query == nullptr) {
        return;
    }
    delete probe.query;
    const unsigned int bond_idx = bond->getIdx();
    // Deep-copy the original bond so undo restores it exactly.
    std::shared_ptr<RDKit::Bond> original(bond->copy());
    auto refresh_cache = [this] {
        try {
            m_mol.updatePropertyCache(/*strict=*/false);
        } catch (...) {
        }
    };
    auto redo = [this, bond_idx, label, refresh_cache] {
        auto spec = make_bond_query(label);
        RDKit::QueryBond qb;
        qb.setBondType(spec.base_type);
        qb.setQuery(spec.query); // QueryBond takes ownership of the query
        qb.setProp(BOND_QUERY_LABEL_PROP, label);
        m_mol.replaceBond(bond_idx, &qb); // replaceBond copies qb
        refresh_cache();
        emitSignal(modelChanged);
    };
    auto undo = [this, bond_idx, original, refresh_cache] {
        m_mol.replaceBond(bond_idx, original.get());
        refresh_cache();
        emitSignal(modelChanged);
    };
    doCommand(std::move(redo), std::move(undo), "Set bond query");
}

void MolModel::addQueryBondBetweenAtoms(unsigned int begin_idx,
                                        unsigned int end_idx,
                                        const std::string& label)
{
    // Backs the bond-query (B▾) draw tool completing a two-atom gesture:
    // ensure a bond exists between the two atoms, then stamp it with the chosen
    // query (or aromatic type) — all in one undo step. `label` is "aromatic"
    // (a real bond type) or one of the query labels handled by make_bond_query.
    if (begin_idx == end_idx || begin_idx >= m_mol.getNumAtoms() ||
        end_idx >= m_mol.getNumAtoms()) {
        return;
    }
    const bool is_aromatic = (label == "aromatic");
    if (!is_aromatic) {
        auto probe = make_bond_query(label);
        if (probe.query == nullptr) {
            return; // unrecognized label — no-op
        }
        delete probe.query;
    }
    auto macro = createUndoMacro("Add query bond");
    if (m_mol.getBondBetweenAtoms(begin_idx, end_idx) == nullptr) {
        addBond(begin_idx, end_idx, RDKit::Bond::BondType::SINGLE);
    }
    if (is_aromatic) {
        setBondTypeUndoable(begin_idx, end_idx, RDKit::Bond::BondType::AROMATIC);
    } else {
        mutateBondToQuery(begin_idx, end_idx, label);
    }
}

void MolModel::mutateSelectedBondsToQuery(const std::string& label)
{
    if (m_selected_bonds.empty()) {
        return;
    }
    auto probe = make_bond_query(label);
    if (probe.query == nullptr) {
        return;
    }
    delete probe.query;
    const std::vector<unsigned int> bonds(m_selected_bonds.begin(),
                                          m_selected_bonds.end());
    auto macro = createUndoMacro("Set bond query on selection");
    for (auto idx : bonds) {
        if (idx >= m_mol.getNumBonds()) {
            continue;
        }
        // replaceBond keeps bond indices stable, so this stays valid across
        // iterations.
        const auto* b = m_mol.getBondWithIdx(idx);
        mutateBondToQuery(b->getBeginAtomIdx(), b->getEndAtomIdx(), label);
    }
}

void MolModel::setBondTopologyForBond(unsigned int begin_idx,
                                      unsigned int end_idx,
                                      const std::string& topology)
{
    if (begin_idx >= m_mol.getNumAtoms() || end_idx >= m_mol.getNumAtoms()) {
        return;
    }
    auto* bond = m_mol.getBondBetweenAtoms(begin_idx, end_idx);
    if (bond == nullptr) {
        return;
    }
    const bool in_ring = (topology == "ring");
    const bool not_in_ring = (topology == "notring");
    const bool either = (topology == "either");
    if (!in_ring && !not_in_ring && !either) {
        return; // unrecognized topology — no-op
    }
    const unsigned int bond_idx = bond->getIdx();
    std::shared_ptr<RDKit::Bond> original(bond->copy());
    auto refresh_cache = [this] {
        try {
            m_mol.updatePropertyCache(/*strict=*/false);
        } catch (...) {
        }
    };
    // Reconstruct the bond deterministically from our own stored metadata
    // (base type + query-label prop) rather than doing query-tree surgery, then
    // (re)apply the ring constraint. Avoids Qt's fragile AND-query unwrap.
    auto redo = [this, bond_idx, in_ring, not_in_ring, either, refresh_cache] {
        auto* b = m_mol.getBondWithIdx(bond_idx);
        const auto base_type = b->getBondType();
        std::string qlabel;
        const bool has_qlabel =
            b->getPropIfPresent(BOND_QUERY_LABEL_PROP, qlabel);

        // Build the base bond (query-typed if it carried a query label).
        std::unique_ptr<RDKit::Bond> rebuilt;
        if (has_qlabel) {
            auto spec = make_bond_query(qlabel);
            auto qb = std::make_unique<RDKit::QueryBond>();
            qb->setBondType(spec.base_type);
            qb->setQuery(spec.query);
            qb->setProp(BOND_QUERY_LABEL_PROP, qlabel);
            rebuilt = std::move(qb);
        } else if (either) {
            rebuilt = std::make_unique<RDKit::Bond>(base_type);
        } else {
            auto qb = std::make_unique<RDKit::QueryBond>();
            qb->setBondType(base_type);
            rebuilt.reset(qb.release());
        }

        if (!either) {
            auto* ring_q = RDKit::makeBondIsInRingQuery();
            ring_q->setNegation(not_in_ring);
            if (rebuilt->hasQuery()) {
                rebuilt->expandQuery(ring_q, Queries::COMPOSITE_AND);
            } else {
                rebuilt->setQuery(ring_q);
            }
            rebuilt->setProp(BOND_TOPOLOGY_PROP,
                             std::string(in_ring ? "ring" : "notring"));
        }
        m_mol.replaceBond(bond_idx, rebuilt.get());
        refresh_cache();
        emitSignal(modelChanged);
    };
    auto undo = [this, bond_idx, original, refresh_cache] {
        m_mol.replaceBond(bond_idx, original.get());
        refresh_cache();
        emitSignal(modelChanged);
    };
    doCommand(std::move(redo), std::move(undo), "Set bond topology");
}

void MolModel::setSelectedBondsTopology(const std::string& topology)
{
    if (m_selected_bonds.empty()) {
        return;
    }
    if (topology != "ring" && topology != "notring" && topology != "either") {
        return;
    }
    const std::vector<unsigned int> bonds(m_selected_bonds.begin(),
                                          m_selected_bonds.end());
    auto macro = createUndoMacro("Set bond topology on selection");
    for (auto idx : bonds) {
        if (idx >= m_mol.getNumBonds()) {
            continue;
        }
        const auto* b = m_mol.getBondWithIdx(idx);
        setBondTopologyForBond(b->getBeginAtomIdx(), b->getEndAtomIdx(),
                               topology);
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

void MolModel::addAtomChain(const std::vector<double>& xs,
                            const std::vector<double>& ys,
                            int bound_to_atom_idx)
{
    if (xs.empty() || xs.size() != ys.size()) {
        return;
    }
    doMutation(
        [this, xs, ys, bound_to_atom_idx] {
            auto& conf = m_mol.getConformer();
            int prev_idx = bound_to_atom_idx;
            for (std::size_t i = 0; i < xs.size(); ++i) {
                auto atom = std::make_unique<RDKit::Atom>("C");
                const auto idx = m_mol.addAtom(atom.release(),
                                               /*updateLabel=*/false,
                                               /*takeOwnership=*/true);
                auto& positions = conf.getPositions();
                if (positions.size() < m_mol.getNumAtoms()) {
                    positions.resize(m_mol.getNumAtoms(),
                                     RDGeom::Point3D(0, 0, 0));
                }
                conf.setAtomPos(idx, RDGeom::Point3D(xs[i], ys[i], 0));
                if (prev_idx >= 0 &&
                    static_cast<unsigned int>(prev_idx) < m_mol.getNumAtoms() &&
                    static_cast<unsigned int>(prev_idx) != idx) {
                    m_mol.addBond(static_cast<unsigned int>(prev_idx), idx,
                                  RDKit::Bond::BondType::SINGLE);
                }
                prev_idx = static_cast<int>(idx);
            }
        },
        "Add chain");
}

namespace
{
// Center-to-center spacing for a linear monomer chain / nucleotide layout, in
// model units. Matches Qt's MONOMER_BOND_LENGTH and the React renderer's copy.
constexpr double MONOMER_BOND_LENGTH = 1.5;

// Read a monomer atom's chain id / residue number from its AtomPDBResidueInfo.
// Returns {"", 0} if the atom carries no monomer info (defensive).
std::pair<std::string, int> monomer_chain_and_resnum(const RDKit::Atom* atom)
{
    const auto* info = atom->getMonomerInfo();
    const auto* res = dynamic_cast<const RDKit::AtomPDBResidueInfo*>(info);
    if (res == nullptr) {
        return {"", 0};
    }
    return {res->getChainId(), res->getResidueNumber()};
}

// Next free chain id for a fresh polymer of the given type, e.g. "PEPTIDE1".
// Scans existing monomer atoms so sequential free monomers get PEPTIDE1,
// PEPTIDE2, ... (matches HELM polymer naming).
std::string next_chain_id(const RDKit::RWMol& mol,
                          rdkit_extensions::ChainType chain_type)
{
    const std::string prefix = rdkit_extensions::toString(chain_type);
    std::unordered_set<std::string> seen;
    for (const auto* atom : mol.atoms()) {
        const auto [chain, resnum] = monomer_chain_and_resnum(atom);
        if (!chain.empty()) {
            seen.insert(chain);
        }
    }
    unsigned int n = 1;
    while (seen.count(prefix + std::to_string(n)) != 0) {
        ++n;
    }
    return prefix + std::to_string(n);
}

// Place a monomer atom's 2D coordinate, growing the conformer if needed (the
// conformer doesn't auto-grow on addAtom — same idiom as MolModel::addAtom).
void set_monomer_pos(RDKit::RWMol& mol, unsigned int idx, double x, double y)
{
    auto& conf = mol.getConformer();
    auto& positions = conf.getPositions();
    if (positions.size() < mol.getNumAtoms()) {
        positions.resize(mol.getNumAtoms(), RDGeom::Point3D(0, 0, 0));
    }
    conf.setAtomPos(idx, RDGeom::Point3D(x, y, 0));
}

// Monomer subtype used for shape + attachment-point resolution. Mirrors Qt's
// get_monomer_type / get_na_monomer_type_from_res_name (sketcher/rdkit/
// monomeric.cpp): peptides are identified by the "PEPTIDE" chain prefix and
// nucleic acids by the "RNA" prefix (which HELM also uses for DNA), sub-typed
// by the monomer symbol's last character (…p → phosphate, …r → sugar, else
// base). Anything else is a generic CHEM monomer.
enum class MonomerKind { PEPTIDE, NA_SUGAR, NA_PHOSPHATE, NA_BASE, CHEM };

MonomerKind na_kind_from_symbol(const std::string& sym)
{
    if (sym.empty()) {
        return MonomerKind::NA_BASE;
    }
    switch (std::tolower(static_cast<unsigned char>(sym.back()))) {
        case 'p':
            return MonomerKind::NA_PHOSPHATE;
        case 'r':
            return MonomerKind::NA_SUGAR;
        default:
            return MonomerKind::NA_BASE;
    }
}

MonomerKind monomer_kind(const RDKit::Atom* atom)
{
    const auto [chain, resnum] = monomer_chain_and_resnum(atom);
    (void) resnum;
    if (chain.rfind("PEPTIDE", 0) == 0) {
        return MonomerKind::PEPTIDE;
    }
    if (chain.rfind("RNA", 0) == 0) {
        std::string sym;
        atom->getPropIfPresent(::ATOM_LABEL, sym);
        return na_kind_from_symbol(sym);
    }
    return MonomerKind::CHEM;
}

// Resolve the connection between an existing monomer and a newly added one from
// their kinds (Qt's get_attachment_point_for_new_monomer, simplified for the
// linear/branch cases the lean draw tool supports). Returns the ordered pair of
// monomer indices to pass to addConnection (begin, end) and the connection type
// so the R#-R# linkage comes out correct. The base branch must be issued with
// the sugar as the begin monomer (R3 lives on the sugar), so we swap the order
// when the user clicked the base with a sugar tool.
struct MonomerConnection {
    size_t begin_idx;
    size_t end_idx;
    rdkit_extensions::ConnectionType type;
};

MonomerConnection resolve_monomer_connection(MonomerKind existing_kind,
                                             size_t existing_idx,
                                             MonomerKind new_kind,
                                             size_t new_idx)
{
    using rdkit_extensions::ConnectionType;
    // Sugar → base branch (R3-R1): the sugar must be the begin monomer.
    if (existing_kind == MonomerKind::NA_SUGAR &&
        new_kind == MonomerKind::NA_BASE) {
        return {existing_idx, new_idx, ConnectionType::SIDECHAIN};
    }
    if (existing_kind == MonomerKind::NA_BASE &&
        new_kind == MonomerKind::NA_SUGAR) {
        return {new_idx, existing_idx, ConnectionType::SIDECHAIN};
    }
    // Everything else (peptide↔peptide, sugar↔phosphate, phosphate↔sugar) is a
    // backbone (R2-R1) connection from the existing monomer to the new one.
    return {existing_idx, new_idx, ConnectionType::FORWARD};
}

// Monomer kind for a newly-armed monomer, from its chain-type int + symbol.
MonomerKind new_monomer_kind(int chain_type, const std::string& res_name)
{
    const auto ct = static_cast<rdkit_extensions::ChainType>(chain_type);
    if (ct == rdkit_extensions::ChainType::PEPTIDE) {
        return MonomerKind::PEPTIDE;
    }
    if (ct == rdkit_extensions::ChainType::CHEM) {
        return MonomerKind::CHEM;
    }
    return na_kind_from_symbol(res_name); // RNA/DNA → sugar/phos/base
}

// The attachment point the NEW monomer should use, given the existing monomer's
// kind + chosen AP and the new monomer's kind. Port of Qt's
// get_attachment_point_for_new_monomer (draw_monomer_scene_tool.cpp). AP model
// names: peptide N=R1/C=R2/X=R3; sugar 5'=R1/3'=R2/1'=R3; phosphate prev=R1/
// next=R2; base N1/9=R1. Returns "pair" for a nucleobase pairing (unsupported
// by the stub-chain path) and "" for CHEM's single AP fallthrough is "R1".
std::string resolve_new_ap(MonomerKind existing, const std::string& existing_ap,
                           MonomerKind neu)
{
    switch (neu) {
        case MonomerKind::CHEM:
            return "R1";
        case MonomerKind::PEPTIDE:
            if (existing == MonomerKind::PEPTIDE) {
                if (existing_ap == "R1") {
                    return "R2"; // existing N → new C
                }
                if (existing_ap == "R2") {
                    return "R1"; // existing C → new N
                }
            }
            return "R3"; // side chain
        case MonomerKind::NA_BASE:
            if (existing == MonomerKind::NA_SUGAR && existing_ap == "R3") {
                return "R1"; // sugar 1' → base N1/9
            }
            return "pair";
        case MonomerKind::NA_SUGAR:
            if (existing == MonomerKind::NA_PHOSPHATE) {
                if (existing_ap == "R1") {
                    return "R2"; // phosphate prev-sugar → sugar 3'
                }
                if (existing_ap == "R2") {
                    return "R1"; // phosphate next-sugar → sugar 5'
                }
            }
            return "R3"; // sugar 1'
        case MonomerKind::NA_PHOSPHATE:
            if (existing == MonomerKind::NA_SUGAR && existing_ap == "R2") {
                return "R1"; // sugar 3' → phosphate prev-sugar
            }
            return "R2"; // phosphate next-sugar
    }
    return "R1";
}
} // namespace

void MolModel::addMonomer(const std::string& res_name, int chain_type,
                          double x, double y)
{
    const auto ct = static_cast<rdkit_extensions::ChainType>(chain_type);
    doMutation(
        [this, res_name, ct, x, y] {
            // Flag the mol monomeric so isMonomeric() / the render bridge treat
            // every atom as a coarse-grained monomer. HELM_MODEL is a global
            // constant declared in rdkit_extensions/helm.h.
            m_mol.setProp(::HELM_MODEL, true);
            const auto chain_id = next_chain_id(m_mol, ct);
            const auto idx = rdkit_extensions::addMonomer(
                m_mol, res_name, /*residue_number=*/1, chain_id,
                rdkit_extensions::MonomerType::REGULAR);
            set_monomer_pos(m_mol, static_cast<unsigned int>(idx), x, y);
        },
        "Add monomer");
}

void MolModel::addBoundMonomer(const std::string& res_name, int chain_type,
                               double x, double y, unsigned int bound_to_idx)
{
    if (bound_to_idx >= m_mol.getNumAtoms()) {
        return;
    }
    // chain_type is unused for a bound monomer (it inherits the neighbor's
    // chain), but kept in the signature for symmetry with addMonomer.
    (void) chain_type;
    doMutation(
        [this, res_name, x, y, bound_to_idx] {
            m_mol.setProp(::HELM_MODEL, true);
            // Continue the neighbor's chain: same chain id, next residue number.
            const auto* existing = m_mol.getAtomWithIdx(bound_to_idx);
            const auto existing_kind = monomer_kind(existing);
            const auto [chain_id, resnum] = monomer_chain_and_resnum(existing);
            const auto idx = rdkit_extensions::addMonomer(
                m_mol, res_name, resnum + 1, chain_id,
                rdkit_extensions::MonomerType::REGULAR);
            set_monomer_pos(m_mol, static_cast<unsigned int>(idx), x, y);
            // Resolve the R#-R# linkage from the two monomers' kinds — a
            // backbone (R2-R1) or a sugar↔base branch (R3-R1). Dative /
            // direction-encoded — see addConnection.
            const auto conn = resolve_monomer_connection(
                existing_kind, bound_to_idx, na_kind_from_symbol(res_name), idx);
            rdkit_extensions::addConnection(m_mol, conn.begin_idx, conn.end_idx,
                                            conn.type);
        },
        "Add bound monomer");
}

void MolModel::addNucleotide(const std::string& sugar, const std::string& base,
                             const std::string& phos, double x, double y)
{
    doMutation(
        [this, sugar, base, phos, x, y] {
            m_mol.setProp(::HELM_MODEL, true);
            // A nucleotide is one HELM residue: sugar + branched base +
            // backbone phosphate, all in the same RNA chain / residue number
            // (HELM "RNA1{R(U)P}"). See addNucleotide doc for the layout.
            const auto chain_id =
                next_chain_id(m_mol, rdkit_extensions::ChainType::RNA);
            const auto sugar_idx = rdkit_extensions::addMonomer(
                m_mol, sugar, /*residue_number=*/1, chain_id,
                rdkit_extensions::MonomerType::REGULAR);
            const auto base_idx = rdkit_extensions::addMonomer(
                m_mol, base, 1, chain_id,
                rdkit_extensions::MonomerType::REGULAR);
            const auto phos_idx = rdkit_extensions::addMonomer(
                m_mol, phos, 1, chain_id,
                rdkit_extensions::MonomerType::REGULAR);
            set_monomer_pos(m_mol, static_cast<unsigned int>(sugar_idx), x, y);
            set_monomer_pos(m_mol, static_cast<unsigned int>(base_idx), x,
                            y - MONOMER_BOND_LENGTH);
            set_monomer_pos(m_mol, static_cast<unsigned int>(phos_idx),
                            x + MONOMER_BOND_LENGTH, y);
            // Base branch (sugar 1' R3 → base R1) then backbone (sugar 3' R2 →
            // phosphate R1).
            rdkit_extensions::addConnection(
                m_mol, sugar_idx, base_idx,
                rdkit_extensions::ConnectionType::SIDECHAIN);
            rdkit_extensions::addConnection(
                m_mol, sugar_idx, phos_idx,
                rdkit_extensions::ConnectionType::FORWARD);
        },
        "Add nucleotide");
}

void MolModel::addBoundNucleotide(const std::string& sugar,
                                  const std::string& base,
                                  const std::string& phos, double x, double y,
                                  unsigned int bound_to_idx)
{
    if (bound_to_idx >= m_mol.getNumAtoms()) {
        return;
    }
    doMutation(
        [this, sugar, base, phos, x, y, bound_to_idx] {
            m_mol.setProp(::HELM_MODEL, true);
            const auto [chain_id, resnum] =
                monomer_chain_and_resnum(m_mol.getAtomWithIdx(bound_to_idx));
            const auto sugar_idx = rdkit_extensions::addMonomer(
                m_mol, sugar, resnum + 1, chain_id,
                rdkit_extensions::MonomerType::REGULAR);
            const auto base_idx = rdkit_extensions::addMonomer(
                m_mol, base, resnum + 1, chain_id,
                rdkit_extensions::MonomerType::REGULAR);
            const auto phos_idx = rdkit_extensions::addMonomer(
                m_mol, phos, resnum + 1, chain_id,
                rdkit_extensions::MonomerType::REGULAR);
            set_monomer_pos(m_mol, static_cast<unsigned int>(sugar_idx), x, y);
            set_monomer_pos(m_mol, static_cast<unsigned int>(base_idx), x,
                            y - MONOMER_BOND_LENGTH);
            set_monomer_pos(m_mol, static_cast<unsigned int>(phos_idx),
                            x + MONOMER_BOND_LENGTH, y);
            // Backbone from the clicked monomer (typically the 3' phosphate) to
            // the new sugar's 5', then the intra-nucleotide branch + backbone.
            rdkit_extensions::addConnection(
                m_mol, bound_to_idx, sugar_idx,
                rdkit_extensions::ConnectionType::FORWARD);
            rdkit_extensions::addConnection(
                m_mol, sugar_idx, base_idx,
                rdkit_extensions::ConnectionType::SIDECHAIN);
            rdkit_extensions::addConnection(
                m_mol, sugar_idx, phos_idx,
                rdkit_extensions::ConnectionType::FORWARD);
        },
        "Add bound nucleotide");
}

void MolModel::mutateMonomer(unsigned int idx, const std::string& res_name)
{
    if (idx >= m_mol.getNumAtoms()) {
        return;
    }
    // Only monomer atoms (carrying residue info) can be mutated — guard against
    // an accidental call on an atomistic mol.
    if (m_mol.getAtomWithIdx(idx)->getMonomerInfo() == nullptr) {
        return;
    }
    doMutation(
        [this, idx, res_name] {
            rdkit_extensions::mutateMonomer(m_mol, idx, res_name);
        },
        "Mutate monomer");
}

void MolModel::addBoundMonomerViaAP(const std::string& res_name, int chain_type,
                                    double x, double y,
                                    unsigned int bound_to_idx,
                                    const std::string& existing_ap)
{
    if (bound_to_idx >= m_mol.getNumAtoms()) {
        return;
    }
    // Only numbered "R#" existing APs are chainable via the stub path; base
    // "pair" and unresolved new APs are skipped (base pairing isn't modeled).
    if (existing_ap.empty() || existing_ap[0] != 'R') {
        return;
    }
    const auto existing_kind = monomer_kind(m_mol.getAtomWithIdx(bound_to_idx));
    const auto new_kind = new_monomer_kind(chain_type, res_name);
    const std::string new_ap =
        resolve_new_ap(existing_kind, existing_ap, new_kind);
    if (new_ap.empty() || new_ap[0] != 'R') {
        return; // would need a "pair" linkage — unsupported here
    }
    const std::string linkage = existing_ap + "-" + new_ap;
    doMutation(
        [this, res_name, x, y, bound_to_idx, linkage] {
            m_mol.setProp(::HELM_MODEL, true);
            const auto [chain_id, resnum] =
                monomer_chain_and_resnum(m_mol.getAtomWithIdx(bound_to_idx));
            const auto idx = rdkit_extensions::addMonomer(
                m_mol, res_name, resnum + 1, chain_id,
                rdkit_extensions::MonomerType::REGULAR);
            set_monomer_pos(m_mol, static_cast<unsigned int>(idx), x, y);
            rdkit_extensions::addConnection(m_mol, bound_to_idx, idx, linkage);
        },
        "Add bound monomer");
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

void MolModel::adjustRadicalElectronsOnAtoms(
    const std::vector<unsigned int>& atom_indices, int delta)
{
    if (atom_indices.empty() || delta == 0 || m_mol.getNumAtoms() == 0) {
        return;
    }
    // Qt's molviewer/constants.h:41-42: MIN_UNPAIRED_E=0, MAX_UNPAIRED_E=4.
    constexpr int MIN_RADICAL = 0;
    constexpr int MAX_RADICAL = 4;
    // Capture (idx, old_count, new_count) up front so redo replays the same
    // post-clamp target (not "current + delta", which would compound across
    // re-redos) and undo restores the pre-edit value exactly. Same pattern as
    // adjustChargeOnSelectedAtoms above.
    std::vector<std::tuple<unsigned int, unsigned int, unsigned int>> previous;
    previous.reserve(atom_indices.size());
    for (auto idx : atom_indices) {
        if (idx >= m_mol.getNumAtoms()) {
            continue;
        }
        const int old_count =
            static_cast<int>(m_mol.getAtomWithIdx(idx)
                                 ->getNumRadicalElectrons());
        int new_count = old_count + delta;
        if (new_count < MIN_RADICAL) new_count = MIN_RADICAL;
        if (new_count > MAX_RADICAL) new_count = MAX_RADICAL;
        if (new_count == old_count) {
            continue;
        }
        previous.emplace_back(idx, static_cast<unsigned int>(old_count),
                              static_cast<unsigned int>(new_count));
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
    auto redo = [this, previous, refresh_cache] {
        for (const auto& [idx, _old, new_count] : previous) {
            m_mol.getAtomWithIdx(idx)->setNumRadicalElectrons(new_count);
        }
        refresh_cache();
        emitSignal(modelChanged);
    };
    auto undo = [this, previous, refresh_cache] {
        for (const auto& [idx, old_count, _new] : previous) {
            m_mol.getAtomWithIdx(idx)->setNumRadicalElectrons(old_count);
        }
        refresh_cache();
        emitSignal(modelChanged);
    };
    doCommand(std::move(redo), std::move(undo),
              delta > 0 ? "Add unpaired electrons"
                        : "Remove unpaired electrons");
}

void MolModel::setAtomElement(unsigned int idx, unsigned int atomic_num)
{
    if (idx >= m_mol.getNumAtoms()) {
        throw std::out_of_range("setAtomElement: atom index out of range");
    }
    auto* a = m_mol.getAtomWithIdx(idx);
    if (a->getAtomicNum() == static_cast<int>(atomic_num)) {
        return;
    }
    // Capture full pre-state so undo restores the original element + the
    // implicit-H-related defaults that we're about to reset. Stored as a POD
    // so lambdas can copy cheaply (same pattern as
    // setSelectedAtomsToHydrogenIsotope above).
    struct AtomState {
        int atomic_num;
        int formal_charge;
        unsigned int num_explicit_hs;
    };
    AtomState previous{a->getAtomicNum(), a->getFormalCharge(),
                       a->getNumExplicitHs()};
    auto refresh_cache = [this] {
        try {
            m_mol.updatePropertyCache(/*strict=*/false);
        } catch (...) {
        }
    };
    auto redo = [this, idx, atomic_num, refresh_cache] {
        auto* atom = m_mol.getAtomWithIdx(idx);
        atom->setAtomicNum(static_cast<int>(atomic_num));
        // Qt mutates by constructing a fresh RDKit::Atom(element), which
        // resets formal charge + explicit-H count to the new element's
        // defaults. Match that so implicit-H counts re-perceive.
        atom->setFormalCharge(0);
        atom->setNumExplicitHs(0);
        refresh_cache();
        emitSignal(modelChanged);
    };
    auto undo = [this, idx, previous, refresh_cache] {
        auto* atom = m_mol.getAtomWithIdx(idx);
        atom->setAtomicNum(previous.atomic_num);
        atom->setFormalCharge(previous.formal_charge);
        atom->setNumExplicitHs(previous.num_explicit_hs);
        refresh_cache();
        emitSignal(modelChanged);
    };
    doCommand(std::move(redo), std::move(undo), "Set element");
}

void MolModel::mutateAtomToRGroup(unsigned int idx, unsigned int r_group_num)
{
    // Mirrors Qt's MolModel::mutateRGroups (model/mol_model.cpp:2245) — the
    // atom context menu's "Replace with > R-Group". Replaces the atom in place
    // with an R-group dummy (make_new_r_group), preserving its bonds and 2D
    // position. Undo swaps the original atom back.
    if (r_group_num == 0) {
        throw std::invalid_argument("R-group number must be >= 1");
    }
    if (idx >= m_mol.getNumAtoms()) {
        return;
    }
    // Deep-copy the original atom so undo restores it exactly (element,
    // charge, radicals, explicit Hs, props). replaceAtom copies the atom it's
    // handed, so the raw pointers below never transfer ownership.
    auto original = std::make_shared<RDKit::Atom>(*m_mol.getAtomWithIdx(idx));
    auto refresh_cache = [this] {
        try {
            m_mol.updatePropertyCache(/*strict=*/false);
        } catch (...) {
        }
    };
    auto redo = [this, idx, r_group_num, refresh_cache] {
        auto rg = rdkit_extensions::make_new_r_group(r_group_num);
        m_mol.replaceAtom(idx, rg.get());
        refresh_cache();
        emitSignal(modelChanged);
    };
    auto undo = [this, idx, original, refresh_cache] {
        m_mol.replaceAtom(idx, original.get());
        refresh_cache();
        emitSignal(modelChanged);
    };
    doCommand(std::move(redo), std::move(undo), "Replace with R-group");
}

namespace
{
// Maps a wildcard label (A/Q/M/X + H variants) to the RDKit query maker used
// by Qt's ATOM_TOOL_QUERY_MAP (rdkit/atoms_and_bonds.h:61). The function
// pointers' derived return types implicitly convert to the base query pointer
// (same trick Qt relies on). Returns nullptr for an unrecognized label.
RDKit::Atom::QUERYATOM_QUERY* make_wildcard_query(const std::string& label)
{
    if (label == "A") return RDKit::makeAAtomQuery();
    if (label == "AH") return RDKit::makeAHAtomQuery();
    if (label == "Q") return RDKit::makeQAtomQuery();
    if (label == "QH") return RDKit::makeQHAtomQuery();
    if (label == "M") return RDKit::makeMAtomQuery();
    if (label == "MH") return RDKit::makeMHAtomQuery();
    if (label == "X") return RDKit::makeXAtomQuery();
    if (label == "XH") return RDKit::makeXHAtomQuery();
    return nullptr;
}
} // namespace

void MolModel::addWildcardAtom(const std::string& label, double x, double y)
{
    // Free-standing / click-to-place counterpart of mutateAtomToWildcard —
    // backs the atom-query (A▾) draw tool clicking empty canvas. Validate the
    // label before opening the mutation so a bad label is a clean no-op.
    auto* probe = make_wildcard_query(label);
    if (probe == nullptr) {
        return;
    }
    delete probe;
    doMutation(
        [this, label, x, y] {
            auto atom = std::make_unique<RDKit::QueryAtom>(0);
            atom->setQuery(make_wildcard_query(label));
            atom->setProp(WILDCARD_LABEL_PROP, label);
            const auto idx = m_mol.addAtom(atom.release(),
                                           /*updateLabel=*/false,
                                           /*takeOwnership=*/true);
            auto& conf = m_mol.getConformer();
            auto& positions = conf.getPositions();
            if (positions.size() < m_mol.getNumAtoms()) {
                positions.resize(m_mol.getNumAtoms(), RDGeom::Point3D(0, 0, 0));
            }
            conf.setAtomPos(idx, RDGeom::Point3D(x, y, 0));
        },
        "Add wildcard atom");
}

void MolModel::mutateAtomToWildcard(unsigned int idx, const std::string& label)
{
    // Mirrors the Wildcard branch of Qt's ReplaceAtomsWithMenu
    // (atom_context_menu.cpp:196) — replaces the atom in place with a query
    // atom (A/Q/M/X + H variants). The display label is stashed in a private
    // prop so the render description can surface it without re-parsing the
    // RDKit query (Qt's full query->label parser isn't ported). Undo swaps the
    // original atom back.
    if (idx >= m_mol.getNumAtoms()) {
        return;
    }
    auto* query = make_wildcard_query(label);
    if (query == nullptr) {
        return; // unrecognized wildcard label — no-op
    }
    // make_wildcard_query hands us an owning pointer; wrap it now so it's freed
    // even if we bail before handing it to the QueryAtom below.
    std::shared_ptr<RDKit::Atom::QUERYATOM_QUERY> query_owner(query);
    auto original = std::make_shared<RDKit::Atom>(*m_mol.getAtomWithIdx(idx));
    auto refresh_cache = [this] {
        try {
            m_mol.updatePropertyCache(/*strict=*/false);
        } catch (...) {
        }
    };
    auto redo = [this, idx, label, refresh_cache] {
        RDKit::QueryAtom qa(0); // dummy (atomic num 0) carrying the query
        qa.setQuery(make_wildcard_query(label));
        qa.setProp(WILDCARD_LABEL_PROP, label);
        m_mol.replaceAtom(idx, &qa);
        refresh_cache();
        emitSignal(modelChanged);
    };
    auto undo = [this, idx, original, refresh_cache] {
        m_mol.replaceAtom(idx, original.get());
        refresh_cache();
        emitSignal(modelChanged);
    };
    doCommand(std::move(redo), std::move(undo), "Replace with wildcard");
}

void MolModel::setElementForSelectedAtoms(unsigned int atomic_num)
{
    if (m_selected_atoms.empty()) {
        return;
    }
    // Capture per-atom pre-state so undo can restore the original element +
    // implicit-H-related defaults that we'll reset. Mirrors the snapshot
    // pattern in setSelectedAtomsToHydrogenIsotope so re-redo doesn't compound.
    struct AtomState {
        unsigned int idx;
        int atomic_num;
        int formal_charge;
        unsigned int num_explicit_hs;
    };
    std::vector<AtomState> previous;
    previous.reserve(m_selected_atoms.size());
    for (auto idx : m_selected_atoms) {
        if (idx >= m_mol.getNumAtoms()) {
            continue;
        }
        auto* a = m_mol.getAtomWithIdx(idx);
        previous.push_back({idx, a->getAtomicNum(), a->getFormalCharge(),
                            a->getNumExplicitHs()});
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
    auto redo = [this, previous, atomic_num, refresh_cache] {
        for (const auto& p : previous) {
            auto* a = m_mol.getAtomWithIdx(p.idx);
            a->setAtomicNum(static_cast<int>(atomic_num));
            a->setFormalCharge(0);
            a->setNumExplicitHs(0);
        }
        refresh_cache();
        emitSignal(modelChanged);
    };
    auto undo = [this, previous, refresh_cache] {
        for (const auto& p : previous) {
            auto* a = m_mol.getAtomWithIdx(p.idx);
            a->setAtomicNum(p.atomic_num);
            a->setFormalCharge(p.formal_charge);
            a->setNumExplicitHs(p.num_explicit_hs);
        }
        refresh_cache();
        emitSignal(modelChanged);
    };
    doCommand(std::move(redo), std::move(undo), "Set element");
}

void MolModel::setSelectedAtomsToHydrogenIsotope(unsigned int isotope)
{
    if (m_selected_atoms.empty()) {
        return;
    }
    // Capture full pre-state per atom so undo restores the original element
    // / isotope / charge / explicit-H exactly, even if redo is replayed
    // multiple times. Stored as a packed POD so the lambdas can copy cheaply.
    struct AtomState {
        unsigned int idx;
        int atomic_num;
        unsigned int isotope;
        int formal_charge;
        unsigned int num_explicit_hs;
    };
    std::vector<AtomState> previous;
    previous.reserve(m_selected_atoms.size());
    for (auto idx : m_selected_atoms) {
        if (idx >= m_mol.getNumAtoms()) {
            continue;
        }
        auto* a = m_mol.getAtomWithIdx(idx);
        previous.push_back({idx, a->getAtomicNum(), a->getIsotope(),
                            a->getFormalCharge(), a->getNumExplicitHs()});
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
    auto redo = [this, previous, isotope, refresh_cache] {
        for (const auto& p : previous) {
            auto* a = m_mol.getAtomWithIdx(p.idx);
            a->setAtomicNum(1);
            a->setIsotope(isotope);
            // Qt mutates by constructing a fresh RDKit::Atom("H"), which
            // resets formal charge and explicit-H count to the H defaults.
            a->setFormalCharge(0);
            a->setNumExplicitHs(0);
        }
        refresh_cache();
        emitSignal(modelChanged);
    };
    auto undo = [this, previous, refresh_cache] {
        for (const auto& p : previous) {
            auto* a = m_mol.getAtomWithIdx(p.idx);
            a->setAtomicNum(p.atomic_num);
            a->setIsotope(p.isotope);
            a->setFormalCharge(p.formal_charge);
            a->setNumExplicitHs(p.num_explicit_hs);
        }
        refresh_cache();
        emitSignal(modelChanged);
    };
    doCommand(std::move(redo), std::move(undo), "Set isotope");
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
    // Monomeric parses (HELM / FASTA — both are in the AUTO_DETECT list) come
    // back as coarse-grained mols with no 2D conformer. Generate a bead layout
    // (Qt runs the same monomer coordgen on import) so the render bridge, which
    // reads getConformer(), has positions. Skip the atomistic prepare — its
    // sanitize/stereo passes don't apply to monomer dummies.
    if (rdkit_extensions::isMonomeric(new_mol)) {
        if (new_mol.getNumConformers() == 0) {
            rdkit_extensions::compute_monomer_mol_coords(new_mol);
        }
        doMutation([this, new_mol] { m_mol = new_mol; }, "Load");
        return;
    }
    // MOL blocks carry their own conformer; we only need to compute when one
    // isn't present (typical for SMILES/InChI inputs).
    prepare_loaded_mol(new_mol, /*needs_2d_coords=*/false);
    doMutation([this, new_mol] { m_mol = new_mol; }, "Load");
}

namespace
{

// Shift `mol`'s 2D conformer so its centroid sits at the origin. Mirrors Qt's
// center_on_origin (molviewer/coord_utils.cpp:249) but inlined here to avoid
// pulling the Qt sketcher target into sketcher_core.
void center_mol_on_origin(RDKit::RWMol& mol)
{
    if (mol.getNumAtoms() == 0 || mol.getNumConformers() == 0) {
        return;
    }
    auto& conf = mol.getConformer();
    RDGeom::Point3D centroid(0, 0, 0);
    for (const auto& p : conf.getPositions()) {
        centroid += p;
    }
    centroid /= static_cast<double>(conf.getNumAtoms());
    for (auto& p : conf.getPositions()) {
        p -= centroid;
    }
}

// Translate `to_move`'s 2D conformer so its left edge sits `gap` units to the
// right of `stationary`'s right edge, vertically aligned against
// `stationary`'s mean-Y. Mirrors Qt's move_molecule_to_the_right_of
// (molviewer/coord_utils.cpp:406) but does not return the placement point
// (no callers in sketcher_core need it).
void move_to_right_of(RDKit::RWMol& to_move, const RDKit::RWMol& stationary,
                      double gap)
{
    auto& to_move_conf = to_move.getConformer();
    const auto& stat_conf = stationary.getConformer();
    if (stat_conf.getNumAtoms() == 0 || to_move_conf.getNumAtoms() == 0) {
        return;
    }
    double max_stat_x = -std::numeric_limits<double>::max();
    double sum_stat_y = 0.0;
    for (const auto& p : stat_conf.getPositions()) {
        max_stat_x = std::max(max_stat_x, p.x);
        sum_stat_y += p.y;
    }
    const double center_stat_y =
        sum_stat_y / static_cast<double>(stat_conf.getNumAtoms());
    double min_move_x = std::numeric_limits<double>::max();
    double sum_move_y = 0.0;
    for (const auto& p : to_move_conf.getPositions()) {
        min_move_x = std::min(min_move_x, p.x);
        sum_move_y += p.y;
    }
    const double center_move_y =
        sum_move_y / static_cast<double>(to_move_conf.getNumAtoms());
    const RDGeom::Point3D offset(max_stat_x - min_move_x + gap,
                                 center_stat_y - center_move_y, 0);
    for (auto& p : to_move_conf.getPositions()) {
        p += offset;
    }
}

} // namespace

void MolModel::addMolFromText(const std::string& text)
{
    // Same parse path as loadFromText — AUTO_DETECT walks SMILES/MOL/etc.
    auto parsed = rdkit_extensions::to_rdkit(text);
    RDKit::RWMol new_mol(*parsed);
    if (new_mol.getNumAtoms() == 0) {
        return;
    }
    prepare_loaded_mol(new_mol, /*needs_2d_coords=*/false);
    // Qt uses IMPORT_SPACING = 2 * BOND_LENGTH (constants.h:329), where
    // BOND_LENGTH = RDDepict::BOND_LEN = 1.5. Hardcoded here so sketcher_core
    // stays free of the Qt constants header.
    constexpr double IMPORT_SPACING = 2.0 * 1.5;
    if (m_mol.getNumAtoms() == 0) {
        center_mol_on_origin(new_mol);
    } else {
        move_to_right_of(new_mol, m_mol, IMPORT_SPACING);
    }
    // insertMol merges atoms/bonds and copies coordinates when conformer
    // counts match (both mols have exactly one 2D conformer here). Mirrors
    // Qt `addMolCommandFunc` (model/mol_model.cpp:2970).
    doMutation([this, new_mol] { m_mol.insertMol(new_mol); }, "Import");
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

void MolModel::addExplicitHsToAtoms(
    const std::vector<unsigned int>& atom_indices)
{
    if (m_mol.getNumAtoms() == 0) {
        return;
    }
    // Copy into the doMutation closure: rdkit_extensions::addHs takes the
    // vector by value (it may augment it internally with attached-H ids).
    const auto indices = atom_indices;
    doMutation(
        [this, indices] {
            rdkit_extensions::addHs(m_mol, indices);
        },
        "Add explicit Hs");
}

void MolModel::removeExplicitHsFromAtoms(
    const std::vector<unsigned int>& atom_indices)
{
    if (m_mol.getNumAtoms() == 0 || atom_indices.empty()) {
        return;
    }
    const auto indices = atom_indices;
    doMutation(
        [this, indices] {
            rdkit_extensions::removeHs(m_mol, indices);
        },
        "Remove explicit Hs");
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

void MolModel::cleanUp()
{
    if (m_mol.getNumAtoms() == 0) {
        return;
    }
    doMutation(
        [this] {
            // compute2DCoords forces the RDKit native depictor with ring
            // templates (matches the SMILES-load coord path). Swallow on
            // failure — the snapshot pre-image is still on the undo stack
            // so a bad recompute won't strand the user.
            try {
                rdkit_extensions::compute2DCoords(m_mol);
            } catch (...) {
                return;
            }
            try {
                // Stereo bond dirs are anchored to the old conformer; the
                // recompute may have rotated/reflected the layout, so
                // re-derive them from CIP chirality.
                RDKit::Chirality::wedgeMolBonds(m_mol, &m_mol.getConformer());
            } catch (...) {
            }
        },
        "Clean up");
}

namespace
{
/**
 * Atoms to transform for rotate/flip: the current selection when one exists,
 * otherwise every atom in the mol. Returns an empty vector when the mol is
 * empty; callers should treat that as a no-op.
 */
std::vector<unsigned int>
transform_target_indices(const RDKit::RWMol& mol,
                         const std::unordered_set<unsigned int>& selected)
{
    if (mol.getNumAtoms() == 0) {
        return {};
    }
    std::vector<unsigned int> indices;
    if (!selected.empty()) {
        indices.assign(selected.begin(), selected.end());
        std::sort(indices.begin(), indices.end());
    } else {
        indices.reserve(mol.getNumAtoms());
        for (unsigned int i = 0; i < mol.getNumAtoms(); ++i) {
            indices.push_back(i);
        }
    }
    return indices;
}
} // namespace

void MolModel::rotateSelectedAtoms(double angle_rad)
{
    auto indices = transform_target_indices(m_mol, m_selected_atoms);
    if (indices.empty()) {
        return;
    }
    const auto& conf = m_mol.getConformer();
    double cx = 0.0;
    double cy = 0.0;
    for (auto i : indices) {
        const auto& p = conf.getAtomPos(i);
        cx += p.x;
        cy += p.y;
    }
    cx /= static_cast<double>(indices.size());
    cy /= static_cast<double>(indices.size());

    const double cos_a = std::cos(angle_rad);
    const double sin_a = std::sin(angle_rad);
    std::vector<double> from_xs(indices.size());
    std::vector<double> from_ys(indices.size());
    std::vector<double> to_xs(indices.size());
    std::vector<double> to_ys(indices.size());
    for (size_t k = 0; k < indices.size(); ++k) {
        const auto& p = conf.getAtomPos(indices[k]);
        from_xs[k] = p.x;
        from_ys[k] = p.y;
        const double dx = p.x - cx;
        const double dy = p.y - cy;
        to_xs[k] = cx + dx * cos_a - dy * sin_a;
        to_ys[k] = cy + dx * sin_a + dy * cos_a;
    }
    // moveAtomsUndoable already wraps the batch in a macro, so the user
    // experiences this as a single Ctrl+Z step.
    moveAtomsUndoable(indices, from_xs, from_ys, to_xs, to_ys);
}

void MolModel::flipSelectedAtoms(bool horizontal)
{
    auto indices = transform_target_indices(m_mol, m_selected_atoms);
    if (indices.empty()) {
        return;
    }
    const auto& conf = m_mol.getConformer();
    double cx = 0.0;
    double cy = 0.0;
    for (auto i : indices) {
        const auto& p = conf.getAtomPos(i);
        cx += p.x;
        cy += p.y;
    }
    cx /= static_cast<double>(indices.size());
    cy /= static_cast<double>(indices.size());

    std::vector<double> from_xs(indices.size());
    std::vector<double> from_ys(indices.size());
    std::vector<double> to_xs(indices.size());
    std::vector<double> to_ys(indices.size());
    for (size_t k = 0; k < indices.size(); ++k) {
        const auto& p = conf.getAtomPos(indices[k]);
        from_xs[k] = p.x;
        from_ys[k] = p.y;
        // "horizontal" flip = mirror left↔right = negate X about the centroid.
        // "vertical" flip = mirror top↔bottom = negate Y about the centroid.
        to_xs[k] = horizontal ? (2.0 * cx - p.x) : p.x;
        to_ys[k] = horizontal ? p.y : (2.0 * cy - p.y);
    }
    moveAtomsUndoable(indices, from_xs, from_ys, to_xs, to_ys);
}

void MolModel::flipSubstituentAroundBond(unsigned int begin_idx,
                                         unsigned int end_idx)
{
    if (begin_idx >= m_mol.getNumAtoms() || end_idx >= m_mol.getNumAtoms()) {
        return;
    }
    const auto* bond = m_mol.getBondBetweenAtoms(begin_idx, end_idx);
    if (bond == nullptr) {
        return;
    }
    // Find the smaller substituent by removing the bond and splitting the mol
    // into fragments — same approach as Qt's get_smaller_substituent_atoms
    // (rdkit/subset.cpp:89). A ring bond leaves the mol connected (one frag),
    // so we bail out and the caller keeps the action disabled for ring bonds.
    RDKit::RWMol cut(m_mol);
    cut.removeBond(begin_idx, end_idx);
    std::vector<int> frag_map;
    std::vector<std::vector<int>> frag_atoms;
    RDKit::MolOps::getMolFrags(cut, /*sanitizeFrags=*/false, &frag_map,
                               &frag_atoms, /*copyConformers=*/false);
    std::vector<std::vector<int>> substituents;
    for (const auto& frag : frag_atoms) {
        const bool has_begin =
            std::find(frag.begin(), frag.end(),
                      static_cast<int>(begin_idx)) != frag.end();
        const bool has_end = std::find(frag.begin(), frag.end(),
                                       static_cast<int>(end_idx)) != frag.end();
        if (has_begin || has_end) {
            substituents.push_back(frag);
        }
    }
    if (substituents.size() != 2) {
        // Ring bond (or otherwise not two clean substituents) — no-op.
        return;
    }
    const auto& smaller = substituents[0].size() > substituents[1].size()
                              ? substituents[1]
                              : substituents[0];

    // Reflect each atom of the smaller substituent across the line through the
    // two bond endpoints. Mirrors Qt's flip_point (molviewer/coord_utils.cpp:
    // 165) — a reflection across the start→end axis. Formula:
    //   P' = A + 2*(v·d)d - v,  v = P - A,  d = unit(B - A)
    const auto& conf = m_mol.getConformer();
    const auto& a = conf.getAtomPos(begin_idx);
    const auto& b = conf.getAtomPos(end_idx);
    const double dx = b.x - a.x;
    const double dy = b.y - a.y;
    const double dlen = std::hypot(dx, dy);
    if (dlen == 0.0) {
        return;
    }
    const double ux = dx / dlen;
    const double uy = dy / dlen;

    std::vector<unsigned int> indices;
    std::vector<double> from_xs;
    std::vector<double> from_ys;
    std::vector<double> to_xs;
    std::vector<double> to_ys;
    indices.reserve(smaller.size());
    for (int raw_idx : smaller) {
        const auto idx = static_cast<unsigned int>(raw_idx);
        const auto& p = conf.getAtomPos(idx);
        const double vx = p.x - a.x;
        const double vy = p.y - a.y;
        const double dot = vx * ux + vy * uy;
        indices.push_back(idx);
        from_xs.push_back(p.x);
        from_ys.push_back(p.y);
        to_xs.push_back(a.x + 2.0 * dot * ux - vx);
        to_ys.push_back(a.y + 2.0 * dot * uy - vy);
    }
    // moveAtomsUndoable wraps the batch in a single undo macro.
    moveAtomsUndoable(indices, from_xs, from_ys, to_xs, to_ys);
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

/**
 * Build a copy of m_mol containing only the selected atoms, with the
 * selection auto-extended to cover both endpoints of any selected bond.
 * Returns an empty mol if nothing is selected. Shared by
 * `toMolBlockForSelection` and the selection branch of `toFormatString`.
 */
static RDKit::RWMol
extract_selection_copy(const RDKit::RWMol& src,
                       const std::unordered_set<unsigned int>& selected_atoms,
                       const std::unordered_set<unsigned int>& selected_bonds)
{
    std::unordered_set<unsigned int> keep_atoms = selected_atoms;
    for (auto bond_idx : selected_bonds) {
        if (bond_idx >= src.getNumBonds()) {
            continue;
        }
        const auto* b = src.getBondWithIdx(bond_idx);
        keep_atoms.insert(b->getBeginAtomIdx());
        keep_atoms.insert(b->getEndAtomIdx());
    }
    RDKit::RWMol mol_copy(src);
    if (keep_atoms.empty()) {
        // Drop every atom — caller treats empty mol as "" output.
        std::vector<unsigned int> all_indices;
        all_indices.reserve(mol_copy.getNumAtoms());
        for (unsigned int i = mol_copy.getNumAtoms(); i-- > 0;) {
            all_indices.push_back(i);
        }
        for (auto idx : all_indices) {
            mol_copy.removeAtom(idx);
        }
        return mol_copy;
    }
    std::vector<unsigned int> drop_desc;
    drop_desc.reserve(mol_copy.getNumAtoms());
    for (unsigned int i = 0; i < mol_copy.getNumAtoms(); ++i) {
        if (keep_atoms.count(i) == 0) {
            drop_desc.push_back(i);
        }
    }
    std::sort(drop_desc.begin(), drop_desc.end(), std::greater<unsigned int>());
    for (auto idx : drop_desc) {
        mol_copy.removeAtom(idx);
    }
    return mol_copy;
}

std::string MolModel::toMolBlockForSelection(bool v3000) const
{
    if (!hasSelection()) {
        return "";
    }
    auto mol_copy =
        extract_selection_copy(m_mol, m_selected_atoms, m_selected_bonds);
    if (mol_copy.getNumAtoms() == 0) {
        return "";
    }
    try {
        const auto fmt = v3000 ? rdkit_extensions::Format::MDL_MOLV3000
                               : rdkit_extensions::Format::MDL_MOLV2000;
        return rdkit_extensions::to_string(mol_copy, fmt);
    } catch (...) {
        return "";
    }
}

std::string MolModel::toFormatString(const std::string& format_name,
                                     bool selection_only) const
{
    if (m_mol.getNumAtoms() == 0) {
        return "";
    }
    // String → Format mapping mirrors Qt's get_standard_export_formats() entry
    // list (file_import_export.cpp:75). Names are lowercase + no spaces so JS
    // callers can hand-key them. MDL_MOLV2000 is here for symmetry but Qt
    // explicitly forbids it on the user-facing Copy As menu.
    rdkit_extensions::Format fmt;
    if (format_name == "smiles") {
        fmt = rdkit_extensions::Format::SMILES;
    } else if (format_name == "extended_smiles") {
        fmt = rdkit_extensions::Format::EXTENDED_SMILES;
    } else if (format_name == "smarts") {
        fmt = rdkit_extensions::Format::SMARTS;
    } else if (format_name == "extended_smarts") {
        fmt = rdkit_extensions::Format::EXTENDED_SMARTS;
    } else if (format_name == "inchi") {
        fmt = rdkit_extensions::Format::INCHI;
    } else if (format_name == "inchikey") {
        fmt = rdkit_extensions::Format::INCHI_KEY;
    } else if (format_name == "pdb") {
        fmt = rdkit_extensions::Format::PDB;
    } else if (format_name == "xyz") {
        fmt = rdkit_extensions::Format::XYZ;
    } else if (format_name == "mrv") {
        fmt = rdkit_extensions::Format::MRV;
    } else if (format_name == "maestro") {
        fmt = rdkit_extensions::Format::MAESTRO;
    } else if (format_name == "mdl_molv3000") {
        fmt = rdkit_extensions::Format::MDL_MOLV3000;
    } else if (format_name == "mdl_molv2000") {
        fmt = rdkit_extensions::Format::MDL_MOLV2000;
    } else if (format_name == "helm") {
        fmt = rdkit_extensions::Format::HELM;
    } else if (format_name == "fasta") {
        fmt = rdkit_extensions::Format::FASTA;
    } else {
        return "";
    }
    try {
        if (selection_only) {
            if (!hasSelection()) {
                return "";
            }
            auto mol_copy = extract_selection_copy(m_mol, m_selected_atoms,
                                                   m_selected_bonds);
            if (mol_copy.getNumAtoms() == 0) {
                return "";
            }
            return rdkit_extensions::to_string(mol_copy, fmt);
        }
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
