/* -------------------------------------------------------------------------
 * Tests for schrodinger::sketcher_core::MolModel — the Qt-free skeleton
 * domain model used by the Phase 0 spike.
 *
 * Copyright Schrodinger LLC, All Rights Reserved.
 --------------------------------------------------------------------------- */

#define BOOST_TEST_MODULE sketcher_core_mol_model

#include <cmath>
#include <vector>

#include <boost/test/unit_test.hpp>

#include <GraphMol/Bond.h>

#include "schrodinger/sketcher_core/mol_model.h"
#include "schrodinger/sketcher_core/undo_stack.h"

using schrodinger::sketcher_core::MolModel;
using schrodinger::sketcher_core::UndoStack;

BOOST_AUTO_TEST_CASE(testNewModelIsEmpty)
{
    UndoStack stack;
    MolModel m(&stack);
    BOOST_CHECK(m.isEmpty());
    BOOST_CHECK_EQUAL(m.numAtoms(), 0u);
    BOOST_CHECK_EQUAL(m.numBonds(), 0u);
}

BOOST_AUTO_TEST_CASE(testAddAtomGrowsTheMolecule)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0.0, 0.0);
    m.addAtom("O", 1.5, 0.0);
    BOOST_CHECK_EQUAL(m.numAtoms(), 2u);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getSymbol(), "C");
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(1)->getSymbol(), "O");
}

BOOST_AUTO_TEST_CASE(testAddAtomStoresCoords)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 1.5, 2.5);
    m.addAtom("O", -3.0, 4.25);

    double x = 0, y = 0;
    m.atomPos(0, x, y);
    BOOST_CHECK_CLOSE(x, 1.5, 1e-6);
    BOOST_CHECK_CLOSE(y, 2.5, 1e-6);
    m.atomPos(1, x, y);
    BOOST_CHECK_CLOSE(x, -3.0, 1e-6);
    BOOST_CHECK_CLOSE(y, 4.25, 1e-6);
}

BOOST_AUTO_TEST_CASE(testUndoRedoPreservesCoords)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 7.0, 11.0);
    stack.undo();
    BOOST_CHECK(m.isEmpty());
    stack.redo();

    double x = 0, y = 0;
    m.atomPos(0, x, y);
    BOOST_CHECK_CLOSE(x, 7.0, 1e-6);
    BOOST_CHECK_CLOSE(y, 11.0, 1e-6);
}

BOOST_AUTO_TEST_CASE(testAddBondConnectsAtoms)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);
    m.addBond(0, 1, RDKit::Bond::BondType::DOUBLE);
    BOOST_REQUIRE_EQUAL(m.numBonds(), 1u);
    const auto* b = m.mol().getBondWithIdx(0);
    BOOST_CHECK_EQUAL(b->getBeginAtomIdx(), 0u);
    BOOST_CHECK_EQUAL(b->getEndAtomIdx(), 1u);
    BOOST_CHECK(b->getBondType() == RDKit::Bond::BondType::DOUBLE);
}

BOOST_AUTO_TEST_CASE(testUndoRedoRoundTripPreservesEverything)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);
    m.addBond(0, 1);

    BOOST_CHECK_EQUAL(stack.count(), 3u);
    BOOST_CHECK_EQUAL(m.numAtoms(), 2u);
    BOOST_CHECK_EQUAL(m.numBonds(), 1u);

    stack.undo(); // bond removed
    BOOST_CHECK_EQUAL(m.numAtoms(), 2u);
    BOOST_CHECK_EQUAL(m.numBonds(), 0u);

    stack.undo(); // 2nd atom removed
    BOOST_CHECK_EQUAL(m.numAtoms(), 1u);

    stack.undo(); // 1st atom removed
    BOOST_CHECK(m.isEmpty());

    stack.redo();
    stack.redo();
    stack.redo();
    BOOST_CHECK_EQUAL(m.numAtoms(), 2u);
    BOOST_CHECK_EQUAL(m.numBonds(), 1u);
}

BOOST_AUTO_TEST_CASE(testRemoveAtomAlsoRemovesIncidentBondsAndUndoRestoresThem)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);
    m.addAtom("O", 3.0, 0);
    m.addBond(0, 1);
    m.addBond(1, 2);
    BOOST_REQUIRE_EQUAL(m.numBonds(), 2u);

    // Removing the middle atom drops both bonds.
    m.removeAtom(1);
    BOOST_CHECK_EQUAL(m.numAtoms(), 2u);
    BOOST_CHECK_EQUAL(m.numBonds(), 0u);

    // Snapshot-based undo restores the bonds too.
    stack.undo();
    BOOST_CHECK_EQUAL(m.numAtoms(), 3u);
    BOOST_CHECK_EQUAL(m.numBonds(), 2u);
}

BOOST_AUTO_TEST_CASE(testRemoveBondLeavesAtomsAlone)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);
    m.addBond(0, 1);
    m.removeBond(0, 1);

    BOOST_CHECK_EQUAL(m.numAtoms(), 2u);
    BOOST_CHECK_EQUAL(m.numBonds(), 0u);

    stack.undo();
    BOOST_CHECK_EQUAL(m.numBonds(), 1u);
}

BOOST_AUTO_TEST_CASE(testClearWipesAtomsAndIsUndoable)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("N", 1.5, 0);
    m.addBond(0, 1);
    m.clear();

    BOOST_CHECK(m.isEmpty());
    stack.undo();
    BOOST_CHECK_EQUAL(m.numAtoms(), 2u);
    BOOST_CHECK_EQUAL(m.numBonds(), 1u);
}

