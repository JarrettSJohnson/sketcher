/* -------------------------------------------------------------------------
 * Lean Qt-free WASM entry point for the sketcher.
 *
 * Spike for the "Sketcher Qt removal" plan: exposes a minimal embind surface
 * over rdkit_extensions to prove a Qt-free WASM bundle is viable.
 *
 * Copyright Schrodinger LLC, All Rights Reserved.
 --------------------------------------------------------------------------- */

#include <array>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <optional>
#include <sstream>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <GraphMol/Atom.h>
#include <GraphMol/Bond.h>
#include <GraphMol/Chirality.h>
#include <GraphMol/CIPLabeler/CIPLabeler.h>
#include <GraphMol/Conformer.h>
#include <GraphMol/FileParsers/MolFileStereochem.h>
#include <GraphMol/MolOps.h>
#include <GraphMol/MonomerInfo.h>
#include <GraphMol/RWMol.h>
#include <GraphMol/SubstanceGroup.h>

#include "schrodinger/rdkit_extensions/convert.h"
#include "schrodinger/rdkit_extensions/coord_utils.h"
#include "schrodinger/rdkit_extensions/file_format.h"
#include "schrodinger/rdkit_extensions/helm.h"
#include "schrodinger/rdkit_extensions/monomer_database.h"
#include "schrodinger/rdkit_extensions/monomer_mol.h"
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
 * Classify a monomer bead for the JS renderer's shape/color dispatch. Mirrors
 * Qt's get_monomer_type / get_na_monomer_type_from_res_name (sketcher/rdkit/
 * monomeric.cpp): a "PEPTIDE" chain prefix → "pep" (rounded rect); an "RNA"
 * prefix (HELM uses it for DNA too) is sub-typed by the residue symbol's last
 * character — "phos" (…p, ellipse), "sugar" (…r, rect), else "base" (diamond).
 * Anything else is a generic "chem" monomer.
 */
std::string monomer_subtype(const RDKit::Atom* atom)
{
    const auto* info = dynamic_cast<const RDKit::AtomPDBResidueInfo*>(
        atom->getMonomerInfo());
    const std::string chain = info != nullptr ? info->getChainId() : "";
    if (chain.rfind("PEPTIDE", 0) == 0) {
        return "pep";
    }
    if (chain.rfind("RNA", 0) == 0) {
        std::string sym;
        atom->getPropIfPresent(ATOM_LABEL, sym);
        if (!sym.empty()) {
            switch (std::tolower(static_cast<unsigned char>(sym.back()))) {
                case 'p':
                    return "phos";
                case 'r':
                    return "sugar";
                default:
                    break;
            }
        }
        return "base";
    }
    return "chem";
}

// ---- Unbound attachment-point solver ------------------------------------
// A faithful port of sketcher/rdkit/monomeric.cpp's get_unbound_attachment_
// points + calculate_direction_for_unbound_attachment_point. Computes, for a
// monomer, the attachment points that are NOT used by a connection, each with a
// cardinal/diagonal direction for drawing its "nubbin". Self-contained: needs
// only the mol + conformer (no monomer DB). Directions are model-space unit
// vectors (+y up); the JS renderer converts via pixelFromModel.

enum class Dir { N, S, E, W, NE, NW, SE, SW };

std::pair<double, double> dir_vec(Dir d)
{
    constexpr double k = 0.70710678; // 1/sqrt(2)
    switch (d) {
        case Dir::N:
            return {0.0, 1.0};
        case Dir::S:
            return {0.0, -1.0};
        case Dir::E:
            return {1.0, 0.0};
        case Dir::W:
            return {-1.0, 0.0};
        case Dir::NE:
            return {k, k};
        case Dir::NW:
            return {-k, k};
        case Dir::SE:
            return {k, -k};
        case Dir::SW:
            return {-k, -k};
    }
    return {0.0, 0.0};
}

Dir dir_opposite(Dir d)
{
    switch (d) {
        case Dir::N:
            return Dir::S;
        case Dir::S:
            return Dir::N;
        case Dir::E:
            return Dir::W;
        case Dir::W:
            return Dir::E;
        default:
            return d;
    }
}

Dir dir_clockwise(Dir d)
{
    switch (d) {
        case Dir::N:
            return Dir::E;
        case Dir::E:
            return Dir::S;
        case Dir::S:
            return Dir::W;
        case Dir::W:
            return Dir::N;
        default:
            return d;
    }
}

std::vector<Dir> dir_perpendiculars(Dir d)
{
    if (d == Dir::N || d == Dir::S) {
        return {Dir::W, Dir::E};
    }
    return {Dir::N, Dir::S};
}

Dir cardinal_for_point(double dx, double dy)
{
    if (std::fabs(dx) >= std::fabs(dy)) {
        return dx > 0 ? Dir::E : Dir::W;
    }
    return dy > 0 ? Dir::N : Dir::S;
}

