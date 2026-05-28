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
#include <GraphMol/CIPLabeler/CIPLabeler.h>
#include <GraphMol/Conformer.h>
#include <GraphMol/FileParsers/MolFileStereochem.h>
#include <GraphMol/MolOps.h>
#include <GraphMol/RWMol.h>

#include "schrodinger/rdkit_extensions/convert.h"
#include "schrodinger/rdkit_extensions/coord_utils.h"
#include "schrodinger/rdkit_extensions/file_format.h"
#include "schrodinger/rdkit_extensions/rgroup.h"
#include "schrodinger/rdkit_extensions/stereochemistry.h"

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
 * Compute the per-atom chirality label for `atom`. Reads
 * RDKit::common_properties::atomNote, which `addStereoAnnotations`
 * populates with the format strings we hand it in apply_stereo_annotations
 * (`"abs (R)"` for absolute centers, `"or1"` / `"and1"` for enhanced groups).
 * The raw label is returned with the `ABSOLUTE_STEREO_PREFIX` intact — the
 * JS render layer decides whether to display it (matches Qt's
 * `m_explicit_abs_labels_shown` toggle, which is exposed in the React
 * Preferences modal as "Use 'ABS' prefix").
 */
std::string atom_chirality_label(const RDKit::Atom& atom)
{
    std::string label;
    if (!atom.getPropIfPresent<std::string>(RDKit::common_properties::atomNote,
                                            label)) {
        return "";
    }
    return label;
}

/**
 * Run the stereo-perception pipeline that populates per-atom CIP labels:
 *   1. assignStereochemistry — perceives chirality from bond dirs + coords
 *   2. CIPLabeler::assignCIPLabels — computes R/S codes
 *   3. Chirality::addStereoAnnotations — writes "(R)" / "(S)" / etc. to
 *      RDKit::common_properties::atomNote on each chiral atom
 *
 * Mirrors Qt's update_molecule_on_change (rdkit/mol_update.cpp:236-298),
 * minus the StereoGroup / sgroup machinery the lean bundle doesn't surface.
 * Swallows CIPLabeler exceptions (matches Qt) so a timeout on a single
 * problem mol doesn't blank the whole render.
 */
void apply_stereo_annotations(RDKit::RWMol& mol)
{
    if (mol.getNumAtoms() == 0) {
        return;
    }
    // assignStereochemistry(cleanIt=true) wipes user-set wedge/dash/wavy
    // bond directions when no stereo center is detected on the endpoint
    // (e.g. wedge dragged onto a non-stereo bond). Snapshot the dirs first
    // so we can restore the user-visible ones afterward. Mirrors Qt's
    // assign_stereochemistry_with_bond_directions_and_coordinates
    // (rdkit/mol_update.cpp:95-152).
    std::vector<RDKit::Bond::BondDir> saved_dirs;
    saved_dirs.reserve(mol.getNumBonds());
    for (auto bond : mol.bonds()) {
        saved_dirs.push_back(bond->getBondDir());
    }
    try {
        RDKit::MolOps::assignStereochemistry(mol, /*cleanIt=*/true,
                                             /*force=*/true,
                                             /*flagPossibleStereoCenters=*/true);
    } catch (...) {
    }
    // Restore the four directions the canvas/SVG renderers special-case.
    // ENDDOWNRIGHT/ENDUPRIGHT (parser-internal markers) are left as
    // assignStereochemistry produced them.
    auto dir_it = saved_dirs.begin();
    for (auto bond : mol.bonds()) {
        const auto saved = *dir_it++;
        if (saved == RDKit::Bond::BondDir::BEGINWEDGE ||
            saved == RDKit::Bond::BondDir::BEGINDASH ||
            saved == RDKit::Bond::BondDir::EITHERDOUBLE ||
            saved == RDKit::Bond::BondDir::UNKNOWN) {
            bond->setBondDir(saved);
        }
    }
    try {
        // 2,000,000 matches Qt's SHARED-11140 limit so equivalent inputs
        // produce equivalent labels across the two builds.
        constexpr unsigned MAX_CYCLES = 2000000;
        RDKit::CIPLabeler::assignCIPLabels(mol, MAX_CYCLES);
    } catch (...) {
    }
    // addStereoAnnotations doesn't clear existing notes — wipe first so
    // a stale label from a previous mutation can't survive into the next
    // render description.
    for (auto atom : mol.atoms()) {
        atom->clearProp(RDKit::common_properties::atomNote);
    }
    // Mirror Qt's add_enhanced_stereo_to_chiral_atoms
    // (sketcher/rdkit/mol_update.cpp:30-46): ensure every ungrouped chiral
    // center is placed in an ABS stereo group. Without this,
    // addStereoAnnotations skips lone stereocenters from plain SMILES like
    // "F[C@H](Cl)Br" and the "abs " prefix never reaches the render
    // description. The MDL chiral flag controls grouping — default to "on"
    // (ABS) when missing, matching SMILES/MAE inputs.
    int chiral_flag{1};
    if (!mol.getPropIfPresent(RDKit::common_properties::_MolFileChiralFlag,
                              chiral_flag)) {
        mol.setProp(RDKit::common_properties::_MolFileChiralFlag, chiral_flag);
    }
    try {
        RDKit::translateChiralFlagToStereoGroups(mol);
    } catch (...) {
    }
    try {
        // Match Qt's label format strings (rdkit/mol_update.cpp:280-283).
        // {cip} gets replaced with the actual R/S code by addStereoAnnotations.
        const std::string abs_label =
            schrodinger::rdkit_extensions::ABSOLUTE_STEREO_PREFIX + "({cip})";
        const std::string or_label =
            schrodinger::rdkit_extensions::OR_STEREO_PREFIX + "{id}";
        const std::string and_label =
            schrodinger::rdkit_extensions::AND_STEREO_PREFIX + "{id}";
        RDKit::Chirality::addStereoAnnotations(mol, abs_label, or_label,
                                               and_label);
    } catch (...) {
    }
}