BOOST_AUTO_TEST_CASE(testModelChangedFiresOncePerCommandAndOncePerUndoRedo)
{
    UndoStack stack;
    MolModel m(&stack);

    int fired = 0;
    auto conn = m.modelChanged.connect([&] { ++fired; });

    m.addAtom("C", 0, 0);
    BOOST_CHECK_EQUAL(fired, 1);
    m.addAtom("C", 1.5, 0);
    BOOST_CHECK_EQUAL(fired, 2);
    m.addBond(0, 1);
    BOOST_CHECK_EQUAL(fired, 3);

    stack.undo();
    BOOST_CHECK_EQUAL(fired, 4);
    stack.redo();
    BOOST_CHECK_EQUAL(fired, 5);
}

BOOST_AUTO_TEST_CASE(testMacroGroupsMutationsIntoSingleUndoStep)
{
    UndoStack stack;
    MolModel m(&stack);
    {
        auto macro = m.createUndoMacro("Build ethane");
        m.addAtom("C", 0, 0);
        m.addAtom("C", 1.5, 0);
        m.addBond(0, 1);
    }
    BOOST_CHECK_EQUAL(stack.count(), 1u);
    BOOST_CHECK_EQUAL(m.numAtoms(), 2u);
    BOOST_CHECK_EQUAL(m.numBonds(), 1u);

    stack.undo();
    BOOST_CHECK(m.isEmpty());
    stack.redo();
    BOOST_CHECK_EQUAL(m.numAtoms(), 2u);
    BOOST_CHECK_EQUAL(m.numBonds(), 1u);
}

BOOST_AUTO_TEST_CASE(testSelectionStartsEmptyAndTogglesAtomAndBond)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);
    m.addBond(0, 1);

    BOOST_CHECK(!m.hasSelection());
    m.setAtomSelected(0, true);
    BOOST_CHECK(m.isAtomSelected(0));
    BOOST_CHECK(!m.isAtomSelected(1));
    BOOST_CHECK(m.hasSelection());

    m.setBondSelected(0, true);
    BOOST_CHECK(m.isBondSelected(0));
    BOOST_CHECK_EQUAL(m.selectedAtoms().size(), 1u);
    BOOST_CHECK_EQUAL(m.selectedBonds().size(), 1u);

    m.setAtomSelected(0, false);
    BOOST_CHECK(!m.isAtomSelected(0));
    BOOST_CHECK(m.hasSelection()); // bond still selected
}

BOOST_AUTO_TEST_CASE(testSelectionChangedFiresOnlyOnRealChanges)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);

    int fired = 0;
    auto conn = m.selectionChanged.connect([&] { ++fired; });

    m.setAtomSelected(0, true);
    BOOST_CHECK_EQUAL(fired, 1);
    m.setAtomSelected(0, true); // already selected — no signal
    BOOST_CHECK_EQUAL(fired, 1);
    m.setAtomSelected(1, false); // already unselected — no signal
    BOOST_CHECK_EQUAL(fired, 1);
    m.setAtomSelected(0, false);
    BOOST_CHECK_EQUAL(fired, 2);

    // Out-of-range indices are silently ignored.
    m.setAtomSelected(999u, true);
    BOOST_CHECK_EQUAL(fired, 2);
}

BOOST_AUTO_TEST_CASE(testSelectAllAndClearSelection)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);
    m.addAtom("O", 3.0, 0);
    m.addBond(0, 1);
    m.addBond(1, 2);

    m.selectAll();
    BOOST_CHECK_EQUAL(m.selectedAtoms().size(), 3u);
    BOOST_CHECK_EQUAL(m.selectedBonds().size(), 2u);

    m.clearSelection();
    BOOST_CHECK(!m.hasSelection());

    int fired = 0;
    auto conn = m.selectionChanged.connect([&] { ++fired; });
    m.clearSelection(); // already empty — no signal
    BOOST_CHECK_EQUAL(fired, 0);
}

BOOST_AUTO_TEST_CASE(testMutationResetsSelectionAndFiresSelectionChanged)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);

    m.setAtomSelected(0, true);
    m.setAtomSelected(1, true);

    int sel_fired = 0;
    auto conn = m.selectionChanged.connect([&] { ++sel_fired; });

    m.addAtom("O", 3.0, 0); // mutation: selection should reset
    BOOST_CHECK(!m.hasSelection());
    BOOST_CHECK_EQUAL(sel_fired, 1);
}

BOOST_AUTO_TEST_CASE(testDeleteSelectedRemovesAtomsAndBondsAndIsUndoable)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);
    m.addAtom("O", 3.0, 0);
    m.addAtom("N", 4.5, 0);
    m.addBond(0, 1);
    m.addBond(1, 2);
    m.addBond(2, 3);

    // Select atom 0 (drops bond 0 with it) and bond 2 explicitly.
    m.setAtomSelected(0, true);
    m.setBondSelected(2, true);
    m.deleteSelected();

    // 3 atoms left, bond 1 (1→2) survives, original bond 2 gone, bond 0 gone.
    BOOST_CHECK_EQUAL(m.numAtoms(), 3u);
    BOOST_CHECK_EQUAL(m.numBonds(), 1u);
    BOOST_CHECK(!m.hasSelection());

    stack.undo();
    BOOST_CHECK_EQUAL(m.numAtoms(), 4u);
    BOOST_CHECK_EQUAL(m.numBonds(), 3u);
}

BOOST_AUTO_TEST_CASE(testDeleteSelectedIsNoOpWhenNothingSelected)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);
    const auto count_before = stack.count();

    m.deleteSelected(); // no selection — should not push a command
    BOOST_CHECK_EQUAL(stack.count(), count_before);
    BOOST_CHECK_EQUAL(m.numAtoms(), 2u);
}

BOOST_AUTO_TEST_CASE(testSetAtomPosUpdatesCoordsAndIsNotUndoable)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 1, 2);
    int fires = 0;
    auto conn = m.modelChanged.connect([&fires] { ++fires; });
    const auto count_before = stack.count();

    m.setAtomPos(0, 9, -4);
    BOOST_CHECK_EQUAL(fires, 1); // direct emit
    BOOST_CHECK_EQUAL(stack.count(), count_before); // not undoable

    double x = 0, y = 0;
    m.atomPos(0, x, y);
    BOOST_CHECK_CLOSE(x, 9.0, 1e-6);
    BOOST_CHECK_CLOSE(y, -4.0, 1e-6);

    m.setAtomPos(99, 0, 0); // out-of-range is a no-op
    BOOST_CHECK_EQUAL(fires, 1);
}

