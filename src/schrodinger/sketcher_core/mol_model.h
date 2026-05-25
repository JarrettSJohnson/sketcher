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

    /**
     * Add a bond and immediately set its BondDir, both inside one undo
     * macro. Convenient when the bond tool runs with an active stereo mode
     * (wedge/dash) so the new bond appears wedged on creation rather than
     * requiring a separate Wedge click. Falls through to addBond when dir
     * is BondDir::NONE.
     */
    void addBondWithDir(unsigned int begin_idx, unsigned int end_idx,
                        RDKit::Bond::BondType type,
                        RDKit::Bond::BondDir dir);

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
     * Batched moveAtomUndoable: every (idx, from, to) row is committed
     * inside a single undo macro so the whole gesture (e.g. drag-moving
     * a multi-atom selection) collapses to one undo step. All four
     * vectors must have the same length; no-op when `indices` is empty.
     * Preserves selection like the single-atom variant.
     */
    void moveAtomsUndoable(const std::vector<unsigned int>& indices,
                           const std::vector<double>& from_xs,
                           const std::vector<double>& from_ys,
                           const std::vector<double>& to_xs,
                           const std::vector<double>& to_ys);

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
     * Change the bond order of the bond between `begin_idx` and `end_idx`
     * to `type`. Used by the Erase tool to decrement triple→double→single
     * before deleting (Qt `EraseSceneTool::onLeftButtonClick`). Preserves
     * selection (no reindexing). Refreshes the implicit-H cache so labels
     * update with the new valence. No-op if the bond is missing or the
     * type already matches.
     */
    void setBondTypeUndoable(unsigned int begin_idx, unsigned int end_idx,
                             RDKit::Bond::BondType type);

    /**
     * Insert a planar regular polygon of `size` carbon atoms centered at
     * (cx, cy). When `aromatic` is true (and `size` is even), bonds alternate
     * SINGLE / DOUBLE in Kekulé form so benzene renders the classic three-
     * double-bond pattern. Otherwise all bonds are SINGLE (cyclohexane etc.).
     * No-op if `size < 3`. Single undo step.
     */
    void addRing(unsigned int size, double cx, double cy, bool aromatic);

    /**
     * Add a chain of carbon atoms at the given 2D positions, single-bonded in
     * order. When `bound_to_atom_idx` is a valid existing atom index, the
     * first new atom is single-bonded to it (extending the chain off an
     * existing structure). Pass -1 for a free-standing chain. Mirrors Qt's
     * `DrawChainSceneTool::onLeftButtonDragRelease` (`tool/draw_chain_scene_tool.cpp:74-89`),
     * which calls `MolModel::addAtomChain(Element::C, coords, start_atom)`.
     * Single undo step. No-op when `xs` is empty or xs/ys lengths mismatch.
     */
    void addAtomChain(const std::vector<double>& xs,
                      const std::vector<double>& ys, int bound_to_atom_idx);

    /**
     * Add `delta` to the formal charge of every selected atom in a single
     * undoable command. Preserves the selection (charge edits don't reindex).
     * Refreshes the implicit-H cache so render description picks up the new
     * H counts. No-op if no atoms are selected.
     */
    void adjustChargeOnSelectedAtoms(int delta);

    /**
     * Replace every selected atom with a hydrogen of the given mass-number
     * isotope (Deuterium = 2, Tritium = 3, ordinary H = 1, "no specific
     * isotope" = 0). Mirrors Qt's D/T keyboard shortcuts
     * (sketcher_widget.cpp:1272-1283), which call mutateAtoms with a fresh
     * RDKit::Atom("H").setIsotope(N). Resets formal charge + explicit-H
     * count on the mutated atoms to the H defaults so the implicit-H cache
     * reflects the new valence. Preserves the selection. Single undo step.
     * No-op if no atoms are selected.
     */
    void setSelectedAtomsToHydrogenIsotope(unsigned int isotope);

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

    /**
     * Perceive aromaticity on the current mol — sets the aromatic flag on
     * atoms and bonds wherever RDKit's default aromaticity model fires
     * (Daylight-ish). Single undo step. No-op when the mol is empty. Swallow
     * RDKit perception failures so a stray odd valence doesn't kill the edit.
     */
    void aromatize();

    /**
     * Kekulize the current mol — replaces aromatic bonds with explicit
     * SINGLE/DOUBLE alternation and clears the aromatic flag. Counterpart to
     * aromatize. Single undo step. Silent no-op if kekulization fails for
     * the current structure (e.g. unkekulizable aromatic system).
     */
    void kekulize();

    /**
     * Recompute 2D coordinates for the entire mol via
     * rdkit_extensions::compute2DCoords + wedgeMolBonds. Useful as a
     * "clean up" action after the user has dragged atoms into a mess, or
     * after a load path that left coords stale. Single undo step. No-op
     * when the mol is empty.
     */
    void cleanUp();

    /**
     * Rotate every selected atom by `angle_rad` (counterclockwise, since the
     * model-space Y axis points up) around the centroid of the selection.
     * When no atoms are selected, rotates the whole mol around its centroid.
     * Single undo step. No-op on empty mol. Preserves selection.
     */
    void rotateSelectedAtoms(double angle_rad);

    /**
     * Flip every selected atom across a horizontal (when `horizontal` is true:
     * mirror left↔right, i.e. negate X about the centroid X) or vertical
     * (mirror top↔bottom: negate Y about the centroid Y) axis through the
     * selection centroid. When no atoms are selected, flips the whole mol.
     * Single undo step. No-op on empty mol. Preserves selection.
     */
    void flipSelectedAtoms(bool horizontal);

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
