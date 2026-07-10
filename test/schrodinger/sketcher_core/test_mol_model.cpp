/* -------------------------------------------------------------------------
 * Tests for schrodinger::sketcher_core::MolModel — the Qt-free skeleton
 * domain model used by the Phase 0 spike.
 *
 * Copyright Schrodinger LLC, All Rights Reserved.
 --------------------------------------------------------------------------- */

#define BOOST_TEST_MODULE sketcher_core_mol_model

#include <cmath>
#include <iostream>
#include <vector>

#include <boost/test/unit_test.hpp>

#include <stdexcept>

#include <GraphMol/Atom.h>
#include <GraphMol/Bond.h>
#include <GraphMol/MonomerInfo.h>
#include <GraphMol/SubstanceGroup.h>

#include "schrodinger/rdkit_extensions/helm.h"
#include "schrodinger/rdkit_extensions/monomer_database.h"
#include "schrodinger/rdkit_extensions/monomer_mol.h"
#include "schrodinger/sketcher_core/mol_model.h"
#include "schrodinger/sketcher_core/undo_stack.h"

using schrodinger::sketcher_core::MolModel;
using schrodinger::sketcher_core::UndoStack;
using schrodinger::sketcher_core::WILDCARD_LABEL_PROP;
using schrodinger::sketcher_core::BOND_QUERY_LABEL_PROP;
using schrodinger::sketcher_core::BOND_TOPOLOGY_PROP;

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

BOOST_AUTO_TEST_CASE(testSetBondTypeUndoableRoundTripsAndPreservesSelection)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1, 0);
    m.addBond(0, 1, RDKit::Bond::TRIPLE);
    // Select the bond before the type edit; selection must survive.
    m.setBondSelected(0, true);

    m.setBondTypeUndoable(0, 1, RDKit::Bond::DOUBLE);
    BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(0)->getBondType(),
                      RDKit::Bond::DOUBLE);
    BOOST_CHECK(m.isBondSelected(0));

    m.setBondTypeUndoable(0, 1, RDKit::Bond::SINGLE);
    BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(0)->getBondType(),
                      RDKit::Bond::SINGLE);
    BOOST_CHECK(m.isBondSelected(0));

    stack.undo();
    BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(0)->getBondType(),
                      RDKit::Bond::DOUBLE);
    stack.undo();
    BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(0)->getBondType(),
                      RDKit::Bond::TRIPLE);
}

BOOST_AUTO_TEST_CASE(testSetBondTypeForSelectedBondsAppliesAsSingleUndoStep)
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

    m.setBondTypeForSelectedBonds(RDKit::Bond::DOUBLE);
    BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(0)->getBondType(),
                      RDKit::Bond::DOUBLE);
    BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(1)->getBondType(),
                      RDKit::Bond::DOUBLE);
    // Selection survives bond-type edits (no reindexing).
    BOOST_CHECK(m.isBondSelected(0));
    BOOST_CHECK(m.isBondSelected(1));

    // Single undo step rolls back both bonds together (one macro).
    stack.undo();
    BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(0)->getBondType(),
                      RDKit::Bond::SINGLE);
    BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(1)->getBondType(),
                      RDKit::Bond::SINGLE);
}

BOOST_AUTO_TEST_CASE(testSetBondTypeForSelectedBondsNoOpOnEmptySelection)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1, 0);
    m.addBond(0, 1, RDKit::Bond::SINGLE);
    const auto count_before = stack.count();
    m.setBondTypeForSelectedBonds(RDKit::Bond::DOUBLE);
    BOOST_CHECK_EQUAL(stack.count(), count_before);
    BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(0)->getBondType(),
                      RDKit::Bond::SINGLE);
}

BOOST_AUTO_TEST_CASE(testSetBondTypeAndDirUndoableCollapsesToOneUndoStep)
{
    // Backs the bond / selection context menu's "Other Type" items
    // (Coordinate / Zero Order / Single Up/Down / Double Cis/Trans). Picking
    // any of those must replace both BondType and BondDir in one undo step so
    // Ctrl+Z restores the bond fully in a single press — mirrors Qt's
    // `MolModel::mutateBonds` (model/mol_model.cpp:2288).
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1, 0);
    m.addBond(0, 1, RDKit::Bond::DOUBLE);
    const auto count_before = stack.count();
    m.setBondTypeAndDirUndoable(0, 1, RDKit::Bond::SINGLE,
                                RDKit::Bond::BondDir::UNKNOWN);
    BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(0)->getBondType(),
                      RDKit::Bond::SINGLE);
    BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(0)->getBondDir(),
                      RDKit::Bond::BondDir::UNKNOWN);
    // The macro registers one entry on the undo stack regardless of the
    // two underlying setBondType / setBondDir commands inside it.
    BOOST_CHECK_EQUAL(stack.count(), count_before + 1);
    stack.undo();
    BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(0)->getBondType(),
                      RDKit::Bond::DOUBLE);
    BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(0)->getBondDir(),
                      RDKit::Bond::BondDir::NONE);
}

BOOST_AUTO_TEST_CASE(testSetBondTypeAndDirUndoableNoOpsWhenBondMissing)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1, 0);
    m.addBond(0, 1, RDKit::Bond::SINGLE);
    const auto count_before = stack.count();
    m.setBondTypeAndDirUndoable(0, 5, RDKit::Bond::DOUBLE,
                                RDKit::Bond::BondDir::EITHERDOUBLE);
    BOOST_CHECK_EQUAL(stack.count(), count_before);
}

BOOST_AUTO_TEST_CASE(
    testSetBondTypeAndDirForSelectedBondsCollapsesToOneUndoStep)
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
    const auto count_before = stack.count();
    m.setBondTypeAndDirForSelectedBonds(RDKit::Bond::DOUBLE,
                                        RDKit::Bond::BondDir::EITHERDOUBLE);
    for (unsigned i = 0; i < 2; ++i) {
        BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(i)->getBondType(),
                          RDKit::Bond::DOUBLE);
        BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(i)->getBondDir(),
                          RDKit::Bond::BondDir::EITHERDOUBLE);
    }
    BOOST_CHECK_EQUAL(stack.count(), count_before + 1);
    stack.undo();
    for (unsigned i = 0; i < 2; ++i) {
        BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(i)->getBondType(),
                          RDKit::Bond::SINGLE);
        BOOST_CHECK_EQUAL(m.mol().getBondWithIdx(i)->getBondDir(),
                          RDKit::Bond::BondDir::NONE);
    }
}

BOOST_AUTO_TEST_CASE(testSetBondTypeAndDirForSelectedBondsNoOpOnEmptySelection)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1, 0);
    m.addBond(0, 1, RDKit::Bond::SINGLE);
    const auto count_before = stack.count();
    m.setBondTypeAndDirForSelectedBonds(RDKit::Bond::DOUBLE,
                                        RDKit::Bond::BondDir::EITHERDOUBLE);
    BOOST_CHECK_EQUAL(stack.count(), count_before);
}

BOOST_AUTO_TEST_CASE(testMutateBondToQueryMakesQueryBondWithBaseTypeAndLabel)
{
    // C-C single bond → "S/D" query. The bond becomes a query bond drawn at
    // its base order (SINGLE), carrying the display label; undo restores the
    // plain single bond.
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);
    m.addBond(0, 1, RDKit::Bond::SINGLE);

    m.mutateBondToQuery(0, 1, "S/D");
    const auto* qb = m.mol().getBondBetweenAtoms(0, 1);
    BOOST_CHECK(qb->hasQuery());
    std::string label;
    BOOST_CHECK(qb->getPropIfPresent(BOND_QUERY_LABEL_PROP, label));
    BOOST_CHECK_EQUAL(label, "S/D");
    // Base type is SINGLE so it draws as a single line.
    BOOST_CHECK_EQUAL(qb->getBondType(), RDKit::Bond::SINGLE);

    stack.undo();
    const auto* plain = m.mol().getBondBetweenAtoms(0, 1);
    BOOST_CHECK(!plain->hasQuery());
    BOOST_CHECK_EQUAL(plain->getBondType(), RDKit::Bond::SINGLE);
    BOOST_CHECK(!plain->hasProp(BOND_QUERY_LABEL_PROP));
}

BOOST_AUTO_TEST_CASE(testMutateBondToQueryDoubleAromaticUsesDoubleBaseType)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);
    m.addBond(0, 1, RDKit::Bond::SINGLE);
    m.mutateBondToQuery(0, 1, "D/A");
    const auto* qb = m.mol().getBondBetweenAtoms(0, 1);
    BOOST_CHECK_EQUAL(qb->getBondType(), RDKit::Bond::DOUBLE);
    std::string label;
    BOOST_CHECK(qb->getPropIfPresent(BOND_QUERY_LABEL_PROP, label));
    BOOST_CHECK_EQUAL(label, "D/A");
}

BOOST_AUTO_TEST_CASE(testMutateBondToQueryNoOpsOnBadLabelOrMissingBond)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);
    m.addBond(0, 1, RDKit::Bond::SINGLE);
    const auto count_before = stack.count();
    m.mutateBondToQuery(0, 1, "ZZ"); // bad label → no-op
    BOOST_CHECK_EQUAL(stack.count(), count_before);
    m.mutateBondToQuery(0, 5, "Any"); // missing bond → no-op
    BOOST_CHECK_EQUAL(stack.count(), count_before);
    BOOST_CHECK(!m.mol().getBondBetweenAtoms(0, 1)->hasQuery());
}

BOOST_AUTO_TEST_CASE(testAddQueryBondBetweenAtomsCreatesQueryBondInOneStep)
{
    // Two unbonded atoms; the bond-query tool completes a gesture between them
    // → a query bond appears in one undo step.
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);
    const auto count_before = stack.count();
    m.addQueryBondBetweenAtoms(0, 1, "S/A");
    const auto* qb = m.mol().getBondBetweenAtoms(0, 1);
    BOOST_REQUIRE(qb != nullptr);
    BOOST_CHECK(qb->hasQuery());
    std::string label;
    BOOST_CHECK(qb->getPropIfPresent(BOND_QUERY_LABEL_PROP, label));
    BOOST_CHECK_EQUAL(label, "S/A");
    BOOST_CHECK_EQUAL(stack.count(), count_before + 1);
    stack.undo();
    BOOST_CHECK(m.mol().getBondBetweenAtoms(0, 1) == nullptr);
}

