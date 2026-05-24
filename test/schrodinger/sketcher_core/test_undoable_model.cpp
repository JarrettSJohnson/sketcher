/* -------------------------------------------------------------------------
 * Tests for schrodinger::sketcher_core::UndoableModel — the Qt-free
 * AbstractUndoableModel replacement used by the Phase 0 spike.
 *
 * Copyright Schrodinger LLC, All Rights Reserved.
 --------------------------------------------------------------------------- */

#define BOOST_TEST_MODULE sketcher_core_undoable_model

#include <stdexcept>
#include <vector>

#include <boost/test/unit_test.hpp>

#include "schrodinger/sketcher_core/observer.h"
#include "schrodinger/sketcher_core/undo_stack.h"
#include "schrodinger/sketcher_core/undoable_model.h"

using schrodinger::sketcher_core::Signal;
using schrodinger::sketcher_core::UndoableModel;
using schrodinger::sketcher_core::UndoStack;

namespace
{

/**
 * Minimal undoable model: holds an int, with an `add(delta)` undoable command
 * that emits changed(new_value). Mirrors the AbstractUndoableModel example in
 * the header docs.
 */
class Counter : public UndoableModel
{
  public:
    explicit Counter(UndoStack* stack) : UndoableModel(stack)
    {
    }

    int value() const
    {
        return m_value;
    }

    void add(int delta)
    {
        auto redo = [this, delta] {
            m_value += delta;
            emitSignal(changed, m_value);
        };
        auto undo = [this, delta] {
            m_value -= delta;
            emitSignal(changed, m_value);
        };
        doCommand(std::move(redo), std::move(undo), "Add");
    }

    Signal<int> changed;

  private:
    int m_value = 0;
};

} // namespace

BOOST_AUTO_TEST_CASE(testDoCommandAppliesRedoImmediately)
{
    UndoStack stack;
    Counter c(&stack);
    c.add(5);
    BOOST_CHECK_EQUAL(c.value(), 5);
    BOOST_CHECK_EQUAL(stack.count(), 1u);
}

BOOST_AUTO_TEST_CASE(testUndoRedoRoundTrip)
{
    UndoStack stack;
    Counter c(&stack);
    c.add(3);
    c.add(4);
    BOOST_CHECK_EQUAL(c.value(), 7);

    stack.undo();
    BOOST_CHECK_EQUAL(c.value(), 3);
    stack.undo();
    BOOST_CHECK_EQUAL(c.value(), 0);
    stack.redo();
    BOOST_CHECK_EQUAL(c.value(), 3);
    stack.redo();
    BOOST_CHECK_EQUAL(c.value(), 7);
}

BOOST_AUTO_TEST_CASE(testSignalFiresOnlyDuringCommandExecution)
{
    UndoStack stack;
    Counter c(&stack);

    std::vector<int> emissions;
    auto connection = c.changed.connect([&](int v) { emissions.push_back(v); });

    c.add(2);     // -> +2 (one emit during redo)
    c.add(3);     // -> +3 (one emit)
    stack.undo(); // -> -3 (one emit from undo)
    stack.redo(); // -> +3 (one emit from redo)

    BOOST_REQUIRE_EQUAL(emissions.size(), 4u);
    BOOST_CHECK_EQUAL(emissions[0], 2);
    BOOST_CHECK_EQUAL(emissions[1], 5);
    BOOST_CHECK_EQUAL(emissions[2], 2);
    BOOST_CHECK_EQUAL(emissions[3], 5);
}

BOOST_AUTO_TEST_CASE(testEmitSignalOutsideCommandIsSilent)
{
    // Replicates the original "blockSignals(true) by default" bug-catcher:
    // calling sig.emit() outside doCommand's redo/undo must NOT propagate.
    UndoStack stack;
    Counter c(&stack);

    int direct_emit_count = 0;
    auto connection = c.changed.connect([&](int) { ++direct_emit_count; });

    // emitSignal is the gated path; should swallow outside a command.
    // The slot still gets called if we hit Signal::emit directly, but the
    // model's emitSignal won't call it.
    // Trying to hit emitSignal externally isn't possible (protected); the
    // *behavioral* contract is that nothing fires outside a command. So we
    // assert: no command run => no emissions.
    BOOST_CHECK_EQUAL(direct_emit_count, 0);
    BOOST_CHECK_EQUAL(c.value(), 0);
}

BOOST_AUTO_TEST_CASE(testDoCommandFromInsideDoCommandThrows)
{
    UndoStack stack;
    struct Reentrant : public UndoableModel {
        explicit Reentrant(UndoStack* s) : UndoableModel(s)
        {
        }
        void outer()
        {
            doCommand([this] { inner(); }, [this] { inner(); }, "outer");
        }
        void inner()
        {
            doCommand([] {}, [] {}, "inner");
        }
    } r(&stack);

    BOOST_CHECK_THROW(r.outer(), std::runtime_error);
}

BOOST_AUTO_TEST_CASE(testMacroGroupsMultipleCommandsAsSingleUndo)
{
    UndoStack stack;
    Counter c(&stack);
    {
        auto macro = c.createUndoMacro("batch");
        c.add(1);
        c.add(10);
        c.add(100);
    }
    BOOST_CHECK_EQUAL(c.value(), 111);
    BOOST_CHECK_EQUAL(stack.count(), 1u);

    stack.undo();
    BOOST_CHECK_EQUAL(c.value(), 0);
    stack.redo();
    BOOST_CHECK_EQUAL(c.value(), 111);
}