BOOST_AUTO_TEST_CASE(testMoveAtomUndoableRoundTripsPosition)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    // Simulate a drag: preview moves wherever the user drags, then commit.
    m.setAtomPos(0, 4, 4);
    m.setAtomPos(0, 7, 1);
    m.moveAtomUndoable(0, /*from=*/0, 0, /*to=*/7, 1);

    double x = 0, y = 0;
    m.atomPos(0, x, y);
    BOOST_CHECK_CLOSE(x, 7.0, 1e-6);
    BOOST_CHECK_CLOSE(y, 1.0, 1e-6);

    stack.undo();
    m.atomPos(0, x, y);
    BOOST_CHECK_CLOSE(x, 0.0, 1e-6);
    BOOST_CHECK_CLOSE(y, 0.0, 1e-6);

    stack.redo();
    m.atomPos(0, x, y);
    BOOST_CHECK_CLOSE(x, 7.0, 1e-6);
    BOOST_CHECK_CLOSE(y, 1.0, 1e-6);
}

BOOST_AUTO_TEST_CASE(testMoveAtomUndoablePreservesSelection)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("O", 1, 0);
    m.setAtomSelected(0, true);
    m.setAtomSelected(1, true);
    int sel_fires = 0;
    auto conn = m.selectionChanged.connect([&sel_fires] { ++sel_fires; });

    // Moving an atom doesn't reindex anything — selection must survive.
    m.moveAtomUndoable(0, 0, 0, 5, 5);
    BOOST_CHECK(m.isAtomSelected(0));
    BOOST_CHECK(m.isAtomSelected(1));
    BOOST_CHECK_EQUAL(sel_fires, 0);

    stack.undo();
    BOOST_CHECK(m.isAtomSelected(0));
    BOOST_CHECK(m.isAtomSelected(1));
    BOOST_CHECK_EQUAL(sel_fires, 0);
}

BOOST_AUTO_TEST_CASE(testSetBondDirUndoableRoundTripsAndPreservesSelection)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1, 0);
    m.addBond(0, 1, RDKit::Bond::SINGLE);
    BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(0)->getBondDir(),
                      RDKit::Bond::BondDir::NONE);

    m.setBondSelected(0, true);
    int sel_fires = 0;
    auto conn = m.selectionChanged.connect([&sel_fires] { ++sel_fires; });

    m.setBondDirUndoable(0, 1, RDKit::Bond::BondDir::BEGINWEDGE);
    BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(0)->getBondDir(),
                      RDKit::Bond::BondDir::BEGINWEDGE);
    // Selection survives — setting bond direction doesn't reindex.
    BOOST_CHECK(m.isBondSelected(0));
    BOOST_CHECK_EQUAL(sel_fires, 0);

    stack.undo();
    BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(0)->getBondDir(),
                      RDKit::Bond::BondDir::NONE);
    BOOST_CHECK(m.isBondSelected(0));

    stack.redo();
    BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(0)->getBondDir(),
                      RDKit::Bond::BondDir::BEGINWEDGE);
}

BOOST_AUTO_TEST_CASE(testSetBondDirNoOpsWhenBondMissingOrUnchanged)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1, 0);
    const auto count_after_atoms = stack.count();
    // No bond exists between 0 and 1 yet — should be a silent no-op
    // (no undo command pushed).
    m.setBondDirUndoable(0, 1, RDKit::Bond::BondDir::BEGINWEDGE);
    BOOST_CHECK_EQUAL(stack.count(), count_after_atoms);

    m.addBond(0, 1, RDKit::Bond::SINGLE);
    const auto count_after_bond = stack.count();
    // Setting NONE on a bond that's already NONE — no command pushed.
    m.setBondDirUndoable(0, 1, RDKit::Bond::BondDir::NONE);
    BOOST_CHECK_EQUAL(stack.count(), count_after_bond);
}

BOOST_AUTO_TEST_CASE(testSetBondDirForSelectedBondsAppliesAsSingleUndoStep)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1, 0);
    m.addAtom("C", 2, 0);
    m.addBond(0, 1, RDKit::Bond::SINGLE);
    m.addBond(1, 2, RDKit::Bond::SINGLE);
    m.setBondSelected(0, true);
    m.setBondSelected(1, true);

    m.setBondDirForSelectedBonds(RDKit::Bond::BondDir::BEGINDASH);
    BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(0)->getBondDir(),
                      RDKit::Bond::BondDir::BEGINDASH);
    BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(1)->getBondDir(),
                      RDKit::Bond::BondDir::BEGINDASH);

    // A single undo must clear stereo on both bonds — they live in one macro.
    stack.undo();
    BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(0)->getBondDir(),
                      RDKit::Bond::BondDir::NONE);
    BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(1)->getBondDir(),
                      RDKit::Bond::BondDir::NONE);
}

BOOST_AUTO_TEST_CASE(testAddBondWithDirAppliesDirAtomicallyAsOneUndoStep)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1, 0);
    const auto count_after_atoms = stack.count();

    // Single user-visible action: draw bond + immediately apply the wedge.
    m.addBondWithDir(0, 1, RDKit::Bond::SINGLE,
                     RDKit::Bond::BondDir::BEGINWEDGE);
    BOOST_CHECK_EQUAL(m.numBonds(), 1u);
    BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(0)->getBondDir(),
                      RDKit::Bond::BondDir::BEGINWEDGE);
    // Exactly one undo step on the stack — the addBond + setBondDir live
    // in a single macro, so the user only Ctrl+Zs once.
    BOOST_CHECK_EQUAL(stack.count(), count_after_atoms + 1);

    stack.undo();
    BOOST_CHECK_EQUAL(m.numBonds(), 0u);
    // Atoms are intact: the macro only covered the bond+dir, not the atoms.
    BOOST_CHECK_EQUAL(m.numAtoms(), 2u);

    stack.redo();
    BOOST_CHECK_EQUAL(m.numBonds(), 1u);
    BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(0)->getBondDir(),
                      RDKit::Bond::BondDir::BEGINWEDGE);
}