BOOST_AUTO_TEST_CASE(testAddQueryBondBetweenAtomsAromaticUsesRealType)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);
    m.addQueryBondBetweenAtoms(0, 1, "aromatic");
    const auto* b = m.mol().getBondBetweenAtoms(0, 1);
    BOOST_REQUIRE(b != nullptr);
    BOOST_CHECK(!b->hasQuery()); // aromatic is a real type, not a query
    BOOST_CHECK_EQUAL(b->getBondType(), RDKit::Bond::AROMATIC);
}

BOOST_AUTO_TEST_CASE(testAddQueryBondBetweenAtomsConvertsExistingBond)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);
    m.addBond(0, 1, RDKit::Bond::SINGLE);
    const auto bonds_before = m.mol().getNumBonds();
    m.addQueryBondBetweenAtoms(0, 1, "Any");
    // No duplicate bond — the existing one is converted.
    BOOST_CHECK_EQUAL(m.mol().getNumBonds(), bonds_before);
    BOOST_CHECK(m.mol().getBondBetweenAtoms(0, 1)->hasQuery());
}

BOOST_AUTO_TEST_CASE(testAddQueryBondBetweenAtomsNoOpsOnBadInput)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);
    const auto count_before = stack.count();
    m.addQueryBondBetweenAtoms(0, 0, "Any");  // same atom
    m.addQueryBondBetweenAtoms(0, 9, "Any");  // out of range
    m.addQueryBondBetweenAtoms(0, 1, "ZZ");   // bad label
    BOOST_CHECK_EQUAL(stack.count(), count_before);
    BOOST_CHECK(m.mol().getBondBetweenAtoms(0, 1) == nullptr);
}

BOOST_AUTO_TEST_CASE(testSetBondTopologyInRingAddsRingQueryAndLabel)
{
    // Plain single bond → In Ring. Becomes a query bond carrying the topology
    // prop; undo restores the plain bond.
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);
    m.addBond(0, 1, RDKit::Bond::SINGLE);
    m.setBondTopologyForBond(0, 1, "ring");
    const auto* b = m.mol().getBondBetweenAtoms(0, 1);
    BOOST_CHECK(b->hasQuery());
    std::string topo;
    BOOST_CHECK(b->getPropIfPresent(BOND_TOPOLOGY_PROP, topo));
    BOOST_CHECK_EQUAL(topo, "ring");
    BOOST_CHECK_EQUAL(b->getBondType(), RDKit::Bond::SINGLE); // base kept
    stack.undo();
    const auto* plain = m.mol().getBondBetweenAtoms(0, 1);
    BOOST_CHECK(!plain->hasQuery());
    BOOST_CHECK(!plain->hasProp(BOND_TOPOLOGY_PROP));
}

BOOST_AUTO_TEST_CASE(testSetBondTopologyEitherClearsConstraint)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);
    m.addBond(0, 1, RDKit::Bond::SINGLE);
    m.setBondTopologyForBond(0, 1, "notring");
    BOOST_CHECK(m.mol().getBondBetweenAtoms(0, 1)->hasProp(BOND_TOPOLOGY_PROP));
    // Clearing to "either" drops the constraint and reverts to a plain bond.
    m.setBondTopologyForBond(0, 1, "either");
    const auto* b = m.mol().getBondBetweenAtoms(0, 1);
    BOOST_CHECK(!b->hasProp(BOND_TOPOLOGY_PROP));
    BOOST_CHECK(!b->hasQuery());
    BOOST_CHECK_EQUAL(b->getBondType(), RDKit::Bond::SINGLE);
}

BOOST_AUTO_TEST_CASE(testSetBondTopologyKeepsExistingQueryLabel)
{
    // A bond that already carries a query type (S/D) keeps it when topology is
    // added — both the query label and the topology prop survive.
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);
    m.addBond(0, 1, RDKit::Bond::SINGLE);
    m.mutateBondToQuery(0, 1, "S/D");
    m.setBondTopologyForBond(0, 1, "ring");
    const auto* b = m.mol().getBondBetweenAtoms(0, 1);
    std::string qlabel, topo;
    BOOST_CHECK(b->getPropIfPresent(BOND_QUERY_LABEL_PROP, qlabel));
    BOOST_CHECK_EQUAL(qlabel, "S/D");
    BOOST_CHECK(b->getPropIfPresent(BOND_TOPOLOGY_PROP, topo));
    BOOST_CHECK_EQUAL(topo, "ring");
    // Clearing topology keeps the query label.
    m.setBondTopologyForBond(0, 1, "either");
    const auto* b2 = m.mol().getBondBetweenAtoms(0, 1);
    BOOST_CHECK(b2->getPropIfPresent(BOND_QUERY_LABEL_PROP, qlabel));
    BOOST_CHECK_EQUAL(qlabel, "S/D");
    BOOST_CHECK(!b2->hasProp(BOND_TOPOLOGY_PROP));
}

BOOST_AUTO_TEST_CASE(testSetBondTopologyNoOpsOnBadInput)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);
    m.addBond(0, 1, RDKit::Bond::SINGLE);
    const auto count_before = stack.count();
    m.setBondTopologyForBond(0, 1, "sideways"); // bad topology
    m.setBondTopologyForBond(0, 9, "ring");     // missing bond
    BOOST_CHECK_EQUAL(stack.count(), count_before);
}

BOOST_AUTO_TEST_CASE(testSetSelectedBondsTopologyAppliesAsOneUndoStep)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);
    m.addAtom("C", 3.0, 0);
    m.addBond(0, 1, RDKit::Bond::SINGLE);
    m.addBond(1, 2, RDKit::Bond::SINGLE);
    m.setBondSelected(0, true);
    m.setBondSelected(1, true);
    const auto count_before = stack.count();
    m.setSelectedBondsTopology("ring");
    BOOST_CHECK(m.mol().getBondWithIdx(0)->hasProp(BOND_TOPOLOGY_PROP));
    BOOST_CHECK(m.mol().getBondWithIdx(1)->hasProp(BOND_TOPOLOGY_PROP));
    BOOST_CHECK_EQUAL(stack.count(), count_before + 1);
    stack.undo();
    BOOST_CHECK(!m.mol().getBondWithIdx(0)->hasProp(BOND_TOPOLOGY_PROP));
    BOOST_CHECK(!m.mol().getBondWithIdx(1)->hasProp(BOND_TOPOLOGY_PROP));
}

BOOST_AUTO_TEST_CASE(testMutateSelectedBondsToQueryAppliesAsOneUndoStep)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);
    m.addAtom("C", 3.0, 0);
    m.addBond(0, 1, RDKit::Bond::SINGLE);
    m.addBond(1, 2, RDKit::Bond::SINGLE);
    m.setBondSelected(0, true);
    m.setBondSelected(1, true);
    const auto count_before = stack.count();
    m.mutateSelectedBondsToQuery("Any");
    BOOST_CHECK(m.mol().getBondWithIdx(0)->hasQuery());
    BOOST_CHECK(m.mol().getBondWithIdx(1)->hasQuery());
    // One macro step for the whole selection.
    BOOST_CHECK_EQUAL(stack.count(), count_before + 1);
    stack.undo();
    BOOST_CHECK(!m.mol().getBondWithIdx(0)->hasQuery());
    BOOST_CHECK(!m.mol().getBondWithIdx(1)->hasQuery());
}

BOOST_AUTO_TEST_CASE(testSetBondTypeNoOpsWhenBondMissingOrUnchanged)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1, 0);
    m.addBond(0, 1, RDKit::Bond::DOUBLE);
    const auto count_before = stack.count();

    // Same type → no command pushed.
    m.setBondTypeUndoable(0, 1, RDKit::Bond::DOUBLE);
    BOOST_CHECK_EQUAL(stack.count(), count_before);

    // Nonexistent bond → no command pushed.
    m.setBondTypeUndoable(0, 5, RDKit::Bond::SINGLE);
    BOOST_CHECK_EQUAL(stack.count(), count_before);
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

BOOST_AUTO_TEST_CASE(testFlipSubstituentReflectsSmallerSideAcrossBondAxis)
{
    // Linear chain C0-C1-C2-C3 laid out on the x-axis with a kink: put C3
    // above the axis so flipping the smaller substituent across the C1-C2
    // bond (the x-axis here) mirrors its y-coordinate. Removing C1-C2 splits
    // the mol into {C0,C1} and {C2,C3}; both are size 2, so substituents[0]
    // (the {C0,C1} side, whichever getMolFrags returns first) is picked as
    // "smaller" on the tie. To make the smaller side deterministic, hang an
    // extra atom off C2 so the C2 side is strictly larger and the C0/C1 side
    // is flipped.
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 1);   // 0 — above axis, on the smaller side
    m.addAtom("C", 1, 0);   // 1 — on the C1-C2 bond axis
    m.addAtom("C", 2, 0);   // 2 — on the axis
    m.addAtom("C", 3, 0);   // 3 — larger side
    m.addAtom("C", 4, 0);   // 4 — larger side
    m.addBond(0, 1, RDKit::Bond::SINGLE);
    m.addBond(1, 2, RDKit::Bond::SINGLE); // the bond we flip across
    m.addBond(2, 3, RDKit::Bond::SINGLE);
    m.addBond(3, 4, RDKit::Bond::SINGLE);

    // Bond axis is the line through C1(1,0) and C2(2,0) — the x-axis. The
    // smaller substituent {C0,C1} reflects across it: C0 y: 1 → -1, C1 stays
    // on the axis.
    m.flipSubstituentAroundBond(1, 2);
    const auto& conf = m.mol().getConformer();
    BOOST_CHECK_CLOSE(conf.getAtomPos(0).y, -1.0, 1e-6);
    BOOST_CHECK_CLOSE(conf.getAtomPos(0).x, 0.0, 1e-6);
    // C1 sits on the axis, unchanged.
    BOOST_CHECK_CLOSE(conf.getAtomPos(1).y, 0.0, 1e-6);
    // Larger side untouched.
    BOOST_CHECK_CLOSE(conf.getAtomPos(3).x, 3.0, 1e-6);
    BOOST_CHECK_CLOSE(conf.getAtomPos(4).x, 4.0, 1e-6);

    // Single undo restores C0 above the axis.
    stack.undo();
    BOOST_CHECK_CLOSE(m.mol().getConformer().getAtomPos(0).y, 1.0, 1e-6);
}

