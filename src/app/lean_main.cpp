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
#include <GraphMol/Chirality.h>
#include <GraphMol/Conformer.h>
#include <GraphMol/RWMol.h>

#include "schrodinger/rdkit_extensions/convert.h"
#include "schrodinger/rdkit_extensions/coord_utils.h"
#include "schrodinger/rdkit_extensions/file_format.h"

#include "schrodinger/sketcher_core/mol_model.h"
#include "schrodinger/sketcher_core/observer.h"
#include "schrodinger/sketcher_core/undo_stack.h"
#include "schrodinger/sketcher_core/undoable_model.h"

namespace
{

using schrodinger::rdkit_extensions::compute2DCoords;
using schrodinger::rdkit_extensions::Format;
using schrodinger::rdkit_extensions::to_rdkit;

/**
 * Serialize an RDKit mol to the JSON render description shape expected by
 * lean.html and Playwright. The caller is responsible for ensuring `mol` has
 * a conformer — typically by calling compute2DCoords first for parsed mols,
 * or by relying on the model to maintain coords for interactive ones.
 *
 * When `model` is non-null, atoms and bonds carry a `"sel": true` flag when
 * they're in the model's selection set. Parsed-from-SMILES callers pass null.
 */
std::string mol_to_render_description(
    const RDKit::RWMol& mol,
    const schrodinger::sketcher_core::MolModel* model = nullptr)
{
    if (mol.getNumAtoms() == 0) {
        return R"({"atoms":[],"bonds":[]})";
    }
    const auto& conf = mol.getConformer();

    std::ostringstream os;
    os.precision(4);
    os << std::fixed;

    os << "{\"atoms\":[";
    for (unsigned int i = 0; i < mol.getNumAtoms(); ++i) {
        const auto* atom = mol.getAtomWithIdx(i);
        const auto& p = conf.getAtomPos(i);
        if (i > 0) {
            os << ',';
        }
        os << "{\"i\":" << i << ",\"el\":\"" << atom->getSymbol()
           << "\",\"x\":" << p.x << ",\"y\":" << p.y;
        // Chemistry annotations — emitted only when non-default to keep the
        // JSON shape minimal for the common case (neutral C/H/O/N skeletons).
        const int charge = atom->getFormalCharge();
        if (charge != 0) {
            os << ",\"q\":" << charge;
        }
        int nh = 0;
        try {
            // Total H = explicit + implicit. Implicit Hs require an up-to-date
            // property cache, which doMutation refreshes for the interactive
            // path and render_description_from_text refreshes for the SMILES
            // path. Defaults to 0 if the cache is unavailable.
            nh = atom->getTotalNumHs();
        } catch (...) {
            nh = 0;
        }
        if (nh != 0) {
            os << ",\"nh\":" << nh;
        }
        const unsigned iso = atom->getIsotope();
        if (iso != 0) {
            os << ",\"iso\":" << iso;
        }
        if (atom->getIsAromatic()) {
            os << ",\"arom\":true";
        }
        if (model != nullptr && model->isAtomSelected(i)) {
            os << ",\"sel\":true";
        }
        os << '}';
    }
    os << "],\"bonds\":[";
    for (unsigned int i = 0; i < mol.getNumBonds(); ++i) {
        const auto* b = mol.getBondWithIdx(i);
        if (i > 0) {
            os << ',';
        }
        os << "{\"a\":" << b->getBeginAtomIdx()
           << ",\"b\":" << b->getEndAtomIdx()
           << ",\"o\":" << b->getBondTypeAsDouble();
        const auto dir = b->getBondDir();
        if (dir != RDKit::Bond::BondDir::NONE) {
            // Cast to underlying enum value — JS side knows the encoding
            // (1=BEGINWEDGE, 2=BEGINDASH, ...). Omitted for the common
            // NONE case to keep the description shape minimal.
            os << ",\"dir\":" << static_cast<int>(dir);
        }
        if (b->getIsAromatic()) {
            os << ",\"arom\":true";
        }
        if (model != nullptr && model->isBondSelected(i)) {
            os << ",\"sel\":true";
        }
        os << '}';
    }
    os << "]}";
    return os.str();
}

std::string render_description_from_text(const std::string& text,
                                         const Format format)
{
    auto mol = to_rdkit(text, format);
    if (!mol) {
        return R"({"atoms":[],"bonds":[]})";
    }
    RDKit::RWMol rw(*mol);
    if (rw.getNumAtoms() > 0) {
        compute2DCoords(rw);
        // Refresh implicit-valence cache so mol_to_render_description can
        // read getTotalNumHs without sanitizing. strict=false tolerates
        // hypervalent inputs the user might paste in.
        try {
            rw.updatePropertyCache(/*strict=*/false);
        } catch (...) {
            // Swallow: render will fall back to nh=0 for affected atoms.
        }
        // Translate parsed CIP chirality into 2D wedge/dash bond dirs so
        // SMILES like [C@@H](F)(Cl)Br renders with a wedge. Swallow on
        // failure — fallback is flat bonds, which is still readable.
        try {
            RDKit::Chirality::wedgeMolBonds(rw, &rw.getConformer());
        } catch (...) {
        }
    }
    return mol_to_render_description(rw);
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
using schrodinger::sketcher_core::MolModel;
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

// -- Phase 0 spike: Qt-free MolModel -------------------------------------
// Thin browser-facing wrapper around sketcher_core::MolModel. Owns its own
// UndoStack so JS can `new Module.MolModel()` without juggling lifetimes.
//
//   const m = new Module.MolModel();
//   m.addAtom("C", 0, 0); m.addAtom("O", 1.5, 0); m.addBond(0, 1, 1);
//   m.undo();
//   const json = JSON.parse(m.description());

class MolModelJS
{
  public:
    MolModelJS() : m_model(&m_stack)
    {
    }

    void addAtom(const std::string& element, double x, double y)
    {
        m_model.addAtom(element, x, y);
    }
    void addBond(unsigned int begin, unsigned int end, int bond_type)
    {
        m_model.addBond(begin, end,
                        static_cast<RDKit::Bond::BondType>(bond_type));
    }
    void addBondWithDir(unsigned int begin, unsigned int end, int bond_type,
                        int dir)
    {
        m_model.addBondWithDir(
            begin, end, static_cast<RDKit::Bond::BondType>(bond_type),
            static_cast<RDKit::Bond::BondDir>(dir));
    }
    void removeAtom(unsigned int idx)
    {
        m_model.removeAtom(idx);
    }
    void removeBond(unsigned int begin, unsigned int end)
    {
        m_model.removeBond(begin, end);
    }
    void clear()
    {
        m_model.clear();
    }
    void setAtomPos(unsigned int idx, double x, double y)
    {
        m_model.setAtomPos(idx, x, y);
    }
    void moveAtomUndoable(unsigned int idx, double from_x, double from_y,
                          double to_x, double to_y)
    {
        m_model.moveAtomUndoable(idx, from_x, from_y, to_x, to_y);
    }
    void moveAtomsUndoable(emscripten::val indices, emscripten::val from_xs,
                           emscripten::val from_ys, emscripten::val to_xs,
                           emscripten::val to_ys)
    {
        // Convert four parallel JS arrays into C++ vectors. emscripten::val
        // arrays expose ["length"] + indexed access; the explicit loop is
        // simpler than wrestling with register_vector wrappers.
        const auto n = indices["length"].as<unsigned int>();
        std::vector<unsigned int> idx(n);
        std::vector<double> fx(n);
        std::vector<double> fy(n);
        std::vector<double> tx(n);
        std::vector<double> ty(n);
        for (unsigned int i = 0; i < n; ++i) {
            idx[i] = indices[i].as<unsigned int>();
            fx[i] = from_xs[i].as<double>();
            fy[i] = from_ys[i].as<double>();
            tx[i] = to_xs[i].as<double>();
            ty[i] = to_ys[i].as<double>();
        }
        m_model.moveAtomsUndoable(idx, fx, fy, tx, ty);
    }
    void setBondDirUndoable(unsigned int begin, unsigned int end, int dir)
    {
        m_model.setBondDirUndoable(
            begin, end, static_cast<RDKit::Bond::BondDir>(dir));
    }
    void setBondDirForSelectedBonds(int dir)
    {
        m_model.setBondDirForSelectedBonds(
            static_cast<RDKit::Bond::BondDir>(dir));
    }
    void addRing(unsigned int size, double cx, double cy, bool aromatic)
    {
        m_model.addRing(size, cx, cy, aromatic);
    }
    void rotateSelectedAtoms(double angle_rad)
    {
        m_model.rotateSelectedAtoms(angle_rad);
    }
    void flipSelectedAtoms(bool horizontal)
    {
        m_model.flipSelectedAtoms(horizontal);
    }
    void adjustChargeOnSelectedAtoms(int delta)
    {
        m_model.adjustChargeOnSelectedAtoms(delta);
    }
    void loadFromSmiles(const std::string& smiles)
    {
        m_model.loadFromSmiles(smiles);
    }
    void loadFromText(const std::string& text)
    {
        m_model.loadFromText(text);
    }
    std::string toSmiles() const
    {
        return m_model.toSmiles();
    }
    std::string toMolBlock(bool v3000) const
    {
        return m_model.toMolBlock(v3000);
    }
    void addHydrogens()
    {
        m_model.addHydrogens();
    }
    void removeHydrogens()
    {
        m_model.removeHydrogens();
    }
    void aromatize()
    {
        m_model.aromatize();
    }
    void kekulize()
    {
        m_model.kekulize();
    }
    void cleanUp()
    {
        m_model.cleanUp();
    }
    void undo()
    {
        m_stack.undo();
    }
    void redo()
    {
        m_stack.redo();
    }
    unsigned int numAtoms() const
    {
        return m_model.numAtoms();
    }
    unsigned int numBonds() const
    {
        return m_model.numBonds();
    }

    // -- Selection (transient UI state, not undoable) ---------------------
    void setAtomSelected(unsigned int idx, bool selected)
    {
        m_model.setAtomSelected(idx, selected);
    }
    void setBondSelected(unsigned int idx, bool selected)
    {
        m_model.setBondSelected(idx, selected);
    }
    bool isAtomSelected(unsigned int idx) const
    {
        return m_model.isAtomSelected(idx);
    }
    bool isBondSelected(unsigned int idx) const
    {
        return m_model.isBondSelected(idx);
    }
    bool hasSelection() const
    {
        return m_model.hasSelection();
    }
    void selectAll()
    {
        m_model.selectAll();
    }
    void clearSelection()
    {
        m_model.clearSelection();
    }
    void deleteSelected()
    {
        m_model.deleteSelected();
    }

    std::string description() const
    {
        return mol_to_render_description(m_model.mol(), &m_model);
    }

    Signal<>& modelChangedSignal()
    {
        return m_model.modelChanged;
    }
    Signal<>& selectionChangedSignal()
    {
        return m_model.selectionChanged;
    }

  private:
    UndoStack m_stack;
    MolModel m_model;
};

struct MolModelConnections {
    std::size_t next_id = 1;
    std::unordered_map<std::size_t, Connection> handles;
};

MolModelConnections& mol_model_connections()
{
    static MolModelConnections inst;
    return inst;
}

std::size_t mol_model_subscribe(MolModelJS& m, emscripten::val callback)
{
    auto id = mol_model_connections().next_id++;
    mol_model_connections().handles.emplace(
        id,
        m.modelChangedSignal().connect([callback]() mutable { callback(); }));
    return id;
}

void mol_model_unsubscribe(std::size_t handle)
{
    mol_model_connections().handles.erase(handle);
}

// Separate registry for selection subscriptions — selection is a distinct
// signal and JS-side handlers usually want to react independently of
// modelChanged.
struct MolModelSelectionConnections {
    std::size_t next_id = 1;
    std::unordered_map<std::size_t, Connection> handles;
};

MolModelSelectionConnections& mol_model_selection_connections()
{
    static MolModelSelectionConnections inst;
    return inst;
}

std::size_t mol_model_selection_subscribe(MolModelJS& m,
                                          emscripten::val callback)
{
    auto id = mol_model_selection_connections().next_id++;
    mol_model_selection_connections().handles.emplace(
        id, m.selectionChangedSignal().connect(
                [callback]() mutable { callback(); }));
    return id;
}

void mol_model_selection_unsubscribe(std::size_t handle)
{
    mol_model_selection_connections().handles.erase(handle);
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

    // Phase 0 spike: Qt-free MolModel
    emscripten::class_<MolModelJS>("MolModel")
        .constructor<>()
        .function("addAtom", &MolModelJS::addAtom)
        .function("addBond", &MolModelJS::addBond)
        .function("addBondWithDir", &MolModelJS::addBondWithDir)
        .function("removeAtom", &MolModelJS::removeAtom)
        .function("removeBond", &MolModelJS::removeBond)
        .function("clear", &MolModelJS::clear)
        .function("setAtomPos", &MolModelJS::setAtomPos)
        .function("moveAtomUndoable", &MolModelJS::moveAtomUndoable)
        .function("moveAtomsUndoable", &MolModelJS::moveAtomsUndoable)
        .function("setBondDirUndoable", &MolModelJS::setBondDirUndoable)
        .function("setBondDirForSelectedBonds",
                  &MolModelJS::setBondDirForSelectedBonds)
        .function("addRing", &MolModelJS::addRing)
        .function("rotateSelectedAtoms", &MolModelJS::rotateSelectedAtoms)
        .function("flipSelectedAtoms", &MolModelJS::flipSelectedAtoms)
        .function("adjustChargeOnSelectedAtoms",
                  &MolModelJS::adjustChargeOnSelectedAtoms)
        .function("loadFromSmiles", &MolModelJS::loadFromSmiles)
        .function("loadFromText", &MolModelJS::loadFromText)
        .function("toSmiles", &MolModelJS::toSmiles)
        .function("toMolBlock", &MolModelJS::toMolBlock)
        .function("addHydrogens", &MolModelJS::addHydrogens)
        .function("removeHydrogens", &MolModelJS::removeHydrogens)
        .function("aromatize", &MolModelJS::aromatize)
        .function("kekulize", &MolModelJS::kekulize)
        .function("cleanUp", &MolModelJS::cleanUp)
        .function("undo", &MolModelJS::undo)
        .function("redo", &MolModelJS::redo)
        .function("numAtoms", &MolModelJS::numAtoms)
        .function("numBonds", &MolModelJS::numBonds)
        .function("setAtomSelected", &MolModelJS::setAtomSelected)
        .function("setBondSelected", &MolModelJS::setBondSelected)
        .function("isAtomSelected", &MolModelJS::isAtomSelected)
        .function("isBondSelected", &MolModelJS::isBondSelected)
        .function("hasSelection", &MolModelJS::hasSelection)
        .function("selectAll", &MolModelJS::selectAll)
        .function("clearSelection", &MolModelJS::clearSelection)
        .function("deleteSelected", &MolModelJS::deleteSelected)
        .function("description", &MolModelJS::description);
    emscripten::function("mol_model_subscribe", &mol_model_subscribe);
    emscripten::function("mol_model_unsubscribe", &mol_model_unsubscribe);
    emscripten::function("mol_model_selection_subscribe",
                         &mol_model_selection_subscribe);
    emscripten::function("mol_model_selection_unsubscribe",
                         &mol_model_selection_unsubscribe);
}

int main()
{
    return 0;
}
