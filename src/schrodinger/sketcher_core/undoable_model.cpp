#include "schrodinger/sketcher_core/undoable_model.h"

#include <memory>
#include <stdexcept>
#include <utility>

namespace schrodinger
{
namespace sketcher_core
{

AllowEditsScope::AllowEditsScope(UndoableModel* model) :
    m_model(model),
    m_was_allowing(model->m_allow_edits)
{
    m_model->m_allow_edits = true;
}

AllowEditsScope::~AllowEditsScope()
{
    m_model->m_allow_edits = m_was_allowing;
}

namespace
{

/**
 * Concrete UndoCommand backing UndoableModel::doCommand. Holds the redo/undo
 * lambdas and uses an AllowEditsScope to enable signal emission while running.
 */
class LambdaUndoableCommand : public UndoCommand
{
  public:
    LambdaUndoableCommand(UndoableModel* model, std::function<void()> redo_fn,
                          std::function<void()> undo_fn,
                          std::string description) :
        UndoCommand(std::move(description)),
        m_model(model),
        m_redo(std::move(redo_fn)),
        m_undo(std::move(undo_fn))
    {
    }

    void redo() override
    {
        run(m_redo);
    }
    void undo() override
    {
        run(m_undo);
    }

  private:
    void run(const std::function<void()>& fn) const
    {
        AllowEditsScope scope(m_model);
        fn();
    }

    UndoableModel* m_model;
    std::function<void()> m_redo;
    std::function<void()> m_undo;
};

} // namespace

UndoableModel::UndoableModel(UndoStack* undo_stack) : m_undo_stack(undo_stack)
{
}

void UndoableModel::setUndoStack(UndoStack* stack)
{
    m_undo_stack = stack;
}

void UndoableModel::doCommand(std::function<void()> redo,
                              std::function<void()> undo,
                              const std::string& description)
{
    throwIfAlreadyAllowingEdits();
    auto cmd = std::make_unique<LambdaUndoableCommand>(
        this, std::move(redo), std::move(undo), description);
    m_undo_stack->push(std::move(cmd));
}

void UndoableModel::throwIfAlreadyAllowingEdits()
{
    if (m_allow_edits) {
        throw std::runtime_error(
            "Cannot create a command while already in edit mode.");
    }
}

UndoMacroRAII UndoableModel::createUndoMacro(const std::string& description)
{
    return UndoMacroRAII(m_undo_stack, description);
}

void UndoableModel::beginUndoMacro(const std::string& description)
{
    m_undo_stack->beginMacro(description);
}

void UndoableModel::endUndoMacro()
{
    m_undo_stack->endMacro();
}

} // namespace sketcher_core
} // namespace schrodinger