BOOST_AUTO_TEST_CASE(testFlipSubstituentNoOpOnRingBond)
{
    // A 3-membered ring: removing any bond leaves the mol connected, so
    // there aren't two substituents and the flip is a no-op (nothing pushed
    // onto the undo stack).
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1, 0);
    m.addAtom("C", 0.5, 1);
    m.addBond(0, 1, RDKit::Bond::SINGLE);
    m.addBond(1, 2, RDKit::Bond::SINGLE);
    m.addBond(2, 0, RDKit::Bond::SINGLE);
    const auto count_before = stack.count();
    m.flipSubstituentAroundBond(0, 1);
    BOOST_CHECK_EQUAL(stack.count(), count_before);
    // Coordinates unchanged.
    BOOST_CHECK_CLOSE(m.mol().getConformer().getAtomPos(2).y, 1.0, 1e-6);
}

BOOST_AUTO_TEST_CASE(testFlipSubstituentNoOpWhenBondMissing)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1, 0);
    // No bond between 0 and 1.
    const auto count_before = stack.count();
    m.flipSubstituentAroundBond(0, 1);
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

BOOST_AUTO_TEST_CASE(testSetAtomElementSwapsAtomicNumAndIsUndoable)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    // Charge + explicit-H state on the original atom — set element resets
    // both to the new element's defaults (mirrors Qt mutateAtoms semantics).
    m.setAtomSelected(0, true);
    m.adjustChargeOnSelectedAtoms(+1);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getAtomicNum(), 6);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getFormalCharge(), 1);

    m.setAtomElement(0, 7); // C → N
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getAtomicNum(), 7);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getFormalCharge(), 0);
    // Selection survives the swap.
    BOOST_CHECK(m.isAtomSelected(0));

    // Undo restores element AND prior charge.
    stack.undo();
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getAtomicNum(), 6);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getFormalCharge(), 1);
    stack.redo();
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getAtomicNum(), 7);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getFormalCharge(), 0);
}

BOOST_AUTO_TEST_CASE(testSetAtomElementNoOpWhenSameAtomicNum)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    const auto count_before = stack.count();
    m.setAtomElement(0, 6); // already carbon
    BOOST_CHECK_EQUAL(stack.count(), count_before);
}

BOOST_AUTO_TEST_CASE(testSetAtomElementThrowsOnOutOfRange)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    BOOST_CHECK_THROW(m.setAtomElement(99, 7), std::out_of_range);
}

BOOST_AUTO_TEST_CASE(testMutateAtomToRGroupReplacesInPlacePreservingBonds)
{
    // Ethane C0-C1; replace C1 with R1. The atom becomes a dummy carrying
    // _MolFileRLabel=1, its bond to C0 and its position survive, and undo
    // restores the carbon exactly.
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);
    m.addBond(0, 1, RDKit::Bond::SINGLE);
    const auto bonds_before = m.mol().getNumBonds();

    m.mutateAtomToRGroup(1, 1);
    const auto* r = m.mol().getAtomWithIdx(1);
    BOOST_CHECK_EQUAL(r->getAtomicNum(), 0); // dummy
    unsigned int rlabel = 0;
    BOOST_CHECK(r->getPropIfPresent(
        RDKit::common_properties::_MolFileRLabel, rlabel));
    BOOST_CHECK_EQUAL(rlabel, 1u);
    // Bond preserved.
    BOOST_CHECK_EQUAL(m.mol().getNumBonds(), bonds_before);
    BOOST_CHECK(m.mol().getBondBetweenAtoms(0, 1) != nullptr);
    // Position preserved.
    BOOST_CHECK_CLOSE(m.mol().getConformer().getAtomPos(1).x, 1.5, 1e-6);

    // Undo restores the carbon (no R-label).
    stack.undo();
    const auto* c = m.mol().getAtomWithIdx(1);
    BOOST_CHECK_EQUAL(c->getAtomicNum(), 6);
    BOOST_CHECK(!c->hasProp(RDKit::common_properties::_MolFileRLabel));
    BOOST_CHECK(m.mol().getBondBetweenAtoms(0, 1) != nullptr);
}

BOOST_AUTO_TEST_CASE(testMutateAtomToRGroupThrowsOnZeroAndNoOpsOutOfRange)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    BOOST_CHECK_THROW(m.mutateAtomToRGroup(0, 0), std::invalid_argument);
    const auto count_before = stack.count();
    m.mutateAtomToRGroup(99, 1); // out of range → no-op
    BOOST_CHECK_EQUAL(stack.count(), count_before);
}

BOOST_AUTO_TEST_CASE(testMutateAtomToWildcardMakesQueryAtomPreservingBonds)
{
    // Ethane C0-C1; replace C1 with the "Q" (heteroatom) wildcard. The atom
    // becomes a query atom carrying the WILDCARD_LABEL_PROP display label, its
    // bond + position survive, and undo restores the carbon.
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1.5, 0);
    m.addBond(0, 1, RDKit::Bond::SINGLE);

    m.mutateAtomToWildcard(1, "Q");
    const auto* q = m.mol().getAtomWithIdx(1);
    BOOST_CHECK(q->hasQuery());
    std::string label;
    BOOST_CHECK(q->getPropIfPresent(WILDCARD_LABEL_PROP, label));
    BOOST_CHECK_EQUAL(label, "Q");
    BOOST_CHECK(m.mol().getBondBetweenAtoms(0, 1) != nullptr);
    BOOST_CHECK_CLOSE(m.mol().getConformer().getAtomPos(1).x, 1.5, 1e-6);

    stack.undo();
    const auto* c = m.mol().getAtomWithIdx(1);
    BOOST_CHECK(!c->hasQuery());
    BOOST_CHECK_EQUAL(c->getAtomicNum(), 6);
    BOOST_CHECK(!c->hasProp(WILDCARD_LABEL_PROP));
}

BOOST_AUTO_TEST_CASE(testMutateAtomToWildcardNoOpsOnBadLabelOrRange)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    const auto count_before = stack.count();
    m.mutateAtomToWildcard(0, "ZZ"); // unrecognized label → no-op
    BOOST_CHECK_EQUAL(stack.count(), count_before);
    m.mutateAtomToWildcard(99, "A"); // out of range → no-op
    BOOST_CHECK_EQUAL(stack.count(), count_before);
    BOOST_CHECK(!m.mol().getAtomWithIdx(0)->hasQuery());
}

BOOST_AUTO_TEST_CASE(testAddWildcardAtomPlacesQueryAtomAndIsUndoable)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addWildcardAtom("X", 2.0, 3.0);
    BOOST_CHECK_EQUAL(m.mol().getNumAtoms(), 1u);
    const auto* a = m.mol().getAtomWithIdx(0);
    BOOST_CHECK(a->hasQuery());
    std::string label;
    BOOST_CHECK(a->getPropIfPresent(WILDCARD_LABEL_PROP, label));
    BOOST_CHECK_EQUAL(label, "X");
    BOOST_CHECK_CLOSE(m.mol().getConformer().getAtomPos(0).x, 2.0, 1e-6);
    BOOST_CHECK_CLOSE(m.mol().getConformer().getAtomPos(0).y, 3.0, 1e-6);
    stack.undo();
    BOOST_CHECK_EQUAL(m.mol().getNumAtoms(), 0u);
}

BOOST_AUTO_TEST_CASE(testAddWildcardAtomNoOpsOnBadLabel)
{
    UndoStack stack;
    MolModel m(&stack);
    const auto count_before = stack.count();
    m.addWildcardAtom("ZZ", 0, 0);
    BOOST_CHECK_EQUAL(stack.count(), count_before);
    BOOST_CHECK_EQUAL(m.mol().getNumAtoms(), 0u);
}

BOOST_AUTO_TEST_CASE(testSetElementForSelectedAtomsSwapsAllSelectedAndIsUndoable)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    m.addAtom("C", 1, 0);
    m.addAtom("C", 2, 0);
    // Charge a couple atoms so we can verify the reset to new-element defaults.
    m.setAtomSelected(0, true);
    m.setAtomSelected(1, true);
    m.adjustChargeOnSelectedAtoms(+1);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getFormalCharge(), 1);

    // Swap to nitrogen — selection still { 0, 1 }.
    m.setElementForSelectedAtoms(7);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getAtomicNum(), 7);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(1)->getAtomicNum(), 7);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(2)->getAtomicNum(), 6);
    // Charges reset to defaults (matches setAtomElement semantics).
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getFormalCharge(), 0);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(1)->getFormalCharge(), 0);
    // Selection survives (element edits don't reindex).
    BOOST_CHECK(m.isAtomSelected(0));
    BOOST_CHECK(m.isAtomSelected(1));

    // Undo restores element AND original charge on each atom.
    stack.undo();
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getAtomicNum(), 6);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(1)->getAtomicNum(), 6);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getFormalCharge(), 1);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(1)->getFormalCharge(), 1);
    stack.redo();
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getAtomicNum(), 7);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(1)->getAtomicNum(), 7);
}

BOOST_AUTO_TEST_CASE(testSetElementForSelectedAtomsNoOpOnEmptySelection)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0, 0);
    const auto count_before = stack.count();
    m.setElementForSelectedAtoms(7);
    BOOST_CHECK_EQUAL(stack.count(), count_before);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getAtomicNum(), 6);
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

BOOST_AUTO_TEST_CASE(testToMolBlockForSelectionEmptyWhenNothingSelected)
{
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("CCO");
    BOOST_CHECK_EQUAL(m.toMolBlockForSelection(/*v3000=*/true), "");
}

BOOST_AUTO_TEST_CASE(testToMolBlockForSelectionExportsSelectedAtomsOnly)
{
    UndoStack stack;
    MolModel m(&stack);
    // CCO: idx 0=C, 1=C, 2=O, bonds 0=(0-1), 1=(1-2). Select the C–C bond's
    // two atoms but NOT the O. Expected output: a 2-atom / 1-bond fragment.
    m.loadFromSmiles("CCO");
    m.setAtomSelected(0, true);
    m.setAtomSelected(1, true);
    const auto mb = m.toMolBlockForSelection(/*v3000=*/true);
    BOOST_CHECK(mb.find("V3000") != std::string::npos);
    BOOST_CHECK(mb.find("M  V30 COUNTS 2 1") != std::string::npos);
    // Live selection survives — toMolBlockForSelection is read-only.
    BOOST_CHECK(m.isAtomSelected(0));
    BOOST_CHECK(m.isAtomSelected(1));
    BOOST_CHECK(!m.isAtomSelected(2));
}

