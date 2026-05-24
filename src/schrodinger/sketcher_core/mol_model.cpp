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

#include <memory>
#include <utility>

#include <GraphMol/Atom.h>
#include <GraphMol/Bond.h>

#include "schrodinger/sketcher_core/undo_stack.h"

namespace schrodinger
{
namespace sketcher_core
{

MolModel::MolModel(UndoStack* stack) : UndoableModel(stack)
{
}

void MolModel::doMutation(const std::function<void()>& mutate,
                          std::string description)
{
    RDKit::RWMol before(m_mol);
    mutate();
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

void MolModel::addAtom(const std::string& element)
{
    doMutation(
        [this, element] {
            auto atom = std::make_unique<RDKit::Atom>(element);
            m_mol.addAtom(atom.release(), /*updateLabel=*/false,
                          /*takeOwnership=*/true);
        },
        "Add atom");
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
    doMutation([this] { m_mol = RDKit::RWMol(); }, "Clear");
}

} // namespace sketcher_core
} // namespace schrodinger