BOOST_AUTO_TEST_CASE(testAddBondWithDirNoneFallsThroughToAddBond)
{
    // When dir is NONE the macro adds nothing on top of addBond — the result
    // should be a plain SINGLE bond with no setBondDir command piled on.
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1, 0);
    const auto count_after_atoms = stack.count();

    m.addBondWithDir(0, 1, RDKit::Bond::SINGLE, RDKit::Bond::BondDir::NONE);
    BOOST_CHECK_EQUAL(m.numBonds(), 1u);
    BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(0)->getBondDir(),
                      RDKit::Bond::BondDir::NONE);
    // Exactly one command pushed — no orphan setBondDir command in a macro.
    BOOST_CHECK_EQUAL(stack.count(), count_after_atoms + 1);
}

BOOST_AUTO_TEST_CASE(testRotateSelectedAtoms90CWAroundCentroidAndUndo)
{
    UndoStack stack;
    MolModel m(&stack);
    // Three atoms with known centroid at (1, 1).
    m.addAtom("C", 0, 0);
    m.addAtom("C", 2, 0);
    m.addAtom("C", 1, 3);
    // Select only the first two — centroid of selection is (1, 0).
    m.setAtomSelected(0, true);
    m.setAtomSelected(1, true);

    const auto count_before = stack.count();
    // CW 90° in math convention is -pi/2 (since Y points up in model coords).
    m.rotateSelectedAtoms(-M_PI_2);

    // Selection centroid was (1, 0): atom 0 (0,0) rotates to (1, 1); atom 1
    // (2, 0) rotates to (1, -1). Atom 2 is untouched.
    auto pos = [&](unsigned i) { return m.mol().getConformer().getAtomPos(i); };
    BOOST_CHECK_CLOSE(pos(0).x, 1.0, 1e-6);
    BOOST_CHECK_CLOSE(pos(0).y, 1.0, 1e-6);
    BOOST_CHECK_CLOSE(pos(1).x, 1.0, 1e-6);
    BOOST_CHECK_CLOSE(pos(1).y, -1.0, 1e-6);
    BOOST_CHECK_CLOSE(pos(2).x, 1.0, 1e-6);
    BOOST_CHECK_CLOSE(pos(2).y, 3.0, 1e-6);
    // Selection survives the rotation — rotating doesn't reindex.
    BOOST_CHECK(m.isAtomSelected(0));
    BOOST_CHECK(m.isAtomSelected(1));
    // Single undo step on the stack — rotate wraps moveAtomsUndoable's macro.
    BOOST_CHECK_EQUAL(stack.count(), count_before + 1);

    stack.undo();
    BOOST_CHECK_CLOSE(pos(0).x, 0.0, 1e-6);
    BOOST_CHECK_CLOSE(pos(0).y, 0.0, 1e-6);
    BOOST_CHECK_CLOSE(pos(1).x, 2.0, 1e-6);
    BOOST_CHECK_CLOSE(pos(1).y, 0.0, 1e-6);
}

BOOST_AUTO_TEST_CASE(testRotateWithNoSelectionRotatesEntireMol)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 2, 0);
    // Centroid is (1, 0). Rotate +pi/2 (CCW): (0,0) -> (1, -1), (2,0) -> (1, 1).
    m.rotateSelectedAtoms(M_PI_2);
    auto pos = [&](unsigned i) { return m.mol().getConformer().getAtomPos(i); };
    BOOST_CHECK_CLOSE(pos(0).x, 1.0, 1e-6);
    BOOST_CHECK_CLOSE(pos(0).y, -1.0, 1e-6);
    BOOST_CHECK_CLOSE(pos(1).x, 1.0, 1e-6);
    BOOST_CHECK_CLOSE(pos(1).y, 1.0, 1e-6);
}

BOOST_AUTO_TEST_CASE(testFlipHorizontalMirrorsAcrossCentroidX)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 1); // centroid x = 1
    m.addAtom("C", 2, 3);
    const auto count_before = stack.count();

    m.flipSelectedAtoms(true);
    auto pos = [&](unsigned i) { return m.mol().getConformer().getAtomPos(i); };
    // (0,1) -> (2, 1); (2, 3) -> (0, 3); Y unchanged.
    BOOST_CHECK_CLOSE(pos(0).x, 2.0, 1e-6);
    BOOST_CHECK_CLOSE(pos(0).y, 1.0, 1e-6);
    BOOST_CHECK_CLOSE(pos(1).x, 0.0, 1e-6);
    BOOST_CHECK_CLOSE(pos(1).y, 3.0, 1e-6);
    // Single undo step.
    BOOST_CHECK_EQUAL(stack.count(), count_before + 1);

    stack.undo();
    BOOST_CHECK_CLOSE(pos(0).x, 0.0, 1e-6);
    BOOST_CHECK_CLOSE(pos(1).x, 2.0, 1e-6);
}

BOOST_AUTO_TEST_CASE(testFlipVerticalMirrorsAcrossCentroidY)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 1, 0);
    m.addAtom("C", 3, 2);
    m.flipSelectedAtoms(false);
    auto pos = [&](unsigned i) { return m.mol().getConformer().getAtomPos(i); };
    // centroid y = 1; (1, 0) -> (1, 2); (3, 2) -> (3, 0).
    BOOST_CHECK_CLOSE(pos(0).x, 1.0, 1e-6);
    BOOST_CHECK_CLOSE(pos(0).y, 2.0, 1e-6);
    BOOST_CHECK_CLOSE(pos(1).x, 3.0, 1e-6);
    BOOST_CHECK_CLOSE(pos(1).y, 0.0, 1e-6);
}