BOOST_AUTO_TEST_CASE(testToMolBlockForSelectionAutoExtendsSelectedBondEndpoints)
{
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("CCO");
    // Select only the C–O bond (idx 1); its endpoints (1, 2) should be
    // auto-included even though they aren't explicitly in m_selected_atoms.
    m.setBondSelected(1, true);
    const auto mb = m.toMolBlockForSelection(/*v3000=*/true);
    BOOST_CHECK(mb.find("M  V30 COUNTS 2 1") != std::string::npos);
}

BOOST_AUTO_TEST_CASE(testToFormatStringRoundTripsKnownFormats)
{
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("CCO");
    // SMILES + Extended SMILES.
    const auto smi = m.toFormatString("smiles", /*selectionOnly=*/false);
    BOOST_CHECK_EQUAL(smi, "CCO");
    const auto cxsmi =
        m.toFormatString("extended_smiles", /*selectionOnly=*/false);
    BOOST_CHECK(cxsmi.find("CCO") != std::string::npos);
    // SMARTS + Extended SMARTS — RDKit's MolToSmarts emits atomic-number
    // queries like `[#6][#6][#8]` (CCO).
    const auto sma = m.toFormatString("smarts", /*selectionOnly=*/false);
    BOOST_CHECK(!sma.empty());
    BOOST_CHECK(sma.find("#8") != std::string::npos);
    BOOST_CHECK(sma.find("#6") != std::string::npos);
    // InChI carries a versioned header.
    const auto inchi = m.toFormatString("inchi", /*selectionOnly=*/false);
    BOOST_CHECK(inchi.find("InChI=") == 0u);
    // InChIKey is 27 chars + dashes (XXXXXXXXXXXXXX-XXXXXXXXFV-N).
    const auto key = m.toFormatString("inchikey", /*selectionOnly=*/false);
    BOOST_CHECK_EQUAL(key.size(), 27u);
    BOOST_CHECK_EQUAL(key[14], '-');
    // PDB header.
    const auto pdb = m.toFormatString("pdb", /*selectionOnly=*/false);
    BOOST_CHECK(pdb.find("HETATM") != std::string::npos);
    // MRV is XML.
    const auto mrv = m.toFormatString("mrv", /*selectionOnly=*/false);
    BOOST_CHECK(mrv.find("<MDocument") != std::string::npos ||
                mrv.find("<cml") != std::string::npos);
    // MDL V3000 + V2000.
    const auto v3 = m.toFormatString("mdl_molv3000", /*selectionOnly=*/false);
    BOOST_CHECK(v3.find("V3000") != std::string::npos);
    const auto v2 = m.toFormatString("mdl_molv2000", /*selectionOnly=*/false);
    BOOST_CHECK(v2.find("V2000") != std::string::npos);
}

BOOST_AUTO_TEST_CASE(testToFormatStringEmptyWhenMolEmpty)
{
    UndoStack stack;
    MolModel m(&stack);
    BOOST_CHECK_EQUAL(m.toFormatString("smiles", false), "");
    BOOST_CHECK_EQUAL(m.toFormatString("inchi", false), "");
}

BOOST_AUTO_TEST_CASE(testToFormatStringEmptyOnUnknownFormat)
{
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("CCO");
    BOOST_CHECK_EQUAL(m.toFormatString("bogus", false), "");
}

BOOST_AUTO_TEST_CASE(testToFormatStringSelectionOnlyRespectsSelection)
{
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("CCO");
    // No selection → "".
    BOOST_CHECK_EQUAL(m.toFormatString("smiles", /*selectionOnly=*/true), "");
    // Select just the O → its SMILES fragment should be a single O.
    m.setAtomSelected(2, true);
    const auto frag = m.toFormatString("smiles", /*selectionOnly=*/true);
    BOOST_CHECK_EQUAL(frag, "O");
    // Whole-mol export still works while selection is set.
    BOOST_CHECK_EQUAL(m.toFormatString("smiles", /*selectionOnly=*/false),
                      "CCO");
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

BOOST_AUTO_TEST_CASE(testAddExplicitHsToAtomsOnlyTouchesSelectedAtoms)
{
    // Ethanol: indices 0=C, 1=C, 2=O; 6 implicit Hs. Adding to atom 2 only
    // promotes the 1 implicit H on the oxygen — leaves the carbons alone.
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("CCO");
    BOOST_CHECK_EQUAL(m.numAtoms(), 3u);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(2)->getSymbol(), "O");

    const auto before = stack.count();
    m.addExplicitHsToAtoms({2u});
    BOOST_CHECK_EQUAL(stack.count(), before + 1u);
    BOOST_CHECK_EQUAL(m.numAtoms(), 4u); // 3 heavies + 1 H on O

    // The new atom (idx 3 after the heavies) is H, bonded to the O.
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(3)->getSymbol(), "H");
    BOOST_REQUIRE(m.mol().getBondBetweenAtoms(2u, 3u) != nullptr);

    stack.undo();
    BOOST_CHECK_EQUAL(m.numAtoms(), 3u);
}

BOOST_AUTO_TEST_CASE(testRemoveExplicitHsFromAtomsOnlyTouchesNamedHs)
{
    // Start from fully-explicit ethanol (9 atoms), then strip Hs only on
    // atom 2 (the oxygen). 9 → 8 atoms (one OH-bound H removed). The carbons
    // keep their explicit Hs because they weren't named.
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("CCO");
    m.addHydrogens();
    BOOST_CHECK_EQUAL(m.numAtoms(), 9u);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(2)->getSymbol(), "O");

    const auto before = stack.count();
    m.removeExplicitHsFromAtoms({2u});
    BOOST_CHECK_EQUAL(stack.count(), before + 1u);
    BOOST_CHECK_EQUAL(m.numAtoms(), 8u);

    // The two carbons (atoms 0 and 1) still carry their explicit Hs.
    unsigned int h_count = 0;
    for (unsigned int i = 0; i < m.numAtoms(); ++i) {
        if (m.mol().getAtomWithIdx(i)->getSymbol() == "H") {
            ++h_count;
        }
    }
    BOOST_CHECK_EQUAL(h_count, 5u);

    stack.undo();
    BOOST_CHECK_EQUAL(m.numAtoms(), 9u);
}

BOOST_AUTO_TEST_CASE(testAddRemoveExplicitHsAreNoOpsWhenEmptyOrEmptyMol)
{
    UndoStack stack;
    MolModel m(&stack);

    // No-op on empty mol — no atoms means nothing to promote/strip.
    m.addExplicitHsToAtoms({0u});
    m.removeExplicitHsFromAtoms({0u});
    BOOST_CHECK_EQUAL(stack.count(), 0u);

    // remove-with-empty-list is a no-op (unlike whole-mol removeHydrogens).
    m.loadFromSmiles("CO");
    const auto before = stack.count();
    m.removeExplicitHsFromAtoms({});
    BOOST_CHECK_EQUAL(stack.count(), before);
}

BOOST_AUTO_TEST_CASE(testAdjustRadicalElectronsAddsPerAtomClampedToFour)
{
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("CCO"); // C-C-O, no radicals up front.
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getNumRadicalElectrons(), 0u);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(2)->getNumRadicalElectrons(), 0u);

    // +1 to atoms 0 and 2 → both pick up a single radical electron.
    m.adjustRadicalElectronsOnAtoms({0u, 2u}, +1);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getNumRadicalElectrons(), 1u);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(1)->getNumRadicalElectrons(), 0u);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(2)->getNumRadicalElectrons(), 1u);

    // +10 to atom 0 — clamps at MAX_UNPAIRED_E=4 instead of overflowing.
    m.adjustRadicalElectronsOnAtoms({0u}, +10);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getNumRadicalElectrons(), 4u);

    // -10 from atom 0 — clamps at MIN_UNPAIRED_E=0.
    m.adjustRadicalElectronsOnAtoms({0u}, -10);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getNumRadicalElectrons(), 0u);
}

BOOST_AUTO_TEST_CASE(testAdjustRadicalElectronsUndoRestoresExactCount)
{
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("CCO");

    m.adjustRadicalElectronsOnAtoms({0u, 1u}, +2);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getNumRadicalElectrons(), 2u);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(1)->getNumRadicalElectrons(), 2u);

    stack.undo();
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getNumRadicalElectrons(), 0u);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(1)->getNumRadicalElectrons(), 0u);

    stack.redo();
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getNumRadicalElectrons(), 2u);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(1)->getNumRadicalElectrons(), 2u);
}

BOOST_AUTO_TEST_CASE(testAdjustRadicalElectronsNoOpCases)
{
    UndoStack stack;
    MolModel m(&stack);

    // Empty mol — no-op, no undo entry.
    m.adjustRadicalElectronsOnAtoms({0u}, +1);
    BOOST_CHECK_EQUAL(stack.count(), 0u);

    m.loadFromSmiles("CCO");
    const auto base = stack.count();

    // Empty index list — no-op.
    m.adjustRadicalElectronsOnAtoms({}, +1);
    BOOST_CHECK_EQUAL(stack.count(), base);

    // delta=0 — no-op.
    m.adjustRadicalElectronsOnAtoms({0u}, 0);
    BOOST_CHECK_EQUAL(stack.count(), base);

    // Bring atom 0 to max, then try +1 again — every per-atom adjust is a
    // no-op (all atoms already at clamp), so no undo entry should be added.
    m.adjustRadicalElectronsOnAtoms({0u}, +4);
    const auto afterMax = stack.count();
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getNumRadicalElectrons(), 4u);
    m.adjustRadicalElectronsOnAtoms({0u}, +1);
    BOOST_CHECK_EQUAL(stack.count(), afterMax);
}

