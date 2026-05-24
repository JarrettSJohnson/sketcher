#pragma once

#include <functional>
#include <string>

#include "schrodinger/sketcher_core/undo_stack.h"

namespace schrodinger
{
namespace sketcher_core
{

class UndoableModel;

/**
 * RAII scope that flips UndoableModel::m_allow_edits to true while alive.
 *
 * Used by command implementations (see undoable_model.cpp) to gate signal
 * emission and to detect attempts to create a command from within a command —
 * which would crash on redo and is therefore made to throw immediately.
 */
class AllowEditsScope
{
  public:
    explicit AllowEditsScope(UndoableModel* model);
    ~AllowEditsScope();

    AllowEditsScope(const AllowEditsScope&) = delete;
    AllowEditsScope& operator=(const AllowEditsScope&) = delete;
    AllowEditsScope(AllowEditsScope&&) = delete;
    AllowEditsScope& operator=(AllowEditsScope&&) = delete;

  private:
    UndoableModel* m_model;
    bool m_was_allowing;
};

/**
 * Qt-free counterpart to AbstractUndoableModel.
 *
 * Derived classes call doCommand(redo, undo, description) to record undoable
 * edits. Each Signal<...> member of the derived class should be emitted via
 * emitSignal(sig, args...) so that emissions outside a redo/undo are silently
 * dropped — matching the original blockSignals(true) bug-catcher pattern.
 *
 * Lifecycle: the UndoStack pointer is non-owning. Callers wire one stack to
 * one or many models.
 */
class UndoableModel
{
  public:
    explicit UndoableModel(UndoStack* undo_stack = nullptr);
    virtual ~UndoableModel() = default;

    UndoableModel(const UndoableModel&) = delete;
    UndoableModel& operator=(const UndoableModel&) = delete;

    void setUndoStack(UndoStack* stack);
    UndoStack* undoStack() const
    {
        return m_undo_stack;
    }

    UndoMacroRAII createUndoMacro(const std::string& description);
    void beginUndoMacro(const std::string& description);
    void endUndoMacro();

  protected:
    void doCommand(std::function<void()> redo, std::function<void()> undo,
                   const std::string& description);

    /**
     * Emit a Signal only when inside a redo/undo. Skips silently otherwise,
     * which catches the common bug of emitting from command-creation code
     * instead of from inside the lambda.
     */
    template <typename SignalT, typename... Args>
    void emitSignal(const SignalT& sig, Args&&... args) const
    {
        if (m_allow_edits) {
            sig.emit(std::forward<Args>(args)...);
        }
    }

  private:
    void throwIfAlreadyAllowingEdits();

    UndoStack* m_undo_stack;
    bool m_allow_edits = false;

    friend class AllowEditsScope;
};

} // namespace sketcher_core
} // namespace schrodinger
