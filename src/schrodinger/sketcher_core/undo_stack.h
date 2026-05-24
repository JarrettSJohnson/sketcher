#pragma once

#include <cstddef>
#include <memory>
#include <string>
#include <vector>

namespace schrodinger
{
namespace sketcher_core
{

/**
 * Qt-free counterpart to QUndoCommand. Subclasses implement redo() and undo().
 */
class UndoCommand
{
  public:
    explicit UndoCommand(std::string description) :
        m_description(std::move(description))
    {
    }
    virtual ~UndoCommand() = default;

    UndoCommand(const UndoCommand&) = delete;
    UndoCommand& operator=(const UndoCommand&) = delete;

    virtual void redo() = 0;
    virtual void undo() = 0;

    const std::string& description() const
    {
        return m_description;
    }

  private:
    std::string m_description;
};

/**
 * A composite command holding child commands — backing store for
 * beginMacro/endMacro on UndoStack. redo() applies children in order;
 * undo() reverses.
 */
class MacroUndoCommand : public UndoCommand
{
  public:
    explicit MacroUndoCommand(std::string description) :
        UndoCommand(std::move(description))
    {
    }

    void addChild(std::unique_ptr<UndoCommand> child);
    bool empty() const
    {
        return m_children.empty();
    }

    void redo() override;
    void undo() override;

  private:
    std::vector<std::unique_ptr<UndoCommand>> m_children;
};

/**
 * Qt-free counterpart to QUndoStack.
 *
 * push() immediately invokes the command's redo() (matching QUndoStack
 * semantics), then stores the command. undo()/redo() walk an index through
 * m_commands.
 *
 * beginMacro/endMacro accumulate pushed commands into a MacroUndoCommand that
 * is then committed to the stack as a single undoable unit on endMacro. Nesting
 * is supported. Empty macros are dropped.
 */
class UndoStack
{
  public:
    UndoStack() = default;
    UndoStack(const UndoStack&) = delete;
    UndoStack& operator=(const UndoStack&) = delete;

    void push(std::unique_ptr<UndoCommand> cmd);

    bool canUndo() const
    {
        return m_index > 0;
    }
    bool canRedo() const
    {
        return m_index < m_commands.size();
    }

    void undo();
    void redo();

    void clear();

    std::size_t count() const
    {
        return m_commands.size();
    }
    std::size_t index() const
    {
        return m_index;
    }

    void beginMacro(const std::string& description);
    void endMacro();
    bool inMacro() const
    {
        return !m_macro_stack.empty();
    }

  private:
    std::vector<std::unique_ptr<UndoCommand>> m_commands;
    std::size_t m_index = 0; // points to slot just past the last redone command
    std::vector<std::unique_ptr<MacroUndoCommand>> m_macro_stack;

    void commitTopLevel(std::unique_ptr<UndoCommand> cmd);
};

/**
 * RAII wrapper around UndoStack::beginMacro/endMacro. Construct in a scope to
 * open a macro; the destructor closes it. Moving transfers ownership of the
 * close.
 */
class UndoMacroRAII
{
  public:
    UndoMacroRAII(UndoStack* stack, const std::string& description);

    UndoMacroRAII(UndoMacroRAII&& other) noexcept;
    UndoMacroRAII(const UndoMacroRAII&) = delete;
    UndoMacroRAII& operator=(const UndoMacroRAII&) = delete;
    UndoMacroRAII& operator=(UndoMacroRAII&&) = delete;

    ~UndoMacroRAII();

  private:
    UndoStack* m_stack;
};

} // namespace sketcher_core
} // namespace schrodinger