BOOST_AUTO_TEST_CASE(testSetAtomMappingSetsNumberAndIsUndoable)
{
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("CCO");
    const auto base = stack.count();
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getAtomMapNum(), 0);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(2)->getAtomMapNum(), 0);

    // Map atoms 0 and 2 to number 1 in one undo step.
    m.setAtomMapping({0u, 2u}, 1);
    BOOST_CHECK_EQUAL(stack.count(), base + 1);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getAtomMapNum(), 1);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(1)->getAtomMapNum(), 0);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(2)->getAtomMapNum(), 1);

    stack.undo();
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getAtomMapNum(), 0);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(2)->getAtomMapNum(), 0);

    stack.redo();
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getAtomMapNum(), 1);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(2)->getAtomMapNum(), 1);
}

BOOST_AUTO_TEST_CASE(testSetAtomMappingZeroClearsMapping)
{
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("CCO");
    m.setAtomMapping({0u, 1u}, 3);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getAtomMapNum(), 3);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(1)->getAtomMapNum(), 3);

    // Clear the mapping on atom 1 only (0 target).
    m.setAtomMapping({1u}, 0);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getAtomMapNum(), 3);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(1)->getAtomMapNum(), 0);
}

BOOST_AUTO_TEST_CASE(testSetAtomMappingNoOpCases)
{
    UndoStack stack;
    MolModel m(&stack);

    // Empty mol — no-op, no undo entry.
    m.setAtomMapping({0u}, 1);
    BOOST_CHECK_EQUAL(stack.count(), 0u);

    m.loadFromSmiles("CCO");
    const auto base = stack.count();

    // Empty index list — no-op.
    m.setAtomMapping({}, 1);
    BOOST_CHECK_EQUAL(stack.count(), base);

    // Setting the number an atom already has — no-op (skipped, no undo entry).
    m.setAtomMapping({0u}, 5);
    const auto afterSet = stack.count();
    m.setAtomMapping({0u}, 5);
    BOOST_CHECK_EQUAL(stack.count(), afterSet);
}

BOOST_AUTO_TEST_CASE(testCanAtomsFormSGroup)
{
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("CCCC"); // linear chain, atoms 0-1-2-3.

    // Middle two atoms bracket cleanly (two crossing bonds).
    BOOST_CHECK(m.canAtomsFormSGroup({1u, 2u}));
    // A single terminal atom has only one crossing bond — invalid.
    BOOST_CHECK(!m.canAtomsFormSGroup({0u}));
    // A single interior atom has two crossing bonds — valid.
    BOOST_CHECK(m.canAtomsFormSGroup({1u}));
    // Empty selection — invalid.
    BOOST_CHECK(!m.canAtomsFormSGroup({}));
    // Whole molecule — zero crossing bonds — invalid.
    BOOST_CHECK(!m.canAtomsFormSGroup({0u, 1u, 2u, 3u}));
}

BOOST_AUTO_TEST_CASE(testAddSGroupCreatesGroupAndIsUndoable)
{
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("CCCC");
    const auto base = stack.count();
    BOOST_CHECK_EQUAL(m.numSGroups(), 0u);

    m.addSGroup({1u, 2u}, "SRU", "HT", "n");
    BOOST_CHECK_EQUAL(stack.count(), base + 1);
    BOOST_CHECK_EQUAL(m.numSGroups(), 1u);

    stack.undo();
    BOOST_CHECK_EQUAL(m.numSGroups(), 0u);
    stack.redo();
    BOOST_CHECK_EQUAL(m.numSGroups(), 1u);
}

BOOST_AUTO_TEST_CASE(testAddSGroupNoOpOnInvalidAtoms)
{
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("CCCC");
    const auto base = stack.count();

    // Whole molecule can't form an S-group — no group, no undo entry.
    m.addSGroup({0u, 1u, 2u, 3u}, "SRU", "HT", "");
    BOOST_CHECK_EQUAL(m.numSGroups(), 0u);
    BOOST_CHECK_EQUAL(stack.count(), base);
}

BOOST_AUTO_TEST_CASE(testRemoveSGroupIsUndoable)
{
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("CCCC");
    m.addSGroup({1u, 2u}, "SRU", "HT", "n");
    BOOST_CHECK_EQUAL(m.numSGroups(), 1u);

    m.removeSGroup(0);
    BOOST_CHECK_EQUAL(m.numSGroups(), 0u);
    stack.undo();
    BOOST_CHECK_EQUAL(m.numSGroups(), 1u);
    stack.redo();
    BOOST_CHECK_EQUAL(m.numSGroups(), 0u);

    // Out-of-range index — no-op.
    const auto count = stack.count();
    m.removeSGroup(5);
    BOOST_CHECK_EQUAL(stack.count(), count);
}

BOOST_AUTO_TEST_CASE(testModifySGroupUpdatesNotation)
{
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("CCCC");
    m.addSGroup({1u, 2u}, "SRU", "HT", "");
    {
        const auto& sgs = RDKit::getSubstanceGroups(m.mol());
        std::string type;
        sgs[0].getPropIfPresent("TYPE", type);
        BOOST_CHECK_EQUAL(type, "SRU");
    }

    m.modifySGroup(0, "COP", "HH", "co");
    {
        const auto& sgs = RDKit::getSubstanceGroups(m.mol());
        std::string type, connect, label;
        sgs[0].getPropIfPresent("TYPE", type);
        sgs[0].getPropIfPresent("CONNECT", connect);
        sgs[0].getPropIfPresent("LABEL", label);
        BOOST_CHECK_EQUAL(type, "COP");
        BOOST_CHECK_EQUAL(connect, "HH");
        BOOST_CHECK_EQUAL(label, "co");
    }

    stack.undo();
    {
        const auto& sgs = RDKit::getSubstanceGroups(m.mol());
        std::string type;
        sgs[0].getPropIfPresent("TYPE", type);
        BOOST_CHECK_EQUAL(type, "SRU");
    }
}

BOOST_AUTO_TEST_CASE(testSetAtomPropertiesSetsAllFieldsAndIsUndoable)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0.0, 0.0);
    const auto base = stack.count();
    const auto* a = m.mol().getAtomWithIdx(0);
    BOOST_CHECK_EQUAL(a->getAtomicNum(), 6);

    m.setAtomProperties(0, "N", -1, 15, 1);
    BOOST_CHECK_EQUAL(stack.count(), base + 1);
    BOOST_CHECK_EQUAL(a->getAtomicNum(), 7);
    BOOST_CHECK_EQUAL(a->getFormalCharge(), -1);
    BOOST_CHECK_EQUAL(a->getIsotope(), 15u);
    BOOST_CHECK_EQUAL(a->getNumRadicalElectrons(), 1u);

    stack.undo();
    BOOST_CHECK_EQUAL(a->getAtomicNum(), 6);
    BOOST_CHECK_EQUAL(a->getFormalCharge(), 0);
    BOOST_CHECK_EQUAL(a->getIsotope(), 0u);
    BOOST_CHECK_EQUAL(a->getNumRadicalElectrons(), 0u);
}

BOOST_AUTO_TEST_CASE(testSetAtomPropertiesNoOpOnBadInput)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0.0, 0.0);
    const auto base = stack.count();

    // Unknown element symbol — no-op, no undo entry.
    m.setAtomProperties(0, "Xx", 0, 0, 0);
    BOOST_CHECK_EQUAL(stack.count(), base);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getAtomicNum(), 6);

    // Out-of-range index — no-op.
    m.setAtomProperties(9, "N", 0, 0, 0);
    BOOST_CHECK_EQUAL(stack.count(), base);
}

BOOST_AUTO_TEST_CASE(testSetAtomAllowedListMakesQueryAtomAndIsUndoable)
{
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("CCO");
    const auto base = stack.count();
    BOOST_CHECK(!m.mol().getAtomWithIdx(0)->hasQuery());

    m.setAtomAllowedList(0, {6, 7, 8}, /*negate=*/false, "[C,N,O]");
    BOOST_CHECK_EQUAL(stack.count(), base + 1);
    const auto* a = m.mol().getAtomWithIdx(0);
    BOOST_CHECK(a->hasQuery());
    std::string label;
    a->getPropIfPresent(schrodinger::sketcher_core::WILDCARD_LABEL_PROP, label);
    BOOST_CHECK_EQUAL(label, "[C,N,O]");

    stack.undo();
    BOOST_CHECK(!m.mol().getAtomWithIdx(0)->hasQuery());
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getAtomicNum(), 6);
    stack.redo();
    BOOST_CHECK(m.mol().getAtomWithIdx(0)->hasQuery());
}

BOOST_AUTO_TEST_CASE(testSetAtomAllowedListNoOpCases)
{
    UndoStack stack;
    MolModel m(&stack);
    m.loadFromSmiles("CCO");
    const auto base = stack.count();

    // Empty list — no-op.
    m.setAtomAllowedList(0, {}, false, "[]");
    BOOST_CHECK_EQUAL(stack.count(), base);
    BOOST_CHECK(!m.mol().getAtomWithIdx(0)->hasQuery());

    // Out-of-range index — no-op.
    m.setAtomAllowedList(9, {6}, false, "[C]");
    BOOST_CHECK_EQUAL(stack.count(), base);
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

BOOST_AUTO_TEST_CASE(testAddRGroupPlacesDummyAtomWithRLabel)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addRGroup(1, 3.0, 4.0, /*bound_to_atom_idx=*/-1);
    BOOST_REQUIRE_EQUAL(m.numAtoms(), 1u);
    const auto* atom = m.mol().getAtomWithIdx(0);
    // Dummy atomic number — make_new_r_group uses DUMMY_ATOMIC_NUMBER (0).
    BOOST_CHECK_EQUAL(atom->getAtomicNum(), 0);
    unsigned int rlabel = 0;
    BOOST_REQUIRE(atom->getPropIfPresent(
        RDKit::common_properties::_MolFileRLabel, rlabel));
    BOOST_CHECK_EQUAL(rlabel, 1u);
    double x = 0, y = 0;
    m.atomPos(0, x, y);
    BOOST_CHECK_CLOSE(x, 3.0, 1e-6);
    BOOST_CHECK_CLOSE(y, 4.0, 1e-6);
    BOOST_CHECK_EQUAL(m.numBonds(), 0u);
}