// Parse the AP number this atom uses on `bond` from its "RX-RY" linkage prop.
// Returns 0 for an unparseable/absent linkage.
int bound_ap_num_on_bond(const RDKit::Atom* atom, const RDKit::Bond* bond)
{
    std::string linkage;
    if (!bond->getPropIfPresent(::LINKAGE, linkage)) {
        return 0;
    }
    const auto dash = linkage.find('-');
    if (dash == std::string::npos || linkage.empty() || linkage[0] != 'R') {
        return 0; // e.g. a "pair" custom linkage — no numbered AP here
    }
    try {
        const bool is_begin = bond->getBeginAtom() == atom;
        const std::string tok = is_begin ? linkage.substr(1, dash - 1)
                                         : linkage.substr(dash + 2);
        return std::stoi(tok);
    } catch (...) {
        return 0;
    }
}

// "Pretty" AP display names by monomer subtype (Qt NUMBERED_AP_NAMES_BY_
// MONOMER_TYPE); index i → R(i+1). Empty → fall back to "R<n>".
const std::vector<std::string>& ap_display_names(const std::string& subtype)
{
    static const std::vector<std::string> PEP = {"N", "C", "X"};
    static const std::vector<std::string> SUGAR = {"5'", "3'", "1'"};
    static const std::vector<std::string> BASE = {"N1/9"};
    static const std::vector<std::string> EMPTY = {};
    if (subtype == "pep") {
        return PEP;
    }
    if (subtype == "sugar") {
        return SUGAR;
    }
    if (subtype == "base") {
        return BASE;
    }
    return EMPTY;
}

struct UnboundAP {
    std::string display;   // "pretty" label, e.g. "C" / "3'" / "R2"
    std::string model;     // model name for the linkage, e.g. "R2" / "pair"
    double dx;
    double dy;
};

std::vector<UnboundAP> unbound_aps_for_monomer(const RDKit::Atom* atom)
{
    const std::string subtype = monomer_subtype(atom);
    // Numbered-AP count per subtype (Qt). CHEM/unknown: skip (we don't model
    // arbitrary CHEM AP counts in the lean port).
    int num_numbered = 0;
    bool has_pair = false;
    if (subtype == "pep" || subtype == "sugar") {
        num_numbered = 3;
    } else if (subtype == "phos") {
        num_numbered = 2;
    } else if (subtype == "base") {
        num_numbered = 1;
        has_pair = true;
    } else {
        return {};
    }

    const auto& mol = atom->getOwningMol();
    const auto& conf = mol.getConformer();
    const auto self_pos = conf.getAtomPos(atom->getIdx());

    // Bound APs: number → cardinal direction of the neighbor.
    std::unordered_map<int, Dir> bound_dir_by_num;
    std::unordered_set<Dir> occupied;
    bool pair_bound = false;
    for (const auto* bond : mol.atomBonds(atom)) {
        const int n = bound_ap_num_on_bond(atom, bond);
        const auto* nbr = bond->getOtherAtom(atom);
        const auto npos = conf.getAtomPos(nbr->getIdx());
        const Dir d = cardinal_for_point(npos.x - self_pos.x,
                                         npos.y - self_pos.y);
        if (n > 0) {
            bound_dir_by_num[n] = d;
            occupied.insert(d);
        } else {
            // A non-numbered ("pair") linkage.
            pair_bound = true;
            occupied.insert(d);
        }
    }

    // Directions assigned so far to unbound numbered APs (for opposite/
    // perpendicular lookups), keyed by AP number.
    std::unordered_map<int, Dir> assigned;
    auto fetch_dir = [&](int ap_num) -> std::optional<Dir> {
        if (auto it = bound_dir_by_num.find(ap_num);
            it != bound_dir_by_num.end()) {
            return it->second;
        }
        if (auto it = assigned.find(ap_num); it != assigned.end()) {
            return it->second;
        }
        return std::nullopt;
    };

    static const std::array<Dir, 4> DIAGONALS = {Dir::NW, Dir::NE, Dir::SE,
                                                 Dir::SW};
    auto first_available =
        [&](const std::vector<Dir>& prefer) -> std::optional<Dir> {
        for (Dir d : prefer) {
            if (!occupied.count(d)) {
                return d;
            }
        }
        for (Dir d : DIAGONALS) {
            if (!occupied.count(d)) {
                return d;
            }
        }
        return std::nullopt;
    };

    // Direction for an unbound AP, mirroring Qt's calculate_direction_for_
    // unbound_attachment_point.
    auto calc_dir = [&](int ap_num, bool is_pair) -> std::optional<Dir> {
        if (ap_num <= 2 || is_pair) {
            const int opposite_ap = (ap_num == 2 || is_pair) ? 1 : 2;
            const auto opp = fetch_dir(opposite_ap);
            if (opp.has_value()) {
                std::vector<Dir> tries = {dir_opposite(*opp)};
                for (Dir p : dir_perpendiculars(*opp)) {
                    tries.push_back(p);
                }
                return first_available(tries);
            }
            if (subtype == "base") {
                return first_available({Dir::S, Dir::E, Dir::W, Dir::N});
            }
            return first_available({Dir::W, Dir::N, Dir::S, Dir::E});
        }
        if (ap_num == 3) {
            const auto r1 = fetch_dir(1);
            if (!r1.has_value()) {
                return std::nullopt; // R1 must be placed first
            }
            const Dir cw = dir_clockwise(*r1);
            return first_available(
                {cw, dir_opposite(cw), dir_opposite(*r1)});
        }
        return first_available({Dir::W, Dir::E, Dir::N, Dir::S});
    };

    const auto& names = ap_display_names(subtype);
    std::vector<UnboundAP> out;
    for (int n = 1; n <= num_numbered; ++n) {
        if (bound_dir_by_num.count(n)) {
            continue; // this AP is in use
        }
        const auto d = calc_dir(n, /*is_pair=*/false);
        if (!d.has_value()) {
            continue;
        }
        assigned[n] = *d;
        occupied.insert(*d);
        const auto [vx, vy] = dir_vec(*d);
        const std::string model = "R" + std::to_string(n);
        const std::string disp = (n >= 1 && n <= static_cast<int>(names.size()))
                                     ? names[n - 1]
                                     : model;
        out.push_back({disp, model, vx, vy});
    }
    if (has_pair && !pair_bound) {
        const auto d = calc_dir(/*ap_num=*/-1, /*is_pair=*/true);
        if (d.has_value()) {
            occupied.insert(*d);
            const auto [vx, vy] = dir_vec(*d);
            out.push_back({"pair", "pair", vx, vy});
        }
    }
    return out;
}

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
// Per-atom reaction role: 'r' (reactant) or 'p' (product), classified by each
// connected fragment's centroid-x relative to the arrow x. Ported from Qt's
// MolModel::isReactantAtom (model/mol_model.cpp:329): frag centroid x <= arrow
// x ⇒ reactant, else product. Returns an empty vector when there's no arrow.
std::vector<char> reaction_roles(RDKit::RWMol& mol, double arrow_x)
{
    std::vector<int> frag_of_atom;
    const auto frags =
        RDKit::MolOps::getMolFrags(mol, /*sanitizeFrags=*/false, &frag_of_atom);
    const auto& conf = mol.getConformer();
    std::vector<double> sum_x(frags.size(), 0.0);
    std::vector<int> count(frags.size(), 0);
    for (unsigned int i = 0; i < mol.getNumAtoms(); ++i) {
        const int f = frag_of_atom[i];
        sum_x[f] += conf.getAtomPos(i).x;
        count[f] += 1;
    }
    std::vector<char> roles(mol.getNumAtoms(), 'r');
    for (unsigned int i = 0; i < mol.getNumAtoms(); ++i) {
        const int f = frag_of_atom[i];
        const double cx = count[f] ? sum_x[f] / count[f] : 0.0;
        roles[i] = (cx <= arrow_x) ? 'r' : 'p';
    }
    return roles;
}