/**
 * Serialize an RDKit mol to the JSON render description shape expected by
 * lean.html and Playwright. The caller is responsible for ensuring `mol` has
 * a conformer — typically by calling compute2DCoords first for parsed mols,
 * or by relying on the model to maintain coords for interactive ones.
 *
 * When `model` is non-null, atoms and bonds carry a `"sel": true` flag when
 * they're in the model's selection set. Parsed-from-SMILES callers pass null.
 *
 * Takes mol by non-const reference: apply_stereo_annotations writes
 * RDKit::common_properties::atomNote into the mol so we can read R/S
 * labels back out alongside the position/element data. The mutations are
 * idempotent — calling again with the same mol produces the same labels.
 */
std::string mol_to_render_description(
    RDKit::RWMol& mol,
    const schrodinger::sketcher_core::MolModel* model = nullptr)
{
    // Non-molecular objects (reaction arrow + pluses) live outside the RWMol,
    // so even an empty mol may have objects to render when the model carries
    // a reaction scheme. Build that JSON fragment up front so the early-empty
    // path can splice it in too.
    std::string non_mol_fragment;
    if (model != nullptr &&
        (model->hasRxnArrow() || !model->rxnPluses().empty())) {
        std::ostringstream os_nm;
        os_nm.precision(4);
        os_nm << std::fixed;
        os_nm << "\"nonMol\":[";
        bool first = true;
        if (model->hasRxnArrow()) {
            const auto [x, y] = model->rxnArrow();
            os_nm << "{\"type\":\"arrow\",\"x\":" << x << ",\"y\":" << y << "}";
            first = false;
        }
        for (const auto& [x, y] : model->rxnPluses()) {
            if (!first) {
                os_nm << ',';
            }
            os_nm << "{\"type\":\"plus\",\"x\":" << x << ",\"y\":" << y << "}";
            first = false;
        }
        os_nm << "]";
        non_mol_fragment = os_nm.str();
    }
    if (mol.getNumAtoms() == 0) {
        if (non_mol_fragment.empty()) {
            return R"({"atoms":[],"bonds":[]})";
        }
        return R"({"atoms":[],"bonds":[],)" + non_mol_fragment + "}";
    }
    apply_stereo_annotations(mol);
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
        // R-group label: dummy atoms tagged with _MolFileRLabel render as
        // "R<n>" (Qt: atom_display_settings / rgroup atom_label). Emit the
        // numeric label and let the JS renderer paint the "R<n>" text so
        // the export round-trips through MOL block writers automatically.
        // Detected before the iso branch because make_new_r_group sets
        // isotope == r_group_num to keep extended-SMILES round-tripping
        // sane; that isotope value is bookkeeping, not user-visible.
        unsigned int rlabel = 0;
        const bool is_rgroup =
            atom->getAtomicNum() == 0 &&
            atom->getPropIfPresent(RDKit::common_properties::_MolFileRLabel,
                                   rlabel);
        if (is_rgroup) {
            os << ",\"rlabel\":" << rlabel;
        }
        // Attachment point (Qt: atom_item.cpp:302-304 — label_is_visible=false,
        // squiggle drawn perpendicular to the bond). Detected by RDKit's
        // is_attachment_point_dummy (atomic num 0, totalDegree 1, atomLabel
        // starts with "_AP"). Emit the numeric suffix so the JS renderer can
        // suppress the atom dot/label and paint the wavy line itself; this
        // mirrors the rlabel pattern so the renderer's atom-rendering branch
        // stays straightforward.
        if (atom->getAtomicNum() == 0 && !is_rgroup &&
            schrodinger::rdkit_extensions::is_attachment_point_dummy(*atom)) {
            std::string label;
            if (atom->getPropIfPresent(RDKit::common_properties::atomLabel,
                                       label) &&
                label.size() > 3) {
                try {
                    const unsigned int ap_num =
                        static_cast<unsigned int>(std::stoul(label.substr(3)));
                    os << ",\"ap\":" << ap_num;
                } catch (...) {
                    // Stay silent — malformed _AP labels fall through to the
                    // default dummy rendering, matching Qt's defensive path.
                }
            }
        }
        const unsigned iso = atom->getIsotope();
        if (iso != 0 && !is_rgroup) {
            os << ",\"iso\":" << iso;
        }
        if (atom->getIsAromatic()) {
            os << ",\"arom\":true";
        }
        // Valence violation (Qt: AtomItem::determineValenceErrorIsVisible).
        // Cheap call once the property cache is current (every caller
        // refreshes via updatePropertyCache before reaching this serializer).
        try {
            if (atom->hasValenceViolation()) {
                os << ",\"verr\":true";
            }
        } catch (...) {
            // hasValenceViolation can throw if the cache hasn't been
            // refreshed yet (rare given our invariants) — treat that as
            // "no violation known" rather than aborting the whole render.
        }
        // Stereo label (R/S/r/s + enhanced-stereo group ids). Empty for
        // achiral atoms — omit the key in that case to keep JSON small.
        const std::string stereo = atom_chirality_label(*atom);
        if (!stereo.empty()) {
            os << ",\"stereo\":\"";
            // Stereo labels are short ASCII (e.g. "(R)", "(S)", "or1")
            // so plain backslash-escaping for the JSON specials is enough.
            for (char c : stereo) {
                if (c == '"' || c == '\\') {
                    os << '\\';
                }
                os << c;
            }
            os << '"';
        }
        // Possible-but-unspecified stereo center (Qt: get_atom_chirality_label
        // rdkit/stereochemistry.cpp:45-53 — emits "(?)" when show_unspecified).
        // _ChiralityPossible is set by assignStereochemistry(flagPossible=true)
        // above; _CIPCode is set by CIPLabeler::assignCIPLabels for defined
        // centers. JS layer renders "(?)" iff Preferences > Include undefined
        // centers is on (gated by Show stereo labels).
        int chiral_possible = 0;
        atom->getPropIfPresent(RDKit::common_properties::_ChiralityPossible,
                               chiral_possible);
        if (chiral_possible &&
            !atom->hasProp(RDKit::common_properties::_CIPCode)) {
            os << ",\"psbl\":true";
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
    os << "]";
    if (!non_mol_fragment.empty()) {
        os << ',' << non_mol_fragment;
    }
    os << "}";
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
    void addRGroup(unsigned int r_group_num, double x, double y,
                   int bound_to_atom_idx)
    {
        m_model.addRGroup(r_group_num, x, y, bound_to_atom_idx);
    }
    void addAttachmentPoint(unsigned int ap_num, double x, double y,
                            unsigned int bound_to_atom_idx)
    {
        m_model.addAttachmentPoint(ap_num, x, y, bound_to_atom_idx);
    }
    void addRxnArrow(double x, double y)
    {
        m_model.addRxnArrow(x, y);
    }
    void addRxnPlus(double x, double y)
    {
        m_model.addRxnPlus(x, y);
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
    void setBondTypeUndoable(unsigned int begin, unsigned int end, int type)
    {
        m_model.setBondTypeUndoable(
            begin, end, static_cast<RDKit::Bond::BondType>(type));
    }
    void setBondTypeForSelectedBonds(int type)
    {
        m_model.setBondTypeForSelectedBonds(
            static_cast<RDKit::Bond::BondType>(type));
    }
    void addRing(unsigned int size, double cx, double cy, bool aromatic)
    {
        m_model.addRing(size, cx, cy, aromatic);
    }
    void addAtomChain(emscripten::val xs, emscripten::val ys,
                      int bound_to_atom_idx)
    {
        const auto n = xs["length"].as<unsigned int>();
        std::vector<double> cxs(n);
        std::vector<double> cys(n);
        for (unsigned int i = 0; i < n; ++i) {
            cxs[i] = xs[i].as<double>();
            cys[i] = ys[i].as<double>();
        }
        m_model.addAtomChain(cxs, cys, bound_to_atom_idx);
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
    void setSelectedAtomsToHydrogenIsotope(unsigned int isotope)
    {
        m_model.setSelectedAtomsToHydrogenIsotope(isotope);
    }
    void setAtomElement(unsigned int idx, unsigned int atomic_num)
    {
        m_model.setAtomElement(idx, atomic_num);
    }
    void setElementForSelectedAtoms(unsigned int atomic_num)
    {
        m_model.setElementForSelectedAtoms(atomic_num);
    }
    void loadFromSmiles(const std::string& smiles)
    {
        m_model.loadFromSmiles(smiles);
    }
    void loadFromText(const std::string& text)
    {
        m_model.loadFromText(text);
    }
    void addMolFromText(const std::string& text)
    {
        m_model.addMolFromText(text);
    }
    std::string toSmiles() const
    {
        return m_model.toSmiles();
    }
    std::string toMolBlock(bool v3000) const
    {
        return m_model.toMolBlock(v3000);
    }
    std::string toMolBlockForSelection(bool v3000) const
    {
        return m_model.toMolBlockForSelection(v3000);
    }
    std::string toFormatString(const std::string& format_name,
                               bool selection_only) const
    {
        return m_model.toFormatString(format_name, selection_only);
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
        // mol_to_render_description writes stereo annotations into the
        // mol via addStereoAnnotations — copy the model's mol first so
        // the model itself stays unchanged (snapshots are by value, so
        // the labels would otherwise leak into the undo history).
        RDKit::RWMol mol_copy(m_model.mol());
        return mol_to_render_description(mol_copy, &m_model);
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
        .function("addRGroup", &MolModelJS::addRGroup)
        .function("addRxnArrow", &MolModelJS::addRxnArrow)
        .function("addRxnPlus", &MolModelJS::addRxnPlus)
        .function("addAttachmentPoint", &MolModelJS::addAttachmentPoint)
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
        .function("setBondTypeUndoable", &MolModelJS::setBondTypeUndoable)
        .function("setBondTypeForSelectedBonds",
                  &MolModelJS::setBondTypeForSelectedBonds)
        .function("addRing", &MolModelJS::addRing)
        .function("addAtomChain", &MolModelJS::addAtomChain)
        .function("rotateSelectedAtoms", &MolModelJS::rotateSelectedAtoms)
        .function("flipSelectedAtoms", &MolModelJS::flipSelectedAtoms)
        .function("adjustChargeOnSelectedAtoms",
                  &MolModelJS::adjustChargeOnSelectedAtoms)
        .function("setSelectedAtomsToHydrogenIsotope",
                  &MolModelJS::setSelectedAtomsToHydrogenIsotope)
        .function("setAtomElement", &MolModelJS::setAtomElement)
        .function("setElementForSelectedAtoms",
                  &MolModelJS::setElementForSelectedAtoms)
        .function("loadFromSmiles", &MolModelJS::loadFromSmiles)
        .function("loadFromText", &MolModelJS::loadFromText)
        .function("addMolFromText", &MolModelJS::addMolFromText)
        .function("toSmiles", &MolModelJS::toSmiles)
        .function("toMolBlock", &MolModelJS::toMolBlock)
        .function("toMolBlockForSelection",
                  &MolModelJS::toMolBlockForSelection)
        .function("toFormatString", &MolModelJS::toFormatString)
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