BOOST_AUTO_TEST_CASE(testRotateAndFlipAreNoOpsOnEmptyMol)
{
    UndoStack stack;
    MolModel m(&stack);
    const auto count_before = stack.count();
    m.rotateSelectedAtoms(M_PI_2);
    m.flipSelectedAtoms(true);
    m.flipSelectedAtoms(false);
    BOOST_CHECK_EQUAL(stack.count(), count_before);
}

BOOST_AUTO_TEST_CASE(testPropertyCacheRefreshExposesImplicitHs)
{
    // doMutation refreshes the implicit-valence cache so callers can read
    // getTotalNumHs without sanitizing the whole mol. A bare O should
    // show two hydrogens after the cache refresh.
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("O", 0, 0);
    const auto* atom = m.mol().getAtomWithIdx(0);
    BOOST_CHECK_EQUAL(atom->getTotalNumHs(), 2);

    m.addAtom("N", 1, 0);
    const auto* nitrogen = m.mol().getAtomWithIdx(1);
    BOOST_CHECK_EQUAL(nitrogen->getTotalNumHs(), 3);

    // After bonding, the H count must update.
    m.addBond(0, 1, RDKit::Bond::SINGLE);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getTotalNumHs(), 1);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(1)->getTotalNumHs(), 2);
}

BOOST_AUTO_TEST_CASE(testAddRingBenzeneInsertsKekuleHexagon)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addRing(6, 0.0, 0.0, /*aromatic=*/true);
    BOOST_CHECK_EQUAL(m.numAtoms(), 6u);
    BOOST_CHECK_EQUAL(m.numBonds(), 6u);
    // Alternating single/double in Kekulé form: bond indices 0,2,4 single;
    // 1,3,5 double. addRing emits bonds in ring order so the index order is
    // deterministic.
    int singles = 0, doubles = 0;
    for (unsigned int i = 0; i < m.numBonds(); ++i) {
        const auto bt = m.mol().getBondWithIdx(i)->getBondType();
        if (bt == RDKit::Bond::BondType::SINGLE) ++singles;
        else if (bt == RDKit::Bond::BondType::DOUBLE) ++doubles;
    }
    BOOST_CHECK_EQUAL(singles, 3);
    BOOST_CHECK_EQUAL(doubles, 3);
    // Vertices live on a circle of bond-length-derived radius (1.5 / (2 sin
    // pi/6) = 1.5). Each atom should be ~1.5 from the center.
    for (unsigned int i = 0; i < 6; ++i) {
        double x = 0, y = 0;
        m.atomPos(i, x, y);
        BOOST_CHECK_CLOSE(std::sqrt(x * x + y * y), 1.5, 0.5);
    }
    // Undo collapses the whole ring in one step.
    stack.undo();
    BOOST_CHECK_EQUAL(m.numAtoms(), 0u);
    BOOST_CHECK_EQUAL(m.numBonds(), 0u);
}

BOOST_AUTO_TEST_CASE(testAddRingCyclohexaneIsAllSingleBonds)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addRing(6, 5.0, -2.0, /*aromatic=*/false);
    BOOST_CHECK_EQUAL(m.numBonds(), 6u);
    for (unsigned int i = 0; i < m.numBonds(); ++i) {
        BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(i)->getBondType(),
                          RDKit::Bond::BondType::SINGLE);
    }
    // Center honored — average atom position close to requested center.
    double cx = 0, cy = 0;
    for (unsigned int i = 0; i < 6; ++i) {
        double x = 0, y = 0;
        m.atomPos(i, x, y);
        cx += x;
        cy += y;
    }
    cx /= 6;
    cy /= 6;
    BOOST_CHECK_SMALL(cx - 5.0, 1e-6);
    BOOST_CHECK_SMALL(cy - (-2.0), 1e-6);
}

BOOST_AUTO_TEST_CASE(testAddRingNoOpWhenSizeTooSmall)
{
    UndoStack stack;
    MolModel m(&stack);
    const auto count = stack.count();
    m.addRing(2, 0, 0, false);
    BOOST_CHECK_EQUAL(m.numAtoms(), 0u);
    BOOST_CHECK_EQUAL(stack.count(), count);
}

BOOST_AUTO_TEST_CASE(testAdjustChargeOnSelectedAtomsAppliesDeltaAndIsUndoable)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("N", 0, 0);
    m.addAtom("O", 1, 0);
    m.addAtom("C", 2, 0);
    m.setAtomSelected(0, true);
    m.setAtomSelected(1, true);

    m.adjustChargeOnSelectedAtoms(+1);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getFormalCharge(), 1);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(1)->getFormalCharge(), 1);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(2)->getFormalCharge(), 0);

    // Selection survives — charge edits don't reindex.
    BOOST_CHECK(m.isAtomSelected(0));
    BOOST_CHECK(m.isAtomSelected(1));

    // Re-redo via undo+redo doesn't compound (charge stays +1, not +2).
    stack.undo();
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getFormalCharge(), 0);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(1)->getFormalCharge(), 0);
    stack.redo();
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getFormalCharge(), 1);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(1)->getFormalCharge(), 1);

    // Negative delta walks back through neutral into anion territory.
    m.adjustChargeOnSelectedAtoms(-2);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getFormalCharge(), -1);
}

BOOST_AUTO_TEST_CASE(testAdjustChargeNoOpWhenNothingSelectedOrDeltaZero)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("N", 0, 0);
    const auto count_before = stack.count();
    m.adjustChargeOnSelectedAtoms(+1); // nothing selected
    BOOST_CHECK_EQUAL(stack.count(), count_before);
    m.setAtomSelected(0, true);
    m.adjustChargeOnSelectedAtoms(0); // delta=0
    BOOST_CHECK_EQUAL(stack.count(), count_before);
}