BOOST_AUTO_TEST_CASE(testAddRGroupBondsToExistingAtom)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0.0, 0.0);
    m.addRGroup(2, 1.5, 0.0, /*bound_to_atom_idx=*/0);
    BOOST_REQUIRE_EQUAL(m.numAtoms(), 2u);
    BOOST_REQUIRE_EQUAL(m.numBonds(), 1u);
    const auto* bond = m.mol().getBondBetweenAtoms(0, 1);
    BOOST_REQUIRE(bond != nullptr);
    BOOST_CHECK_EQUAL(bond->getBondType(), RDKit::Bond::BondType::SINGLE);
    unsigned int rlabel = 0;
    BOOST_REQUIRE(m.mol().getAtomWithIdx(1)->getPropIfPresent(
        RDKit::common_properties::_MolFileRLabel, rlabel));
    BOOST_CHECK_EQUAL(rlabel, 2u);
}

BOOST_AUTO_TEST_CASE(testAddRGroupIsUndoable)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addRGroup(1, 0.0, 0.0, -1);
    BOOST_CHECK_EQUAL(m.numAtoms(), 1u);
    stack.undo();
    BOOST_CHECK_EQUAL(m.numAtoms(), 0u);
    stack.redo();
    BOOST_CHECK_EQUAL(m.numAtoms(), 1u);
}

BOOST_AUTO_TEST_CASE(testAddRGroupRejectsRZero)
{
    UndoStack stack;
    MolModel m(&stack);
    BOOST_CHECK_THROW(m.addRGroup(0, 0.0, 0.0, -1), std::invalid_argument);
    // Failed call must not leave a partial mutation or a dangling undo entry.
    BOOST_CHECK_EQUAL(m.numAtoms(), 0u);
    BOOST_CHECK_EQUAL(stack.count(), 0u);
}

BOOST_AUTO_TEST_CASE(testAddAttachmentPointPlacesDummyAtomWithApLabel)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0.0, 0.0);
    m.addAttachmentPoint(1, 1.5, 0.0, /*bound_to_atom_idx=*/0);
    BOOST_REQUIRE_EQUAL(m.numAtoms(), 2u);
    const auto* atom = m.mol().getAtomWithIdx(1);
    // Dummy atomic number — create_dummy_atom uses DUMMY_ATOMIC_NUMBER (0).
    BOOST_CHECK_EQUAL(atom->getAtomicNum(), 0);
    // No _MolFileRLabel — APs use atomLabel only.
    BOOST_CHECK(!atom->hasProp(RDKit::common_properties::_MolFileRLabel));
    std::string label;
    BOOST_REQUIRE(
        atom->getPropIfPresent(RDKit::common_properties::atomLabel, label));
    BOOST_CHECK_EQUAL(label, "_AP1");
    // Position is preserved.
    double x = 0, y = 0;
    m.atomPos(1, x, y);
    BOOST_CHECK_CLOSE(x, 1.5, 1e-6);
    BOOST_CHECK_CLOSE(y, 0.0, 1e-6);
}

BOOST_AUTO_TEST_CASE(testAddAttachmentPointAlwaysBondsToExistingAtom)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0.0, 0.0);
    m.addAttachmentPoint(7, 1.5, 0.0, /*bound_to_atom_idx=*/0);
    // The bond is part of the contract: is_attachment_point_dummy requires
    // totalDegree == 1, so APs are never free-standing.
    BOOST_REQUIRE_EQUAL(m.numBonds(), 1u);
    const auto* bond = m.mol().getBondBetweenAtoms(0, 1);
    BOOST_REQUIRE(bond != nullptr);
    BOOST_CHECK_EQUAL(bond->getBondType(), RDKit::Bond::BondType::SINGLE);
}

BOOST_AUTO_TEST_CASE(testAddAttachmentPointIsUndoable)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0.0, 0.0);
    m.addAttachmentPoint(1, 1.5, 0.0, 0);
    BOOST_CHECK_EQUAL(m.numAtoms(), 2u);
    BOOST_CHECK_EQUAL(m.numBonds(), 1u);
    stack.undo();
    BOOST_CHECK_EQUAL(m.numAtoms(), 1u);
    BOOST_CHECK_EQUAL(m.numBonds(), 0u);
    stack.redo();
    BOOST_CHECK_EQUAL(m.numAtoms(), 2u);
    BOOST_CHECK_EQUAL(m.numBonds(), 1u);
}

BOOST_AUTO_TEST_CASE(testAddAttachmentPointRejectsZeroAndOutOfRangeAnchor)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C", 0.0, 0.0);
    // ap_num == 0 is meaningless — get_attachment_point_number returns 0 for
    // both missing and zero-suffix labels, so the lookup would be ambiguous.
    BOOST_CHECK_THROW(m.addAttachmentPoint(0, 1.5, 0.0, 0),
                      std::invalid_argument);
    // bound_to_atom_idx must reference an existing atom; out-of-range is
    // a programmer error and surfaces as a throw rather than a silent no-op
    // so misuse from JS shows up immediately.
    BOOST_CHECK_THROW(m.addAttachmentPoint(1, 1.5, 0.0, 5),
                      std::invalid_argument);
    // Neither call should leave a partial mutation or dangling undo entry.
    BOOST_CHECK_EQUAL(m.numAtoms(), 1u);
    BOOST_CHECK_EQUAL(m.numBonds(), 0u);
    BOOST_CHECK_EQUAL(stack.count(), 1u); // just the initial addAtom
}

BOOST_AUTO_TEST_CASE(testAddRxnArrowPlacesArrowAtCoords)
{
    UndoStack stack;
    MolModel m(&stack);
    BOOST_CHECK(!m.hasRxnArrow());
    m.addRxnArrow(2.5, -1.0);
    BOOST_CHECK(m.hasRxnArrow());
    BOOST_CHECK_CLOSE(m.rxnArrow().first, 2.5, 1e-6);
    BOOST_CHECK_CLOSE(m.rxnArrow().second, -1.0, 1e-6);
    // Pure non-mol mutation shouldn't add atoms or bonds.
    BOOST_CHECK_EQUAL(m.numAtoms(), 0u);
    BOOST_CHECK_EQUAL(m.numBonds(), 0u);
    // The model isn't "empty" once a non-mol object is present — matters for
    // export/clear semantics (Qt: MolModel::isEmpty considers non-mol objects).
    BOOST_CHECK(!m.isEmpty());
}

BOOST_AUTO_TEST_CASE(testAddRxnArrowRejectsSecondArrow)
{
    // Qt MolModel::addNonMolecularObject throws "Only one arrow allowed"
    // when an arrow already exists. Pluses are unlimited; arrows are not.
    UndoStack stack;
    MolModel m(&stack);
    m.addRxnArrow(0.0, 0.0);
    BOOST_CHECK_THROW(m.addRxnArrow(3.0, 3.0), std::runtime_error);
    // Failed call must not leave a partial mutation behind.
    BOOST_CHECK(m.hasRxnArrow());
    BOOST_CHECK_CLOSE(m.rxnArrow().first, 0.0, 1e-6);
    BOOST_CHECK_CLOSE(m.rxnArrow().second, 0.0, 1e-6);
    BOOST_CHECK_EQUAL(stack.count(), 1u); // just the first addRxnArrow
}

BOOST_AUTO_TEST_CASE(testAddRxnPlusAppendsMultiple)
{
    // Pluses are unbounded — each click drops another. Order preserved.
    UndoStack stack;
    MolModel m(&stack);
    m.addRxnPlus(1.0, 0.0);
    m.addRxnPlus(2.0, 0.0);
    m.addRxnPlus(3.0, 0.0);
    BOOST_CHECK_EQUAL(m.rxnPluses().size(), 3u);
    BOOST_CHECK_CLOSE(m.rxnPluses()[0].first, 1.0, 1e-6);
    BOOST_CHECK_CLOSE(m.rxnPluses()[1].first, 2.0, 1e-6);
    BOOST_CHECK_CLOSE(m.rxnPluses()[2].first, 3.0, 1e-6);
    BOOST_CHECK(!m.isEmpty());
}

BOOST_AUTO_TEST_CASE(testAddRxnArrowAndPlusAreUndoable)
{
    // doMutation snapshots non-mol state alongside the RWMol, so undo
    // restores both atom topology and reaction objects atomically.
    UndoStack stack;
    MolModel m(&stack);
    m.addRxnArrow(0.0, 0.0);
    m.addRxnPlus(1.0, 0.0);
    BOOST_CHECK(m.hasRxnArrow());
    BOOST_CHECK_EQUAL(m.rxnPluses().size(), 1u);
    stack.undo();
    BOOST_CHECK(m.hasRxnArrow());
    BOOST_CHECK_EQUAL(m.rxnPluses().size(), 0u);
    stack.undo();
    BOOST_CHECK(!m.hasRxnArrow());
    BOOST_CHECK_EQUAL(m.rxnPluses().size(), 0u);
    BOOST_CHECK(m.isEmpty());
    // Redo should bring both objects back in order.
    stack.redo();
    BOOST_CHECK(m.hasRxnArrow());
    stack.redo();
    BOOST_CHECK_EQUAL(m.rxnPluses().size(), 1u);
}

// -------- Monomers (coarse-grained peptide mode) --------

BOOST_AUTO_TEST_CASE(testAddMonomerCreatesMonomericMolWithLabelAndCoords)
{
    UndoStack stack;
    MolModel m(&stack);
    // chain_type 0 = PEPTIDE. "A" = Alanine.
    m.addMonomer("A", 0, 2.0, 3.0);
    BOOST_CHECK(schrodinger::rdkit_extensions::isMonomeric(m.mol()));
    BOOST_REQUIRE_EQUAL(m.mol().getNumAtoms(), 1u);
    const auto* atom = m.mol().getAtomWithIdx(0);
    // Monomer atoms are dummies carrying an atomLabel = the residue symbol.
    BOOST_CHECK_EQUAL(atom->getAtomicNum(), 0);
    std::string label;
    BOOST_CHECK(atom->getPropIfPresent(ATOM_LABEL, label));
    BOOST_CHECK_EQUAL(label, "A");
    BOOST_CHECK_CLOSE(m.mol().getConformer().getAtomPos(0).x, 2.0, 1e-6);
    BOOST_CHECK_CLOSE(m.mol().getConformer().getAtomPos(0).y, 3.0, 1e-6);
    // Undo removes the monomer (and the monomeric flag).
    stack.undo();
    BOOST_CHECK(m.isEmpty());
}

