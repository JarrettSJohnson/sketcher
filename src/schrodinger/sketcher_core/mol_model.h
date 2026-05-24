/* -------------------------------------------------------------------------
 * Qt-free skeleton of sketcher::MolModel — owns an RDKit RWMol and supports
 * undoable add/remove of atoms and bonds. Built on sketcher_core's
 * UndoableModel + Signal primitives.
 *
 * Scope: enough to validate the sketcher_core pattern against the real
 * domain. Selection, monomers, S-groups, reactions, query atoms/bonds, and
 * stereo edits are deliberately out of the Phase 0 skeleton.
 *
 * Copyright Schrodinger LLC, All Rights Reserved.
 --------------------------------------------------------------------------- */

#pragma once

#include <functional>
#include <string>

#include <GraphMol/Bond.h>
#include <GraphMol/RWMol.h>

#include "schrodinger/sketcher_core/observer.h"
#include "schrodinger/sketcher_core/undoable_model.h"

namespace schrodinger
{
namespace sketcher_core
{

class UndoStack;

class MolModel : public UndoableModel
{
  public:
    explicit MolModel(UndoStack* stack);

    const RDKit::RWMol& mol() const
    {
        return m_mol;
    }
    bool isEmpty() const
    {
        return m_mol.getNumAtoms() == 0;
    }
    unsigned int numAtoms() const
    {
        return m_mol.getNumAtoms();
    }
    unsigned int numBonds() const
    {
        return m_mol.getNumBonds();
    }

    /** Append an atom by element symbol at the given 2D position. */
    void addAtom(const std::string& element, double x, double y);

    /** 2D position of the atom at `idx` (z is always 0). */
    void atomPos(unsigned int idx, double& x, double& y) const;

    /** Add a bond between two existing atom indices. */
    void addBond(unsigned int begin_idx, unsigned int end_idx,
                 RDKit::Bond::BondType type = RDKit::Bond::BondType::SINGLE);

    /** Remove an atom (and its incident bonds) by index. */
    void removeAtom(unsigned int idx);

    /** Remove the bond between two atom indices. */
    void removeBond(unsigned int begin_idx, unsigned int end_idx);

    /** Reset to an empty molecule. */
    void clear();

    /** Fired once per applied/undone/redone mutation. */
    Signal<> modelChanged;

  private:
    /**
     * Run a mutation under snapshot-based undo: capture an RWMol copy before
     * and after, then push a command whose redo/undo restore those copies.
     */
    void doMutation(const std::function<void()>& mutate,
                    std::string description);

    RDKit::RWMol m_mol;
};

} // namespace sketcher_core
} // namespace schrodinger