BOOST_AUTO_TEST_CASE(testLoadFromSmilesReplacesMolWithCoords)
{
    UndoStack stack;
    MolModel m(&stack);
    // Pre-populate with a stray atom — load should fully replace it.
    m.addAtom("F", 99, 99);
    BOOST_CHECK_EQUAL(m.numAtoms(), 1u);

    m.loadFromSmiles("CCO");
    BOOST_CHECK_EQUAL(m.numAtoms(), 3u);
    BOOST_CHECK_EQUAL(m.numBonds(), 2u);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getSymbol(), "C");
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(1)->getSymbol(), "C");
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(2)->getSymbol(), "O");

    // compute2DCoords should have placed atoms at non-degenerate positions.
    double x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    m.atomPos(0, x0, y0);
    m.atomPos(1, x1, y1);
    BOOST_CHECK(std::abs(x0 - x1) + std::abs(y0 - y1) > 0.1);

    // Undo restores the prior single-fluorine state.
    stack.undo();
    BOOST_CHECK_EQUAL(m.numAtoms(), 1u);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getSymbol(), "F");
}

BOOST_AUTO_TEST_CASE(testLoadFromSmilesThrowsOnGarbage)
{
    UndoStack stack;
    MolModel m(&stack);
    BOOST_CHECK_THROW(m.loadFromSmiles("not a smiles!!!"),
                      std::invalid_argument);
    // Failure must leave the model untouched and not push an undo step.
    BOOST_CHECK(m.isEmpty());
    BOOST_CHECK_EQUAL(stack.count(), 0u);
}

BOOST_AUTO_TEST_CASE(testToSmilesEmpty)
{
    UndoStack stack;
    MolModel m(&stack);
    BOOST_CHECK_EQUAL(m.toSmiles(), "");
}

BOOST_AUTO_TEST_CASE(testToSmilesRoundTripsBenzene)
{
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("c1ccccc1");
    const auto out = m.toSmiles();
    // Canonical form is c1ccccc1 (lowercase aromatic).
    BOOST_CHECK_EQUAL(out, "c1ccccc1");
}

BOOST_AUTO_TEST_CASE(testToSmilesIncludesFormalCharge)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("N", 0, 0);
    m.addAtom("H", 1.0, 0);
    m.addAtom("H", 0, 1.0);
    m.addAtom("H", -1.0, 0);
    m.addAtom("H", 0, -1.0);
    m.addBond(0, 1);
    m.addBond(0, 2);
    m.addBond(0, 3);
    m.addBond(0, 4);
    m.setAtomSelected(0, true);
    m.adjustChargeOnSelectedAtoms(+1); // NH4+
    const auto out = m.toSmiles();
    // [NH4+] is the canonical form for ammonium when written from atoms.
    BOOST_CHECK(out.find("NH4+") != std::string::npos ||
                out.find("N+") != std::string::npos);
}

BOOST_AUTO_TEST_CASE(testToMolBlockEmpty)
{
    UndoStack stack;
    MolModel m(&stack);
    BOOST_CHECK_EQUAL(m.toMolBlock(/*v3000=*/false), "");
    BOOST_CHECK_EQUAL(m.toMolBlock(/*v3000=*/true), "");
}

BOOST_AUTO_TEST_CASE(testToMolBlockV2000HasMatchingCountsLine)
{
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("CCO");
    const auto mb = m.toMolBlock(/*v3000=*/false);
    // V2000 counts line is "  3  2  0  0  0  0  0  0  0  0999 V2000".
    BOOST_CHECK(mb.find("V2000") != std::string::npos);
    BOOST_CHECK(mb.find("  3  2") != std::string::npos);
}

BOOST_AUTO_TEST_CASE(testToMolBlockV3000HasV3000Tag)
{
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("CCO");
    const auto mb = m.toMolBlock(/*v3000=*/true);
    BOOST_CHECK(mb.find("V3000") != std::string::npos);
    BOOST_CHECK(mb.find("M  V30 COUNTS 3 2") != std::string::npos);
}

BOOST_AUTO_TEST_CASE(testLoadFromTextRoundTripsMolBlock)
{
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("CCO");
    const auto mb = m.toMolBlock(/*v3000=*/false);

    UndoStack stack2;
    MolModel m2(&stack2);
    m2.loadFromText(mb);
    BOOST_CHECK_EQUAL(m2.numAtoms(), 3u);
    BOOST_CHECK_EQUAL(m2.numBonds(), 2u);
    // Round-trip preserves canonical SMILES (the MOL block carries enough
    // structure to recover the same canonical form).
    BOOST_CHECK_EQUAL(m2.toSmiles(), m.toSmiles());
}

BOOST_AUTO_TEST_CASE(testLoadFromTextAlsoAcceptsSmiles)
{
    UndoStack stack;
    MolModel m(&stack);
    // AUTO_DETECT routes a SMILES-shaped string through the SMILES parser.
    m.loadFromText("c1ccncc1"); // pyridine
    BOOST_CHECK_EQUAL(m.numAtoms(), 6u);
    BOOST_CHECK_EQUAL(m.numBonds(), 6u);
    // Aromatic pyridine: one of the atoms is N.
    bool found_n = false;
    for (unsigned int i = 0; i < m.numAtoms(); ++i) {
        if (m.mol().getAtomWithIdx(i)->getSymbol() == "N") {
            found_n = true;
            break;
        }
    }
    BOOST_CHECK(found_n);
}

BOOST_AUTO_TEST_CASE(testLoadFromTextThrowsOnGarbage)
{
    UndoStack stack;
    MolModel m(&stack);
    BOOST_CHECK_THROW(m.loadFromText("definitely not a molecule"),
                      std::invalid_argument);
    BOOST_CHECK(m.isEmpty());
    BOOST_CHECK_EQUAL(stack.count(), 0u);
}

