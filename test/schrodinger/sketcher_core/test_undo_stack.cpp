/* -------------------------------------------------------------------------
 * Tests for schrodinger::sketcher_core::UndoStack and friends — the Qt-free
 * QUndoStack/QUndoCommand replacements used by the Phase 0 spike.
 *
 * Copyright Schrodinger LLC, All Rights Reserved.
 --------------------------------------------------------------------------- */

#define BOOST_TEST_MODULE sketcher_core_undo_stack

#include <memory>
#include <string>
#include <vector>

#include <boost/test/unit_test.hpp>

#include "schrodinger/sketcher_core/undo_stack.h"

using schrodinger::sketcher_core::MacroUndoCommand;
using schrodinger::sketcher_core::UndoCommand;
using schrodinger::sketcher_core::UndoMacroRAII;
using schrodinger::sketcher_core::UndoStack;

namespace
{

/**
 * Small command that records its redo/undo calls onto a shared log.
 */
class LoggingCommand : public UndoCommand
{
  public:
    LoggingCommand(std::vector<std::string>& log, std::string tag) :
        UndoCommand(tag),
        m_log(log),
        m_tag(std::move(tag))
    {
    }

    void redo() override
    {
        m_log.push_back("+" + m_tag);
    }
    void undo() override
    {
        m_log.push_back("-" + m_tag);
    }

  private:
    std::vector<std::string>& m_log;
    std::string m_tag;
};

std::unique_ptr<LoggingCommand> make(std::vector<std::string>& log,
                                     std::string tag)
{
    return std::make_unique<LoggingCommand>(log, std::move(tag));
}

} // namespace

BOOST_AUTO_TEST_CASE(testPushExecutesRedoImmediately)
{
    std::vector<std::string> log;
    UndoStack stack;
    stack.push(make(log, "A"));
    BOOST_CHECK_EQUAL(log.size(), 1u);
    BOOST_CHECK_EQUAL(log[0], "+A");
    BOOST_CHECK(stack.canUndo());
    BOOST_CHECK(!stack.canRedo());
}

BOOST_AUTO_TEST_CASE(testUndoAndRedoFlipState)
{
    std::vector<std::string> log;
    UndoStack stack;
    stack.push(make(log, "A"));

    stack.undo();
    BOOST_CHECK_EQUAL(log.back(), "-A");
    BOOST_CHECK(!stack.canUndo());
    BOOST_CHECK(stack.canRedo());

    stack.redo();
    BOOST_CHECK_EQUAL(log.back(), "+A");
    BOOST_CHECK(stack.canUndo());
    BOOST_CHECK(!stack.canRedo());
}

BOOST_AUTO_TEST_CASE(testUndoRedoNoopsWhenNothingToDo)
{
    UndoStack stack;
    BOOST_CHECK(!stack.canUndo());
    BOOST_CHECK(!stack.canRedo());
    stack.undo(); // no throw
    stack.redo(); // no throw
    BOOST_CHECK_EQUAL(stack.count(), 0u);
}

BOOST_AUTO_TEST_CASE(testPushTruncatesRedoableTail)
{
    std::vector<std::string> log;
    UndoStack stack;
    stack.push(make(log, "A"));
    stack.push(make(log, "B"));
    stack.undo();
    BOOST_CHECK(stack.canRedo());

    stack.push(make(log, "C"));
    BOOST_CHECK(!stack.canRedo());
    BOOST_CHECK_EQUAL(stack.count(), 2u);
}

BOOST_AUTO_TEST_CASE(testMacroCollapsesIntoOneUndoUnit)
{
    std::vector<std::string> log;
    UndoStack stack;
    stack.beginMacro("group");
    stack.push(make(log, "A"));
    stack.push(make(log, "B"));
    stack.push(make(log, "C"));
    stack.endMacro();

    BOOST_CHECK_EQUAL(stack.count(), 1u);
    BOOST_CHECK_EQUAL(log.size(), 3u);

    log.clear();
    stack.undo();
    // Undo runs children in reverse.
    BOOST_REQUIRE_EQUAL(log.size(), 3u);
    BOOST_CHECK_EQUAL(log[0], "-C");
    BOOST_CHECK_EQUAL(log[1], "-B");
    BOOST_CHECK_EQUAL(log[2], "-A");
}

BOOST_AUTO_TEST_CASE(testEmptyMacroIsDropped)
{
    UndoStack stack;
    stack.beginMacro("empty");
    stack.endMacro();
    BOOST_CHECK_EQUAL(stack.count(), 0u);
    BOOST_CHECK(!stack.canUndo());
}

BOOST_AUTO_TEST_CASE(testNestedMacrosCollapseIntoOuter)
{
    std::vector<std::string> log;
    UndoStack stack;
    stack.beginMacro("outer");
    stack.push(make(log, "A"));
    stack.beginMacro("inner");
    stack.push(make(log, "B"));
    stack.push(make(log, "C"));
    stack.endMacro();
    stack.push(make(log, "D"));
    stack.endMacro();

    BOOST_CHECK_EQUAL(stack.count(), 1u);

    log.clear();
    stack.undo();
    // Outer undo runs in reverse: D, inner-macro (which itself reverses C,B), A
    BOOST_REQUIRE_EQUAL(log.size(), 4u);
    BOOST_CHECK_EQUAL(log[0], "-D");
    BOOST_CHECK_EQUAL(log[1], "-C");
    BOOST_CHECK_EQUAL(log[2], "-B");
    BOOST_CHECK_EQUAL(log[3], "-A");
}

BOOST_AUTO_TEST_CASE(testEndMacroWithoutBeginThrows)
{
    UndoStack stack;
    BOOST_CHECK_THROW(stack.endMacro(), std::runtime_error);
}

BOOST_AUTO_TEST_CASE(testClearWhileMacroOpenThrows)
{
    UndoStack stack;
    stack.beginMacro("x");
    BOOST_CHECK_THROW(stack.clear(), std::runtime_error);
    stack.endMacro();
}

BOOST_AUTO_TEST_CASE(testRaiiHelperEndsMacroOnScopeExit)
{
    std::vector<std::string> log;
    UndoStack stack;
    {
        UndoMacroRAII guard(&stack, "raii");
        stack.push(make(log, "A"));
        stack.push(make(log, "B"));
    }
    BOOST_CHECK_EQUAL(stack.count(), 1u);
    BOOST_CHECK(!stack.inMacro());
}

BOOST_AUTO_TEST_CASE(testRaiiMoveTransfersResponsibility)
{
    std::vector<std::string> log;
    UndoStack stack;
    {
        UndoMacroRAII outer(&stack, "raii");
        stack.push(make(log, "A"));
        UndoMacroRAII inner = std::move(outer);
        stack.push(make(log, "B"));
        // outer is moved-from and a no-op on destruction; inner will end the
        // macro at the closing brace.
    }
    BOOST_CHECK_EQUAL(stack.count(), 1u);
    BOOST_CHECK(!stack.inMacro());
}
