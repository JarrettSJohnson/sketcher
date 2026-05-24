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
#include <unordered_set>

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

    /**
     * Set the 2D position of an existing atom *without* pushing an undo
     * command. Used as the live-preview step of a drag; the caller is
     * responsible for calling moveAtomUndoable on commit. Fires
     * modelChanged so observers can repaint. No-op if `idx` is out of range.
     */
    void setAtomPos(unsigned int idx, double x, double y);

    /**
     * Push an undoable atom move from `(from_x, from_y)` to `(to_x, to_y)`.
     * Unlike addAtom/removeAtom this does NOT clear the selection — moving
     * an atom doesn't reindex anything, so existing selection indices stay
     * valid. Backed by a custom command (not a whole-RWMol snapshot) so a
     * single drag commits one tiny command instead of two RWMol copies.
     */
    void moveAtomUndoable(unsigned int idx, double from_x, double from_y,
                          double to_x, double to_y);

    /**
     * Set the BondDir on the bond between `begin_idx` and `end_idx` to
     * `dir` (RDKit::Bond::BondDir cast to int). Undoable; preserves the
     * current selection (setting stereo doesn't reindex anything). No-op
     * if the bond does not exist.
     */
    void setBondDirUndoable(unsigned int begin_idx, unsigned int end_idx,
                            RDKit::Bond::BondDir dir);

    /**
     * Apply `setBondDirUndoable` to every selected bond in a single undo
     * macro. Convenient for UI actions like "wedge selected bonds". No-op
     * if no bonds are selected.
     */
    void setBondDirForSelectedBonds(RDKit::Bond::BondDir dir);

    /**
     * Insert a planar regular polygon of `size` carbon atoms centered at
     * (cx, cy). When `aromatic` is true (and `size` is even), bonds alternate
     * SINGLE / DOUBLE in Kekulé form so benzene renders the classic three-
     * double-bond pattern. Otherwise all bonds are SINGLE (cyclohexane etc.).
     * No-op if `size < 3`. Single undo step.
     */
    void addRing(unsigned int size, double cx, double cy, bool aromatic);

    /**
     * Add `delta` to the formal charge of every selected atom in a single
     * undoable command. Preserves the selection (charge edits don't reindex).
     * Refreshes the implicit-H cache so render description picks up the new
     * H counts. No-op if no atoms are selected.
     */
    void adjustChargeOnSelectedAtoms(int delta);

    /**
     * Replace the entire mol with the parsed SMILES, computing 2D coords +
     * wedge bonds so the new structure is renderable. Single undo step
     * (snapshot-based); throws std::invalid_argument if the SMILES is
     * unparseable (caller decides whether to surface that to the user).
     */
    void loadFromSmiles(const std::string& smiles);

    /**
     * Replace the mol with the parsed text, auto-detecting the format
     * (SMILES, MOL V2000/V3000, SMARTS, InChI, etc. — whatever to_rdkit's
     * AUTO_DETECT supports). Computes 2D coords + wedges. For inputs that
     * already carry coords (MOL blocks), coords are preserved as-is.
     * Throws std::invalid_argument on unparseable input.
     */
    void loadFromText(const std::string& text);

    /**
     * Serialize the current mol as a SMILES string. Returns an empty string
     * for an empty mol. RDKit writes non-Kekulé canonical SMILES by default;
     * stereo is preserved.
     */
    std::string toSmiles() const;

    /**
     * Serialize the current mol as an MDL MOL block. `v3000` selects the
     * V3000 spec (no atom-count limit, richer query support); false picks
     * V2000 for compatibility with older tools. Returns "" for an empty
     * mol or on writer failure.
     */
    std::string toMolBlock(bool v3000) const;

    /**
     * Promote every implicit hydrogen to an explicit atom with a generated
     * 2D position. Single undo step. No-op when the mol is empty; safe to
     * call repeatedly (a fully-explicit mol just stays that way).
     */
    void addHydrogens();

    /**
     * Strip explicit hydrogens back to implicit. Counterpart to addHydrogens.
     * Hs that carry isotopes / charges / unusual valence are preserved (per
     * rdkit_extensions::removeHs's "common standard"). Single undo step.
     */
    void removeHydrogens();

    // -- Selection --------------------------------------------------------
    // Selection is transient UI state, not undoable. Any mutation that may
    // reindex atoms/bonds clears it (matching the simplest correct policy
    // for index-based selection). For a stable-across-edits selection we'd
    // need the original sketcher's tag system; deliberately scoped out.

    void setAtomSelected(unsigned int atom_idx, bool selected);
    void setBondSelected(unsigned int bond_idx, bool selected);
    bool isAtomSelected(unsigned int atom_idx) const;
    bool isBondSelected(unsigned int bond_idx) const;
    bool hasSelection() const;
    void selectAll();
    void clearSelection();

    const std::unordered_set<unsigned int>& selectedAtoms() const
    {
        return m_selected_atoms;
    }
    const std::unordered_set<unsigned int>& selectedBonds() const
    {
        return m_selected_bonds;
    }

    /** Undoably remove every selected atom and bond (and incident bonds of
     *  selected atoms). No-op if the selection is empty. */
    void deleteSelected();

    /** Fired once per applied/undone/redone mutation. */
    Signal<> modelChanged;

    /** Fired when the selection set changes (independent of modelChanged). */
    Signal<> selectionChanged;

  private:
    /**
     * Run a mutation under snapshot-based undo: capture an RWMol copy before
     * and after, then push a command whose redo/undo restore those copies.
     * Also clears any current selection (selection is reset by any edit).
     */
    void doMutation(const std::function<void()>& mutate,
                    std::string description);

    RDKit::RWMol m_mol;
    std::unordered_set<unsigned int> m_selected_atoms;
    std::unordered_set<unsigned int> m_selected_bonds;
};

} // namespace sketcher_core
} // namespace schrodinger
