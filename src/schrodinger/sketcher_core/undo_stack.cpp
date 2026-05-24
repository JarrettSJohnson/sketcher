#include "schrodinger/sketcher_core/undo_stack.h"

#include <stdexcept>
#include <utility>

namespace schrodinger
{
namespace sketcher_core
{

void MacroUndoCommand::addChild(std::unique_ptr<UndoCommand> child)
{
    m_children.push_back(std::move(child));
}

void MacroUndoCommand::redo()
{
    for (auto& child : m_children) {
        child->redo();
    }
}

void MacroUndoCommand::undo()
{
    for (auto it = m_children.rbegin(); it != m_children.rend(); ++it) {
        (*it)->undo();
    }
}

void UndoStack::push(std::unique_ptr<UndoCommand> cmd)
{
    // Execute immediately so callers see the result, matching QUndoStack.
    cmd->redo();

    if (inMacro()) {
        m_macro_stack.back()->addChild(std::move(cmd));
    } else {
        commitTopLevel(std::move(cmd));
    }
}

void UndoStack::commitTopLevel(std::unique_ptr<UndoCommand> cmd)
{
    // Truncate any redoable tail before appending.
    m_commands.erase(m_commands.begin() + m_index, m_commands.end());
    m_commands.push_back(std::move(cmd));
    m_index = m_commands.size();
}

void UndoStack::undo()
{
    if (!canUndo()) {
        return;
    }
    --m_index;
    m_commands[m_index]->undo();
}

void UndoStack::redo()
{
    if (!canRedo()) {
        return;
    }
    m_commands[m_index]->redo();
    ++m_index;
}

void UndoStack::clear()
{
    if (inMacro()) {
        throw std::runtime_error(
            "UndoStack::clear() called while a macro is open");
    }
    m_commands.clear();
    m_index = 0;
}

void UndoStack::beginMacro(const std::string& description)
{
    m_macro_stack.push_back(std::make_unique<MacroUndoCommand>(description));
}

void UndoStack::endMacro()
{
    if (m_macro_stack.empty()) {
        throw std::runtime_error(
            "UndoStack::endMacro() called without a matching beginMacro");
    }
    auto macro = std::move(m_macro_stack.back());
    m_macro_stack.pop_back();
    if (macro->empty()) {
        return;
    }
    if (inMacro()) {
        m_macro_stack.back()->addChild(std::move(macro));
    } else {
        commitTopLevel(std::move(macro));
    }
}

UndoMacroRAII::UndoMacroRAII(UndoStack* stack, const std::string& description) :
    m_stack(stack)
{
    m_stack->beginMacro(description);
}

UndoMacroRAII::UndoMacroRAII(UndoMacroRAII&& other) noexcept :
    m_stack(other.m_stack)
{
    other.m_stack = nullptr;
}

UndoMacroRAII::~UndoMacroRAII()
{
    if (m_stack) {
        m_stack->endMacro();
    }
}

} // namespace sketcher_core
} // namespace schrodinger