BOOST_AUTO_TEST_CASE(testLoadFromTextPreservesMolBlockCoords)
{
    UndoStack stack;
    MolModel m(&stack);
    // Hand-crafted V2000 block: two atoms placed at (10, 20) and (15, 25)
    // — way outside what compute2DCoords would generate, so we can detect
    // whether the coords survived the load.
    const std::string mb =
        "test\n"
        "     RDKit          2D\n"
        "\n"
        "  2  1  0  0  0  0  0  0  0  0999 V2000\n"
        "   10.0000   20.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0\n"
        "   15.0000   25.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0\n"
        "  1  2  1  0\n"
        "M  END\n";
    m.loadFromText(mb);
    BOOST_CHECK_EQUAL(m.numAtoms(), 2u);
    double x = 0, y = 0;
    m.atomPos(0, x, y);
    BOOST_CHECK_CLOSE(x, 10.0, 1e-3);
    BOOST_CHECK_CLOSE(y, 20.0, 1e-3);
    m.atomPos(1, x, y);
    BOOST_CHECK_CLOSE(x, 15.0, 1e-3);
    BOOST_CHECK_CLOSE(y, 25.0, 1e-3);
}

BOOST_AUTO_TEST_CASE(testAddHydrogensPromotesImplicitToExplicit)
{
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("C"); // methane — one heavy atom + four implicit Hs
    BOOST_CHECK_EQUAL(m.numAtoms(), 1u);

    m.addHydrogens();
    BOOST_CHECK_EQUAL(m.numAtoms(), 5u);
    BOOST_CHECK_EQUAL(m.numBonds(), 4u);
    // Every new atom is an H, bonded back to the carbon.
    unsigned int h_count = 0;
    for (unsigned int i = 0; i < m.numAtoms(); ++i) {
        if (m.mol().getAtomWithIdx(i)->getSymbol() == "H") {
            ++h_count;
        }
    }
    BOOST_CHECK_EQUAL(h_count, 4u);

    // Undo restores the implicit-H form.
    stack.undo();
    BOOST_CHECK_EQUAL(m.numAtoms(), 1u);
}

BOOST_AUTO_TEST_CASE(testRemoveHydrogensRoundTripsAddHydrogens)
{
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("CCO"); // ethanol: 3 heavies, 6 implicit Hs
    BOOST_CHECK_EQUAL(m.numAtoms(), 3u);

    m.addHydrogens();
    BOOST_CHECK_EQUAL(m.numAtoms(), 9u); // 3 heavies + 6 Hs

    m.removeHydrogens();
    BOOST_CHECK_EQUAL(m.numAtoms(), 3u);
    BOOST_CHECK_EQUAL(m.toSmiles(), "CCO");
}

BOOST_AUTO_TEST_CASE(testAddHydrogensIsNoOpOnEmptyMol)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addHydrogens();
    BOOST_CHECK_EQUAL(m.numAtoms(), 0u);
    // No-op should not push an undo command.
    BOOST_CHECK_EQUAL(stack.count(), 0u);
}

BOOST_AUTO_TEST_CASE(testRemoveHydrogensIsNoOpOnEmptyMol)
{
    UndoStack stack;
    MolModel m(&stack);
    m.removeHydrogens();
    BOOST_CHECK_EQUAL(m.numAtoms(), 0u);
    BOOST_CHECK_EQUAL(stack.count(), 0u);
}

BOOST_AUTO_TEST_CASE(testKekulizeBenzeneReplacesAromaticWithExplicitDoubles)
{
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("c1ccccc1"); // arrives aromatic from the SMILES parser
    // Sanity: every bond is aromatic up front.
    for (unsigned int i = 0; i < m.numBonds(); ++i) {
        BOOST_CHECK(m.mol().getBondWithIdx(i)->getIsAromatic());
    }

    m.kekulize();

    // After kekulize: 3 SINGLE + 3 DOUBLE bonds, no aromatic flag.
    unsigned int singles = 0, doubles = 0;
    for (unsigned int i = 0; i < m.numBonds(); ++i) {
        const auto* b = m.mol().getBondWithIdx(i);
        BOOST_CHECK(!b->getIsAromatic());
        if (b->getBondType() == RDKit::Bond::BondType::SINGLE) {
            ++singles;
        } else if (b->getBondType() == RDKit::Bond::BondType::DOUBLE) {
            ++doubles;
        }
    }
    BOOST_CHECK_EQUAL(singles, 3u);
    BOOST_CHECK_EQUAL(doubles, 3u);

    // Atom arom flag is also cleared.
    for (unsigned int i = 0; i < m.numAtoms(); ++i) {
        BOOST_CHECK(!m.mol().getAtomWithIdx(i)->getIsAromatic());
    }
}

BOOST_AUTO_TEST_CASE(testAromatizeBenzeneSetsAromaticFlag)
{
    UndoStack stack;
    MolModel m(&stack);
    // Start from a kekulized benzene laid out via addRing(aromatic=true),
    // which builds explicit SINGLE/DOUBLE bonds without aromatic perception.
    m.addRing(6, /*cx=*/0.0, /*cy=*/0.0, /*aromatic=*/true);
    // Up front: no aromatic flags (addRing builds Kekulé form).
    for (unsigned int i = 0; i < m.numBonds(); ++i) {
        BOOST_CHECK(!m.mol().getBondWithIdx(i)->getIsAromatic());
    }

    m.aromatize();

    // After aromatize: every bond + atom carries the aromatic flag.
    for (unsigned int i = 0; i < m.numBonds(); ++i) {
        BOOST_CHECK(m.mol().getBondWithIdx(i)->getIsAromatic());
    }
    for (unsigned int i = 0; i < m.numAtoms(); ++i) {
        BOOST_CHECK(m.mol().getAtomWithIdx(i)->getIsAromatic());
    }
}

