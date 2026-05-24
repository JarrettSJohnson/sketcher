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
    m.addAtom("C");
    m.addAtom("O");
    BOOST_CHECK_EQUAL(m.numAtoms(), 2u);
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(0)->getSymbol(), "C");
    BOOST_CHECK_EQUAL(m.mol().getAtomWithIdx(1)->getSymbol(), "O");
}

BOOST_AUTO_TEST_CASE(testAddBondConnectsAtoms)
{
    UndoStack stack;
    MolModel m(&stack);
    m.addAtom("C");
    m.addAtom("C");
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
    m.addAtom("C");
    m.addAtom("C");
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
    m.addAtom("C");
    m.addAtom("C");
    m.addAtom("O");
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
    m.addAtom("C");
    m.addAtom("C");
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
    m.addAtom("C");
    m.addAtom("N");
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

    m.addAtom("C");
    BOOST_CHECK_EQUAL(fired, 1);
    m.addAtom("C");
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
        m.addAtom("C");
        m.addAtom("C");
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