std::string json_escape(const std::string& s); // defined below

// Substance-group (bracket subgroup) render fragment. Ports Qt's bracket
// geometry (rdkit/sgroup.cpp update_bracket_coordinates + sgroup_item.cpp
// getBracketPath/computeShortSideForBracket + label text). Each S-group emits
// two brackets (4-point polylines forming "[" / "]"), a polymer/repeat label,
// and the repeat-pattern text, all in model coords. Returns "" when the mol has
// no bracketable S-groups.
std::string sgroups_json(RDKit::RWMol& mol)
{
    const auto& sgroups = RDKit::getSubstanceGroups(mol);
    if (sgroups.empty()) {
        return "";
    }
    // BRACKETS_LONG_SIDE = RDDepict::BOND_LEN(1.5) * 0.9; SHORT = 0.2*LONG;
    // LABEL_DISTANCE = 0.5*SHORT (Qt rdkit/sgroup.h + molviewer/constants.h).
    constexpr double LONG = 1.5 * 0.9;
    constexpr double SHORT = LONG * 0.2;
    constexpr double LABEL_DIST = SHORT * 0.5;
    const auto& conf = mol.getConformer();
    std::ostringstream os;
    os.precision(4);
    os << std::fixed;
    os << "\"sgroups\":[";
    bool first_sg = true;
    for (unsigned int sg_idx = 0; sg_idx < sgroups.size(); ++sg_idx) {
        const auto& sg = sgroups[sg_idx];
        const auto bonds = sg.getBonds();
        if (bonds.size() != 2) {
            continue; // only two-attachment bracket S-groups render
        }
        const auto atom_idxs = sg.getAtoms();
        std::unordered_set<unsigned int> atom_set(atom_idxs.begin(),
                                                  atom_idxs.end());
        // Build the two brackets; track the rightmost for label placement.
        struct Bracket {
            double x0, y0, x1, y1;   // long-side endpoints
            double sx, sy;           // short-side (foot) vector, toward group
        };
        std::vector<Bracket> brs;
        for (auto bidx : bonds) {
            const auto* bond = mol.getBondWithIdx(bidx);
            const unsigned int a1 = bond->getBeginAtomIdx();
            const unsigned int a2 = bond->getEndAtomIdx();
            const auto p1 = conf.getAtomPos(a1);
            const auto p2 = conf.getAtomPos(a2);
            const double mx = (p1.x + p2.x) * 0.5;
            const double my = (p1.y + p2.y) * 0.5;
            const double bdx = p1.x - p2.x;
            const double bdy = p1.y - p2.y;
            // Long side ⟂ the bond, length LONG.
            double nx = -bdy;
            double ny = bdx;
            const double nlen = std::sqrt(nx * nx + ny * ny);
            if (nlen > 1e-9) {
                nx /= nlen;
                ny /= nlen;
            }
            const double hx = nx * LONG * 0.5;
            const double hy = ny * LONG * 0.5;
            const double x0 = mx + hx, y0 = my + hy;
            const double x1 = mx - hx, y1 = my - hy;
            // Short foot ∥ the bond, pointing toward the in-group atom.
            const auto in_pos = atom_set.count(a1) ? p1 : p2;
            double sx = bond ? (bdx) : 0.0; // along the bond
            double sy = bdy;
            const double slen = std::sqrt(sx * sx + sy * sy);
            if (slen > 1e-9) {
                sx /= slen;
                sy /= slen;
            }
            if (sx * (in_pos.x - mx) + sy * (in_pos.y - my) < 0) {
                sx = -sx;
                sy = -sy;
            }
            sx *= SHORT;
            sy *= SHORT;
            brs.push_back({x0, y0, x1, y1, sx, sy});
        }
        // Label text: "n" (empty SRU), "co" (empty copolymer), else LABEL.
        std::string type_str, label_str, connect_str;
        sg.getPropIfPresent(std::string("TYPE"), type_str);
        sg.getPropIfPresent(std::string("LABEL"), label_str);
        sg.getPropIfPresent(std::string("CONNECT"), connect_str);
        std::string label = label_str;
        if (label.empty() && type_str == "SRU") {
            label = "n";
        } else if (label.empty() && type_str == "COP") {
            label = "co";
        }
        // Repeat text: lowercased CONNECT unless head-to-tail ("HT").
        std::string repeat;
        if (!connect_str.empty() && connect_str != "HT") {
            for (char c : connect_str) {
                repeat += static_cast<char>(std::tolower(c));
            }
        }
        // Place the label just outside the rightmost bracket's midpoint.
        const auto& rb = (brs[0].x0 + brs[0].x1) >= (brs[1].x0 + brs[1].x1)
                             ? brs[0] : brs[1];
        const double rmx = (rb.x0 + rb.x1) * 0.5;
        const double rmy = (rb.y0 + rb.y1) * 0.5;
        // Outward = away from group = -short direction.
        double olen = std::sqrt(rb.sx * rb.sx + rb.sy * rb.sy);
        double odx = olen > 1e-9 ? -rb.sx / olen : 1.0;
        double ody = olen > 1e-9 ? -rb.sy / olen : 0.0;
        const double lx = rmx + odx * (SHORT + LABEL_DIST);
        const double ly = rmy + ody * (SHORT + LABEL_DIST);

        if (!first_sg) {
            os << ',';
        }
        first_sg = false;
        os << "{\"brackets\":[";
        for (size_t k = 0; k < brs.size(); ++k) {
            if (k > 0) {
                os << ',';
            }
            const auto& b = brs[k];
            // 4-point "[" polyline: b0+short, b0, b1, b1+short.
            os << "[{\"x\":" << (b.x0 + b.sx) << ",\"y\":" << (b.y0 + b.sy)
               << "},{\"x\":" << b.x0 << ",\"y\":" << b.y0
               << "},{\"x\":" << b.x1 << ",\"y\":" << b.y1
               << "},{\"x\":" << (b.x1 + b.sx) << ",\"y\":" << (b.y1 + b.sy)
               << "}]";
        }
        os << "],\"label\":\"" << json_escape(label) << "\",\"repeat\":\""
           << json_escape(repeat) << "\",\"lx\":" << lx << ",\"ly\":" << ly
           // Raw values for the right-click "Modify Notation…" flow: the true
           // getSubstanceGroups index + TYPE / CONNECT / raw LABEL props.
           << ",\"idx\":" << sg_idx << ",\"type\":\"" << json_escape(type_str)
           << "\",\"connect\":\"" << json_escape(connect_str)
           << "\",\"rawLabel\":\"" << json_escape(label_str) << "\"}";
    }
    os << "]";
    return first_sg ? "" : os.str();
}

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
    // Monomeric (coarse-grained) mols render as labeled beads + connectors, not
    // as atoms/bonds. Detect once; skip atomistic stereo perception (it doesn't
    // apply to monomer dummies) and emit a top-level flag so the JS renderer
    // switches to monomer drawing for the whole scene.
    const bool is_monomeric = schrodinger::rdkit_extensions::isMonomeric(mol);
    if (!is_monomeric) {
        apply_stereo_annotations(mol);
    }
    const auto& conf = mol.getConformer();

    // Reaction roles (reactant/product per atom) — only meaningful once an
    // arrow exists and the scene is atomistic. Computed once (getMolFrags is
    // O(atoms+bonds)) and reused across the atom loop for the "rxn" field.
    std::vector<char> rxn_roles;
    if (model != nullptr && model->hasRxnArrow() && !is_monomeric) {
        rxn_roles = reaction_roles(mol, model->rxnArrow().first);
    }

    std::ostringstream os;
    os.precision(4);
    os << std::fixed;

    os << "{";
    if (is_monomeric) {
        os << "\"monomeric\":true,";
    }
    os << "\"atoms\":[";
    for (unsigned int i = 0; i < mol.getNumAtoms(); ++i) {
        const auto* atom = mol.getAtomWithIdx(i);
        const auto& p = conf.getAtomPos(i);
        if (i > 0) {
            os << ',';
        }
        os << "{\"i\":" << i << ",\"el\":\"" << atom->getSymbol()
           << "\",\"x\":" << p.x << ",\"y\":" << p.y;
        if (is_monomeric) {
            // Monomer bead: emit its subtype (pep / sugar / phos / base — drives
            // the JS shape + color dispatch) and 1-letter display label (the
            // residue symbol, from the atomLabel prop). Skip all atomistic
            // chemistry annotations — they don't apply.
            std::string label;
            atom->getPropIfPresent(ATOM_LABEL, label);
            os << ",\"mon\":\"" << monomer_subtype(atom) << "\",\"lbl\":\""
               << label << "\"";
            if (model != nullptr && model->isAtomSelected(i)) {
                os << ",\"sel\":true";
            }
            // Unbound attachment points (draw target stubs the user can click
            // to chain a monomer via a specific AP). Each: display name +
            // model-space direction unit vector.
            const auto aps = unbound_aps_for_monomer(atom);
            if (!aps.empty()) {
                os << ",\"aps\":[";
                for (size_t k = 0; k < aps.size(); ++k) {
                    if (k > 0) {
                        os << ',';
                    }
                    os << "{\"n\":\"" << aps[k].display << "\",\"r\":\""
                       << aps[k].model << "\",\"dx\":" << aps[k].dx
                       << ",\"dy\":" << aps[k].dy << "}";
                }
                os << ']';
            }
            os << '}';
            continue;
        }
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
        // Wildcard query atom (A/Q/M/X + H variants). MolModel::mutateAtomTo
        // Wildcard stashes the display label in WILDCARD_LABEL_PROP; surface
        // it as "qlabel" so the renderer paints the letter in place of the
        // element symbol (the underlying atom is a dummy → getSymbol() = "*").
        std::string qlabel;
        if (atom->getPropIfPresent(
                schrodinger::sketcher_core::WILDCARD_LABEL_PROP, qlabel)) {
            os << ",\"qlabel\":\"" << qlabel << "\"";
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
        // Unpaired-electron count (Qt: AtomItem::updateChargeAndRadicalLabel
        // atom_item.cpp:539-575). Renders as a "•" bullet to the upper-right
        // of the atom label, combined with the charge label when both are
        // non-zero. Emitted only when non-zero to keep the common JSON small.
        const unsigned int n_rad = atom->getNumRadicalElectrons();
        if (n_rad != 0) {
            os << ",\"nrad\":" << n_rad;
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
        // Reaction atom-map number (Qt: AtomItem paints ":n"). Emitted only
        // when set so the common unmapped scene stays minimal.
        const int map_num = atom->getAtomMapNum();
        if (map_num != 0) {
            os << ",\"map\":" << map_num;
        }
        // Reaction role (reactant/product) — drives the Map Atoms drag's
        // valid-pair gate and the Remove Mapping product special-case. Present
        // only while an arrow exists.
        if (!rxn_roles.empty()) {
            os << ",\"rxn\":\"" << rxn_roles[i] << "\"";
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
        if (is_monomeric) {
            // Monomer connection: the JS renderer draws a plain connector
            // between the two beads. Skip all atomistic bond annotations
            // (a monomer bond is DATIVE, which would otherwise emit "bt").
            // A connection touching a nucleobase is a thin sugar→base branch
            // (Qt NA_BACKBONE_TO_BASE_CONNECTOR); flag it so the renderer draws
            // it lighter/thinner than a backbone connector.
            os << ",\"mon\":true";
            if (monomer_subtype(b->getBeginAtom()) == "base" ||
                monomer_subtype(b->getEndAtom()) == "base") {
                os << ",\"conn\":\"base\"";
            }
            if (model != nullptr && model->isBondSelected(i)) {
                os << ",\"sel\":true";
            }
            os << '}';
            continue;
        }
        const auto bond_type = b->getBondType();
        // `o` is the bond ORDER as a double (SINGLE=1, DOUBLE=2, ...), which
        // can't distinguish a coordinate (DATIVE→1.0) or zero-order (ZERO→
        // 0.0) bond from an ordinary single. Emit the raw BondType enum int
        // as `bt` for exactly those cases so the renderer can draw Qt's
        // dative arrow / dashed zero-order line (bond_item.cpp:210-219).
        // Omitted otherwise to keep the description shape minimal.
        if (bond_type == RDKit::Bond::BondType::DATIVE ||
            bond_type == RDKit::Bond::BondType::DATIVEONE ||
            bond_type == RDKit::Bond::BondType::DATIVEL ||
            bond_type == RDKit::Bond::BondType::DATIVER ||
            bond_type == RDKit::Bond::BondType::ZERO) {
            os << ",\"bt\":" << static_cast<int>(bond_type);
        }
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
        // Query bond (Any / S/D / S/A / D/A). MolModel::mutateBondToQuery
        // stashes the display label in BOND_QUERY_LABEL_PROP; surface it as
        // "qlabel" so the renderer paints the annotation near the bond (the
        // bond still draws at its base order via `o`). Mirrors Qt's
        // get_bond_type_and_query_label (rdkit/atoms_and_bonds.cpp:31).
        std::string bond_qlabel;
        if (b->getPropIfPresent(
                schrodinger::sketcher_core::BOND_QUERY_LABEL_PROP,
                bond_qlabel)) {
            os << ",\"qlabel\":\"" << bond_qlabel << "\"";
        }
        // Ring-topology constraint ("ring" / "notring"). The renderer draws
        // Qt's ⭔ / "Not ⭔" annotation next to any query label.
        std::string bond_topo;
        if (b->getPropIfPresent(
                schrodinger::sketcher_core::BOND_TOPOLOGY_PROP, bond_topo)) {
            os << ",\"topo\":\"" << bond_topo << "\"";
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
    // Substance groups (bracket subgroups) render on top of the atomistic mol.
    if (!is_monomeric) {
        const std::string sg = sgroups_json(mol);
        if (!sg.empty()) {
            os << ',' << sg;
        }
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

// Minimal JSON string escaping (backslash + double-quote + control chars) for
// the small monomer names/symbols we emit below.
std::string json_escape(const std::string& s)
{
    std::string out;
    out.reserve(s.size() + 2);
    for (char c : s) {
        switch (c) {
            case '"':
                out += "\\\"";
                break;
            case '\\':
                out += "\\\\";
                break;
            case '\n':
                out += "\\n";
                break;
            case '\t':
                out += "\\t";
                break;
            default:
                out += c;
        }
    }
    return out;
}

/**
 * Return the monomer database's non-natural analogs grouped by their natural
 * analog, as a JSON object: { "A": [ {"s":"<symbol>","n":"<name>"}, ... ], ... }
 * `chain_type` is a rdkit_extensions::ChainType int (0=PEPTIDE, 1=RNA). The
 * natural residue itself (symbol == natural analog) is filtered out so each list
 * holds only variants (e.g. D-alanine, N-methyl-alanine for "A"). Backs the
 * per-residue analog popups (Qt MonomerToolWidget, SKETCH-2482). Returns "{}"
 * on any failure so the JS side degrades to plain tiles.
 */
std::string monomer_analogs_json(int chain_type)
{
    try {
        const auto ct =
            static_cast<schrodinger::rdkit_extensions::ChainType>(chain_type);
        auto& db = schrodinger::rdkit_extensions::MonomerDatabase::instance();
        const auto by_analog = db.getMonomersByNaturalAnalog(ct);
        std::ostringstream os;
        os << '{';
        bool first_group = true;
        for (const auto& [analog, monomers] : by_analog) {
            // Collect variant (symbol, name) pairs, skipping the natural residue.
            std::vector<std::pair<std::string, std::string>> variants;
            for (const auto& m : monomers) {
                if (!m.symbol.has_value()) {
                    continue;
                }
                const std::string sym = *m.symbol;
                if (sym == analog) {
                    continue; // the natural residue itself
                }
                variants.emplace_back(sym, m.name.value_or(sym));
            }
            if (variants.empty()) {
                continue;
            }
            if (!first_group) {
                os << ',';
            }
            first_group = false;
            os << '"' << json_escape(analog) << "\":[";
            bool first_v = true;
            for (const auto& [sym, name] : variants) {
                if (!first_v) {
                    os << ',';
                }
                first_v = false;
                os << "{\"s\":\"" << json_escape(sym) << "\",\"n\":\""
                   << json_escape(name) << "\"}";
            }
            os << ']';
        }
        os << '}';
        return os.str();
    } catch (...) {
        return "{}";
    }
}

/**
 * Return the D↔L toggled HELM symbol for a PEPTIDE residue, or "" when no
 * valid counterpart exists in the monomer DB. Ported verbatim in intent from
 * Qt's MonomerContextMenu (menu/monomer_context_menu.cpp): `dFoo` is the
 * D-form of `Foo` iff both exist as PEPTIDEs AND share the same NATURAL_ANALOG
 * — prefix alone is unsafe because a custom DB could name an entry `dXyz`
 * with no semantic link to `Xyz`. Backs the "Set D-Form / Set L-Form" toggle:
 * the JS side derives the label + enabled state from the returned string
 * (shorter than the input ⇒ currently D-form ⇒ "Set L-Form"; empty ⇒ disabled).
 */
std::string monomer_dform_toggle(const std::string& sym)
{
    try {
        auto& db = schrodinger::rdkit_extensions::MonomerDatabase::instance();
        const auto ct = schrodinger::rdkit_extensions::ChainType::PEPTIDE;
        const auto analog_of = [&](const std::string& s) {
            return db.getNaturalAnalog(s, ct);
        };
        // D → L: strip the leading 'd' when the stripped form exists with a
        // matching natural analog (mirrors is_d_form + the strip branch).
        if (sym.size() >= 2 && sym.front() == 'd') {
            const auto full = analog_of(sym);
            const auto stripped = analog_of(sym.substr(1));
            if (full && stripped && !full->empty() && *full == *stripped) {
                return sym.substr(1);
            }
        }
        // L → D: prepend 'd' when the candidate exists with a matching analog.
        const auto candidate = std::string("d") + sym;
        const auto cand_analog = analog_of(candidate);
        const auto sym_analog = analog_of(sym);
        if (cand_analog && sym_analog && !cand_analog->empty() &&
            *cand_analog == *sym_analog) {
            return candidate;
        }
    } catch (...) {
    }
    return "";
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
    void setBondTypeAndDirUndoable(unsigned int begin, unsigned int end,
                                   int type, int dir)
    {
        m_model.setBondTypeAndDirUndoable(
            begin, end, static_cast<RDKit::Bond::BondType>(type),
            static_cast<RDKit::Bond::BondDir>(dir));
    }
    void setBondTypeAndDirForSelectedBonds(int type, int dir)
    {
        m_model.setBondTypeAndDirForSelectedBonds(
            static_cast<RDKit::Bond::BondType>(type),
            static_cast<RDKit::Bond::BondDir>(dir));
    }
    void mutateBondToQuery(unsigned int begin, unsigned int end,
                           const std::string& label)
    {
        m_model.mutateBondToQuery(begin, end, label);
    }
    void mutateSelectedBondsToQuery(const std::string& label)
    {
        m_model.mutateSelectedBondsToQuery(label);
    }
    void addQueryBondBetweenAtoms(unsigned int begin, unsigned int end,
                                  const std::string& label)
    {
        m_model.addQueryBondBetweenAtoms(begin, end, label);
    }
    void setBondTopologyForBond(unsigned int begin, unsigned int end,
                                const std::string& topology)
    {
        m_model.setBondTopologyForBond(begin, end, topology);
    }
    void setSelectedBondsTopology(const std::string& topology)
    {
        m_model.setSelectedBondsTopology(topology);
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
    void addMonomer(const std::string& res_name, int chain_type, double x,
                    double y)
    {
        m_model.addMonomer(res_name, chain_type, x, y);
    }
    void addBoundMonomer(const std::string& res_name, int chain_type, double x,
                         double y, unsigned int bound_to_idx)
    {
        m_model.addBoundMonomer(res_name, chain_type, x, y, bound_to_idx);
    }
    void addNucleotide(const std::string& sugar, const std::string& base,
                       const std::string& phos, double x, double y)
    {
        m_model.addNucleotide(sugar, base, phos, x, y);
    }
    void addBoundNucleotide(const std::string& sugar, const std::string& base,
                            const std::string& phos, double x, double y,
                            unsigned int bound_to_idx)
    {
        m_model.addBoundNucleotide(sugar, base, phos, x, y, bound_to_idx);
    }
    void mutateMonomer(unsigned int idx, const std::string& res_name)
    {
        m_model.mutateMonomer(idx, res_name);
    }
    void addBoundMonomerViaAP(const std::string& res_name, int chain_type,
                              double x, double y, unsigned int bound_to_idx,
                              const std::string& existing_ap)
    {
        m_model.addBoundMonomerViaAP(res_name, chain_type, x, y, bound_to_idx,
                                     existing_ap);
    }
    void rotateSelectedAtoms(double angle_rad)
    {
        m_model.rotateSelectedAtoms(angle_rad);
    }
    void flipSelectedAtoms(bool horizontal)
    {
        m_model.flipSelectedAtoms(horizontal);
    }
    void flipSubstituentAroundBond(unsigned int begin, unsigned int end)
    {
        m_model.flipSubstituentAroundBond(begin, end);
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
    void mutateAtomToRGroup(unsigned int idx, unsigned int r_group_num)
    {
        m_model.mutateAtomToRGroup(idx, r_group_num);
    }
    void mutateAtomToWildcard(unsigned int idx, const std::string& label)
    {
        m_model.mutateAtomToWildcard(idx, label);
    }
    void addWildcardAtom(const std::string& label, double x, double y)
    {
        m_model.addWildcardAtom(label, x, y);
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
    void addExplicitHsToAtoms(emscripten::val atom_indices)
    {
        const auto n = atom_indices["length"].as<unsigned int>();
        std::vector<unsigned int> idx(n);
        for (unsigned int i = 0; i < n; ++i) {
            idx[i] = atom_indices[i].as<unsigned int>();
        }
        m_model.addExplicitHsToAtoms(idx);
    }
    void removeExplicitHsFromAtoms(emscripten::val atom_indices)
    {
        const auto n = atom_indices["length"].as<unsigned int>();
        std::vector<unsigned int> idx(n);
        for (unsigned int i = 0; i < n; ++i) {
            idx[i] = atom_indices[i].as<unsigned int>();
        }
        m_model.removeExplicitHsFromAtoms(idx);
    }
    void adjustRadicalElectronsOnAtoms(emscripten::val atom_indices, int delta)
    {
        const auto n = atom_indices["length"].as<unsigned int>();
        std::vector<unsigned int> idx(n);
        for (unsigned int i = 0; i < n; ++i) {
            idx[i] = atom_indices[i].as<unsigned int>();
        }
        m_model.adjustRadicalElectronsOnAtoms(idx, delta);
    }
    void setAtomMapping(emscripten::val atom_indices, int mapping_num)
    {
        const auto n = atom_indices["length"].as<unsigned int>();
        std::vector<unsigned int> idx(n);
        for (unsigned int i = 0; i < n; ++i) {
            idx[i] = atom_indices[i].as<unsigned int>();
        }
        m_model.setAtomMapping(idx, mapping_num);
    }
    bool canAtomsFormSGroup(emscripten::val atom_indices)
    {
        const auto n = atom_indices["length"].as<unsigned int>();
        std::vector<unsigned int> idx(n);
        for (unsigned int i = 0; i < n; ++i) {
            idx[i] = atom_indices[i].as<unsigned int>();
        }
        return m_model.canAtomsFormSGroup(idx);
    }
    void addSGroup(emscripten::val atom_indices, const std::string& type_str,
                   const std::string& connect_str, const std::string& label)
    {
        const auto n = atom_indices["length"].as<unsigned int>();
        std::vector<unsigned int> idx(n);
        for (unsigned int i = 0; i < n; ++i) {
            idx[i] = atom_indices[i].as<unsigned int>();
        }
        m_model.addSGroup(idx, type_str, connect_str, label);
    }
    unsigned int numSGroups()
    {
        return m_model.numSGroups();
    }
    void removeSGroup(unsigned int index)
    {
        m_model.removeSGroup(index);
    }
    void modifySGroup(unsigned int index, const std::string& type_str,
                      const std::string& connect_str, const std::string& label)
    {
        m_model.modifySGroup(index, type_str, connect_str, label);
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
    emscripten::function("monomer_analogs_json", &monomer_analogs_json);
    emscripten::function("monomer_dform_toggle", &monomer_dform_toggle);

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
        .function("setBondTypeAndDirUndoable",
                  &MolModelJS::setBondTypeAndDirUndoable)
        .function("setBondTypeAndDirForSelectedBonds",
                  &MolModelJS::setBondTypeAndDirForSelectedBonds)
        .function("mutateBondToQuery", &MolModelJS::mutateBondToQuery)
        .function("mutateSelectedBondsToQuery",
                  &MolModelJS::mutateSelectedBondsToQuery)
        .function("addQueryBondBetweenAtoms",
                  &MolModelJS::addQueryBondBetweenAtoms)
        .function("setBondTopologyForBond",
                  &MolModelJS::setBondTopologyForBond)
        .function("setSelectedBondsTopology",
                  &MolModelJS::setSelectedBondsTopology)
        .function("addRing", &MolModelJS::addRing)
        .function("addAtomChain", &MolModelJS::addAtomChain)
        .function("addMonomer", &MolModelJS::addMonomer)
        .function("addBoundMonomer", &MolModelJS::addBoundMonomer)
        .function("addNucleotide", &MolModelJS::addNucleotide)
        .function("addBoundNucleotide", &MolModelJS::addBoundNucleotide)
        .function("mutateMonomer", &MolModelJS::mutateMonomer)
        .function("addBoundMonomerViaAP", &MolModelJS::addBoundMonomerViaAP)
        .function("rotateSelectedAtoms", &MolModelJS::rotateSelectedAtoms)
        .function("flipSelectedAtoms", &MolModelJS::flipSelectedAtoms)
        .function("flipSubstituentAroundBond",
                  &MolModelJS::flipSubstituentAroundBond)
        .function("adjustChargeOnSelectedAtoms",
                  &MolModelJS::adjustChargeOnSelectedAtoms)
        .function("setSelectedAtomsToHydrogenIsotope",
                  &MolModelJS::setSelectedAtomsToHydrogenIsotope)
        .function("setAtomElement", &MolModelJS::setAtomElement)
        .function("setElementForSelectedAtoms",
                  &MolModelJS::setElementForSelectedAtoms)
        .function("mutateAtomToRGroup", &MolModelJS::mutateAtomToRGroup)
        .function("mutateAtomToWildcard", &MolModelJS::mutateAtomToWildcard)
        .function("addWildcardAtom", &MolModelJS::addWildcardAtom)
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
        .function("addExplicitHsToAtoms", &MolModelJS::addExplicitHsToAtoms)
        .function("removeExplicitHsFromAtoms",
                  &MolModelJS::removeExplicitHsFromAtoms)
        .function("adjustRadicalElectronsOnAtoms",
                  &MolModelJS::adjustRadicalElectronsOnAtoms)
        .function("setAtomMapping", &MolModelJS::setAtomMapping)
        .function("canAtomsFormSGroup", &MolModelJS::canAtomsFormSGroup)
        .function("addSGroup", &MolModelJS::addSGroup)
        .function("numSGroups", &MolModelJS::numSGroups)
        .function("removeSGroup", &MolModelJS::removeSGroup)
        .function("modifySGroup", &MolModelJS::modifySGroup)
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
