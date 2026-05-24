/* -------------------------------------------------------------------------
 * Lean Qt-free WASM entry point for the sketcher.
 *
 * Spike for the "Sketcher Qt removal" plan: exposes a minimal embind surface
 * over rdkit_extensions to prove a Qt-free WASM bundle is viable.
 *
 * Copyright Schrodinger LLC, All Rights Reserved.
 --------------------------------------------------------------------------- */

#include <cstddef>
#include <sstream>
#include <string>
#include <unordered_map>
#include <utility>

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <GraphMol/Atom.h>
#include <GraphMol/Bond.h>
#include <GraphMol/Conformer.h>
#include <GraphMol/RWMol.h>

#include "schrodinger/rdkit_extensions/convert.h"
#include "schrodinger/rdkit_extensions/coord_utils.h"
#include "schrodinger/rdkit_extensions/file_format.h"

#include "schrodinger/sketcher_core/observer.h"
#include "schrodinger/sketcher_core/undo_stack.h"
#include "schrodinger/sketcher_core/undoable_model.h"

namespace
{

using schrodinger::rdkit_extensions::compute2DCoords;
using schrodinger::rdkit_extensions::Format;
using schrodinger::rdkit_extensions::to_rdkit;

std::string render_description_from_text(const std::string& text,
                                         const Format format)
{
    auto mol = to_rdkit(text, format);
    if (!mol || mol->getNumAtoms() == 0) {
        return R"({"atoms":[],"bonds":[]})";
    }
    compute2DCoords(*mol);
    const auto& conf = mol->getConformer();

    std::ostringstream os;
    os.precision(4);
    os << std::fixed;

    os << "{\"atoms\":[";
    for (unsigned int i = 0; i < mol->getNumAtoms(); ++i) {
        const auto& p = conf.getAtomPos(i);
        if (i > 0) {
            os << ',';
        }
        os << "{\"i\":" << i << ",\"el\":\""
           << mol->getAtomWithIdx(i)->getSymbol() << "\",\"x\":" << p.x
           << ",\"y\":" << p.y << '}';
    }
    os << "],\"bonds\":[";
    for (unsigned int i = 0; i < mol->getNumBonds(); ++i) {
        const auto* b = mol->getBondWithIdx(i);
        if (i > 0) {
            os << ',';
        }
        os << "{\"a\":" << b->getBeginAtomIdx()
           << ",\"b\":" << b->getEndAtomIdx()
           << ",\"o\":" << b->getBondTypeAsDouble() << '}';
    }
    os << "]}";
    return os.str();
}

std::string render_description_from_smiles(const std::string& smiles)
{
    return render_description_from_text(smiles, Format::SMILES);
}

// -- Phase 0 spike consumer ------------------------------------------------
// A trivial undoable model demonstrating that sketcher_core::UndoableModel +
// UndoStack + Signal compose into an end-to-end pattern with no Qt. Exposed
// via embind so it can be poked from the browser:
//
//   const c = new Module.Counter();
//   c.onChanged(n => console.log("value =", n));
//   c.add(5); c.add(3); c.undo();          // -> 5, 8, 5
//   Module.disposeCounter(c);              // free C++ side
//
// Replaces a hypothetical QObject + Q_SIGNAL + QUndoStack triplet.

using schrodinger::sketcher_core::Connection;
using schrodinger::sketcher_core::Signal;
using schrodinger::sketcher_core::UndoableModel;
using schrodinger::sketcher_core::UndoStack;

class Counter : public UndoableModel
{
  public:
    Counter() : UndoableModel(&m_owned_stack)
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
        doCommand(std::move(redo), std::move(undo),
                  "Add " + std::to_string(delta));
    }

    void undoLast()
    {
        undoStack()->undo();
    }
    void redoLast()
    {
        undoStack()->redo();
    }

    Signal<int> changed;

  private:
    int m_value = 0;
    UndoStack m_owned_stack;
};

// embind doesn't bind C++ class members of arbitrary types directly, so the
// Signal is reached through a small wrapper that returns the active Connection
// to JS. JS holds a "pseudo-handle" (just the index) and disposes via
// counter_disconnect(handle).
struct CounterConnections {
    std::size_t next_id = 1;
    std::unordered_map<std::size_t, Connection> handles;
};

CounterConnections& connections()
{
    static CounterConnections inst;
    return inst;
}

std::size_t counter_subscribe(Counter& c, emscripten::val callback)
{
    auto id = connections().next_id++;
    connections().handles.emplace(
        id,
        c.changed.connect([callback](int value) mutable { callback(value); }));
    return id;
}

void counter_unsubscribe(std::size_t handle)
{
    connections().handles.erase(handle);
}

} // namespace

EMSCRIPTEN_BINDINGS(sketcher_lean)
{
    emscripten::enum_<Format>("Format")
        .value("AUTO_DETECT", Format::AUTO_DETECT)
        .value("SMILES", Format::SMILES)
        .value("EXTENDED_SMILES", Format::EXTENDED_SMILES)
        .value("MDL_MOLV2000", Format::MDL_MOLV2000)
        .value("MDL_MOLV3000", Format::MDL_MOLV3000)
        .value("INCHI", Format::INCHI)
        .value("HELM", Format::HELM)
        .value("FASTA_PEPTIDE", Format::FASTA_PEPTIDE);

    emscripten::function("render_description_from_smiles",
                         &render_description_from_smiles);
    emscripten::function("render_description_from_text",
                         &render_description_from_text);

    // Phase 0 spike: Qt-free undoable model
    emscripten::class_<Counter>("Counter")
        .constructor<>()
        .function("value", &Counter::value)
        .function("add", &Counter::add)
        .function("undo", &Counter::undoLast)
        .function("redo", &Counter::redoLast);
    emscripten::function("counter_subscribe", &counter_subscribe);
    emscripten::function("counter_unsubscribe", &counter_unsubscribe);
}

int main()
{
    return 0;
}