BOOST_AUTO_TEST_CASE(testAromatizeKekulizeRoundTripsThroughUndo)
{
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("c1ccccc1");
    const std::string before = m.toSmiles();

    m.kekulize();
    m.aromatize();
    // Canonical SMILES is stable under aromatize-after-kekulize.
    BOOST_CHECK_EQUAL(m.toSmiles(), before);

    // Undo the aromatize → kekulé form; undo the kekulize → original aromatic.
    stack.undo();
    bool any_arom_after_undo_aromatize = false;
    for (unsigned int i = 0; i < m.numBonds(); ++i) {
        if (m.mol().getBondWithIdx(i)->getIsAromatic()) {
            any_arom_after_undo_aromatize = true;
            break;
        }
    }
    BOOST_CHECK(!any_arom_after_undo_aromatize);

    stack.undo();
    BOOST_CHECK_EQUAL(m.toSmiles(), before);
}

BOOST_AUTO_TEST_CASE(testAromatizeAndKekulizeAreNoOpOnEmptyMol)
{
    UndoStack stack;
    MolModel m(&stack);
    m.aromatize();
    m.kekulize();
    BOOST_CHECK_EQUAL(m.numAtoms(), 0u);
    BOOST_CHECK_EQUAL(stack.count(), 0u);
}

BOOST_AUTO_TEST_CASE(testMoveAtomsUndoableTranslatesMultipleAtomsAsOneUndoStep)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0.0, 0.0);
    m.addAtom("C", 1.0, 0.0);
    m.addAtom("C", 0.0, 1.0);
    const auto stack_before = stack.count();

    // Translate atoms 0 and 1 by (+10, +20); leave atom 2 alone.
    m.moveAtomsUndoable(/*indices=*/{0u, 1u},
                        /*from_xs=*/{0.0, 1.0},
                        /*from_ys=*/{0.0, 0.0},
                        /*to_xs=*/{10.0, 11.0},
                        /*to_ys=*/{20.0, 20.0});

    // Exactly one macro command was pushed (not two).
    BOOST_CHECK_EQUAL(stack.count(), stack_before + 1);

    double x = 0, y = 0;
    m.atomPos(0, x, y);
    BOOST_CHECK_CLOSE(x, 10.0, 1e-6);
    BOOST_CHECK_CLOSE(y, 20.0, 1e-6);
    m.atomPos(1, x, y);
    BOOST_CHECK_CLOSE(x, 11.0, 1e-6);
    BOOST_CHECK_CLOSE(y, 20.0, 1e-6);
    m.atomPos(2, x, y);
    BOOST_CHECK_CLOSE(x, 0.0, 1e-6);
    BOOST_CHECK_CLOSE(y, 1.0, 1e-6);

    // Single undo restores both atoms.
    stack.undo();
    m.atomPos(0, x, y);
    BOOST_CHECK_CLOSE(x, 0.0, 1e-6);
    BOOST_CHECK_CLOSE(y, 0.0, 1e-6);
    m.atomPos(1, x, y);
    BOOST_CHECK_CLOSE(x, 1.0, 1e-6);
    BOOST_CHECK_CLOSE(y, 0.0, 1e-6);
}

BOOST_AUTO_TEST_CASE(testMoveAtomsUndoableIsNoOpOnEmptyAndMismatchedArrays)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0.0, 0.0);
    const auto stack_before = stack.count();
    m.moveAtomsUndoable({}, {}, {}, {}, {});
    BOOST_CHECK_EQUAL(stack.count(), stack_before);

    // Mismatched array lengths: silent no-op (defensive against JS bridge
    // bugs — better than throwing across the embind boundary).
    m.moveAtomsUndoable({0u}, {0.0, 1.0}, {0.0}, {1.0}, {1.0});
    BOOST_CHECK_EQUAL(stack.count(), stack_before);
    double x = 0, y = 0;
    m.atomPos(0, x, y);
    BOOST_CHECK_CLOSE(x, 0.0, 1e-6);
    BOOST_CHECK_CLOSE(y, 0.0, 1e-6);
}

BOOST_AUTO_TEST_CASE(testCleanUpRecomputesCoordsAndIsUndoable)
{
    UndoStack stack;
    MolModel m(&stack);
    // Three carbons stacked nearly on top of each other — degenerate layout
    // that compute2DCoords will redistribute. Two bonds keep them connected
    // so the depictor actually moves them apart.
    m.addAtom("C", 0.0, 0.0);
    m.addAtom("C", 0.01, 0.0);
    m.addAtom("C", 0.0, 0.01);
    m.addBond(0, 1);
    m.addBond(1, 2);

    double x0_before = 0, y0_before = 0, x1_before = 0, y1_before = 0;
    m.atomPos(0, x0_before, y0_before);
    m.atomPos(1, x1_before, y1_before);
    const auto stack_before = stack.count();

    m.cleanUp();
    BOOST_CHECK_EQUAL(stack.count(), stack_before + 1);

    // After clean-up the two bonded atoms must be a non-trivial distance
    // apart (depictor uses ~1.5 unit bond length).
    double x0_after = 0, y0_after = 0, x1_after = 0, y1_after = 0;
    m.atomPos(0, x0_after, y0_after);
    m.atomPos(1, x1_after, y1_after);
    const double dist = std::hypot(x1_after - x0_after, y1_after - y0_after);
    BOOST_CHECK_GT(dist, 1.0);

    // Single undo restores the original degenerate coords.
    stack.undo();
    double x0_undo = 0, y0_undo = 0;
    m.atomPos(0, x0_undo, y0_undo);
    BOOST_CHECK_CLOSE(x0_undo, x0_before, 1e-6);
    BOOST_CHECK_CLOSE(y0_undo, y0_before, 1e-6);
}

BOOST_AUTO_TEST_CASE(testCleanUpIsNoOpOnEmptyMol)
{
    UndoStack stack;
    MolModel m(&stack);
    m.cleanUp();
    BOOST_CHECK_EQUAL(m.numAtoms(), 0u);
    BOOST_CHECK_EQUAL(stack.count(), 0u);
}