BOOST_AUTO_TEST_CASE(testAddBoundMonomerChainsWithConnectionInOneUndoStep)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addMonomer("A", 0, 0.0, 0.0);
    const auto count_after_first = stack.count();
    m.addBoundMonomer("G", 0, 1.5, 0.0, /*bound_to_idx=*/0);
    // addBoundMonomer is a single undoable command (one snapshot mutation).
    BOOST_CHECK_EQUAL(stack.count(), count_after_first + 1);
    BOOST_REQUIRE_EQUAL(m.mol().getNumAtoms(), 2u);
    BOOST_REQUIRE_EQUAL(m.mol().getNumBonds(), 1u);
    // The two monomers share a chain; the new one is residue 2.
    const auto* a0 = m.mol().getAtomWithIdx(0);
    const auto* a1 = m.mol().getAtomWithIdx(1);
    const auto* r0 =
        dynamic_cast<const RDKit::AtomPDBResidueInfo*>(a0->getMonomerInfo());
    const auto* r1 =
        dynamic_cast<const RDKit::AtomPDBResidueInfo*>(a1->getMonomerInfo());
    BOOST_REQUIRE(r0 != nullptr);
    BOOST_REQUIRE(r1 != nullptr);
    BOOST_CHECK_EQUAL(r0->getChainId(), r1->getChainId());
    BOOST_CHECK_EQUAL(r1->getResidueNumber(), r0->getResidueNumber() + 1);
    std::string g_label;
    BOOST_CHECK(a1->getPropIfPresent(ATOM_LABEL, g_label));
    BOOST_CHECK_EQUAL(g_label, "G");
    // The connection carries the backbone linkage prop.
    const auto* bond = m.mol().getBondBetweenAtoms(0, 1);
    BOOST_REQUIRE(bond != nullptr);
    std::string linkage;
    BOOST_CHECK(bond->getPropIfPresent(LINKAGE, linkage));
    BOOST_CHECK_EQUAL(linkage, BACKBONE_LINKAGE);
    // A single undo removes both the new monomer and the connection.
    stack.undo();
    BOOST_CHECK_EQUAL(m.mol().getNumAtoms(), 1u);
    BOOST_CHECK_EQUAL(m.mol().getNumBonds(), 0u);
}

BOOST_AUTO_TEST_CASE(testAddMonomerAssignsSequentialChainsForFreeMonomers)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addMonomer("A", 0, 0.0, 0.0);
    m.addMonomer("G", 0, 3.0, 0.0); // separate free monomer → new chain
    const auto* r0 = dynamic_cast<const RDKit::AtomPDBResidueInfo*>(
        m.mol().getAtomWithIdx(0)->getMonomerInfo());
    const auto* r1 = dynamic_cast<const RDKit::AtomPDBResidueInfo*>(
        m.mol().getAtomWithIdx(1)->getMonomerInfo());
    BOOST_REQUIRE(r0 != nullptr && r1 != nullptr);
    BOOST_CHECK_EQUAL(r0->getChainId(), "PEPTIDE1");
    BOOST_CHECK_EQUAL(r1->getChainId(), "PEPTIDE2");
}

BOOST_AUTO_TEST_CASE(testAddBoundMonomerNoOpOnBadIndex)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addMonomer("A", 0, 0.0, 0.0);
    const auto count_before = stack.count();
    m.addBoundMonomer("G", 0, 1.5, 0.0, /*bound_to_idx=*/9);
    BOOST_CHECK_EQUAL(stack.count(), count_before);
    BOOST_CHECK_EQUAL(m.mol().getNumAtoms(), 1u);
}

BOOST_AUTO_TEST_CASE(testAddMonomerNucleicAcidUsesRnaChainPrefix)
{
    UndoStack stack;
    MolModel m(&stack);
    // chain_type 1 = RNA. A free nucleobase starts an "RNA" chain (HELM uses
    // the RNA prefix for both RNA and DNA).
    m.addMonomer("A", 1, 0.0, 0.0);
    const auto* r0 = dynamic_cast<const RDKit::AtomPDBResidueInfo*>(
        m.mol().getAtomWithIdx(0)->getMonomerInfo());
    BOOST_REQUIRE(r0 != nullptr);
    BOOST_CHECK_EQUAL(r0->getChainId(), "RNA1");
}

BOOST_AUTO_TEST_CASE(testAddBoundMonomerSugarToBaseUsesBranchLinkage)
{
    UndoStack stack;
    MolModel m(&stack);
    // A ribose sugar, then a base chained onto it. Sugar→base resolves to the
    // R3-R1 branch linkage (not the R2-R1 backbone).
    m.addMonomer("R", 1, 0.0, 0.0);
    m.addBoundMonomer("A", 1, 0.0, -1.5, /*bound_to_idx=*/0);
    BOOST_REQUIRE_EQUAL(m.mol().getNumAtoms(), 2u);
    const auto* bond = m.mol().getBondBetweenAtoms(0, 1);
    BOOST_REQUIRE(bond != nullptr);
    std::string linkage;
    BOOST_CHECK(bond->getPropIfPresent(LINKAGE, linkage));
    BOOST_CHECK_EQUAL(linkage, BRANCH_LINKAGE);
}

BOOST_AUTO_TEST_CASE(testAddNucleotideBuildsSugarBasePhosphateInOneUndoStep)
{
    UndoStack stack;
    MolModel m(&stack);
    const auto count_before = stack.count();
    // RNA nucleotide: ribose (R) + uracil (U) + phosphate (P).
    m.addNucleotide("R", "U", "P", 2.0, 5.0);
    // One undoable command builds all three monomers + both connections.
    BOOST_CHECK_EQUAL(stack.count(), count_before + 1);
    BOOST_CHECK(schrodinger::rdkit_extensions::isMonomeric(m.mol()));
    BOOST_REQUIRE_EQUAL(m.mol().getNumAtoms(), 3u);
    BOOST_REQUIRE_EQUAL(m.mol().getNumBonds(), 2u);
    // Atom order: sugar (0), base (1), phosphate (2).
    std::string sugar, base, phos;
    BOOST_CHECK(m.mol().getAtomWithIdx(0)->getPropIfPresent(ATOM_LABEL, sugar));
    BOOST_CHECK(m.mol().getAtomWithIdx(1)->getPropIfPresent(ATOM_LABEL, base));
    BOOST_CHECK(m.mol().getAtomWithIdx(2)->getPropIfPresent(ATOM_LABEL, phos));
    BOOST_CHECK_EQUAL(sugar, "R");
    BOOST_CHECK_EQUAL(base, "U");
    BOOST_CHECK_EQUAL(phos, "P");
    // Layout: sugar at click, base one bond-length below, phosphate to the +x.
    const auto& conf = m.mol().getConformer();
    BOOST_CHECK_CLOSE(conf.getAtomPos(0).x, 2.0, 1e-6);
    BOOST_CHECK_CLOSE(conf.getAtomPos(0).y, 5.0, 1e-6);
    BOOST_CHECK_CLOSE(conf.getAtomPos(1).y, 5.0 - 1.5, 1e-6);
    BOOST_CHECK_CLOSE(conf.getAtomPos(2).x, 2.0 + 1.5, 1e-6);
    // Sugar→base is the R3-R1 branch; sugar→phosphate the R2-R1 backbone.
    const auto* branch = m.mol().getBondBetweenAtoms(0, 1);
    const auto* backbone = m.mol().getBondBetweenAtoms(0, 2);
    BOOST_REQUIRE(branch != nullptr && backbone != nullptr);
    std::string branch_linkage, backbone_linkage;
    BOOST_CHECK(branch->getPropIfPresent(LINKAGE, branch_linkage));
    BOOST_CHECK(backbone->getPropIfPresent(LINKAGE, backbone_linkage));
    BOOST_CHECK_EQUAL(branch_linkage, BRANCH_LINKAGE);
    BOOST_CHECK_EQUAL(backbone_linkage, BACKBONE_LINKAGE);
    // A single undo removes the whole nucleotide.
    stack.undo();
    BOOST_CHECK(m.isEmpty());
}

BOOST_AUTO_TEST_CASE(testAddBoundNucleotideChainsToExistingPhosphate)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addNucleotide("R", "U", "P", 0.0, 0.0);
    const auto count_after_first = stack.count();
    // Chain a second nucleotide onto the first nucleotide's 3' phosphate (idx 2).
    m.addBoundNucleotide("R", "A", "P", 3.0, 0.0, /*bound_to_idx=*/2);
    BOOST_CHECK_EQUAL(stack.count(), count_after_first + 1);
    BOOST_REQUIRE_EQUAL(m.mol().getNumAtoms(), 6u);
    // 5 bonds: 2 per nucleotide + 1 inter-nucleotide backbone connection.
    BOOST_REQUIRE_EQUAL(m.mol().getNumBonds(), 5u);
    // The new sugar (idx 3) is bonded to the previous phosphate (idx 2) via a
    // backbone connection, and shares the same chain.
    const auto* link = m.mol().getBondBetweenAtoms(2, 3);
    BOOST_REQUIRE(link != nullptr);
    std::string linkage;
    BOOST_CHECK(link->getPropIfPresent(LINKAGE, linkage));
    BOOST_CHECK_EQUAL(linkage, BACKBONE_LINKAGE);
    const auto* r_prev = dynamic_cast<const RDKit::AtomPDBResidueInfo*>(
        m.mol().getAtomWithIdx(2)->getMonomerInfo());
    const auto* r_new = dynamic_cast<const RDKit::AtomPDBResidueInfo*>(
        m.mol().getAtomWithIdx(3)->getMonomerInfo());
    BOOST_REQUIRE(r_prev != nullptr && r_new != nullptr);
    BOOST_CHECK_EQUAL(r_prev->getChainId(), r_new->getChainId());
    // A single undo removes the entire second nucleotide.
    stack.undo();
    BOOST_CHECK_EQUAL(m.mol().getNumAtoms(), 3u);
    BOOST_CHECK_EQUAL(m.mol().getNumBonds(), 2u);
}

BOOST_AUTO_TEST_CASE(testAddBoundNucleotideNoOpOnBadIndex)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addNucleotide("R", "U", "P", 0.0, 0.0);
    const auto count_before = stack.count();
    m.addBoundNucleotide("R", "A", "P", 3.0, 0.0, /*bound_to_idx=*/99);
    BOOST_CHECK_EQUAL(stack.count(), count_before);
    BOOST_CHECK_EQUAL(m.mol().getNumAtoms(), 3u);
}

