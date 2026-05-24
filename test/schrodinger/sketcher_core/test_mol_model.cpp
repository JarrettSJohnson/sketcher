/* -------------------------------------------------------------------------
 * Tests for schrodinger::sketcher_core::MolModel — the Qt-free skeleton
 * domain model used by the Phase 0 spike.
 *
 * Copyright Schrodinger LLC, All Rights Reserved.
 --------------------------------------------------------------------------- */

#define BOOST_TEST_MODULE sketcher_core_mol_model

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