BOOST_AUTO_TEST_CASE(testMutateMonomerChangesResidueInPlaceUndoably)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addMonomer("A", 0, 2.0, 3.0);
    // Mutate the Alanine to Glycine — the atom, chain, residue number, and
    // position are unchanged; only the residue symbol/label flips.
    m.mutateMonomer(0, "G");
    BOOST_REQUIRE_EQUAL(m.mol().getNumAtoms(), 1u);
    const auto* atom = m.mol().getAtomWithIdx(0);
    std::string label;
    BOOST_CHECK(atom->getPropIfPresent(ATOM_LABEL, label));
    BOOST_CHECK_EQUAL(label, "G");
    const auto* res =
        dynamic_cast<const RDKit::AtomPDBResidueInfo*>(atom->getMonomerInfo());
    BOOST_REQUIRE(res != nullptr);
    BOOST_CHECK_EQUAL(res->getResidueName(), "G");
    BOOST_CHECK_CLOSE(m.mol().getConformer().getAtomPos(0).x, 2.0, 1e-6);
    BOOST_CHECK_CLOSE(m.mol().getConformer().getAtomPos(0).y, 3.0, 1e-6);
    // Undo restores the original residue.
    stack.undo();
    std::string restored;
    BOOST_CHECK(
        m.mol().getAtomWithIdx(0)->getPropIfPresent(ATOM_LABEL, restored));
    BOOST_CHECK_EQUAL(restored, "A");
}

BOOST_AUTO_TEST_CASE(testMutateMonomerPreservesConnections)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addMonomer("A", 0, 0.0, 0.0);
    m.addBoundMonomer("G", 0, 1.5, 0.0, /*bound_to_idx=*/0);
    BOOST_REQUIRE_EQUAL(m.mol().getNumBonds(), 1u);
    // Mutating a connected monomer keeps the connection intact.
    m.mutateMonomer(1, "L");
    BOOST_CHECK_EQUAL(m.mol().getNumAtoms(), 2u);
    BOOST_CHECK_EQUAL(m.mol().getNumBonds(), 1u);
    std::string label;
    BOOST_CHECK(m.mol().getAtomWithIdx(1)->getPropIfPresent(ATOM_LABEL, label));
    BOOST_CHECK_EQUAL(label, "L");
}

BOOST_AUTO_TEST_CASE(testMutateMonomerNoOpOnBadIndex)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addMonomer("A", 0, 0.0, 0.0);
    const auto count_before = stack.count();
    m.mutateMonomer(9, "G");
    BOOST_CHECK_EQUAL(stack.count(), count_before);
    std::string label;
    BOOST_CHECK(m.mol().getAtomWithIdx(0)->getPropIfPresent(ATOM_LABEL, label));
    BOOST_CHECK_EQUAL(label, "A");
}

BOOST_AUTO_TEST_CASE(testAddBoundMonomerViaApUsesExplicitLinkage)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addMonomer("A", 0, 0.0, 0.0);
    // Chain a Glycine onto Alanine's C-terminus (R2). The new peptide attaches
    // via its N (R1), so the linkage is R2-R1.
    m.addBoundMonomerViaAP("G", 0, 1.5, 0.0, /*bound_to_idx=*/0,
                           /*existing_ap=*/"R2");
    BOOST_REQUIRE_EQUAL(m.mol().getNumAtoms(), 2u);
    BOOST_REQUIRE_EQUAL(m.mol().getNumBonds(), 1u);
    const auto* bond = m.mol().getBondBetweenAtoms(0, 1);
    BOOST_REQUIRE(bond != nullptr);
    std::string linkage;
    BOOST_CHECK(bond->getPropIfPresent(LINKAGE, linkage));
    BOOST_CHECK_EQUAL(linkage, "R2-R1");
}

BOOST_AUTO_TEST_CASE(testAddBoundMonomerViaApNTerminusReversesBondDirection)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addMonomer("A", 0, 0.0, 0.0);
    // Chaining off the N-terminus (R1) attaches the new peptide's C (R2). The
    // stored linkage is always canonicalized higher→lower ("R2-R1"), so the
    // N-vs-C direction shows up in the bond's begin/end atoms instead: the new
    // upstream monomer (idx 1) becomes the bond's begin atom.
    m.addBoundMonomerViaAP("G", 0, -1.5, 0.0, /*bound_to_idx=*/0,
                           /*existing_ap=*/"R1");
    const auto* bond = m.mol().getBondBetweenAtoms(0, 1);
    BOOST_REQUIRE(bond != nullptr);
    std::string linkage;
    BOOST_CHECK(bond->getPropIfPresent(LINKAGE, linkage));
    BOOST_CHECK_EQUAL(linkage, "R2-R1");
    BOOST_CHECK_EQUAL(bond->getBeginAtomIdx(), 1u); // new monomer is upstream
    BOOST_CHECK_EQUAL(bond->getEndAtomIdx(), 0u);
}

BOOST_AUTO_TEST_CASE(testAddBoundMonomerViaApNoOpOnBadInputs)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addMonomer("A", 0, 0.0, 0.0);
    const auto count = stack.count();
    m.addBoundMonomerViaAP("G", 0, 1.5, 0.0, /*bound_to_idx=*/9, "R2");
    BOOST_CHECK_EQUAL(stack.count(), count); // bad index
    m.addBoundMonomerViaAP("G", 0, 1.5, 0.0, /*bound_to_idx=*/0, "pair");
    BOOST_CHECK_EQUAL(stack.count(), count); // non-numbered existing AP
    BOOST_CHECK_EQUAL(m.mol().getNumAtoms(), 1u);
}

BOOST_AUTO_TEST_CASE(testToFormatStringExportsPeptideAsHelmAndFasta)
{
    UndoStack stack;
    MolModel m(&stack);
    // Build a two-residue peptide chain A→G.
    m.addMonomer("A", 0, 0.0, 0.0);
    m.addBoundMonomer("G", 0, 1.5, 0.0, /*bound_to_idx=*/0);
    // HELM names the polymer PEPTIDE1 and lists the residues in order.
    const auto helm = m.toFormatString("helm", /*selectionOnly=*/false);
    BOOST_CHECK(helm.find("PEPTIDE1{") != std::string::npos);
    BOOST_CHECK(helm.find("A.G") != std::string::npos);
    // FASTA writes the one-letter sequence.
    const auto fasta = m.toFormatString("fasta", /*selectionOnly=*/false);
    BOOST_CHECK(!fasta.empty());
    BOOST_CHECK(fasta.find("AG") != std::string::npos);
}

BOOST_AUTO_TEST_CASE(testToFormatStringExportsNucleotideAsHelm)
{
    UndoStack stack;
    MolModel m(&stack);
    // A single RNA nucleotide round-trips to HELM as the RNA polymer R(U)P.
    m.addNucleotide("R", "U", "P", 0.0, 0.0);
    const auto helm = m.toFormatString("helm", /*selectionOnly=*/false);
    BOOST_CHECK(helm.find("RNA1{") != std::string::npos);
    BOOST_CHECK(helm.find("R(U)P") != std::string::npos);
}

BOOST_AUTO_TEST_CASE(testMonomerDatabaseProvidesPeptideAnalogs)
{
    // The baked-in monomer DB groups non-natural analogs by their natural
    // residue — this backs the per-residue analog popups (SKETCH-2482). Verify
    // Alanine's group carries the D- and N-methyl variants.
    auto& db = schrodinger::rdkit_extensions::MonomerDatabase::instance();
    const auto by_analog = db.getMonomersByNaturalAnalog(
        schrodinger::rdkit_extensions::ChainType::PEPTIDE);
    BOOST_REQUIRE(by_analog.count("A") == 1u);
    std::vector<std::string> a_syms;
    for (const auto& m : by_analog.at("A")) {
        if (m.symbol) {
            a_syms.push_back(*m.symbol);
        }
    }
    BOOST_CHECK(std::find(a_syms.begin(), a_syms.end(), "dA") != a_syms.end());
    BOOST_CHECK(std::find(a_syms.begin(), a_syms.end(), "meA") != a_syms.end());
    // A placed analog is just a monomer with that symbol — round-trips through
    // addMonomer + HELM export.
    UndoStack stack;
    MolModel m(&stack);
    m.addMonomer("dA", 0, 0.0, 0.0);
    std::string label;
    BOOST_CHECK(m.mol().getAtomWithIdx(0)->getPropIfPresent(ATOM_LABEL, label));
    BOOST_CHECK_EQUAL(label, "dA");
}

BOOST_AUTO_TEST_CASE(testLoadFromTextImportsHelmWithGeneratedCoords)
{
    UndoStack stack;
    MolModel m(&stack);
    // HELM is in the AUTO_DETECT list; loadFromText parses it and generates a
    // bead layout (a HELM parse carries no conformer on its own).
    m.loadFromText("PEPTIDE1{A.G.C}$$$$V2.0");
    BOOST_CHECK(schrodinger::rdkit_extensions::isMonomeric(m.mol()));
    BOOST_REQUIRE_EQUAL(m.mol().getNumAtoms(), 3u);
    BOOST_REQUIRE_EQUAL(m.mol().getNumBonds(), 2u);
    // A conformer was generated so the render bridge can read positions.
    BOOST_REQUIRE_EQUAL(m.mol().getNumConformers(), 1u);
    std::vector<std::string> labels;
    for (const auto* atom : m.mol().atoms()) {
        std::string label;
        atom->getPropIfPresent(ATOM_LABEL, label);
        labels.push_back(label);
    }
    std::sort(labels.begin(), labels.end());
    BOOST_CHECK((labels == std::vector<std::string>{"A", "C", "G"}));
}

BOOST_AUTO_TEST_CASE(testHelmExportImportRoundTrips)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addMonomer("A", 0, 0.0, 0.0);
    m.addBoundMonomer("G", 0, 1.5, 0.0, /*bound_to_idx=*/0);
    const auto helm = m.toFormatString("helm", /*selectionOnly=*/false);
    BOOST_REQUIRE(!helm.empty());
    // Reloading the exported HELM reproduces the same monomer count.
    m.loadFromText(helm);
    BOOST_CHECK(schrodinger::rdkit_extensions::isMonomeric(m.mol()));
    BOOST_CHECK_EQUAL(m.mol().getNumAtoms(), 2u);
    BOOST_CHECK_EQUAL(m.mol().getNumBonds(), 1u);
}
