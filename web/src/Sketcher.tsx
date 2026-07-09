import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
    type ChangeEvent,
    type CSSProperties,
    type JSX,
    type MouseEvent as ReactMouseEvent,
} from 'react';
import type { MolModelInstance, SketcherLeanModule } from './sketcherLean';

// Pure interactive demo that drives sketcher_core::MolModel via embind.
// Click empty canvas to add an atom of the current element; click an existing
// atom (with the bond tool selected) to start a bond, then click a second atom
// to commit it. Undo/redo/clear go through the same UndoStack the C++ Boost
// tests cover.

type Tool = 'atom' | 'bond' | 'select' | 'move-rotate' | 'erase' | 'ring'
    | 'atom-chain' | 'rgroup' | 'attachment-point' | 'reaction'
    | 'atom-query' | 'bond-query' | 'monomer';

// Reaction sub-mode — Qt: EnumerationTool::{RXN_ARROW, RXN_PLUS} in the
// reaction popup. The two map 1:1 to MolModel::addRxnArrow / addRxnPlus.
// Add Mapping / Remove Mapping (also in Qt's ReactionPopup) are deferred —
// they need atom-mapping primitives the lean MolModel doesn't expose yet.
type ReactionMode = 'arrow' | 'plus';
// SetAtomWidget.ui ships C/H/N/O/P/S/F/Cl/Si on the atomistic panel.
// Element symbol — any RDKit-recognized symbol. The sidebar exposes
// 8 fixed elements via dedicated buttons; everything else flows through
// the periodic-table popup + last-picked-element slot.
type Element = string;
const FIXED_ELEMENTS: readonly Element[] =
    ['C', 'H', 'N', 'O', 'P', 'S', 'F', 'Cl'] as const;
const LAST_PICKED_DEFAULT: Element = 'Si';

// RDKit atomic numbers for the 8 fixed-element buttons. Used by the atom
// context menu's Set Element submenu to call MolModel.setAtomElement.
const FIXED_ELEMENT_ATOMIC_NUMS: Record<string, number> = {
    H: 1, C: 6, N: 7, O: 8, F: 9, P: 15, S: 16, Cl: 17,
};

// Mirrors Qt's AtomQuery enum (definitions.h). Stubbed for v1: the popup
// is visually faithful but picking a choice surfaces a coming-soon status
// since the lean MolModel doesn't expose RDKit::QueryAtom yet.
type AtomQueryChoice = 'A' | 'AH' | 'Q' | 'QH' | 'M' | 'MH' | 'X' | 'XH';
// Bond-query popup choices — Qt ui/bond_query_popup.ui. 5 choices in a single
// row (aromatic icon + 4 text variants). Same fidelity caveat as atom-query:
// visually present but picking surfaces a coming-soon status (lean MolModel
// doesn't expose RDKit::QueryBond yet).
type BondQueryChoice = 'aromatic' | 'any' | 'single_double' | 'single_aromatic'
    | 'double_aromatic';
// BondQueryChoice → the label string the lean MolModel primitives expect
// (addQueryBondBetweenAtoms / mutateBondToQuery). "aromatic" is a real bond
// type; the rest are RDKit query bonds.
const BOND_QUERY_CPP_LABEL: Record<BondQueryChoice, string> = {
    aromatic: 'aromatic',
    any: 'Any',
    single_double: 'S/D',
    single_aromatic: 'S/A',
    double_aromatic: 'D/A',
};
// Short face shown on the B▾ button for each mode (aromatic uses its icon).
const BOND_QUERY_FACE: Record<BondQueryChoice, string> = {
    aromatic: '',
    any: 'Any',
    single_double: 'S/D',
    single_aromatic: 'S/A',
    double_aromatic: 'D/A',
};
// Qt's bond_group is a single radio group covering single/double/triple plus
// the stereo variants — picking any one button replaces the previously-active
// bond mode. We mirror that here: BondMode collapses "what order is the next
// bond?" and "what stereo dir does it get?" into one selection.
//   wavy    = single bond with BondDir::UNKNOWN  (stereo_bond_popup single_either)
//   crossed = double bond with BondDir::EITHERDOUBLE (stereo_bond_popup double_either)
type BondMode =
    'single' | 'double' | 'triple' | 'wedge' | 'dash' | 'wavy' | 'crossed'
    | 'coordinate' | 'zero';

interface RingSpec {
    size: number;
    aromatic: boolean;
    label: string;
    iconName: string;
}
// RingToolWidget.ui ships 8 ring presets — wire all of them. Qt order:
// row 0: cyclohexane, benzene, cycloheptane
// row 1: cyclopentane, cyclopentadiene, cyclooctane
// row 2: cyclobutane, cyclopropane
const RING_CYCLOHEXANE: RingSpec = { size: 6, aromatic: false, label: 'Cyclohexane', iconName: 'ring_cyclohexane' };
const RING_BENZENE: RingSpec = { size: 6, aromatic: true, label: 'Benzene', iconName: 'ring_benzene' };
const RING_CYCLOHEPTANE: RingSpec = { size: 7, aromatic: false, label: 'Cycloheptane', iconName: 'ring_cycloheptane' };
const RING_CYCLOPENTANE: RingSpec = { size: 5, aromatic: false, label: 'Cyclopentane', iconName: 'ring_cyclopentane' };
const RING_CYCLOPENTADIENE: RingSpec = { size: 5, aromatic: true, label: 'Cyclopentadiene', iconName: 'ring_cyclopentadiene' };
const RING_CYCLOOCTANE: RingSpec = { size: 8, aromatic: false, label: 'Cyclooctane', iconName: 'ring_cyclooctane' };
const RING_CYCLOBUTANE: RingSpec = { size: 4, aromatic: false, label: 'Cyclobutane', iconName: 'ring_cyclobutane' };
const RING_CYCLOPROPANE: RingSpec = { size: 3, aromatic: false, label: 'Cyclopropane', iconName: 'ring_cyclopropane' };
const RING_PRESETS: RingSpec[] = [
    RING_CYCLOHEXANE, RING_BENZENE, RING_CYCLOHEPTANE,
    RING_CYCLOPENTANE, RING_CYCLOPENTADIENE, RING_CYCLOOCTANE,
    RING_CYCLOBUTANE, RING_CYCLOPROPANE,
];

// Palette mirrors the original Qt sketcher's QSS so the React port doesn't
// drift into a different look. Sage-green accent is the primary interactive
// color; selection halos and selected-state fills use the same family.
const ACCENT_GREEN = '#779c59';
const SELECTION_FILL = '#c7d5b8';
const HOVER_FILL = '#e2eadb';
const PENDING_FILL = '#fde68a';

interface AtomDesc {
    i: number;
    el: string;
    x: number;
    y: number;
    sel?: boolean;
    q?: number; // formal charge (omitted when 0)
    nh?: number; // total H count (omitted when 0)
    iso?: number; // isotope (omitted when 0)
    arom?: boolean; // aromatic flag (omitted when false)
    // Valence violation — drives the orange dotted halo when the user
    // has Show Valence Errors enabled. Qt: AtomItem::determineValenceErrorIsVisible
    // (molviewer/atom_item.cpp:853-856).
    verr?: boolean;
    // Stereo / chirality annotation — "(R)", "(S)", "(r)", "(s)", "or1",
    // "and1", or "abs (R)" when explicit abs labels are shown. Drives the
    // small label drawn near the atom when Show Stereo Labels is enabled.
    // Qt: AtomItem::updateChiralityLabel (molviewer/atom_item.cpp:417-449).
    stereo?: string;
    // Possible-but-unspecified stereo center (RDKit's _ChiralityPossible set,
    // _CIPCode missing). Rendered as "(?)" iff Preferences > Include undefined
    // centers is on. Qt: get_atom_chirality_label (rdkit/stereochemistry.cpp:45-53).
    psbl?: boolean;
    // R-group number — atom is a dummy with `_MolFileRLabel = n`. Rendered as
    // "R<n>" instead of the element symbol (suppresses the implicit-H "H" and
    // isotope hints that would otherwise leak from the underlying dummy atom).
    // Set by MolModel::addRGroup (Qt: MolModel::addRGroup, model/mol_model.cpp:643-648).
    rlabel?: number;
    // Wildcard query label — atom is a query atom (A/Q/M/X + H variants) made
    // by MolModel::mutateAtomToWildcard. Rendered as the letter in place of
    // the dummy "*" symbol. Suppresses H / charge like R-groups.
    qlabel?: string;
    // Attachment-point number — atom is a dummy whose atomLabel starts with
    // "_AP" (RDKit's is_attachment_point_dummy). The atom dot/label is
    // suppressed; instead a wavy squiggle is drawn perpendicular to the
    // bond from this atom to its single neighbor. Qt: atom_item.cpp:302-304
    // (label_is_visible=false, squiggle_path=getWavyLine()).
    ap?: number;
    // Unpaired-electron (radical) count [1..4]; omitted when 0. Rendered as
    // "•" (or "n•", or "(n•)" when also carrying a charge) to the upper-right
    // of the atom label. Qt: AtomItem::updateChargeAndRadicalLabel
    // (molviewer/atom_item.cpp:539-575).
    nrad?: number;
    // Monomer bead subtype: "pep" (peptide, rounded rect), "sugar" (NA, rect),
    // "phos" (NA, ellipse), "base" (NA, diamond), or "chem". Present only for
    // coarse-grained monomer atoms; drives shape + color-class lookup.
    mon?: string;
    // Monomer display label (1-letter residue symbol, e.g. "A"). Present with
    // `mon`. Rendered centered inside the bead.
    lbl?: string;
}
interface BondDesc {
    a: number;
    b: number;
    o: number;
    sel?: boolean;
    arom?: boolean;
    dir?: number; // RDKit::Bond::BondDir: 1=BEGINWEDGE, 2=BEGINDASH
    // Raw RDKit::Bond::BondType enum int, emitted only for coordinate
    // (17=DATIVE) and zero-order (21=ZERO) bonds — the `o` bond-order double
    // can't distinguish those from a plain single. Absent for ordinary bonds.
    bt?: number;
    // Query-bond annotation label (Any / S/D / S/A / D/A) made by
    // MolModel::mutateBondToQuery. Drawn near the bond midpoint; the bond
    // itself still renders at its base order (`o`). Absent for plain bonds.
    qlabel?: string;
    // Ring-topology constraint ("ring" / "notring") from
    // MolModel::setBondTopologyForBond. Drawn as Qt's ⭔ / "Not ⭔" annotation
    // alongside any query label. Absent when unconstrained.
    topo?: string;
    // Monomer connection flag. Present for coarse-grained monomer connections;
    // the renderer draws a plain connector between beads instead of a chemical
    // bond (a monomer bond is DATIVE and would otherwise render as an arrow).
    mon?: boolean;
    // Monomer connector kind. "base" for a thin sugar→base branch connector
    // (Qt NA_BACKBONE_TO_BASE_CONNECTOR); absent for a backbone connector.
    conn?: string;
}

// Combined bond annotation text (query label + ring-topology symbol), drawn
// near the bond midpoint. Mirrors Qt's get_bond_type_and_query_label output
// where an AND(query, BondInRing) surfaces both. Empty when the bond is plain.
function bondAnnotationText(b: BondDesc): string {
    const parts: string[] = [];
    if (typeof b.qlabel === 'string') parts.push(b.qlabel);
    if (b.topo === 'ring') parts.push('⭔');
    else if (b.topo === 'notring') parts.push('Not ⭔');
    return parts.join(' ');
}

// Amino-acid fill colors by 1-letter residue, ported verbatim from Qt's
// AMINO_ACID_COLOR_BY_RES_NAME + MONOMER_COLOR_MAP
// (molviewer/monomer_constants.h). Color is per chemistry class.
const AMINO_ACID_COLOR_BY_RES_NAME: Record<string, string> = {
    A: '#B4FCB4', B: '#F3E0F9', C: '#FCFCB6', D: '#FCB7D6', E: '#FCB7D6',
    F: '#FBC6B7', G: '#B4FCB4', H: '#B8D1FC', I: '#B4FCB4', K: '#B8D1FC',
    L: '#B4FCB4', M: '#B4FCB4', N: '#B9FCFD', P: '#DADADA', Q: '#B9FCFD',
    R: '#B8D1FC', S: '#B9FCFD', T: '#B9FCFD', V: '#B4FCB4', W: '#FBC6B7',
    Y: '#FBC6B7', Z: '#F3E0F9',
};
// Nucleic-acid base fill colors by 1-letter residue, from Qt's
// NUCLEIC_ACID_COLOR_BY_RES_NAME + MONOMER_COLOR_MAP (monomer_constants.h).
const NUCLEIC_ACID_COLOR_BY_RES_NAME: Record<string, string> = {
    A: '#B0A8F3', // ADENINE
    C: '#FF9CB6', // CYTOSINE
    G: '#6CF2BF', // GUANINE
    T: '#F0F693', // THYMINE
    U: '#F1CC6C', // URACIL
};
// Chrome colors (monomer_constants.h): unnatural fill, borders, label text.
const MONOMER_DEFAULT_FILL = '#F0E7E1';   // OTHER
const MONOMER_BORDER_STD = '#444444';     // GRAY4 — standard residues
const MONOMER_BORDER_NONSTD = '#330000';  // DARK_RED — D-/non-standard
const MONOMER_LABEL_COLOR = '#333333';    // GRAY3
const MONOMER_CONNECTOR_COLOR = '#444444'; // GRAY4 — peptide linear connector
// NA backbone bead fill (sugar + phosphate) — Qt NA_BACKBONE_COLOR.
const NA_BACKBONE_FILL = '#E0E0E0';
// NA sugar→base branch connector — a thinner, lighter GRAY6 line (Qt
// NA_BACKBONE_TO_BASE_CONNECTOR). The backbone connector reuses
// MONOMER_CONNECTOR_COLOR (GRAY4 #444444), shared with peptides.
const NA_BASE_CONNECTOR_COLOR = '#666666';
// Center-to-center spacing for a linear monomer chain, in model units. Matches
// Qt's MONOMER_BOND_LENGTH (rdkit_extensions/helm/monomer_coordgen.cpp = 1.5).
const MONOMER_BOND_LENGTH = 1.5;

// Fill for a peptide monomer bead — matches Qt's get_color_for_monomer:
// direct residue-class lookup, else the unnatural-AA default. (DB natural-
// analog fallback for dA/meA lands with nucleic acids + analogs.)
function monomerFill(lbl: string | undefined): string {
    if (lbl && AMINO_ACID_COLOR_BY_RES_NAME[lbl]) {
        return AMINO_ACID_COLOR_BY_RES_NAME[lbl];
    }
    return MONOMER_DEFAULT_FILL;
}
// Border: standard residues get a gray outline; D-/non-standard get dark red
// (Qt amino_acid_item.cpp::get_amino_acid_type).
function monomerBorder(lbl: string | undefined): string {
    return (lbl && AMINO_ACID_COLOR_BY_RES_NAME[lbl])
        ? MONOMER_BORDER_STD
        : MONOMER_BORDER_NONSTD;
}
// Trace a rounded-rect subpath (canvas). Used for peptide monomer beads.
function roundedRectPath(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number, r: number,
): void {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
}
// Trace a diamond (rhombus) subpath centered at (cx, cy). Used for nucleobase
// beads (Qt NucleicAcidBaseItem::set_path_to_diamond).
function diamondPath(
    ctx: CanvasRenderingContext2D, cx: number, cy: number, half: number,
): void {
    ctx.beginPath();
    ctx.moveTo(cx - half, cy);
    ctx.lineTo(cx, cy + half);
    ctx.lineTo(cx + half, cy);
    ctx.lineTo(cx, cy - half);
    ctx.closePath();
}

// A monomer bead's shape is chosen from its subtype (AtomDesc.mon): peptide →
// rounded rect, sugar → plain rect, phosphate → ellipse, base → diamond.
// Fill: peptide by AA class, sugar/phosphate the NA backbone gray, base by
// nucleobase color (else the unnatural default). Border: gray for standard
// residues, dark red otherwise — for NA, "standard" means A/C/G/T/U, so sugars,
// phosphates, and non-standard bases (e.g. N) get the dark-red outline (Qt
// get_border_and_font_settings_for_nucleic_acid + is_standard_nucleotide).
function isStandardNucleobase(lbl: string | undefined): boolean {
    return !!lbl && lbl in NUCLEIC_ACID_COLOR_BY_RES_NAME;
}
function monomerFillFor(mon: string | undefined, lbl: string | undefined): string {
    if (mon === 'sugar' || mon === 'phos') return NA_BACKBONE_FILL;
    if (mon === 'base') {
        return (lbl && NUCLEIC_ACID_COLOR_BY_RES_NAME[lbl]) ||
            MONOMER_DEFAULT_FILL;
    }
    return monomerFill(lbl); // peptide / chem
}
function monomerBorderFor(mon: string | undefined, lbl: string | undefined): string {
    if (mon === 'sugar' || mon === 'phos') return MONOMER_BORDER_NONSTD;
    if (mon === 'base') {
        return isStandardNucleobase(lbl) ? MONOMER_BORDER_STD
            : MONOMER_BORDER_NONSTD;
    }
    return monomerBorder(lbl); // peptide / chem
}
// Subtype of a single armed monomer (peptide vs NA sugar/phos/base) — the same
// classification the render bridge applies (chain prefix + symbol's last char).
// Used to decide whether clicking a bead mutates it (Qt clickShouldMutate: same
// kind, different residue) rather than chaining a new monomer.
function armedMonomerSubtype(chainType: number, resName: string): string {
    if (chainType === 0) return 'pep';
    const c = resName.slice(-1).toLowerCase();
    if (c === 'p') return 'phos';
    if (c === 'r') return 'sugar';
    return 'base';
}

// Mirror RDKit::Bond::BondDir for the values we render.
const BOND_DIR_NONE = 0;
const BOND_DIR_WEDGE = 1;
const BOND_DIR_DASH = 2;
const BOND_DIR_EITHERDOUBLE = 5; // crossed double (cis/trans unknown)
const BOND_DIR_UNKNOWN = 6;       // wavy single (up/down unknown)
// Mirror RDKit::Bond::BondType values used by the Other Type bond submenu.
// SINGLE / DOUBLE / TRIPLE / AROMATIC are passed as inline ints above; these
// constants stand in where the value would otherwise be opaque.
const BOND_TYPE_SINGLE = 1;
const BOND_TYPE_DOUBLE = 2;
const BOND_TYPE_DATIVE = 17;     // Qt BondTool::COORDINATE
const BOND_TYPE_ZERO = 21;       // Qt BondTool::ZERO

// True when the bond (ba,bb) lies in a ring: drop that bond from the graph and
// BFS — if the two endpoints are still connected, they were part of a cycle.
// Qt's ModifyBondsMenu::updateActions (bond_context_menu.cpp:38) disables Flip
// Substituent for ring bonds via getRingInfo(); the lean render description
// doesn't carry ring membership, so we recover it from the bond adjacency here.
function bondIsInRing(bonds: BondDesc[], ba: number, bb: number): boolean {
    const adj = new Map<number, number[]>();
    for (const bd of bonds) {
        // Skip the bond under test — we want reachability WITHOUT it.
        if ((bd.a === ba && bd.b === bb) || (bd.a === bb && bd.b === ba)) {
            continue;
        }
        (adj.get(bd.a) ?? adj.set(bd.a, []).get(bd.a)!).push(bd.b);
        (adj.get(bd.b) ?? adj.set(bd.b, []).get(bd.b)!).push(bd.a);
    }
    const seen = new Set<number>([ba]);
    const queue = [ba];
    while (queue.length > 0) {
        const cur = queue.shift()!;
        if (cur === bb) return true;
        for (const nb of adj.get(cur) ?? []) {
            if (!seen.has(nb)) {
                seen.add(nb);
                queue.push(nb);
            }
        }
    }
    return false;
}

// Sorted list of distinct R-group numbers already present in the sketch, read
// from each atom's `rlabel` (emitted for _MolFileRLabel dummies). Mirrors Qt's
// get_all_r_group_numbers (rdkit/rgroup.cpp) used by ExistingRGroupMenu.
function existingRGroupNumbers(atoms: AtomDesc[]): number[] {
    const nums = new Set<number>();
    for (const a of atoms) {
        if (typeof a.rlabel === 'number') {
            nums.add(a.rlabel);
        }
    }
    return [...nums].sort((x, y) => x - y);
}

// Smallest positive integer not already used as an R-group number — Qt's
// get_next_r_group_numbers picks the first free slot, not max+1.
function nextRGroupNumber(existing: number[]): number {
    const used = new Set(existing);
    let n = 1;
    while (used.has(n)) n++;
    return n;
}
// Reaction objects live outside the RWMol — sketcher_core mirrors Qt's
// `m_arrow` (optional) + `m_pluses` (vector) shape and emits them as a
// flat `nonMol` array in render description JSON. Each entry's `type`
// disambiguates which shape to draw. Qt: NonMolecularObject in
// model/non_molecular_object.h.
interface NonMolDesc {
    type: 'arrow' | 'plus';
    x: number;
    y: number;
}
interface RenderDesc {
    atoms: AtomDesc[];
    bonds: BondDesc[];
    nonMol?: NonMolDesc[];
    // True when the mol is coarse-grained monomeric — the whole scene renders
    // as labeled beads + connectors instead of atoms/bonds.
    monomeric?: boolean;
}

const CANVAS_W = 540;
const CANVAS_H = 360;
const DEFAULT_SCALE = 40; // pixels per RDKit model unit
const ATOM_HIT_RADIUS = 18; // pixels for click hit-test
const BOND_HIT_RADIUS = 6; // pixels perpendicular to bond line
// Qt RotationItem constants (constants.h:297-301): orange handle, 12-px
// handle radius, 8-px pivot radius, 130 scene-units arm. Scene units in
// the Qt sketcher are roughly pixels at the resting zoom, so we treat
// them as pixels here too.
const ROTATION_HANDLE_RADIUS = 12;
const ROTATION_PIVOT_RADIUS = 8;
const ROTATION_ARM_LENGTH = 130;
const ROTATION_HANDLE_COLOR = '#ff9b00';
const ROTATION_HANDLE_PEN = 3;
// Attachment-point wavy line geometry from Qt (constants.h:283-290):
// 3 waves × 8 scene-units wide × 3 scene-units tall, drawn perpendicular
// to the bond at the AP atom's position. Qt scene units relate to model
// units via VIEW_SCALE = floor(50 / 1.5) = 33 (constants.h:59). Pre-divide
// so the renderer multiplies by view.scale (pixels per model unit) to land
// at the right pixel size — at the React default scale (40 px/unit) the
// squiggle measures ~29 px wide × ~3.6 px tall, matching the Qt render.
const QT_VIEW_SCALE = 33;
const AP_SQUIGGLE_NUM_WAVES = 3;
const AP_SQUIGGLE_WIDTH_PER_WAVE_MODEL = 8.0 / QT_VIEW_SCALE;
const AP_SQUIGGLE_HEIGHT_MODEL = 3.0 / QT_VIEW_SCALE;
// Reaction non-molecular constants (Qt molviewer/constants.h:309-316):
//   ARROW_LENGTH = 40 scene-units (tail-to-tip)
//   ARROW_WIDTH  = 10 scene-units (chevron height at tip)
//   PLUS_LENGTH  = 20 scene-units (arm-to-arm)
//   NON_MOLECULAR_PEN_WIDTH = 3.0 scene-units
// Divided by VIEW_SCALE to land in model units; the renderer multiplies
// by view.scale to get pixels.
const RXN_ARROW_LENGTH_MODEL = 40.0 / QT_VIEW_SCALE;
const RXN_ARROW_TIP_HALF_WIDTH_MODEL = 5.0 / QT_VIEW_SCALE; // ARROW_WIDTH/2
const RXN_PLUS_HALF_LENGTH_MODEL = 10.0 / QT_VIEW_SCALE; // PLUS_LENGTH/2
const RXN_PEN_WIDTH_MODEL = 3.0 / QT_VIEW_SCALE;
const BLANK_DESC: RenderDesc = { atoms: [], bonds: [] };

// View transform. (scale = pixels per model unit; offsetX/offsetY shift the
// origin away from canvas center, in pixels.) modelFromPixel + pixelFromModel
// are pure functions of (canvas, view) so passing a fresh `View` object is
// enough to repaint the canvas at a new viewport.
interface View {
    scale: number;
    offsetX: number;
    offsetY: number;
}

const DEFAULT_VIEW: View = { scale: DEFAULT_SCALE, offsetX: 0, offsetY: 0 };

// Element colors approximate the CPK / Jmol conventions the original uses.
// Chlorine is the deeper green used in the Qt build — pure #0c0 fights
// the sage accent for attention. These match Qt's "Default" color scheme;
// AVALON/CDK/DARK variants live in COLOR_PALETTES below and follow the
// RDKit assign{Default,Avalon,CDK,DarkMode}Palette functions verbatim
// (rdkit/.../MolDraw2D/MolDraw2DHelpers.h). The keys "default-elements"
// and "ELEMENT_COLORS" stay public so the element picker keeps its
// static color hint regardless of the active scheme.
const ELEMENT_COLORS: Record<string, string> = {
    C: '#222',
    H: '#444',
    N: '#1f4faa',
    O: '#c0392b',
    P: '#cc8a00',
    S: '#b58900',
    F: '#3fa54f',
    Cl: '#3fa54f',
    Si: '#7d6f4a',
};

// Qt's ColorScheme enum (image_constants.h:39-48). The Preferences modal
// holds TWO independent values — m_color_mode_combo (visible when Color
// Heteroatoms is ON) cycles Default/Avalon/CDK/Dark; m_bw_mode_combo
// (visible when OFF) cycles Default/Dark. The pair-aware mapping in
// updateWidgets (rendering_settings_dialog.cpp:111-121) keeps both
// combos in sync on the "Dark" bit so toggling Color Heteroatoms
// preserves the user's light/dark intent. We mirror both pieces of state
// in `displayOptions` and resolve to a single active scheme below.
type ColorScheme = 'default' | 'avalon' | 'cdk' | 'dark';
type BWColorScheme = 'default' | 'dark';
type ActiveColorScheme = ColorScheme | 'bw' | 'white-black';

// Render-time palette: rendering chrome (canvas BG, bond stroke, label
// backdrop, annotation text) + per-element colors. All hex strings so
// the canvas/SVG renderers can drop them in unchanged. Element keys are
// the symbols emitted by the wasm side; missing keys fall back to the
// palette's C color (Qt's `assignDefaultPalette`-style "-1" entry).
interface RenderPalette {
    bg: string;
    bond: string;
    labelBg: string;
    annotation: string;
    elements: Record<string, string>;
}

// f01 → 2-digit hex byte (RDKit DrawColour floats in [0,1]).
const F = (v: number): string => {
    const n = Math.max(0, Math.min(255, Math.round(v * 255)));
    return n.toString(16).padStart(2, '0');
};
const RGB = (r: number, g: number, b: number): string =>
    `#${F(r)}${F(g)}${F(b)}`;

// Light-on-white: bond/strokes stay near-black; canvas background pure
// white (matches Qt's QGraphicsView default; rendering_settings_dialog
// doesn't override it for non-dark schemes).
const LIGHT_BOND = '#222';
// Keep the heteroatom label backdrop as the CSS keyword "white" (not
// '#ffffff') so the SVG "transparent background" test can target the
// background-fill rect uniquely by its hex form. Same pixel either way.
const LIGHT_LABEL_BG = 'white';
const LIGHT_BG = '#ffffff';

// Dark-mode chrome — Qt swaps the scene BG via setBackgroundBrush and
// the bond color to a light gray (scene.cpp / view.cpp). Pick a near-
// black BG with light gray strokes for legibility (mirrors the
// DARK_MODE palette's carbon color of 0.9,0.9,0.9 → #e6e6e6).
const DARK_BOND = '#e6e6e6';
const DARK_LABEL_BG = '#1a1a1a';
const DARK_BG = '#1a1a1a';

const COLOR_PALETTES: Record<ActiveColorScheme, RenderPalette> = {
    // DEFAULT: preserve the existing ELEMENT_COLORS visuals exactly —
    // we vetted these against the Qt sketcher's default-scheme output in
    // earlier batches, so switching DEFAULT to RDKit's raw assignDefault
    // values would visually regress the no-touch baseline.
    'default': {
        bg: LIGHT_BG,
        bond: LIGHT_BOND,
        labelBg: LIGHT_LABEL_BG,
        annotation: '#444',
        elements: ELEMENT_COLORS,
    },
    // AVALON: per assignAvalonPalette (MolDraw2DHelpers.h:96-110). F/Cl/
    // Br all collapse to the same green (0,0.498,0); P is purple; S is
    // brown; I is dark purple.
    'avalon': {
        bg: LIGHT_BG,
        bond: LIGHT_BOND,
        labelBg: LIGHT_LABEL_BG,
        annotation: '#444',
        elements: {
            C: '#222', H: '#000', N: RGB(0, 0, 1), O: RGB(1, 0, 0),
            F: RGB(0, 0.498, 0), Cl: RGB(0, 0.498, 0),
            Br: RGB(0, 0.498, 0), I: RGB(0.247, 0, 0.498),
            P: RGB(0.498, 0, 0.498), S: RGB(0.498, 0.247, 0),
            Si: '#7d6f4a',
        },
    },
    // CDK: per assignCDKPalette (MolDraw2DHelpers.h:118-133). Brighter
    // N (0.188,0.314,0.972); pale-green F; salmon-red Br; lime Cl.
    'cdk': {
        bg: LIGHT_BG,
        bond: LIGHT_BOND,
        labelBg: LIGHT_LABEL_BG,
        annotation: '#444',
        elements: {
            C: '#222', H: '#000', N: RGB(0.188, 0.314, 0.972),
            O: RGB(1, 0.051, 0.051), F: RGB(0.565, 0.878, 0.314),
            Cl: RGB(0.122, 0.498, 0.122), Br: RGB(0.651, 0.161, 0.161),
            I: RGB(0.58, 0, 0.58), P: RGB(1, 0.5, 0),
            S: RGB(0.776, 0.776, 0.173), B: RGB(1, 0.71, 0.71),
            Si: '#7d6f4a',
        },
    },
    // DARK_MODE: per assignDarkModePalette (MolDraw2DHelpers.h:136-150).
    // Carbon = light gray; bonds + labels match. Adjusted N hue for
    // legibility on dark BG.
    'dark': {
        bg: DARK_BG,
        bond: DARK_BOND,
        labelBg: DARK_LABEL_BG,
        annotation: '#cccccc',
        elements: {
            C: DARK_BOND, H: DARK_BOND,
            N: RGB(0.33, 0.41, 0.92), O: RGB(1, 0.2, 0.2),
            F: RGB(0.2, 0.8, 0.8), Cl: RGB(0, 0.802, 0),
            Br: RGB(0.71, 0.4, 0.07), I: RGB(0.89, 0.004, 1),
            P: RGB(1, 0.5, 0), S: RGB(0.8, 0.8, 0),
            Si: '#7d6f4a',
        },
    },
    // BLACK_WHITE: Color Heteroatoms OFF on a light BG — every atom
    // renders as the bond color (assignBWPalette only sets -1 to black).
    'bw': {
        bg: LIGHT_BG,
        bond: LIGHT_BOND,
        labelBg: LIGHT_LABEL_BG,
        annotation: '#444',
        elements: {},
    },
    // WHITE_BLACK: Color Heteroatoms OFF on a dark BG. Qt's comment
    // (image_constants.h:46) calls this "very, very light gray structure
    // (matches DARK_MODE's carbon color)" — every atom uses the dark
    // bond color (#e6e6e6 light gray) against the dark BG.
    'white-black': {
        bg: DARK_BG,
        bond: DARK_BOND,
        labelBg: DARK_LABEL_BG,
        annotation: '#cccccc',
        elements: {},
    },
};

function resolveActiveScheme(opt: DisplayOptions): ActiveColorScheme {
    if (opt.colorHeteroatoms) {
        return opt.colorScheme;
    }
    return opt.bwColorScheme === 'dark' ? 'white-black' : 'bw';
}

function getPalette(opt: DisplayOptions): RenderPalette {
    return COLOR_PALETTES[resolveActiveScheme(opt)];
}

function elementColor(pal: RenderPalette, el: string): string {
    return pal.elements[el] ?? pal.elements.C ?? pal.bond;
}

function modelFromPixel(
    canvas: HTMLCanvasElement,
    view: View,
    pixelX: number,
    pixelY: number,
): { x: number; y: number } {
    const cx = canvas.width / 2 + view.offsetX;
    const cy = canvas.height / 2 + view.offsetY;
    return {
        x: (pixelX - cx) / view.scale,
        y: -(pixelY - cy) / view.scale,
    };
}

function pixelFromModel(
    canvas: HTMLCanvasElement,
    view: View,
    x: number,
    y: number,
): { px: number; py: number } {
    const cx = canvas.width / 2 + view.offsetX;
    const cy = canvas.height / 2 + view.offsetY;
    return { px: x * view.scale + cx, py: -y * view.scale + cy };
}

// Locate the neighbor atom index for an attachment-point dummy (which always
// has totalDegree == 1). Returns -1 when no bond involves `apIdx` — a defensive
// fallback that should never trigger for AP atoms created via addAttachmentPoint
// but keeps a corrupt incoming description from crashing the renderer.
function attachmentPointAnchor(apIdx: number, bonds: BondDesc[]): number {
    for (const b of bonds) {
        if (b.a === apIdx) return b.b;
        if (b.b === apIdx) return b.a;
    }
    return -1;
}

// Stamp a wavy squiggle path at (cx, cy) rotated `angleRad`. The base path
// is horizontal, centered on the origin, extending from -W/2 to +W/2 where
// W = numWaves * widthPerWave (Qt: get_wavy_line_path in coord_utils.cpp:254-274).
// Caller is responsible for ctx.strokeStyle / lineWidth. Quadratic curves
// approximate Qt's arcs at this size — visually indistinguishable.
function strokeWavyPath(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    angleRad: number,
    widthPerWave: number,
    height: number,
    numWaves: number,
): void {
    const halfWidth = widthPerWave / 2;
    const startX = -numWaves * halfWidth;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angleRad);
    ctx.beginPath();
    ctx.moveTo(startX, 0);
    let x = startX;
    for (let i = 0; i < numWaves; i++) {
        // Down half-wave (positive screen y because canvas y is down).
        ctx.quadraticCurveTo(x + halfWidth / 2, height, x + halfWidth, 0);
        x += halfWidth;
        // Up half-wave.
        ctx.quadraticCurveTo(x + halfWidth / 2, -height, x + halfWidth, 0);
        x += halfWidth;
    }
    ctx.stroke();
    ctx.restore();
}

// Stamp a reaction arrow centered at (cx, cy). Horizontal, tip on the right.
// Mirrors Qt NonMolecularItem::updateCachedData (molviewer/non_molecular_item.cpp:44-66):
// horizontal shaft from (-half, 0) to (+half, 0), then a chevron drawn as two
// line segments from the tip back to (tip_start, ±half_width). Caller sets
// strokeStyle / lineWidth.
function strokeRxnArrow(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    lengthPx: number,
    tipHalfWidthPx: number,
): void {
    const halfLen = lengthPx / 2;
    const tipStartX = cx + halfLen - tipHalfWidthPx;
    const tipX = cx + halfLen;
    ctx.beginPath();
    ctx.moveTo(cx - halfLen, cy);
    ctx.lineTo(tipX, cy);
    ctx.lineTo(tipStartX, cy - tipHalfWidthPx);
    ctx.moveTo(tipX, cy);
    ctx.lineTo(tipStartX, cy + tipHalfWidthPx);
    ctx.stroke();
}

// Stamp a reaction plus sign centered at (cx, cy). Two crossed line segments
// of total length PLUS_LENGTH each. Qt: NonMolecularItem::updateCachedData
// (non_molecular_item.cpp:67-72).
function strokeRxnPlus(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    halfLengthPx: number,
): void {
    ctx.beginPath();
    ctx.moveTo(cx - halfLengthPx, cy);
    ctx.lineTo(cx + halfLengthPx, cy);
    ctx.moveTo(cx, cy - halfLengthPx);
    ctx.lineTo(cx, cy + halfLengthPx);
    ctx.stroke();
}

function nearestAtomIndex(
    canvas: HTMLCanvasElement,
    view: View,
    atoms: AtomDesc[],
    pixelX: number,
    pixelY: number,
): number {
    let bestIdx = -1;
    let bestDist = ATOM_HIT_RADIUS;
    for (const a of atoms) {
        const { px, py } = pixelFromModel(canvas, view, a.x, a.y);
        const d = Math.hypot(px - pixelX, py - pixelY);
        if (d < bestDist) {
            bestIdx = a.i;
            bestDist = d;
        }
    }
    return bestIdx;
}

// Index of the bond whose pixel-space line segment is closest to (px,py),
// or -1 when no bond is within BOND_HIT_RADIUS. Used by the select tool.
function nearestBondIndex(
    canvas: HTMLCanvasElement,
    view: View,
    rd: RenderDesc,
    pixelX: number,
    pixelY: number,
): number {
    let bestIdx = -1;
    let bestDist = BOND_HIT_RADIUS;
    for (let i = 0; i < rd.bonds.length; ++i) {
        const b = rd.bonds[i];
        const a1 = rd.atoms[b.a];
        const a2 = rd.atoms[b.b];
        if (!a1 || !a2) continue;
        const p1 = pixelFromModel(canvas, view, a1.x, a1.y);
        const p2 = pixelFromModel(canvas, view, a2.x, a2.y);
        const dx = p2.px - p1.px;
        const dy = p2.py - p1.py;
        const len2 = dx * dx + dy * dy;
        if (len2 === 0) continue;
        let t = ((pixelX - p1.px) * dx + (pixelY - p1.py) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const qx = p1.px + t * dx;
        const qy = p1.py + t * dy;
        const d = Math.hypot(qx - pixelX, qy - pixelY);
        if (d < bestDist) {
            bestIdx = i;
            bestDist = d;
        }
    }
    return bestIdx;
}

// Qt ui/selection_tool_popup.ui offers three shapes for the select tool:
// rect_btn / lasso_btn / ellipse_btn. We mirror the same three.
type SelectShape = 'rect' | 'lasso' | 'ellipse';

// Export format dropdown choices in the Export-to-File modal. Maps to the
// Qt FileExportDialog format combo (dialog/file_export_dialog.cpp), trimmed
// to the formats the lean MolModel actually exposes today: SMILES via
// toSmiles, MDL MOL V2000/V3000 via toMolBlock(v3000). Reaction formats,
// InChI/InChIKey, PDB, XYZ, Maestro, Marvin are deferred — they'd need
// extra rdkit_extensions writer paths plumbed through MolModel first.
type ExportFormat = 'smiles' | 'mol-v2000' | 'mol-v3000';
const EXPORT_FORMAT_CHOICES: { value: ExportFormat; label: string;
    ext: string }[] = [
    { value: 'smiles', label: 'SMILES', ext: 'smi' },
    { value: 'mol-v2000', label: 'MDL MOL V2000', ext: 'mol' },
    { value: 'mol-v3000', label: 'MDL MOL V3000', ext: 'mol' },
];

// Save-Image dialog choices. Qt's FileSaveImageDialog
// (dialog/file_save_image_dialog.cpp:80-86) offers PNG and SVG; PNG is
// painted by drawSketch into an offscreen canvas, SVG is built by
// buildSketchSvg from the same RenderDesc + view so the vector output
// matches the pixel output geometrically.
type ImageFormat = 'png' | 'svg';
const IMAGE_FORMAT_CHOICES: { value: ImageFormat; label: string;
    ext: string; mime: string }[] = [
    { value: 'png', label: 'PNG', ext: 'png', mime: 'image/png' },
    { value: 'svg', label: 'SVG', ext: 'svg', mime: 'image/svg+xml' },
];
const IMAGE_SIZE_MIN = 1;
const IMAGE_SIZE_MAX = 9999;

// Configure-View options — mirrors Qt's ConfigureViewMenu (menu/
// sketcher_top_bar_menus.cpp:109-128). The four toggles match Qt's
// menu items 1:1; defaults match SketcherModel::initializeDefaults
// (model/sketcher_model.cpp:230-233). Only `colorHeteroatoms` is wired
// to the renderer today (gates ELEMENT_COLORS); the other three are
// stored faithfully and reserved for future rendering hooks
// (valence-error halo, stereo annotations, implicit-H labels on
// carbons) once the lean MolModel exposes the underlying data — Qt
// itself stores them even when the renderer hasn't yet consumed them,
// which is the behavior the port matches.
interface DisplayOptions {
    showValenceErrors: boolean;
    colorHeteroatoms: boolean;
    showStereoLabels: boolean;
    useImplicitHydrogens: boolean;
    // Qt RenderingSettings (dialog/rendering_settings_dialog.h). Surfaced
    // through the "Preferences..." (2D Settings) modal; defaults mirror
    // image_constants.h DEFAULT_FONT_SIZE=18 and constants.h
    // BOND_DEFAULT_PEN_WIDTH=2.4. The React port uses smaller per-pixel
    // defaults (13/2) because its canvas zoom level is independent of the
    // Qt scene scale — what we preserve is "user hasn't touched anything
    // ⇒ visuals identical to pre-Batch-24".
    atomFontSize: number;
    bondLineWidth: number;
    // Qt's explicit_abs_labels_shown (default false). When true the "abs"
    // prefix shipped from `atom_chirality_label` (lean_main.cpp) is kept
    // in the rendered label ("abs (R)"); when false we strip it ("(R)").
    explicitAbsLabels: boolean;
    // Qt's m_undefined_centers_labels_cb (rendering_settings_dialog.ui:274-281,
    // default true). Disabled when Show stereo labels is off. When ON, atoms
    // flagged as possible-but-unspecified stereo centers (AtomDesc.psbl) get
    // a "(?)" label. Mirrors the StereoLabels::ALL vs DEFINED distinction in
    // atom_display_settings.h (collapsed into showStereoLabels+this boolean).
    includeUndefinedStereoCenters: boolean;
    // Qt's CarbonLabels enum (image_constants.h:24-32). Controls when
    // carbon atoms get a visible "C" label. NONE = bare-dot rendering
    // (the React default and Qt's default); TERMINAL = label carbons
    // with exactly one heavy-atom bond; ALL = label every carbon.
    carbonLabels: CarbonLabelMode;
    // Qt's m_color_mode_combo / m_bw_mode_combo (rendering_settings_dialog.ui
    // :137-154). The two values persist independently — only one combo is
    // shown at a time (gated by Color Heteroatoms) but flipping back to
    // the other preserves the user's Default/Dark/Avalon/CDK choice. The
    // sync_comboboxes logic at rendering_settings_dialog.cpp:111-121
    // mirrors only the "Dark" bit between them; we replicate that in the
    // change handler so picking Dark in one combo nudges the other.
    colorScheme: ColorScheme;
    bwColorScheme: BWColorScheme;
}
type CarbonLabelMode = 'none' | 'terminal' | 'all';
const DEFAULT_ATOM_FONT_SIZE = 13;
const DEFAULT_BOND_LINE_WIDTH = 2;
const DEFAULT_DISPLAY_OPTIONS: DisplayOptions = {
    showValenceErrors: true,
    colorHeteroatoms: true,
    showStereoLabels: true,
    useImplicitHydrogens: false,
    atomFontSize: DEFAULT_ATOM_FONT_SIZE,
    bondLineWidth: DEFAULT_BOND_LINE_WIDTH,
    explicitAbsLabels: false,
    includeUndefinedStereoCenters: true,
    carbonLabels: 'none',
    colorScheme: 'default',
    bwColorScheme: 'default',
};

// Matches rdkit_extensions::ABSOLUTE_STEREO_PREFIX = "abs" + HAIR_SPACE
// (U+200A). The lean WASM bindings emit the raw label including this
// prefix; the React renderer strips it unless `explicitAbsLabels` is on,
// mirroring Qt's RenderingSettings.m_explicit_abs_labels_shown default.
const ABS_STEREO_PREFIX = 'abs ';
function renderedStereoLabel(label: string, showAbsPrefix: boolean): string {
    if (showAbsPrefix) return label;
    return label.startsWith(ABS_STEREO_PREFIX)
        ? label.substring(ABS_STEREO_PREFIX.length)
        : label;
}

// Mirrors Qt's SKETCHER_RELEASE/SKETCHER_BUILD substituted from version.h.in
// at build time. We hardcode a string here to avoid pulling the project-
// root version.json into the Vite root; keep this aligned with
// `../../version.json` (worktree root). The MAJOR-MINOR slug is the
// fragment Qt's onHelpClicked drops into the docs URL
// (widget/sketcher_top_bar.cpp:293-300).
const SKETCHER_VERSION = '2026.3.55';
const SKETCHER_VERSION_SLUG = '2026-3';
const HELP_DOCS_URL =
    `https://learn.schrodinger.com/public/2D-Sketcher/${SKETCHER_VERSION_SLUG}` +
    '/Content/2d-sketcher/2d_sketcher_home.htm';
const EULA_URL = 'https://www.schrodinger.com/salesagreements';

interface DragShape {
    kind: SelectShape;
    startPx: number;
    startPy: number;
    curPx: number;
    curPy: number;
    // For lasso only — sampled freehand points (including start). We append
    // on every mousemove while dragging. Rect/ellipse derive geometry purely
    // from start/cur, so this stays undefined for those.
    lassoPoints?: { px: number; py: number }[];
    additive: boolean;
    // 'select' = rubber-band select; 'erase' = rubber-band erase (Qt
    // EraseSceneTool reuses RectSelectSceneTool's rubber-band but commits
    // a delete on the contents instead of selecting them).
    mode: 'select' | 'erase';
}

interface AtomDrag {
    // The "grabbed" atom — the one the user actually clicked. Its (fromX,
    // fromY) define the drag origin against which the live cursor delta is
    // measured. For a single-atom drag, `atoms` is just [{idx, fromX, fromY}]
    // for the grabbed atom. For a multi-atom drag, `atoms` lists every atom
    // in the selection (including the grabbed one) so the whole set
    // translates together by the same (dx, dy).
    grabbedIdx: number;
    grabbedFromX: number;
    grabbedFromY: number;
    atoms: { idx: number; fromX: number; fromY: number }[];
    startPx: number; // pixel coords at drag start (for threshold check)
    startPy: number;
    moved: boolean; // true once we crossed the move threshold
}

const ATOM_DRAG_THRESHOLD = 3; // pixels — below this, treat as a click

// Mirrors Qt DrawChainSceneTool (tool/draw_chain_scene_tool.cpp). Tracks an
// active chain-draw drag so the live "blue hint" preview can be drawn between
// the press point and the current cursor, and the commit (mouseUp) knows
// whether to attach the new chain to an existing start atom.
interface ChainDrag {
    startPx: number;
    startPy: number;
    curPx: number;
    curPy: number;
    // start in model coords — snapped to an existing atom's position when
    // startAtomIdx >= 0, otherwise the mousedown pixel converted to model.
    startX: number;
    startY: number;
    // Index of the existing atom under the press point (-1 = empty area).
    // Used to omit the start position from addAtomChain coords + bond the
    // first new atom to this existing atom (Qt's `skip_first_coord` +
    // `bound_to_atom` plumbing).
    startAtomIdx: number;
}

interface RotateDrag {
    // Pivot in model coords — the geometric center of rotation. All `atoms`
    // rotate about this point. Pixel projection (pivotPx,pivotPy) is captured
    // at drag start so a pan during the drag wouldn't shift the rotation
    // center mid-gesture.
    pivotX: number;
    pivotY: number;
    pivotPx: number;
    pivotPy: number;
    // Atoms being rotated. fromX/fromY are model coords at drag start.
    atoms: { idx: number; fromX: number; fromY: number }[];
    // Initial cursor angle (radians) from the pivot at mouse-press, used as
    // the zero reference so the first sample doesn't snap the structure.
    startAngleRad: number;
    moved: boolean;
}

interface RotationHandle {
    pivotPx: number;
    pivotPy: number;
    handlePx: number;
    handlePy: number;
}

function distanceSq(ax: number, ay: number, bx: number, by: number): number {
    const dx = ax - bx;
    const dy = ay - by;
    return dx * dx + dy * dy;
}

// Model-space port of Qt's get_bond_chain_atom_coords
// (tool/draw_chain_scene_tool.cpp:112-162). Builds the zig-zag chain that
// fits between `start` and `end` (both in model coords) at the nearest
// 30°-rounded angle, with 1.5-unit bond length and alternating ±30° kinks.
// Returns the full atom positions including the start point; callers are
// responsible for dropping coords[0] when the chain attaches to an existing
// atom (matches Qt's `skip_first_coord` logic).
const CHAIN_BOND_LEN = 1.5;
function computeChainAtomCoords(
    startX: number, startY: number,
    endX: number, endY: number,
): { x: number; y: number }[] {
    const STEP = Math.PI / 6;
    const dx = endX - startX;
    const dy = endY - startY;
    // atan2 in model space (Y up) gives the same "math angle" Qt computes
    // via QLineF::angle (which is also math-style CCW from +X, even though
    // its inputs are pixel coords). Round to nearest 30° step.
    const rawAngle = Math.atan2(dy, dx);
    const angle = Math.round(rawAngle / STEP) * STEP;
    const COS_STEP = Math.cos(STEP);
    const SIN_STEP = 0.5;
    // Projection of one bond onto the rounded-angle vector V. Bonds zig-zag
    // ±30° around V, so each bond covers BOND_LEN*cos(30°) along V.
    const projLen = CHAIN_BOND_LEN * COS_STEP;
    const projX = Math.cos(angle) * projLen;
    const projY = Math.sin(angle) * projLen;
    // Perpendicular kick to V — odd-index atoms sit one BOND_LEN*sin(30°)
    // off V; even-index atoms are on V. Rotating (cos,sin) by +90° CCW
    // gives (-sin, cos).
    const perpX = -Math.sin(angle) * CHAIN_BOND_LEN * SIN_STEP;
    const perpY = Math.cos(angle) * CHAIN_BOND_LEN * SIN_STEP;
    const dist = Math.hypot(dx, dy);
    let numBonds = Math.round(dist / projLen);
    if (numBonds === 0) numBonds = 1; // always at least one bond
    const coords: { x: number; y: number }[] = [];
    for (let i = 0; i <= numBonds; ++i) {
        coords.push({
            x: startX + i * projX + ((i % 2) * perpX),
            y: startY + i * projY + ((i % 2) * perpY),
        });
    }
    return coords;
}

const CHAIN_HINT_COLOR = '#9cbcd1'; // Qt STRUCTURE_HINT_COLOR

// Qt's QGraphicsView wheel zoom (sketcher_view.cpp `wheelEvent`) uses
// scale_factor = 2^(angleDelta.y / 2400) and caps zoom-in at the default
// "fit" scale — you can never zoom in past that resting view. We mirror
// both: factor formula and the DEFAULT_SCALE upper bound.
const MIN_VIEW_SCALE = 4;

function dragShapeBounds(d: DragShape): {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
} {
    if (d.kind === 'lasso' && d.lassoPoints && d.lassoPoints.length > 0) {
        let x1 = Infinity;
        let y1 = Infinity;
        let x2 = -Infinity;
        let y2 = -Infinity;
        for (const p of d.lassoPoints) {
            if (p.px < x1) x1 = p.px;
            if (p.py < y1) y1 = p.py;
            if (p.px > x2) x2 = p.px;
            if (p.py > y2) y2 = p.py;
        }
        return { x1, y1, x2, y2 };
    }
    return {
        x1: Math.min(d.startPx, d.curPx),
        y1: Math.min(d.startPy, d.curPy),
        x2: Math.max(d.startPx, d.curPx),
        y2: Math.max(d.startPy, d.curPy),
    };
}

// Ray-casting point-in-polygon test (standard even-odd rule). Used to test
// atoms and bond midpoints against the lasso path's polygon (Qt's
// LassoSelectionItem builds a QPainterPath via addPolygon, which uses the
// same even-odd containment).
function pointInPolygon(
    px: number,
    py: number,
    poly: { px: number; py: number }[],
): boolean {
    if (poly.length < 3) return false;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].px;
        const yi = poly[i].py;
        const xj = poly[j].px;
        const yj = poly[j].py;
        const intersects = (yi > py) !== (yj > py) &&
            px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-12) + xi;
        if (intersects) inside = !inside;
    }
    return inside;
}

function pointInEllipseBounds(
    px: number,
    py: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
): boolean {
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const rx = (x2 - x1) / 2;
    const ry = (y2 - y1) / 2;
    if (rx <= 0 || ry <= 0) return false;
    const dx = (px - cx) / rx;
    const dy = (py - cy) / ry;
    return dx * dx + dy * dy <= 1;
}

// Returns true if a model-space point (already projected to pixel coords)
// falls inside the drag shape. Centralized so atom containment and bond
// midpoint containment share the exact same rule per shape — mirrors Qt's
// `getCollidingItemsUsingBondMidpoints` which treats atoms-by-position and
// bonds-by-midpoint identically against the same shape geometry.
function pointInDragShape(d: DragShape, px: number, py: number): boolean {
    const { x1, y1, x2, y2 } = dragShapeBounds(d);
    if (d.kind === 'rect') {
        return px >= x1 && px <= x2 && py >= y1 && py <= y2;
    }
    if (d.kind === 'ellipse') {
        return pointInEllipseBounds(px, py, x1, y1, x2, y2);
    }
    return pointInPolygon(px, py, d.lassoPoints ?? []);
}

// Render a coarse-grained monomeric scene: connectors under labeled beads.
// Mirrors Qt's AbstractMonomerItem (rounded-rect peptide bead, residue-class
// fill, 1-letter label) + MonomerConnectorItem. Bead/font/connector sizes
// scale with the view so zoom stays consistent with atomistic spacing.
function drawMonomers(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    view: View,
    rd: RenderDesc,
): void {
    const byIdx = new Map<number, AtomDesc>();
    for (const a of rd.atoms) byIdx.set(a.i, a);
    // Connectors first so beads paint on top. A sugar→base branch (conn:"base")
    // is drawn thinner and lighter than a peptide/NA backbone connector.
    const backboneW = Math.max(2, view.scale * 0.1);
    for (const b of rd.bonds) {
        const a1 = byIdx.get(b.a);
        const a2 = byIdx.get(b.b);
        if (!a1 || !a2) continue;
        const p1 = pixelFromModel(canvas, view, a1.x, a1.y);
        const p2 = pixelFromModel(canvas, view, a2.x, a2.y);
        if (b.conn === 'base') {
            ctx.strokeStyle = NA_BASE_CONNECTOR_COLOR;
            ctx.lineWidth = Math.max(1.5, view.scale * 0.05);
        } else {
            ctx.strokeStyle = MONOMER_CONNECTOR_COLOR;
            ctx.lineWidth = backboneW;
        }
        ctx.beginPath();
        ctx.moveTo(p1.px, p1.py);
        ctx.lineTo(p2.px, p2.py);
        ctx.stroke();
    }
    // Beads. Qt bead ≈ 0.75 model units; keep that proportion off view.scale.
    const half = Math.max(10, view.scale * 0.37);
    const radius = Math.max(3, view.scale * 0.1);
    const font = `${Math.max(9, Math.round(view.scale * 0.42))}px sans-serif`;
    // Trace the bead outline for the given subtype into the current path.
    const beadPath = (mon: string | undefined, cx: number, cy: number,
                      h: number): void => {
        if (mon === 'base') {
            // Diamond needs a larger half-diagonal to enclose the same label.
            diamondPath(ctx, cx, cy, h * 1.35);
        } else if (mon === 'phos') {
            ctx.beginPath();
            ctx.ellipse(cx, cy, h, h, 0, 0, 2 * Math.PI);
        } else if (mon === 'sugar') {
            ctx.beginPath();
            ctx.rect(cx - h, cy - h, h * 2, h * 2);
        } else {
            roundedRectPath(ctx, cx - h, cy - h, h * 2, h * 2, radius);
        }
    };
    for (const a of rd.atoms) {
        const p = pixelFromModel(canvas, view, a.x, a.y);
        // Selection halo (sage ring), matching the atomistic selection look.
        if (a.sel) {
            beadPath(a.mon, p.px, p.py, half + 3);
            ctx.fillStyle = ACCENT_GREEN;
            ctx.fill();
        }
        beadPath(a.mon, p.px, p.py, half);
        ctx.fillStyle = monomerFillFor(a.mon, a.lbl);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = monomerBorderFor(a.mon, a.lbl);
        ctx.stroke();
        ctx.fillStyle = MONOMER_LABEL_COLOR;
        ctx.font = font;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText((a.lbl ?? '').slice(0, 6), p.px, p.py);
    }
}

function drawSketch(
    canvas: HTMLCanvasElement,
    view: View,
    rd: RenderDesc,
    pendingAtomIdx: number | null,
    hoverAtomIdx: number | null,
    dragShape: DragShape | null,
    rotationHandle: RotationHandle | null,
    chainDrag: ChainDrag | null,
    displayOptions: DisplayOptions = DEFAULT_DISPLAY_OPTIONS,
): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const palette = getPalette(displayOptions);
    // Fill (not just clear) so dark-mode schemes get their BG color
    // instead of the default-transparent canvas underneath.
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Original sketcher has no grid — a clean working-area canvas reads
    // without competing for attention with the structure.

    // Coarse-grained monomeric scene: render labeled beads + connectors and
    // skip the atomistic passes entirely (Qt AbstractMonomerItem/Connector).
    if (rd.monomeric) {
        drawMonomers(ctx, canvas, view, rd);
        return;
    }

    const BOND_STROKE = displayOptions.bondLineWidth;
    const BOND_DOUBLE_OFFSET = 4.5;
    // Subscript (H count, charge) scales proportionally to atom label so a
    // doubled font size doesn't leave the subscripts looking shrunken.
    const ATOM_FONT_PX = displayOptions.atomFontSize;
    const SUB_FONT_PX = Math.max(7, Math.round(ATOM_FONT_PX * 9 / 13));
    const ATOM_FONT = `${ATOM_FONT_PX}px sans-serif`;
    const SUB_FONT = `${SUB_FONT_PX}px sans-serif`;
    // Query-bond annotation font — a touch smaller than the atom label, like
    // Qt's query/stereo annotation text.
    const QUERY_LABEL_FONT =
        `${Math.max(8, Math.round(ATOM_FONT_PX * 10 / 13))}px sans-serif`;
    // Charge superscript baseline offset (the original code used py - 4 for
    // a 13px font); keep proportional so it doesn't drift up at larger sizes.
    const CHARGE_DY = Math.round(ATOM_FONT_PX * 4 / 13);

    // Centroid of all atoms — used to pick the "inside" side for aromatic
    // inner-dashed lines so a benzene ring shows three inward dashes (the
    // classic look). Falls back to the geometric origin for an empty mol.
    let centroidX = 0;
    let centroidY = 0;
    for (const a of rd.atoms) {
        centroidX += a.x;
        centroidY += a.y;
    }
    if (rd.atoms.length > 0) {
        centroidX /= rd.atoms.length;
        centroidY /= rd.atoms.length;
    }
    const centroidPx = pixelFromModel(canvas, view, centroidX, centroidY);

    // Per-atom degree + double-bond count — feeds the carbon-label rule
    // (mirrors AtomItem::determineLabelIsVisible at molviewer/atom_item.cpp:
    // 677-720). Computed once per draw so the inner atom loop is O(1).
    const degree = new Array<number>(rd.atoms.length).fill(0);
    const doubleCount = new Array<number>(rd.atoms.length).fill(0);
    for (const bb of rd.bonds) {
        degree[bb.a]++; degree[bb.b]++;
        if (bb.o === 2) { doubleCount[bb.a]++; doubleCount[bb.b]++; }
    }
    const shouldLabelCarbon = (i: number, a: AtomDesc): boolean => {
        if (a.el !== 'C') return false;
        if (displayOptions.carbonLabels === 'all') return true;
        const d = degree[i];
        if (d === 0) return true;
        if (displayOptions.carbonLabels === 'terminal' && d === 1) return true;
        if (d === 2 && doubleCount[i] === 2) return true;
        return false;
    };

    for (let i = 0; i < rd.bonds.length; ++i) {
        const b = rd.bonds[i];
        const p1 = pixelFromModel(canvas, view, rd.atoms[b.a].x, rd.atoms[b.a].y);
        const p2 = pixelFromModel(canvas, view, rd.atoms[b.b].x, rd.atoms[b.b].y);
        if (b.sel) {
            // Wide sage highlight underneath the bond strokes — matches the
            // selection halo color used for atoms below.
            ctx.strokeStyle = SELECTION_FILL;
            ctx.lineWidth = 9;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(p1.px, p1.py);
            ctx.lineTo(p2.px, p2.py);
            ctx.stroke();
            ctx.lineCap = 'butt';
        }
        ctx.strokeStyle = palette.bond;
        ctx.fillStyle = palette.bond;
        // Stereo bonds: wedge is a filled triangle expanding from begin to
        // end atom; dash is a sequence of perpendicular bars that grow in
        // length toward the end atom. Both replace the plain line stroke
        // for single bonds (b.o === 1); for double/triple we still draw
        // the second stroke so the order is visible alongside the stereo.
        const dir = b.dir ?? BOND_DIR_NONE;
        if (dir === BOND_DIR_WEDGE && b.o === 1) {
            const dx = p2.px - p1.px;
            const dy = p2.py - p1.py;
            const len = Math.hypot(dx, dy);
            const ox = (-dy / len) * 5;
            const oy = (dx / len) * 5;
            ctx.beginPath();
            ctx.moveTo(p1.px, p1.py);
            ctx.lineTo(p2.px + ox, p2.py + oy);
            ctx.lineTo(p2.px - ox, p2.py - oy);
            ctx.closePath();
            ctx.fill();
        } else if (dir === BOND_DIR_DASH && b.o === 1) {
            const dx = p2.px - p1.px;
            const dy = p2.py - p1.py;
            const len = Math.hypot(dx, dy);
            const ux = dx / len;
            const uy = dy / len;
            const px = -uy;
            const py2 = ux;
            const dashCount = 6;
            ctx.lineWidth = 1.6;
            for (let k = 1; k <= dashCount; ++k) {
                const t = k / (dashCount + 1);
                const cx = p1.px + dx * t;
                const cy = p1.py + dy * t;
                const halfW = 1 + 3.5 * t; // grows toward the end atom
                ctx.beginPath();
                ctx.moveTo(cx + px * halfW, cy + py2 * halfW);
                ctx.lineTo(cx - px * halfW, cy - py2 * halfW);
                ctx.stroke();
            }
        } else if (dir === BOND_DIR_UNKNOWN && b.o === 1) {
            // Wavy single bond (cis/trans-unknown stereo). Qt draws a zig-
            // zag wedge; we approximate with a sine wave along the bond
            // axis — both read as "stereo direction unknown" at a glance.
            const dx = p2.px - p1.px;
            const dy = p2.py - p1.py;
            const len = Math.hypot(dx, dy);
            const ux = dx / len;
            const uy = dy / len;
            const nx = -uy;
            const ny = ux;
            const amp = 3; // perpendicular swing in pixels
            const waves = Math.max(2, Math.round(len / 8));
            const steps = waves * 8;
            ctx.lineWidth = BOND_STROKE;
            ctx.beginPath();
            ctx.moveTo(p1.px, p1.py);
            for (let s = 1; s <= steps; ++s) {
                const t = s / steps;
                const phase = Math.sin(2 * Math.PI * waves * t);
                const cx = p1.px + dx * t + nx * amp * phase;
                const cy = p1.py + dy * t + ny * amp * phase;
                ctx.lineTo(cx, cy);
            }
            ctx.stroke();
        } else if (dir === BOND_DIR_EITHERDOUBLE && b.o === 2) {
            // Crossed double bond (cis/trans-unknown). Two symmetric
            // offset lines with their endpoints swapped → X shape. Qt's
            // crossDoubleBondLines (bond_item.cpp:557-563).
            const dx = p2.px - p1.px;
            const dy = p2.py - p1.py;
            const len = Math.hypot(dx, dy);
            const ox = (-dy / len) * BOND_DOUBLE_OFFSET;
            const oy = (dx / len) * BOND_DOUBLE_OFFSET;
            ctx.lineWidth = BOND_STROKE;
            // Line A: p1+offset → p2-offset
            ctx.beginPath();
            ctx.moveTo(p1.px + ox, p1.py + oy);
            ctx.lineTo(p2.px - ox, p2.py - oy);
            ctx.stroke();
            // Line B: p1-offset → p2+offset
            ctx.beginPath();
            ctx.moveTo(p1.px - ox, p1.py - oy);
            ctx.lineTo(p2.px + ox, p2.py + oy);
            ctx.stroke();
        } else if (b.bt === BOND_TYPE_DATIVE) {
            // Coordinate (dative) bond: a solid line with a filled arrowhead
            // at the end atom. Qt bond_item.cpp:210-216 + calcArrowTip.
            ctx.lineWidth = BOND_STROKE;
            ctx.beginPath();
            ctx.moveTo(p1.px, p1.py);
            ctx.lineTo(p2.px, p2.py);
            ctx.stroke();
            const dx = p2.px - p1.px;
            const dy = p2.py - p1.py;
            const len = Math.hypot(dx, dy);
            const ux = dx / len;
            const uy = dy / len;
            const nx = -uy;
            const ny = ux;
            const aLen = 8; // arrow length (Qt DATIVE_ARROW_LENGTH=7)
            const aHalf = 5; // arrow half-width (Qt DATIVE_ARROW_HALF_WIDTH=4)
            const baseX = p2.px - ux * aLen;
            const baseY = p2.py - uy * aLen;
            ctx.beginPath();
            ctx.moveTo(p2.px, p2.py);
            ctx.lineTo(baseX + nx * aHalf, baseY + ny * aHalf);
            ctx.lineTo(baseX - nx * aHalf, baseY - ny * aHalf);
            ctx.closePath();
            ctx.fill();
        } else if (b.bt === BOND_TYPE_ZERO) {
            // Zero-order bond: drawn with a dashed line (Qt m_dashed_pen,
            // dash pattern {3,3}). bond_item.cpp:218-219.
            ctx.lineWidth = BOND_STROKE;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(p1.px, p1.py);
            ctx.lineTo(p2.px, p2.py);
            ctx.stroke();
            ctx.setLineDash([]);
        } else if (b.arom) {
            // Aromatic: plain solid line PLUS an inner dashed line offset
            // toward the molecule centroid. Replaces both the single-stroke
            // path and the would-be double-stroke (RDKit reports aromatic
            // bonds as b.o = 1.5, which doesn't enter the 2/3 branch below).
            ctx.lineWidth = BOND_STROKE;
            ctx.beginPath();
            ctx.moveTo(p1.px, p1.py);
            ctx.lineTo(p2.px, p2.py);
            ctx.stroke();

            const dx = p2.px - p1.px;
            const dy = p2.py - p1.py;
            const len = Math.hypot(dx, dy);
            // Unit perpendicular to the bond direction.
            const nx = -dy / len;
            const ny = dx / len;
            // Bond midpoint → centroid: pick the offset sign whose dot
            // product with the perpendicular is positive (i.e. the side
            // that points toward the rest of the molecule).
            const mx = (p1.px + p2.px) / 2;
            const my = (p1.py + p2.py) / 2;
            const sign = nx * (centroidPx.px - mx) + ny * (centroidPx.py - my) >= 0
                ? 1
                : -1;
            const ox = nx * BOND_DOUBLE_OFFSET * sign;
            const oy = ny * BOND_DOUBLE_OFFSET * sign;
            // Shrink the inner line slightly along the bond so it doesn't
            // collide with adjacent bonds at the ring vertices.
            const shrink = 0.18;
            const sx1 = p1.px + dx * shrink + ox;
            const sy1 = p1.py + dy * shrink + oy;
            const sx2 = p1.px + dx * (1 - shrink) + ox;
            const sy2 = p1.py + dy * (1 - shrink) + oy;
            ctx.setLineDash([5, 3]);
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(sx1, sy1);
            ctx.lineTo(sx2, sy2);
            ctx.stroke();
            ctx.setLineDash([]);
        } else {
            ctx.lineWidth = BOND_STROKE;
            ctx.beginPath();
            ctx.moveTo(p1.px, p1.py);
            ctx.lineTo(p2.px, p2.py);
            ctx.stroke();
        }
        // Crossed double already drew both strokes itself (X shape); skip
        // the second-stroke pass so we don't double-paint.
        const isCrossedDouble = dir === BOND_DIR_EITHERDOUBLE && b.o === 2;
        if (!b.arom && !isCrossedDouble && (b.o === 2 || b.o === 3)) {
            const dx = p2.px - p1.px;
            const dy = p2.py - p1.py;
            const len = Math.hypot(dx, dy);
            const ox = (-dy / len) * BOND_DOUBLE_OFFSET;
            const oy = (dx / len) * BOND_DOUBLE_OFFSET;
            ctx.lineWidth = BOND_STROKE;
            ctx.beginPath();
            ctx.moveTo(p1.px + ox, p1.py + oy);
            ctx.lineTo(p2.px + ox, p2.py + oy);
            ctx.stroke();
            if (b.o === 3) {
                ctx.beginPath();
                ctx.moveTo(p1.px - ox, p1.py - oy);
                ctx.lineTo(p2.px - ox, p2.py - oy);
                ctx.stroke();
            }
        }
        // Query-bond + ring-topology annotation (Any / S/D / … and ⭔ / Not ⭔).
        // Qt draws it as a small label near the bond midpoint (bond_item.cpp:
        // 135-171). We place it just off the midpoint, offset perpendicular so
        // it clears the line. Kept horizontal for legibility (Qt rotates it
        // along the bond; a minor, documented divergence like the wavy bond).
        const annotation = bondAnnotationText(b);
        if (annotation) {
            const mx = (p1.px + p2.px) / 2;
            const my = (p1.py + p2.py) / 2;
            const dx = p2.px - p1.px;
            const dy = p2.py - p1.py;
            const len = Math.hypot(dx, dy) || 1;
            const nx = -dy / len;
            const ny = dx / len;
            const off = 8;
            ctx.font = QUERY_LABEL_FONT;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = palette.bond;
            ctx.fillText(annotation, mx + nx * off, my + ny * off);
        }
    }

    ctx.font = ATOM_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Valence-error halos: orange dotted ellipse drawn *under* the atom
    // labels so the label sits on top. Qt paints these inside AtomItem::paint
    // before the main label (molviewer/atom_item.cpp:750-758). The colors
    // and ~3px padding come from molviewer/constants.h:177-232.
    if (displayOptions.showValenceErrors) {
        ctx.save();
        ctx.strokeStyle = '#fb7100';
        ctx.fillStyle = '#ffecc5';
        ctx.lineWidth = 2;
        ctx.setLineDash([1, 3]);
        ctx.lineCap = 'round';
        for (const a of rd.atoms) {
            if (!a.verr) continue;
            const { px, py } = pixelFromModel(canvas, view, a.x, a.y);
            // 13 = atom-label half-width (matches the 13px-radius selection
            // halo) + the 3-px area border Qt uses on m_main_label_rect.
            const r = 13;
            ctx.beginPath();
            ctx.ellipse(px, py, r, r, 0, 0, 2 * Math.PI);
            ctx.fill();
            ctx.stroke();
        }
        ctx.restore();
    }
    for (let i = 0; i < rd.atoms.length; i++) {
        const a = rd.atoms[i];
        const { px, py } = pixelFromModel(canvas, view, a.x, a.y);
        const isPending = pendingAtomIdx === a.i;
        const isHover = hoverAtomIdx === a.i;
        // Attachment-point dummies render as a wavy squiggle (drawn in the
        // pass below) instead of an atom dot/label. Skip the dot, label,
        // and selection halo here — Qt does the same via
        // label_is_visible=false (atom_item.cpp:302-304). Selection is still
        // tracked, but visualizing it on a label-less dummy adds no signal.
        if (typeof a.ap === 'number') {
            continue;
        }
        if (a.sel) {
            // Sage outline ring + light sage fill matches the Qt sketcher's
            // selection halo so a port user can't tell the renderer changed.
            ctx.fillStyle = ACCENT_GREEN;
            ctx.beginPath();
            ctx.arc(px, py, 13, 0, 2 * Math.PI);
            ctx.fill();
            ctx.fillStyle = SELECTION_FILL;
            ctx.beginPath();
            ctx.arc(px, py, 10, 0, 2 * Math.PI);
            ctx.fill();
        }
        if (isPending || isHover) {
            ctx.fillStyle = isPending ? PENDING_FILL : HOVER_FILL;
            ctx.beginPath();
            ctx.arc(px, py, 13, 0, 2 * Math.PI);
            ctx.fill();
        }
        const hasCharge = typeof a.q === 'number' && a.q !== 0;
        const hasRadical = typeof a.nrad === 'number' && a.nrad > 0;
        // Carbons get only a dot unless they carry a charge / radical OR
        // the user turned on Preferences → Label Carbons (none/terminal/all,
        // mirrors Qt's CarbonLabels enum + AtomItem::determineLabelIsVisible).
        const dotOnly =
            a.el === 'C' && !hasCharge && !hasRadical
            && !isPending && !isHover && !a.sel
            && !shouldLabelCarbon(i, a);
        if (dotOnly) {
            ctx.fillStyle = palette.bond;
            ctx.beginPath();
            ctx.arc(px, py, 2.5, 0, 2 * Math.PI);
            ctx.fill();
            continue;
        }
        if (a.el !== 'C') {
            // Backdrop punches a hole in any bond line passing through —
            // matches the scheme's BG so dark-mode doesn't leave a white
            // square behind the letter.
            ctx.fillStyle = palette.labelBg;
            ctx.fillRect(px - 9, py - 9, 18, 18);
        }
        // ConfigureView "Heteroatom Colors" toggle gates which palette
        // is active (resolveActiveScheme flips to BW/WHITE_BLACK when
        // OFF). Element lookups fall back to the palette's carbon color
        // for unknown symbols.
        ctx.fillStyle = elementColor(palette, a.el);
        if (a.el === 'C' && a.sel && !isPending && !isHover && !hasCharge
            && !hasRadical && !shouldLabelCarbon(i, a)) {
            ctx.beginPath();
            ctx.arc(px, py, 2.5, 0, 2 * Math.PI);
            ctx.fill();
        } else {
            ctx.font = ATOM_FONT;
            // R-group atoms render as "R<n>" instead of the dummy "*" symbol,
            // and they suppress the H-count / charge superscripts the
            // underlying dummy atom would otherwise advertise.
            if (typeof a.rlabel === 'number') {
                ctx.fillStyle = elementColor(palette, 'C');
                ctx.fillText(`R${a.rlabel}`, px, py);
            } else if (typeof a.qlabel === 'string') {
                // Wildcard query atom (A/Q/M/X + H variants): render the
                // letter label instead of the dummy "*" symbol, with no
                // H-count / charge superscript.
                ctx.fillStyle = elementColor(palette, 'C');
                ctx.fillText(a.qlabel, px, py);
            } else {
                ctx.fillText(a.el, px, py);
                // H count: render "H" or "Hn" to the right of non-C labels. Skip
                // for C even when shown for charge — carbons typically suppress
                // their Hs to keep the structure readable.
                if (a.el !== 'C' && typeof a.nh === 'number' && a.nh > 0) {
                    ctx.textAlign = 'left';
                    const labelWidth = ctx.measureText(a.el).width;
                    const hX = px + labelWidth / 2 + 1;
                    ctx.fillText('H', hX, py);
                    if (a.nh > 1) {
                        ctx.font = SUB_FONT;
                        const hWidth = ctx.measureText('H').width;
                        ctx.fillText(String(a.nh), hX + hWidth + 1, py + CHARGE_DY);
                    }
                    ctx.textAlign = 'center';
                    ctx.font = ATOM_FONT;
                }
                // Combined radical + charge label (Qt:
                // AtomItem::updateChargeAndRadicalLabel, atom_item.cpp:539-575):
                //   - radical alone: "•" (or "n•" for n>1)
                //   - charge alone: "+" / "−" (or "n+" / "n−" for |n|>1)
                //   - both: "n•" wraps in parens when n>1, joined by a space:
                //       "•+", "(3•) 2+", etc.
                // Unicode minus sign reads better than ASCII "-".
                let chargeAndRadicalText = '';
                if (hasRadical) {
                    const n = a.nrad as number;
                    const parens = n > 1 && hasCharge;
                    chargeAndRadicalText =
                        (parens ? '(' : '') +
                        (n > 1 ? String(n) : '') +
                        '•' +
                        (parens ? ')' : '');
                }
                if (hasCharge) {
                    const q = a.q as number;
                    const sign = q > 0 ? '+' : '−';
                    const chargeText =
                        Math.abs(q) === 1 ? sign : `${Math.abs(q)}${sign}`;
                    chargeAndRadicalText +=
                        (chargeAndRadicalText ? ' ' : '') + chargeText;
                }
                if (chargeAndRadicalText) {
                    ctx.font = SUB_FONT;
                    ctx.textAlign = 'left';
                    const labelWidth = ctx.measureText(a.el).width;
                    // Push past the H label if one is rendered.
                    let chargeX = px + labelWidth / 2 + 1;
                    if (a.el !== 'C' && typeof a.nh === 'number' && a.nh > 0) {
                        ctx.font = ATOM_FONT;
                        chargeX += ctx.measureText('H').width;
                        if (a.nh > 1) {
                            ctx.font = SUB_FONT;
                            chargeX += ctx.measureText(String(a.nh)).width + 1;
                        }
                        ctx.font = SUB_FONT;
                    }
                    ctx.fillText(chargeAndRadicalText, chargeX, py - CHARGE_DY);
                    ctx.textAlign = 'center';
                    ctx.font = ATOM_FONT;
                }
            }
        }
    }

    // Attachment-point squiggles. Drawn after the atom labels so the wavy
    // line lays on top of any bond endpoint stub. Qt's geometry: a wavy
    // path perpendicular to the bond, centered on the AP atom position
    // (atom_item.cpp:409-415 + coord_utils.cpp:276-286).
    {
        const widthPx = AP_SQUIGGLE_WIDTH_PER_WAVE_MODEL * view.scale;
        const heightPx = AP_SQUIGGLE_HEIGHT_MODEL * view.scale;
        ctx.save();
        ctx.strokeStyle = palette.bond;
        ctx.lineWidth = 1.5;
        ctx.lineCap = 'round';
        for (const a of rd.atoms) {
            if (typeof a.ap !== 'number') continue;
            const anchorIdx = attachmentPointAnchor(a.i, rd.bonds);
            if (anchorIdx < 0) continue;
            const anchor = rd.atoms.find((x) => x.i === anchorIdx);
            if (!anchor) continue;
            const apPx = pixelFromModel(canvas, view, a.x, a.y);
            const anchorPx =
                pixelFromModel(canvas, view, anchor.x, anchor.y);
            // Bond direction in pixel space (anchor → AP). Perpendicular
            // = bond_angle + 90°; the wavy path is horizontal pre-rotation
            // so this rotation seats it across the bond axis.
            const bondAngle = Math.atan2(apPx.py - anchorPx.py,
                                         apPx.px - anchorPx.px);
            strokeWavyPath(ctx, apPx.px, apPx.py, bondAngle + Math.PI / 2,
                           widthPx, heightPx, AP_SQUIGGLE_NUM_WAVES);
        }
        ctx.restore();
    }

    // Reaction non-molecular objects (arrow + pluses) — drawn after the
    // mol so they sit on top visually. Qt: NonMolecularItem (Z = RXN_ARROW_AND_PLUS).
    if (rd.nonMol && rd.nonMol.length > 0) {
        const arrowLenPx = RXN_ARROW_LENGTH_MODEL * view.scale;
        const tipHalfPx = RXN_ARROW_TIP_HALF_WIDTH_MODEL * view.scale;
        const plusHalfPx = RXN_PLUS_HALF_LENGTH_MODEL * view.scale;
        const penPx = RXN_PEN_WIDTH_MODEL * view.scale;
        ctx.save();
        ctx.strokeStyle = palette.bond;
        ctx.lineWidth = penPx;
        ctx.lineCap = 'round';
        for (const obj of rd.nonMol) {
            const { px, py } = pixelFromModel(canvas, view, obj.x, obj.y);
            if (obj.type === 'arrow') {
                strokeRxnArrow(ctx, px, py, arrowLenPx, tipHalfPx);
            } else {
                strokeRxnPlus(ctx, px, py, plusHalfPx);
            }
        }
        ctx.restore();
    }

    // Stereo labels: small text drawn just past the atom toward an empty
    // wedge of space around it. Qt uses CHIRALITY_LABEL_DISTANCE_RATIO=0.10
    // of the bond length plus the label's half-diagonal so the label sits
    // a fixed distance from the atom regardless of font size
    // (molviewer/atom_item.cpp:434-448). For a 2D sketcher with our
    // ~40px-per-unit scale, ~16px offset reads at roughly the same gap.
    if (displayOptions.showStereoLabels) {
        ctx.save();
        // Stereo annotation tracks atom-label size at ~10/13 of the main
        // label (matches the pre-Batch-24 visual default 10/13 px ratio).
        const stereoFontPx = Math.max(7, Math.round(ATOM_FONT_PX * 10 / 13));
        ctx.font = `${stereoFontPx}px sans-serif`;
        ctx.fillStyle = palette.annotation;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const a of rd.atoms) {
            let text: string | undefined;
            if (a.stereo) {
                text = renderedStereoLabel(
                    a.stereo, displayOptions.explicitAbsLabels);
            } else if (a.psbl &&
                       displayOptions.includeUndefinedStereoCenters) {
                text = '(?)';
            }
            if (!text) continue;
            const { px, py } = pixelFromModel(canvas, view, a.x, a.y);
            // Pick a direction away from the centroid so the label
            // doesn't sit on top of the bond lines pointing inward.
            const dx = a.x - centroidX;
            const dy = a.y - centroidY;
            const len = Math.hypot(dx, dy) || 1;
            const offset = 16;
            // Flip dy sign — model y is up, pixel y is down.
            const lx = px + (dx / len) * offset;
            const ly = py - (dy / len) * offset;
            ctx.fillText(text, lx, ly);
        }
        ctx.restore();
    }

    if (dragShape) {
        const isErase = dragShape.mode === 'erase';
        ctx.fillStyle = isErase
            ? 'rgba(200, 70, 70, 0.10)'
            : 'rgba(119, 156, 89, 0.12)';
        ctx.strokeStyle = isErase ? '#c84646' : ACCENT_GREEN;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        if (dragShape.kind === 'rect') {
            const { x1, y1, x2, y2 } = dragShapeBounds(dragShape);
            ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
            ctx.strokeRect(x1 + 0.5, y1 + 0.5, x2 - x1 - 1, y2 - y1 - 1);
        } else if (dragShape.kind === 'ellipse') {
            const { x1, y1, x2, y2 } = dragShapeBounds(dragShape);
            const cx = (x1 + x2) / 2;
            const cy = (y1 + y2) / 2;
            const rx = Math.max(0, (x2 - x1) / 2);
            const ry = Math.max(0, (y2 - y1) / 2);
            ctx.beginPath();
            ctx.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
            ctx.fill();
            ctx.stroke();
        } else {
            const pts = dragShape.lassoPoints ?? [];
            if (pts.length >= 2) {
                ctx.beginPath();
                ctx.moveTo(pts[0].px, pts[0].py);
                for (let i = 1; i < pts.length; ++i) {
                    ctx.lineTo(pts[i].px, pts[i].py);
                }
                // Close the loop with a dashed seam back to the start so the
                // hovering "what would I select?" region is visible while the
                // user drags — Qt's LassoSelectionItem fills the closed
                // polygon, we render it the same way.
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
            }
        }
        ctx.setLineDash([]);
    }

    // Rotation handle (Qt rotation_item.cpp:18-34). Pivot dot, arm line,
    // handle dot — all orange, 3-px pen.
    if (rotationHandle) {
        const { pivotPx, pivotPy, handlePx, handlePy } = rotationHandle;
        ctx.strokeStyle = ROTATION_HANDLE_COLOR;
        ctx.fillStyle = ROTATION_HANDLE_COLOR;
        ctx.lineWidth = ROTATION_HANDLE_PEN;
        // Arm line from edge of pivot dot to edge of handle dot.
        const dx = handlePx - pivotPx;
        const dy = handlePy - pivotPy;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        ctx.beginPath();
        ctx.moveTo(pivotPx + ux * ROTATION_PIVOT_RADIUS,
                   pivotPy + uy * ROTATION_PIVOT_RADIUS);
        ctx.lineTo(handlePx - ux * ROTATION_HANDLE_RADIUS,
                   handlePy - uy * ROTATION_HANDLE_RADIUS);
        ctx.stroke();
        // Pivot dot.
        ctx.beginPath();
        ctx.arc(pivotPx, pivotPy, ROTATION_PIVOT_RADIUS, 0, 2 * Math.PI);
        ctx.fill();
        // Handle dot (the grabbable knob).
        ctx.beginPath();
        ctx.arc(handlePx, handlePy, ROTATION_HANDLE_RADIUS, 0, 2 * Math.PI);
        ctx.fill();
    }

    // Atom-chain hint (Qt HintChainItem, draw_chain_scene_tool.cpp:20-43).
    // Blue polyline showing where the new chain atoms would land + a label
    // with the bond count at the cursor end.
    if (chainDrag) {
        const { x: endX, y: endY } = modelFromPixel(
            canvas, view, chainDrag.curPx, chainDrag.curPy,
        );
        const coords = computeChainAtomCoords(
            chainDrag.startX, chainDrag.startY, endX, endY,
        );
        const pixCoords = coords.map((c) => pixelFromModel(canvas, view, c.x, c.y));
        ctx.strokeStyle = CHAIN_HINT_COLOR;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(pixCoords[0].px, pixCoords[0].py);
        for (let i = 1; i < pixCoords.length; ++i) {
            ctx.lineTo(pixCoords[i].px, pixCoords[i].py);
        }
        ctx.stroke();
        // Label = number of bonds = coords.length - 1.
        const last = pixCoords[pixCoords.length - 1];
        ctx.fillStyle = CHAIN_HINT_COLOR;
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(coords.length - 1), last.px + 6, last.py - 6);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
    }
}

// Build an SVG string mirroring drawSketch for the same `rd` / `view` /
// `displayOptions` — used by Save Image when SVG is the selected format.
// Mirrors Qt's QSvgGenerator path (image_generation.cpp:358-368), which
// repaints the same scene through a Qt paint device that emits SVG
// commands. The result is the same vector geometry the canvas renders,
// just expressed as SVG primitives.
//
// `measureCanvas` only supplies a CanvasRenderingContext2D for measureText
// (caller already creates a real canvas for PNG; reuse it here so H/charge
// glyph offsets match the PNG version pixel-for-pixel). Transient chrome
// (drag/rotation/chain hints + hover/pending highlights) is intentionally
// not emitted — saved output is a clean structure.
function buildSketchSvg(
    measureCanvas: HTMLCanvasElement,
    view: View,
    rd: RenderDesc,
    w: number,
    h: number,
    displayOptions: DisplayOptions,
    includeBackground: boolean,
): string {
    const ctx = measureCanvas.getContext('2d');
    const BOND_STROKE = displayOptions.bondLineWidth;
    const BOND_DOUBLE_OFFSET = 4.5;
    const ATOM_FONT_PX = displayOptions.atomFontSize;
    const SUB_FONT_PX = Math.max(7, Math.round(ATOM_FONT_PX * 9 / 13));
    const CHARGE_DY = Math.round(ATOM_FONT_PX * 4 / 13);
    const f = (n: number): string => n.toFixed(2);
    const esc = (s: string): string =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const parts: string[] = [];
    const palette = getPalette(displayOptions);
    parts.push(
        `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' ` +
        `viewBox='0 0 ${w} ${h}'>`,
    );
    if (includeBackground) {
        parts.push(
            `<rect x='0' y='0' width='${w}' height='${h}' ` +
            `fill='${palette.bg}'/>`,
        );
    }
    // pixelFromModel only reads width/height — measureCanvas is sized to (w,h)
    // so the coord math matches the PNG renderer above.
    const px = (x: number, y: number): { px: number; py: number } =>
        pixelFromModel(measureCanvas, view, x, y);

    // Coarse-grained monomeric scene — beads + connectors, mirroring
    // drawMonomers. Emitted instead of the atomistic atom/bond passes.
    if (rd.monomeric) {
        const byIdx = new Map<number, AtomDesc>();
        for (const a of rd.atoms) byIdx.set(a.i, a);
        const cw = Math.max(2, view.scale * 0.1);
        const baseCw = Math.max(1.5, view.scale * 0.05);
        for (const b of rd.bonds) {
            const a1 = byIdx.get(b.a);
            const a2 = byIdx.get(b.b);
            if (!a1 || !a2) continue;
            const p1 = px(a1.x, a1.y);
            const p2 = px(a2.x, a2.y);
            const isBase = b.conn === 'base';
            parts.push(
                `<line x1='${f(p1.px)}' y1='${f(p1.py)}' ` +
                `x2='${f(p2.px)}' y2='${f(p2.py)}' ` +
                `stroke='${isBase ? NA_BASE_CONNECTOR_COLOR
                    : MONOMER_CONNECTOR_COLOR}' ` +
                `stroke-width='${f(isBase ? baseCw : cw)}'/>`,
            );
        }
        const half = Math.max(10, view.scale * 0.37);
        const radius = Math.max(3, view.scale * 0.1);
        const fs = Math.max(9, Math.round(view.scale * 0.42));
        for (const a of rd.atoms) {
            const p = px(a.x, a.y);
            const fill = monomerFillFor(a.mon, a.lbl);
            const stroke = monomerBorderFor(a.mon, a.lbl);
            if (a.mon === 'base') {
                const h = half * 1.35;
                parts.push(
                    `<polygon points='${f(p.px - h)},${f(p.py)} ` +
                    `${f(p.px)},${f(p.py + h)} ${f(p.px + h)},${f(p.py)} ` +
                    `${f(p.px)},${f(p.py - h)}' ` +
                    `fill='${fill}' stroke='${stroke}' stroke-width='2'/>`,
                );
            } else if (a.mon === 'phos') {
                parts.push(
                    `<ellipse cx='${f(p.px)}' cy='${f(p.py)}' ` +
                    `rx='${f(half)}' ry='${f(half)}' ` +
                    `fill='${fill}' stroke='${stroke}' stroke-width='2'/>`,
                );
            } else {
                // sugar → sharp rect; peptide/chem → rounded rect.
                const rx = a.mon === 'sugar' ? 0 : radius;
                parts.push(
                    `<rect x='${f(p.px - half)}' y='${f(p.py - half)}' ` +
                    `width='${f(half * 2)}' height='${f(half * 2)}' ` +
                    `rx='${f(rx)}' ry='${f(rx)}' ` +
                    `fill='${fill}' stroke='${stroke}' stroke-width='2'/>`,
                );
            }
            parts.push(
                `<text x='${f(p.px)}' y='${f(p.py)}' ` +
                `fill='${MONOMER_LABEL_COLOR}' font-family='sans-serif' ` +
                `font-size='${fs}' text-anchor='middle' ` +
                `dominant-baseline='central'>${esc((a.lbl ?? '').slice(0, 6))}` +
                `</text>`,
            );
        }
        parts.push('</svg>');
        return parts.join('');
    }

    let centroidX = 0;
    let centroidY = 0;
    for (const a of rd.atoms) {
        centroidX += a.x;
        centroidY += a.y;
    }
    if (rd.atoms.length > 0) {
        centroidX /= rd.atoms.length;
        centroidY /= rd.atoms.length;
    }
    const centroidPx = px(centroidX, centroidY);

    // Carbon-label rule mirrors drawSketch (and Qt's
    // AtomItem::determineLabelIsVisible). Computed once per build.
    const degree = new Array<number>(rd.atoms.length).fill(0);
    const doubleCount = new Array<number>(rd.atoms.length).fill(0);
    for (const bb of rd.bonds) {
        degree[bb.a]++; degree[bb.b]++;
        if (bb.o === 2) { doubleCount[bb.a]++; doubleCount[bb.b]++; }
    }
    const shouldLabelCarbon = (i: number, a: AtomDesc): boolean => {
        if (a.el !== 'C') return false;
        if (displayOptions.carbonLabels === 'all') return true;
        const d = degree[i];
        if (d === 0) return true;
        if (displayOptions.carbonLabels === 'terminal' && d === 1) return true;
        if (d === 2 && doubleCount[i] === 2) return true;
        return false;
    };

    for (const b of rd.bonds) {
        const p1 = px(rd.atoms[b.a].x, rd.atoms[b.a].y);
        const p2 = px(rd.atoms[b.b].x, rd.atoms[b.b].y);
        if (b.sel) {
            parts.push(
                `<line x1='${f(p1.px)}' y1='${f(p1.py)}' ` +
                `x2='${f(p2.px)}' y2='${f(p2.py)}' ` +
                `stroke='${SELECTION_FILL}' stroke-width='9' ` +
                `stroke-linecap='round'/>`,
            );
        }
        const dir = b.dir ?? BOND_DIR_NONE;
        if (dir === BOND_DIR_WEDGE && b.o === 1) {
            const dx = p2.px - p1.px;
            const dy = p2.py - p1.py;
            const len = Math.hypot(dx, dy);
            const ox = (-dy / len) * 5;
            const oy = (dx / len) * 5;
            parts.push(
                `<polygon points='${f(p1.px)},${f(p1.py)} ` +
                `${f(p2.px + ox)},${f(p2.py + oy)} ` +
                `${f(p2.px - ox)},${f(p2.py - oy)}' fill='${palette.bond}'/>`,
            );
        } else if (dir === BOND_DIR_DASH && b.o === 1) {
            const dx = p2.px - p1.px;
            const dy = p2.py - p1.py;
            const len = Math.hypot(dx, dy);
            const ux = dx / len;
            const uy = dy / len;
            const nx = -uy;
            const ny = ux;
            const dashCount = 6;
            for (let k = 1; k <= dashCount; ++k) {
                const t = k / (dashCount + 1);
                const cx = p1.px + dx * t;
                const cy = p1.py + dy * t;
                const halfW = 1 + 3.5 * t;
                parts.push(
                    `<line x1='${f(cx + nx * halfW)}' y1='${f(cy + ny * halfW)}' ` +
                    `x2='${f(cx - nx * halfW)}' y2='${f(cy - ny * halfW)}' ` +
                    `stroke='${palette.bond}' stroke-width='1.6'/>`,
                );
            }
        } else if (dir === BOND_DIR_UNKNOWN && b.o === 1) {
            const dx = p2.px - p1.px;
            const dy = p2.py - p1.py;
            const len = Math.hypot(dx, dy);
            const nx = -dy / len;
            const ny = dx / len;
            const amp = 3;
            const waves = Math.max(2, Math.round(len / 8));
            const steps = waves * 8;
            const pts: string[] = [`${f(p1.px)},${f(p1.py)}`];
            for (let s = 1; s <= steps; ++s) {
                const t = s / steps;
                const phase = Math.sin(2 * Math.PI * waves * t);
                pts.push(
                    `${f(p1.px + dx * t + nx * amp * phase)},` +
                    `${f(p1.py + dy * t + ny * amp * phase)}`,
                );
            }
            parts.push(
                `<polyline points='${pts.join(' ')}' fill='none' ` +
                `stroke='${palette.bond}' stroke-width='${BOND_STROKE}'/>`,
            );
        } else if (dir === BOND_DIR_EITHERDOUBLE && b.o === 2) {
            const dx = p2.px - p1.px;
            const dy = p2.py - p1.py;
            const len = Math.hypot(dx, dy);
            const ox = (-dy / len) * BOND_DOUBLE_OFFSET;
            const oy = (dx / len) * BOND_DOUBLE_OFFSET;
            parts.push(
                `<line x1='${f(p1.px + ox)}' y1='${f(p1.py + oy)}' ` +
                `x2='${f(p2.px - ox)}' y2='${f(p2.py - oy)}' ` +
                `stroke='${palette.bond}' stroke-width='${BOND_STROKE}'/>`,
                `<line x1='${f(p1.px - ox)}' y1='${f(p1.py - oy)}' ` +
                `x2='${f(p2.px + ox)}' y2='${f(p2.py + oy)}' ` +
                `stroke='${palette.bond}' stroke-width='${BOND_STROKE}'/>`,
            );
        } else if (b.bt === BOND_TYPE_DATIVE) {
            // Coordinate (dative) bond: solid line + filled arrowhead at the
            // end atom. Mirrors the canvas branch / Qt bond_item.cpp:210-216.
            const dx = p2.px - p1.px;
            const dy = p2.py - p1.py;
            const len = Math.hypot(dx, dy);
            const ux = dx / len;
            const uy = dy / len;
            const nx = -uy;
            const ny = ux;
            const aLen = 8;
            const aHalf = 5;
            const baseX = p2.px - ux * aLen;
            const baseY = p2.py - uy * aLen;
            parts.push(
                `<line x1='${f(p1.px)}' y1='${f(p1.py)}' ` +
                `x2='${f(p2.px)}' y2='${f(p2.py)}' ` +
                `stroke='${palette.bond}' stroke-width='${BOND_STROKE}'/>`,
                `<polygon points='${f(p2.px)},${f(p2.py)} ` +
                `${f(baseX + nx * aHalf)},${f(baseY + ny * aHalf)} ` +
                `${f(baseX - nx * aHalf)},${f(baseY - ny * aHalf)}' ` +
                `fill='${palette.bond}'/>`,
            );
        } else if (b.bt === BOND_TYPE_ZERO) {
            // Zero-order bond: dashed line (Qt m_dashed_pen {3,3}).
            parts.push(
                `<line x1='${f(p1.px)}' y1='${f(p1.py)}' ` +
                `x2='${f(p2.px)}' y2='${f(p2.py)}' ` +
                `stroke='${palette.bond}' stroke-width='${BOND_STROKE}' ` +
                `stroke-dasharray='3,3'/>`,
            );
        } else if (b.arom) {
            parts.push(
                `<line x1='${f(p1.px)}' y1='${f(p1.py)}' ` +
                `x2='${f(p2.px)}' y2='${f(p2.py)}' ` +
                `stroke='${palette.bond}' stroke-width='${BOND_STROKE}'/>`,
            );
            const dx = p2.px - p1.px;
            const dy = p2.py - p1.py;
            const len = Math.hypot(dx, dy);
            const nx = -dy / len;
            const ny = dx / len;
            const mx = (p1.px + p2.px) / 2;
            const my = (p1.py + p2.py) / 2;
            const sign = nx * (centroidPx.px - mx) +
                ny * (centroidPx.py - my) >= 0 ? 1 : -1;
            const ox = nx * BOND_DOUBLE_OFFSET * sign;
            const oy = ny * BOND_DOUBLE_OFFSET * sign;
            const shrink = 0.18;
            const sx1 = p1.px + dx * shrink + ox;
            const sy1 = p1.py + dy * shrink + oy;
            const sx2 = p1.px + dx * (1 - shrink) + ox;
            const sy2 = p1.py + dy * (1 - shrink) + oy;
            parts.push(
                `<line x1='${f(sx1)}' y1='${f(sy1)}' ` +
                `x2='${f(sx2)}' y2='${f(sy2)}' ` +
                `stroke='${palette.bond}' stroke-width='1.5' ` +
                `stroke-dasharray='5,3'/>`,
            );
        } else {
            parts.push(
                `<line x1='${f(p1.px)}' y1='${f(p1.py)}' ` +
                `x2='${f(p2.px)}' y2='${f(p2.py)}' ` +
                `stroke='${palette.bond}' stroke-width='${BOND_STROKE}'/>`,
            );
        }
        const isCrossedDouble = dir === BOND_DIR_EITHERDOUBLE && b.o === 2;
        if (!b.arom && !isCrossedDouble && (b.o === 2 || b.o === 3)) {
            const dx = p2.px - p1.px;
            const dy = p2.py - p1.py;
            const len = Math.hypot(dx, dy);
            const ox = (-dy / len) * BOND_DOUBLE_OFFSET;
            const oy = (dx / len) * BOND_DOUBLE_OFFSET;
            parts.push(
                `<line x1='${f(p1.px + ox)}' y1='${f(p1.py + oy)}' ` +
                `x2='${f(p2.px + ox)}' y2='${f(p2.py + oy)}' ` +
                `stroke='${palette.bond}' stroke-width='${BOND_STROKE}'/>`,
            );
            if (b.o === 3) {
                parts.push(
                    `<line x1='${f(p1.px - ox)}' y1='${f(p1.py - oy)}' ` +
                    `x2='${f(p2.px - ox)}' y2='${f(p2.py - oy)}' ` +
                    `stroke='${palette.bond}' stroke-width='${BOND_STROKE}'/>`,
                );
            }
        }
        // Query-bond + topology annotation, mirroring the canvas branch.
        const annotation = bondAnnotationText(b);
        if (annotation) {
            const mx = (p1.px + p2.px) / 2;
            const my = (p1.py + p2.py) / 2;
            const dx = p2.px - p1.px;
            const dy = p2.py - p1.py;
            const len = Math.hypot(dx, dy) || 1;
            const off = 8;
            const lx = mx + (-dy / len) * off;
            const ly = my + (dx / len) * off;
            const qpx = Math.max(8, Math.round(ATOM_FONT_PX * 10 / 13));
            parts.push(
                `<text x='${f(lx)}' y='${f(ly)}' fill='${palette.bond}' ` +
                `font-family='sans-serif' font-size='${qpx}' ` +
                `text-anchor='middle' dominant-baseline='central'>` +
                `${esc(annotation)}</text>`,
            );
        }
    }

    // Valence-error halos render under the atom labels — mirror the canvas
    // (drawSketch) ordering so the SVG looks identical.
    if (displayOptions.showValenceErrors) {
        for (const a of rd.atoms) {
            if (!a.verr) continue;
            const { px: ax, py: ay } = px(a.x, a.y);
            parts.push(
                `<ellipse cx='${f(ax)}' cy='${f(ay)}' rx='13' ry='13' ` +
                `fill='#ffecc5' stroke='#fb7100' stroke-width='2' ` +
                `stroke-dasharray='1,3' stroke-linecap='round'/>`,
            );
        }
    }
    for (let i = 0; i < rd.atoms.length; i++) {
        const a = rd.atoms[i];
        const { px: ax, py: ay } = px(a.x, a.y);
        // Attachment-point atoms render as a squiggle path below; skip the
        // dot/label/selection-halo so the SVG matches the Canvas pass.
        if (typeof a.ap === 'number') continue;
        if (a.sel) {
            parts.push(
                `<circle cx='${f(ax)}' cy='${f(ay)}' r='13' ` +
                `fill='${ACCENT_GREEN}'/>`,
                `<circle cx='${f(ax)}' cy='${f(ay)}' r='10' ` +
                `fill='${SELECTION_FILL}'/>`,
            );
        }
        const hasCharge = typeof a.q === 'number' && a.q !== 0;
        const hasRadical = typeof a.nrad === 'number' && a.nrad > 0;
        const dotOnly = a.el === 'C' && !hasCharge && !hasRadical
            && !a.sel && !shouldLabelCarbon(i, a);
        if (dotOnly) {
            parts.push(
                `<circle cx='${f(ax)}' cy='${f(ay)}' r='2.5' ` +
                `fill='${palette.bond}'/>`,
            );
            continue;
        }
        if (a.el !== 'C') {
            parts.push(
                `<rect x='${f(ax - 9)}' y='${f(ay - 9)}' ` +
                `width='18' height='18' fill='${palette.labelBg}'/>`,
            );
        }
        const labelColor = elementColor(palette, a.el);
        if (a.el === 'C' && a.sel && !hasCharge && !hasRadical
            && !shouldLabelCarbon(i, a)) {
            parts.push(
                `<circle cx='${f(ax)}' cy='${f(ay)}' r='2.5' ` +
                `fill='${labelColor}'/>`,
            );
        } else if (typeof a.rlabel === 'number') {
            // R-group atoms: render "R<n>" instead of the dummy element
            // symbol. Suppress H-count / charge superscripts (the underlying
            // dummy atom's bookkeeping doesn't surface to the user).
            const rColor = elementColor(palette, 'C');
            parts.push(
                `<text x='${f(ax)}' y='${f(ay)}' fill='${rColor}' ` +
                `font-family='sans-serif' font-size='${ATOM_FONT_PX}' ` +
                `text-anchor='middle' dominant-baseline='central'>` +
                `${esc(`R${a.rlabel}`)}</text>`,
            );
        } else if (typeof a.qlabel === 'string') {
            // Wildcard query atom: render the letter label in place of "*".
            const qColor = elementColor(palette, 'C');
            parts.push(
                `<text x='${f(ax)}' y='${f(ay)}' fill='${qColor}' ` +
                `font-family='sans-serif' font-size='${ATOM_FONT_PX}' ` +
                `text-anchor='middle' dominant-baseline='central'>` +
                `${esc(a.qlabel)}</text>`,
            );
        } else {
            // dominant-baseline=central + text-anchor=middle reproduces the
            // canvas (textBaseline='middle', textAlign='center') layout.
            parts.push(
                `<text x='${f(ax)}' y='${f(ay)}' fill='${labelColor}' ` +
                `font-family='sans-serif' font-size='${ATOM_FONT_PX}' ` +
                `text-anchor='middle' dominant-baseline='central'>` +
                `${esc(a.el)}</text>`,
            );
            if (a.el !== 'C' && typeof a.nh === 'number' && a.nh > 0 && ctx) {
                ctx.font = `${ATOM_FONT_PX}px sans-serif`;
                const labelWidth = ctx.measureText(a.el).width;
                const hX = ax + labelWidth / 2 + 1;
                parts.push(
                    `<text x='${f(hX)}' y='${f(ay)}' fill='${labelColor}' ` +
                    `font-family='sans-serif' font-size='${ATOM_FONT_PX}' ` +
                    `text-anchor='start' dominant-baseline='central'>` +
                    `H</text>`,
                );
                if (a.nh > 1) {
                    ctx.font = `${ATOM_FONT_PX}px sans-serif`;
                    const hWidth = ctx.measureText('H').width;
                    parts.push(
                        `<text x='${f(hX + hWidth + 1)}' ` +
                        `y='${f(ay + CHARGE_DY)}' ` +
                        `fill='${labelColor}' font-family='sans-serif' ` +
                        `font-size='${SUB_FONT_PX}' text-anchor='start' ` +
                        `dominant-baseline='central'>` +
                        `${esc(String(a.nh))}</text>`,
                    );
                }
            }
            let chargeAndRadicalText = '';
            if (hasRadical) {
                const n = a.nrad as number;
                const parens = n > 1 && hasCharge;
                chargeAndRadicalText =
                    (parens ? '(' : '') +
                    (n > 1 ? String(n) : '') +
                    '•' +
                    (parens ? ')' : '');
            }
            if (hasCharge) {
                const q = a.q as number;
                const sign = q > 0 ? '+' : '−';
                const chargeText = Math.abs(q) === 1
                    ? sign
                    : `${Math.abs(q)}${sign}`;
                chargeAndRadicalText +=
                    (chargeAndRadicalText ? ' ' : '') + chargeText;
            }
            if (chargeAndRadicalText && ctx) {
                ctx.font = `${ATOM_FONT_PX}px sans-serif`;
                const labelWidth = ctx.measureText(a.el).width;
                let chargeX = ax + labelWidth / 2 + 1;
                if (a.el !== 'C' && typeof a.nh === 'number' && a.nh > 0) {
                    chargeX += ctx.measureText('H').width;
                    if (a.nh > 1) {
                        ctx.font = `${SUB_FONT_PX}px sans-serif`;
                        chargeX += ctx.measureText(String(a.nh)).width + 1;
                    }
                }
                parts.push(
                    `<text x='${f(chargeX)}' y='${f(ay - CHARGE_DY)}' ` +
                    `fill='${labelColor}' font-family='sans-serif' ` +
                    `font-size='${SUB_FONT_PX}' text-anchor='start' ` +
                    `dominant-baseline='central'>` +
                    `${esc(chargeAndRadicalText)}</text>`,
                );
            }
        }
    }
    // Attachment-point squiggles — quadratic-bezier path matching the canvas
    // renderer. Stroke color/width tracks the bond palette so the squiggle
    // reads as a bond cap rather than a separate annotation.
    {
        const widthPx = AP_SQUIGGLE_WIDTH_PER_WAVE_MODEL * view.scale;
        const heightPx = AP_SQUIGGLE_HEIGHT_MODEL * view.scale;
        const halfWidth = widthPx / 2;
        const startX = -AP_SQUIGGLE_NUM_WAVES * halfWidth;
        for (const a of rd.atoms) {
            if (typeof a.ap !== 'number') continue;
            const anchorIdx = attachmentPointAnchor(a.i, rd.bonds);
            if (anchorIdx < 0) continue;
            const anchor = rd.atoms.find((x) => x.i === anchorIdx);
            if (!anchor) continue;
            const apP = px(a.x, a.y);
            const anchorP = px(anchor.x, anchor.y);
            const bondAngle = Math.atan2(apP.py - anchorP.py,
                                         apP.px - anchorP.px);
            const angle = bondAngle + Math.PI / 2;
            // Build the SVG path in path-local coords (rotation handled via
            // a transform) — mirrors how the canvas renderer wraps the path
            // in save/translate/rotate.
            let d = `M ${f(startX)} 0`;
            let x = startX;
            for (let i = 0; i < AP_SQUIGGLE_NUM_WAVES; i++) {
                d += ` Q ${f(x + halfWidth / 2)} ${f(heightPx)} ` +
                    `${f(x + halfWidth)} 0`;
                x += halfWidth;
                d += ` Q ${f(x + halfWidth / 2)} ${f(-heightPx)} ` +
                    `${f(x + halfWidth)} 0`;
                x += halfWidth;
            }
            // SVG rotate() takes degrees.
            const angleDeg = (angle * 180) / Math.PI;
            parts.push(
                `<path d='${d}' fill='none' stroke='${palette.bond}' ` +
                `stroke-width='1.5' stroke-linecap='round' ` +
                `transform='translate(${f(apP.px)} ${f(apP.py)}) ` +
                `rotate(${f(angleDeg)})'/>`,
            );
        }
    }
    // Reaction non-molecular objects — drawn after the mol so they sit on
    // top. Qt: NonMolecularItem (Z = RXN_ARROW_AND_PLUS, above bonds).
    if (rd.nonMol && rd.nonMol.length > 0) {
        const arrowLenPx = RXN_ARROW_LENGTH_MODEL * view.scale;
        const tipHalfPx = RXN_ARROW_TIP_HALF_WIDTH_MODEL * view.scale;
        const plusHalfPx = RXN_PLUS_HALF_LENGTH_MODEL * view.scale;
        const penPx = RXN_PEN_WIDTH_MODEL * view.scale;
        for (const obj of rd.nonMol) {
            const { px: ox, py: oy } = px(obj.x, obj.y);
            if (obj.type === 'arrow') {
                const halfLen = arrowLenPx / 2;
                const tipStartX = ox + halfLen - tipHalfPx;
                const tipX = ox + halfLen;
                const d =
                    `M ${f(ox - halfLen)} ${f(oy)} ` +
                    `L ${f(tipX)} ${f(oy)} ` +
                    `L ${f(tipStartX)} ${f(oy - tipHalfPx)} ` +
                    `M ${f(tipX)} ${f(oy)} ` +
                    `L ${f(tipStartX)} ${f(oy + tipHalfPx)}`;
                parts.push(
                    `<path d='${d}' fill='none' stroke='${palette.bond}' ` +
                    `stroke-width='${f(penPx)}' stroke-linecap='round'/>`,
                );
            } else {
                const d =
                    `M ${f(ox - plusHalfPx)} ${f(oy)} ` +
                    `L ${f(ox + plusHalfPx)} ${f(oy)} ` +
                    `M ${f(ox)} ${f(oy - plusHalfPx)} ` +
                    `L ${f(ox)} ${f(oy + plusHalfPx)}`;
                parts.push(
                    `<path d='${d}' fill='none' stroke='${palette.bond}' ` +
                    `stroke-width='${f(penPx)}' stroke-linecap='round'/>`,
                );
            }
        }
    }
    // Stereo labels — same direction-from-centroid pick as drawSketch so
    // the SVG and the canvas place the label in matching positions.
    if (displayOptions.showStereoLabels) {
        const stereoFontPx = Math.max(7, Math.round(ATOM_FONT_PX * 10 / 13));
        for (const a of rd.atoms) {
            let text: string | undefined;
            if (a.stereo) {
                text = renderedStereoLabel(
                    a.stereo, displayOptions.explicitAbsLabels);
            } else if (a.psbl &&
                       displayOptions.includeUndefinedStereoCenters) {
                text = '(?)';
            }
            if (!text) continue;
            const { px: ax, py: ay } = px(a.x, a.y);
            const dx = a.x - centroidX;
            const dy = a.y - centroidY;
            const len = Math.hypot(dx, dy) || 1;
            const offset = 16;
            const lx = ax + (dx / len) * offset;
            const ly = ay - (dy / len) * offset;
            parts.push(
                `<text x='${f(lx)}' y='${f(ly)}' fill='${palette.annotation}' ` +
                `font-family='sans-serif' font-size='${stereoFontPx}' ` +
                `text-anchor='middle' dominant-baseline='central'>` +
                `${esc(text)}</text>`,
            );
        }
    }
    parts.push('</svg>');
    return parts.join('');
}

interface SketcherProps {
    module: SketcherLeanModule;
}

export function Sketcher({ module: Module }: SketcherProps): JSX.Element {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const modelRef = useRef<MolModelInstance | null>(null);
    const subscriptionRef = useRef<number | null>(null);
    const selectionSubscriptionRef = useRef<number | null>(null);
    const pendingRef = useRef<number | null>(null);
    // Suppress the click event that fires after a drag-select mouseUp — we
    // already committed the selection in mouseUp and don't want the click
    // handler to interpret the release as a toggle/clear.
    const suppressNextClickRef = useRef<boolean>(false);
    // Mouse-driven atom move state. Lives in a ref because we mutate it on
    // every mousemove (high frequency) and don't want to trigger a React
    // re-render per pixel — the model.setAtomPos preview already fires
    // modelChanged which drives the redraw.
    const atomDragRef = useRef<AtomDrag | null>(null);
    // Rotate-gesture state — same lifecycle as atomDragRef: high-frequency
    // mousemove preview, single committed undo on mouseup, cancellable on
    // mouseleave. Mutually exclusive with atomDragRef at any given time.
    const rotateDragRef = useRef<RotateDrag | null>(null);
    // Atom-chain drag state. Lives in React state (not a ref) so updates
    // re-render and refresh the canvas hint. Lower frequency than
    // atomDrag/rotateDrag — we only need it while the user is actively
    // drawing a new chain, not the constant stream of an existing-mol drag.
    const [chainDrag, setChainDrag] = useState<ChainDrag | null>(null);
    // View transform — mirrors viewState into a ref so event handlers (which
    // capture the closure at mount) always read the current viewport.
    const viewRef = useRef<View>(DEFAULT_VIEW);

    const [tool, setTool] = useState<Tool>('atom');
    // Sidebar page toggle — Qt's sketcher_side_bar.ui has a QStackedWidget
    // (`atomistic_or_monomeric_stack`) with two pages: `atomistic_page` (the
    // SetAtomWidget + bonds + rings + enumeration cluster) and
    // `monomeric_page` (the MonomerToolWidget). The two header buttons act
    // as a QButtonGroup — only one mode is active at a time. The SELECT
    // section above sits outside the stack and is visible in both modes
    // (sketcher_side_bar.cpp:55-188). Monomeric draw tools themselves are
    // placeholders until the C++ MolModel learns about monomers — see the
    // [[project-qt-removal]] memory for the staged plan.
    const [mode, setMode] = useState<'atomistic' | 'monomeric'>('atomistic');
    // Inside the monomeric page, Qt has a second QStackedWidget
    // (`amino_or_nucleic_stack`) gated by an AMINO/NUCLEIC toggle pair
    // (`amino_monomer_btn` defaults to checked=true — see
    // monomer_tool_widget.ui). 'amino' is the default to match.
    const [monomerSubMode, setMonomerSubMode] =
        useState<'amino' | 'nucleic'>('amino');
    const [element, setElement] = useState<Element>('C');
    // Element shown in the last-picked slot (Qt set_atom_widget.cpp:27 —
    // last_picked_element_btn defaults to Si). Updates whenever the user
    // picks something outside the 8 fixed buttons via the periodic-table
    // popup, matching Qt's onModelValuePinged behavior.
    const [lastPickedElement, setLastPickedElement] =
        useState<Element>(LAST_PICKED_DEFAULT);
    // Qt's bond_group is one radio group — picking Single clears any active
    // stereo, picking Wedge implies single+wedge. bondMode collapses both.
    const [bondMode, setBondMode] = useState<BondMode>('single');
    // Selected wildcard for the atom-query (A▾) draw tool. Mirrors Qt's
    // ModularToolButton remembering the last-picked atom-query variant.
    const [atomQueryMode, setAtomQueryMode] = useState<AtomQueryChoice>('A');
    // Selected query for the bond-query (B▾) draw tool.
    const [bondQueryMode, setBondQueryMode] =
        useState<BondQueryChoice>('aromatic');
    // Armed monomer for the monomer draw tool: the 1-letter residue symbol and
    // its ChainType int (0=PEPTIDE, 1=RNA). Set when an amino-acid or nucleic-
    // acid building-block tile is clicked.
    const [monomerResName, setMonomerResName] = useState<string>('A');
    const [monomerChainType, setMonomerChainType] = useState<number>(0);
    // Armed full nucleotide (sugar/base/phosphate symbols) for the RNA/DNA
    // nucleotide tiles. Non-null routes the monomer tool through addNucleotide /
    // addBoundNucleotide instead of the single-monomer path. `id` labels the
    // active tile (e.g. "rna"/"dna") for the pressed-state highlight.
    const [nucleotideSpec, setNucleotideSpec] = useState<
        { id: string; sugar: string; base: string; phos: string } | null>(null);
    // Non-natural peptide analogs grouped by natural residue (D-/N-methyl
    // variants etc.) from the monomer DB, fetched once. Drives the per-residue
    // analog popups on the amino-acid tiles (Qt MonomerToolWidget, SKETCH-2482).
    const peptideAnalogs = useMemo<Record<string, { s: string; n: string }[]>>(
        () => {
            try {
                return JSON.parse(Module.monomer_analogs_json(0));
            } catch {
                return {};
            }
        }, [],
    );
    // Each stereo / bond-order slot is a Qt ModularToolButton: clicking
    // applies its currently-selected mode; picking from its popup swaps the
    // mode AND applies it. The selected mode determines both icon and
    // active state for that slot. Defaults match Qt
    // (widget/draw_tools_widget.cpp:29-32): stereo1=SINGLE_UP (wedge),
    // stereo2=SINGLE_DOWN (dash), bond_order=DOUBLE.
    const [stereo1Mode, setStereo1Mode] = useState<BondMode>('wedge');
    const [stereo2Mode, setStereo2Mode] = useState<BondMode>('dash');
    const [bondOrderMode, setBondOrderMode] = useState<BondMode>('double');
    const [ring, setRing] = useState<RingSpec>(RING_BENZENE);
    // Reaction popup sub-mode. Mirrors Qt's EnumerationToolWidget slot icon —
    // the slot defaults to RXN_ARROW (Qt: setEnumItem(RXN_ARROW) at
    // widget/enumeration_tool_widget.cpp:23) and swaps to RXN_PLUS when the
    // user picks the plus from the popup. The slot retains the picked mode
    // until another popup choice changes it (the ModularToolButton pattern).
    const [reactionMode, setReactionMode] = useState<ReactionMode>('arrow');
    const [pendingBondAtom, setPendingBondAtom] = useState<number | null>(null);
    const [hoverAtom, setHoverAtom] = useState<number | null>(null);
    const [dragShape, setDragShape] = useState<DragShape | null>(null);
    // Persistent shape for the Select tool. Switches via the long-press popup
    // on the Select button — mirrors Qt's selection_tool_popup (rect/lasso/
    // ellipse), where the chosen shape sticks until the user picks another.
    const [selectShape, setSelectShape] = useState<SelectShape>('rect');
    const selectShapeRef = useRef<SelectShape>('rect');
    const [status, setStatus] = useState<string>('ready');
    const [view, setViewState] = useState<View>(DEFAULT_VIEW);
    const [moreMenuOpen, setMoreMenuOpen] = useState<boolean>(false);
    // Right-click context menu on empty canvas — mirrors Qt's
    // BackgroundContextMenu (menu/background_context_menu.cpp). Qt opens it
    // from SketcherView::contextMenuEvent when the click lands on no item
    // and there is no active selection. `x`/`y` are viewport coords
    // (position: fixed) and `sceneEmpty` is snapshotted at open time so
    // enable-states (Save Image, Export, Flip H/V, Select All) match Qt's
    // BackgroundContextMenu::updateActions().
    const [bgContextMenu, setBgContextMenu] = useState<
        { x: number; y: number; sceneEmpty: boolean } | null
    >(null);
    // Selection right-click context menu — mirrors Qt's SelectionContextMenu
    // (menu/selection_context_menu.cpp). Qt opens it when right-clicking
    // anywhere on the canvas while a selection is active. Open-time snapshot
    // captures atom/bond selection counts so we can label "Flip" vs.
    // "Flip Molecule" the same way Qt does (Flip is shown when there's
    // exactly one crossing bond on a single-fragment selection — that path
    // needs adjacency data we don't have client-side yet, so we always show
    // the Flip Molecule submenu form which is the more general case).
    const [selContextMenu, setSelContextMenu] = useState<
        { x: number; y: number; nAtoms: number; nBonds: number;
          selAtomIndices: number[]; selHasImplicitH: boolean;
          // Per-atom radical totals captured at menu-open time so the
          // "± Unpaired Electrons" entries can clamp to [0, 4] (Qt
          // MIN/MAX_UNPAIRED_E) without re-querying the model.
          selMinRadical: number; selMaxRadical: number } | null
    >(null);
    // Per-bond right-click context menu — mirrors Qt's BondContextMenu
    // (menu/bond_context_menu.cpp). Opens when right-click hits a bond and
    // no selection is active. `bondIdx` is the index in the render
    // description's bond array; `a`/`b` are its endpoint atom indices.
    // `type`/`dir` are RDKit::Bond::BondType / BondDir as ints (passed
    // through from the render description so the menu can show the
    // current state without re-querying the model).
    const [bondContextMenu, setBondContextMenu] = useState<
        { x: number; y: number; bondIdx: number; a: number; b: number;
          type: number; dir: number; bt?: number; inRing: boolean;
          qlabel?: string; topo?: string } | null
    >(null);
    // Per-atom right-click context menu — mirrors Qt's AtomContextMenu
    // (menu/atom_context_menu.cpp). Opens when right-click hits an atom and
    // no selection is active. `atomIdx` is the atom's index in the render
    // description; `el` is its element symbol, `q` its current formal
    // charge, `isRGroupOrAp` flags R-groups / attachment points so we can
    // disable charge edits on those (Qt: is_r_group gate in
    // ModifyAtomsMenu::updateActions). Captured at open time so the menu
    // can show the current state and gate actions without re-querying.
    const [atomContextMenu, setAtomContextMenu] = useState<
        { x: number; y: number; atomIdx: number; el: string;
          q: number; nh: number; nrad: number;
          isRGroupOrAp: boolean;
          // Existing R-group numbers in the mol + the next free number, both
          // snapshotted at open time so the "Replace with > R-Group" submenu
          // can list "R1/R2/…" and pick a fresh number for "New R-Group".
          existingRGroups: number[]; nextRGroup: number } | null
    >(null);
    // Attachment-point right-click menu — mirrors Qt's tiny
    // AttachmentPointContextMenu (menu/attachment_point_context_menu.cpp:11),
    // which is just a "Delete" entry under an "Attachment Point" title. Runs
    // ahead of the generic atom menu when the hit atom carries an `ap`
    // property (a wavy-squiggle dummy bound to a real atom).
    const [apContextMenu, setApContextMenu] = useState<
        { x: number; y: number; atomIdx: number } | null
    >(null);
    // Top-bar Import / Export dropdowns + their modals. Mirrors Qt's
    // ImportMenu / ExportMenu (menu/sketcher_top_bar_menus.cpp) + the
    // PasteInTextDialog / FileExportDialog popups they open.
    const [importMenuOpen, setImportMenuOpen] = useState<boolean>(false);
    const [exportMenuOpen, setExportMenuOpen] = useState<boolean>(false);
    const [pasteModalOpen, setPasteModalOpen] = useState<boolean>(false);
    const [pasteText, setPasteText] = useState<string>('');
    const [exportModalOpen, setExportModalOpen] = useState<boolean>(false);
    const [exportFormat, setExportFormat] = useState<ExportFormat>('smiles');
    // Save Image dialog — mirrors Qt FileSaveImageDialog
    // (dialog/file_save_image_dialog.cpp). Defaults to 400×400 opaque white
    // PNG, same as Qt.
    const [imageModalOpen, setImageModalOpen] = useState<boolean>(false);
    const [imageFormat, setImageFormat] = useState<ImageFormat>('png');
    const [imageWidth, setImageWidth] = useState<number>(400);
    const [imageHeight, setImageHeight] = useState<number>(400);
    const [imageTransparent, setImageTransparent] = useState<boolean>(false);
    // Configure View dropdown (Qt's ConfigureViewMenu) — opens off the
    // gear button in the top bar. Holds the four checkable toggles +
    // the "Preferences..." action. Defaults mirror Qt
    // (model/sketcher_model.cpp:230-233).
    const [configureViewOpen, setConfigureViewOpen] = useState<boolean>(false);
    const [displayOptions, setDisplayOptions] = useState<DisplayOptions>(
        DEFAULT_DISPLAY_OPTIONS,
    );
    type BooleanDisplayOption =
        | 'showValenceErrors'
        | 'colorHeteroatoms'
        | 'showStereoLabels'
        | 'useImplicitHydrogens'
        | 'explicitAbsLabels'
        | 'includeUndefinedStereoCenters';
    const toggleDisplayOption = (key: BooleanDisplayOption): void => {
        setDisplayOptions((opt) => ({ ...opt, [key]: !opt[key] }));
    };
    // "Preferences..." (2D Settings) modal — Qt's
    // RenderingSettingsDialog (dialog/rendering_settings_dialog.h). Holds
    // the font/line-width controls plus toggles that mirror Configure View
    // (color heteroatoms, show stereo annotations) so both surfaces stay
    // in sync against the same `displayOptions` state.
    const [preferencesOpen, setPreferencesOpen] = useState<boolean>(false);
    // Import menu's checkable "Replace Current Content" toggle — Qt's
    // ImportMenu::m_replace_content_act (menu/sketcher_top_bar_menus.cpp:50)
    // mirrors NEW_STRUCTURES_REPLACE_CONTENT in the SketcherModel and
    // defaults to true (model/sketcher_model.cpp:227). When checked, file
    // import + paste-in-text clear the existing mol first; when unchecked
    // the Qt path merges via add_mol_or_reaction_to_mol_model. The lean
    // MolModel doesn't have an append/merge primitive yet, so unchecked
    // mode surfaces a friendly stub message instead of silently replacing.
    // Ctrl+V (clipboard paste) is agnostic per Qt's
    // sketcher_widget.cpp:685 comment ("paste is agnostic of
    // NEW_STRUCTURES_REPLACE_CONTENT"), so the Batch 17 paste handler is
    // unchanged.
    const [replaceCurrentContent, setReplaceCurrentContent] =
        useState<boolean>(true);
    // Help dropdown (Qt's HelpMenu, menu/sketcher_top_bar_menus.cpp:130-151)
    // + its two modal sub-dialogs (SketcherWelcomeDialog,
    // About2DSketcher). Modal state mirrors what the Qt dialogs hold.
    const [helpMenuOpen, setHelpMenuOpen] = useState<boolean>(false);
    const [welcomeModalOpen, setWelcomeModalOpen] = useState<boolean>(false);
    const [aboutModalOpen, setAboutModalOpen] = useState<boolean>(false);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const bondModeRef = useRef<BondMode>('single');
    const [, bumpVersion] = useReducer((v: number) => v + 1, 0);

    // Always update both the state (drives redraw) and the ref (so event
    // handlers see the new viewport without waiting for a re-render).
    const setView = useCallback((next: View): void => {
        viewRef.current = next;
        setViewState(next);
    }, []);

    // Mirror bondMode into a ref so onCanvasClick (closure-captured) sees the
    // current mode without waiting for the next render. Pick a bond mode also
    // switches tool back to 'bond' so the next click starts a bond.
    const pickBondMode = useCallback((mode: BondMode): void => {
        bondModeRef.current = mode;
        setBondMode(mode);
        setTool('bond');
        setPendingBondAtom(null);
    }, []);

    // Mirrors Qt set_atom_widget.cpp:92-100 + periodic_table_widget.cpp:51-69.
    // Sets the active element, switches to atom tool, and — if the picked
    // element isn't one of the 8 fixed sidebar elements — promotes it to the
    // last-picked slot so the user can re-arm it without re-opening the PT.
    const pickElement = useCallback((sym: Element): void => {
        setElement(sym);
        setTool('atom');
        setPendingBondAtom(null);
        if (!FIXED_ELEMENTS.includes(sym)) {
            setLastPickedElement(sym);
        }
    }, []);

    // BondMode → (order, dir) for addBondWithDir / setBondDirForSelectedBonds.
    const bondModeToOrderAndDir = (mode: BondMode): { order: number; dir: number } => {
        switch (mode) {
            case 'single':  return { order: 1, dir: BOND_DIR_NONE };
            case 'double':  return { order: 2, dir: BOND_DIR_NONE };
            case 'triple':  return { order: 3, dir: BOND_DIR_NONE };
            case 'wedge':   return { order: 1, dir: BOND_DIR_WEDGE };
            case 'dash':    return { order: 1, dir: BOND_DIR_DASH };
            case 'wavy':    return { order: 1, dir: BOND_DIR_UNKNOWN };
            case 'crossed': return { order: 2, dir: BOND_DIR_EITHERDOUBLE };
            // order carries the raw RDKit::Bond::BondType int here (the JS
            // binding casts it straight to BondType), so DATIVE=17 / ZERO=21
            // draw as coordinate/zero bonds via the render `bt` field.
            case 'coordinate': return { order: BOND_TYPE_DATIVE, dir: BOND_DIR_NONE };
            case 'zero':       return { order: BOND_TYPE_ZERO, dir: BOND_DIR_NONE };
        }
    };

    // Per-slot icon for the stereo & bond-order ModularToolButtons. Used by
    // the popup primitive to swap the parent button's display when the user
    // picks something new from the popup. Icon names mirror Qt's resource
    // paths (ui/draw_tools_widget.ui + popup .ui files).
    const bondModeIcon = (mode: BondMode): string => {
        switch (mode) {
            case 'single':  return 'bond_single';
            case 'double':  return 'bond_double';
            case 'triple':  return 'bond_triple';
            case 'wedge':   return 'bond_up';
            case 'dash':    return 'bond_down';
            case 'wavy':    return 'bond_wiggly';
            case 'crossed': return 'bond_crossed';
            case 'coordinate': return 'bond_coordinate';
            case 'zero':    return 'bond_zero';
        }
    };
    const bondModeTitle = (mode: BondMode): string => {
        switch (mode) {
            case 'single':  return 'Single Bond';
            case 'double':  return 'Double Bond';
            case 'triple':  return 'Triple Bond';
            case 'wedge':   return 'Single Up Bond';
            case 'dash':    return 'Single Down Bond';
            case 'wavy':    return 'Single Up or Down Bond';
            case 'crossed': return 'Double Cis or Trans Bond';
            case 'coordinate': return 'Coordinate Bond';
            case 'zero':    return 'Zero Order Bond';
        }
    };

    // The 4-choice stereo popup — mirrors ui/stereo_bond_popup.ui order:
    // up_btn, down_btn, single_either_btn, double_either_btn. Used as the
    // popup for both stereo slots (Qt: each stereo_bondN_btn has its own
    // independent StereoBondPopup but they offer the same 4 choices).
    const STEREO_CHOICES: PopupChoice<BondMode>[] = [
        { value: 'wedge',   icon: 'bond_up',      title: 'Single Up Bond',          testid: 'stereo-popup-wedge' },
        { value: 'dash',    icon: 'bond_down',    title: 'Single Down Bond',        testid: 'stereo-popup-dash' },
        { value: 'wavy',    icon: 'bond_wiggly',  title: 'Single Up or Down Bond',  testid: 'stereo-popup-wavy' },
        { value: 'crossed', icon: 'bond_crossed', title: 'Double Cis or Trans Bond',testid: 'stereo-popup-crossed' },
    ];
    // The bond-order popup — mirrors ui/bond_order_popup.ui (Double, Triple,
    // Coordinate, Zero). Coordinate = BondType::DATIVE, Zero = BondType::ZERO;
    // both draw via the render `bt` field (dative arrow / dashed line).
    const BOND_ORDER_CHOICES: PopupChoice<BondMode>[] = [
        { value: 'double',     icon: 'bond_double',     title: 'Double Bond',     testid: 'order-popup-double' },
        { value: 'triple',     icon: 'bond_triple',     title: 'Triple Bond',     testid: 'order-popup-triple' },
        { value: 'coordinate', icon: 'bond_coordinate', title: 'Coordinate Bond', testid: 'order-popup-coordinate' },
        { value: 'zero',       icon: 'bond_zero',       title: 'Zero Order Bond', testid: 'order-popup-zero' },
    ];
    // Atom-query popup (Qt ui/atom_query_popup.ui). 8 choices in a 2×4 grid
    // with column headers (Any/Hetero/Metal/Halogen). The popup primitive
    // renders a single horizontal row in this port — close enough for v1
    // since picking is stubbed anyway (RDKit query atoms aren't ported to
    // the lean MolModel yet).
    // Select shape popup — Qt ui/selection_tool_popup.ui (rect / lasso /
    // ellipse). Picking changes the persistent shape AND switches the active
    // tool to 'select' so the next drag uses the new shape.
    const SELECT_SHAPE_CHOICES: PopupChoice<SelectShape>[] = [
        { value: 'rect',    icon: 'select_square',  title: 'Rectangle Select', testid: 'select-popup-rect' },
        { value: 'lasso',   icon: 'select_lasso',   title: 'Lasso Select',     testid: 'select-popup-lasso' },
        { value: 'ellipse', icon: 'select_ellipse', title: 'Ellipse Select',   testid: 'select-popup-ellipse' },
    ];
    const SELECT_SHAPE_ICON: Record<SelectShape, string> = {
        rect: 'select_square',
        lasso: 'select_lasso',
        ellipse: 'select_ellipse',
    };
    const SELECT_SHAPE_TITLE: Record<SelectShape, string> = {
        rect: 'Rectangle Select',
        lasso: 'Lasso Select',
        ellipse: 'Ellipse Select',
    };

    const pickSelectShape = useCallback((s: SelectShape): void => {
        selectShapeRef.current = s;
        setSelectShape(s);
        setTool('select');
        setPendingBondAtom(null);
        setStatus(`${SELECT_SHAPE_TITLE[s].toLowerCase()} mode`);
        // SELECT_SHAPE_TITLE isn't a stable dep — it's a const object freshly
        // built each render but the values never change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Bond-query popup (Qt ui/bond_query_popup.ui). 5 choices in column
    // order: aromatic (icon) / Any / S/D / S/A / D/A. Layout matches Qt
    // exactly so the visual reads identically.
    const BOND_QUERY_CHOICES: PopupChoice<BondQueryChoice>[] = [
        { value: 'aromatic',        icon: 'bond_aromatic', title: 'Aromatic Bond',           testid: 'bond-query-popup-aromatic' },
        { value: 'any',             label: 'Any',          title: 'Any Bond',                testid: 'bond-query-popup-any' },
        { value: 'single_double',   label: 'S/D',          title: 'Single or Double Bond',   testid: 'bond-query-popup-single-double' },
        { value: 'single_aromatic', label: 'S/A',          title: 'Single or Aromatic Bond', testid: 'bond-query-popup-single-aromatic' },
        { value: 'double_aromatic', label: 'D/A',          title: 'Double or Aromatic Bond', testid: 'bond-query-popup-double-aromatic' },
    ];

    const ATOM_QUERY_CHOICES: PopupChoice<AtomQueryChoice>[] = [
        { value: 'A',  label: 'A',  title: 'Any Heavy Atom',     testid: 'atom-query-popup-A' },
        { value: 'Q',  label: 'Q',  title: 'Any Heteroatom',     testid: 'atom-query-popup-Q' },
        { value: 'M',  label: 'M',  title: 'Any Metal',          testid: 'atom-query-popup-M' },
        { value: 'X',  label: 'X',  title: 'Any Halogen',        testid: 'atom-query-popup-X' },
        { value: 'AH', label: 'AH', title: 'Any Atom',           testid: 'atom-query-popup-AH' },
        { value: 'QH', label: 'QH', title: 'Any Heteroatom or H',testid: 'atom-query-popup-QH' },
        { value: 'MH', label: 'MH', title: 'Any Metal or H',     testid: 'atom-query-popup-MH' },
        { value: 'XH', label: 'XH', title: 'Any Halogen or H',   testid: 'atom-query-popup-XH' },
    ];

    // Reaction popup — Qt ReactionPopup (ui/reaction_popup.ui) has 4 choices:
    // arrow / plus / map-atoms / remove-mapping. Mapping requires reaction
    // atom-map plumbing in the lean MolModel (not yet wired) so the port
    // exposes the two placement primitives only; mapping is deferred.
    const REACTION_CHOICES: PopupChoice<ReactionMode>[] = [
        { value: 'arrow', icon: 'reaction_arrow', title: 'Reaction Arrow', testid: 'reaction-popup-arrow' },
        { value: 'plus',  icon: 'reaction_plus',  title: 'Reaction Plus',  testid: 'reaction-popup-plus' },
    ];
    const REACTION_ICON: Record<ReactionMode, string> = {
        arrow: 'reaction_arrow',
        plus: 'reaction_plus',
    };
    const REACTION_TITLE: Record<ReactionMode, string> = {
        arrow: 'Reaction Arrow',
        plus: 'Reaction Plus',
    };

    // Base picker for the RNA / DNA nucleotide selectors — Qt's NucleotidePopup
    // (widget/nucleotide_popup.cpp) offers A / C / G / U-or-T / N. Choosing a
    // base arms the nucleotide tool with sugar(base)phosphate (R for RNA, dR for
    // DNA). Values are the base symbols passed straight to addNucleotide.
    const RNA_BASE_CHOICES: PopupChoice<string>[] = [
        { value: 'A', label: 'A', title: 'Adenine (RNA)',  testid: 'na-rna-base-a' },
        { value: 'C', label: 'C', title: 'Cytosine (RNA)', testid: 'na-rna-base-c' },
        { value: 'G', label: 'G', title: 'Guanine (RNA)',  testid: 'na-rna-base-g' },
        { value: 'U', label: 'U', title: 'Uracil (RNA)',   testid: 'na-rna-base-u' },
        { value: 'N', label: 'N', title: 'Unknown (RNA)',  testid: 'na-rna-base-n' },
    ];
    const DNA_BASE_CHOICES: PopupChoice<string>[] = [
        { value: 'A', label: 'A', title: 'Adenine (DNA)',  testid: 'na-dna-base-a' },
        { value: 'C', label: 'C', title: 'Cytosine (DNA)', testid: 'na-dna-base-c' },
        { value: 'G', label: 'G', title: 'Guanine (DNA)',  testid: 'na-dna-base-g' },
        { value: 'T', label: 'T', title: 'Thymine (DNA)',  testid: 'na-dna-base-t' },
        { value: 'N', label: 'N', title: 'Unknown (DNA)',  testid: 'na-dna-base-n' },
    ];
    // Arm the nucleotide draw tool with the given base for RNA (R sugar) or DNA
    // (dR sugar). Shared by the RNA/DNA tile click (default base) and popup pick.
    const armNucleotide = (id: 'rna' | 'dna', base: string): void => {
        const sugar = id === 'dna' ? 'dR' : 'R';
        setNucleotideSpec({ id, sugar, base, phos: 'P' });
        setTool('monomer');
        setPendingBondAtom(null);
        setStatus(`nucleotide: ${id.toUpperCase()} ${sugar}(${base})P `
            + '— click canvas to place');
    };

    // Amino-acid roster + display order ported from Qt's
    // src/schrodinger/sketcher/model/sketcher_model.h (AminoAcidTool +
    // AMINO_ACID_TOOL_TO_RES_NAME + AMINO_ACID_TOOL_TO_FULL_NAME) and the
    // 3-col×7-row button layout from src/schrodinger/sketcher/ui/
    // monomer_tool_widget.ui. The grid is row-major; iterating this array
    // and laying it out into 3 columns reproduces the Qt button positions
    // exactly (ALA top-left, UNK bottom-right). Each entry is
    // `[3-letter ID, 1-letter symbol, full name]`. The 1-letter is the
    // button face (matches Qt's `<string>X</string>`); the full name goes
    // into the tooltip. Clicks stub through comingSoon — the MolModel
    // doesn't speak monomer yet, so this batch is layout-only.
    const AMINO_ACIDS: Array<readonly [string, string, string]> = [
        ['ala', 'A', 'Alanine'],
        ['phe', 'F', 'Phenylalanine'],
        ['gly', 'G', 'Glycine'],
        ['ile', 'I', 'Isoleucine'],
        ['leu', 'L', 'Leucine'],
        ['met', 'M', 'Methionine'],
        ['pro', 'P', 'Proline'],
        ['val', 'V', 'Valine'],
        ['trp', 'W', 'Tryptophan'],
        ['cys', 'C', 'Cysteine'],
        ['asn', 'N', 'Asparagine'],
        ['gln', 'Q', 'Glutamine'],
        ['ser', 'S', 'Serine'],
        ['thr', 'T', 'Threonine'],
        ['tyr', 'Y', 'Tyrosine'],
        ['his', 'H', 'Histidine'],
        ['lys', 'K', 'Lysine'],
        ['arg', 'R', 'Arginine'],
        ['asp', 'D', 'Aspartate'],
        ['glu', 'E', 'Glutamate'],
        ['unk', 'X', 'Unknown'],
    ];

    // Nucleic-acid grid — Qt's nucleic_page in monomer_tool_widget.ui.
    // Layout (top → bottom): wide RNA selector (row 0, colspan 4), wide
    // DNA selector (row 1, colspan 3), wide Custom Nucleotide selector
    // (row 2, colspan 3), then a 3-col letter grid laid out
    // [A C N / G U T] (rows 4-5) for individual bases, and finally
    // [R dR P] (row 8) for the sugar / deoxyribose / phosphate
    // building blocks. Enum + display names mirror
    // src/schrodinger/sketcher/model/sketcher_model.h::NucleicAcidTool.
    // Base tiles place a single nucleobase (diamond) and the R/dR/P blocks a
    // single sugar (rect) / phosphate (ellipse); the RNA/DNA selectors place a
    // full sugar+base+phosphate nucleotide. Long-press base pickers and the
    // Custom triple-builder popup are deferred to a later batch.
    const NUCLEIC_LETTERS: Array<readonly [string, string, string]> = [
        ['a',  'A',  'Adenine'],
        ['c',  'C',  'Cytosine'],
        ['n',  'N',  'Any base'],
        ['g',  'G',  'Guanine'],
        ['u',  'U',  'Uracil'],
        ['t',  'T',  'Thymine'],
    ];
    const NUCLEIC_BUILDING_BLOCKS:
        Array<readonly [string, string, string]> = [
        ['r',  'R',  'Ribose'],
        ['dr', 'dR', 'Deoxyribose'],
        ['p',  'P',  'Phosphate'],
    ];

    // Build the C++ MolModel once per mount, tear it down on unmount.
    useEffect(() => {
        const model = new Module.MolModel();
        const handle = Module.mol_model_subscribe(model, () => {
            // The signal fires after every applied / undone / redone mutation.
            // Bumping the reducer triggers a re-render; the draw effect below
            // reads model.description() to pick up the new state.
            bumpVersion();
        });
        const selHandle = Module.mol_model_selection_subscribe(model, () => {
            // Selection is non-undoable but visually distinct — re-render so
            // the canvas picks up the new sel flags from description().
            bumpVersion();
        });
        modelRef.current = model;
        subscriptionRef.current = handle;
        selectionSubscriptionRef.current = selHandle;
        // Expose for Playwright assertions, mirroring lean.html.
        (
            window as unknown as { SketcherModel?: MolModelInstance }
        ).SketcherModel = model;
        // Expose the live view ref so PW tests can inspect the current
        // viewport without us having to publish each individual scale/offset
        // change to React state.
        (
            window as unknown as { SketcherView?: { current: View } }
        ).SketcherView = viewRef;
        bumpVersion();
        return () => {
            if (subscriptionRef.current !== null) {
                Module.mol_model_unsubscribe(subscriptionRef.current);
                subscriptionRef.current = null;
            }
            if (selectionSubscriptionRef.current !== null) {
                Module.mol_model_selection_unsubscribe(
                    selectionSubscriptionRef.current,
                );
                selectionSubscriptionRef.current = null;
            }
            if (modelRef.current) {
                modelRef.current.delete();
                modelRef.current = null;
            }
            delete (window as unknown as { SketcherModel?: MolModelInstance })
                .SketcherModel;
            delete (window as unknown as { SketcherView?: { current: View } })
                .SketcherView;
        };
    }, [Module]);

    // Compute the rotation handle (pivot + handle endpoint) for the
    // Move/Rotate tool. Returns null when the handle shouldn't be shown:
    // wrong tool, empty mol, single-atom selection (rotation has no
    // meaning), or single-atom mol with nothing selected.
    //
    // Pivot rules (Qt standard_scene_tool_base.cpp findPivotPointForRotation,
    // simplified — we skip the single-crossing-bond special case):
    //   no selection → centroid of all atoms
    //   selection    → centroid of selected atoms
    //
    // Arm always points to the right (Qt rotation_item.cpp:50 — angle 0
    // initially; Qt resets to 0 on every updateRotationItem).
    const computeRotationHandle = useCallback(
        (rd: RenderDesc): RotationHandle | null => {
            if (tool !== 'move-rotate') return null;
            const canvas = canvasRef.current;
            if (!canvas) return null;
            if (rd.atoms.length === 0) return null;
            const selected = rd.atoms.filter((a) => a.sel === true);
            const target = selected.length > 0 ? selected : rd.atoms;
            // Qt: handle only when >1 atom in the rotated set.
            if (target.length < 2) return null;
            let cx = 0, cy = 0;
            for (const a of target) {
                cx += a.x;
                cy += a.y;
            }
            cx /= target.length;
            cy /= target.length;
            const pivot = pixelFromModel(canvas, viewRef.current, cx, cy);
            return {
                pivotPx: pivot.px,
                pivotPy: pivot.py,
                // Arm at angle 0: handle to the right of pivot, 130 px out.
                handlePx: pivot.px + ROTATION_ARM_LENGTH,
                handlePy: pivot.py,
            };
        },
        [tool],
    );

    // Redraw whenever React re-renders. The render description comes from
    // MolModel, which is the source of truth.
    useEffect(() => {
        const canvas = canvasRef.current;
        const model = modelRef.current;
        if (!canvas || !model) return;
        let rd: RenderDesc = BLANK_DESC;
        try {
            rd = JSON.parse(model.description()) as RenderDesc;
        } catch {
            rd = BLANK_DESC;
        }
        const rotationHandle = computeRotationHandle(rd);
        drawSketch(
            canvas,
            view,
            rd,
            pendingBondAtom,
            hoverAtom,
            dragShape,
            rotationHandle,
            chainDrag,
            displayOptions,
        );
    });

    // View-center-anchored wheel zoom, matching Qt's QGraphicsView::wheelEvent
    // in sketcher_view.cpp: scale_factor = 2^(angleDelta.y / 2400). Wheel up
    // (negative deltaY in browsers, positive angleDelta.y in Qt) zooms in.
    // Capped at DEFAULT_SCALE so the user can never zoom in past the resting
    // "fit" view — Qt enforces the same upper bound. Attached imperatively
    // because React's onWheel is passive and we need preventDefault.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        function onWheel(e: WheelEvent): void {
            e.preventDefault();
            const cur = viewRef.current;
            const factor = Math.pow(2, -e.deltaY / 2400);
            const nextScale = Math.max(
                MIN_VIEW_SCALE,
                Math.min(DEFAULT_SCALE, cur.scale * factor),
            );
            if (nextScale === cur.scale) return;
            // Center anchor: keep the model-space point at the canvas center
            // pinned. canvas-center maps to model-space (-offsetX/scale,
            // offsetY/scale); pinning that point yields offsets scaled by the
            // same factor.
            const ratio = nextScale / cur.scale;
            setView({
                scale: nextScale,
                offsetX: cur.offsetX * ratio,
                offsetY: cur.offsetY * ratio,
            });
        }
        canvas.addEventListener('wheel', onWheel, { passive: false });
        return () => {
            canvas.removeEventListener('wheel', onWheel);
        };
    }, [setView]);

    // Keep a ref in sync so the cleanup callback (which doesn't re-create on
    // every render) can clear it without stale state.
    useEffect(() => {
        pendingRef.current = pendingBondAtom;
    }, [pendingBondAtom]);

    // Wrapper refs for the 5 top-bar dropdowns. Used by the outside-click
    // effect below — clicks outside the wrapper close the menu, but mouse
    // motion does not (Qt menus don't auto-dismiss on mouse-leave).
    const moreMenuWrapperRef = useRef<HTMLDivElement | null>(null);
    const importMenuWrapperRef = useRef<HTMLDivElement | null>(null);
    const exportMenuWrapperRef = useRef<HTMLDivElement | null>(null);
    const configureViewWrapperRef = useRef<HTMLDivElement | null>(null);
    const helpMenuWrapperRef = useRef<HTMLDivElement | null>(null);
    const bgContextMenuRef = useRef<HTMLDivElement | null>(null);
    const selContextMenuRef = useRef<HTMLDivElement | null>(null);
    const bondContextMenuRef = useRef<HTMLDivElement | null>(null);
    const atomContextMenuRef = useRef<HTMLDivElement | null>(null);
    const apContextMenuRef = useRef<HTMLDivElement | null>(null);
    // Bounds-clamp the right-click menus within the viewport — Qt's QMenu
    // does this automatically (flips upward / leftward at edges). The
    // background menu has 21 items and tall layouts can easily push the
    // bottom items below a 700px-tall window.
    useLayoutEffect(() => {
        if (!bgContextMenu) return;
        const el = bgContextMenuRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let { x, y } = bgContextMenu;
        if (x + rect.width > vw) x = Math.max(0, vw - rect.width - 4);
        if (y + rect.height > vh) y = Math.max(0, vh - rect.height - 4);
        if (x !== bgContextMenu.x || y !== bgContextMenu.y) {
            el.style.left = `${x}px`;
            el.style.top = `${y}px`;
        }
    }, [bgContextMenu]);
    useLayoutEffect(() => {
        if (!selContextMenu) return;
        const el = selContextMenuRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let { x, y } = selContextMenu;
        if (x + rect.width > vw) x = Math.max(0, vw - rect.width - 4);
        if (y + rect.height > vh) y = Math.max(0, vh - rect.height - 4);
        if (x !== selContextMenu.x || y !== selContextMenu.y) {
            el.style.left = `${x}px`;
            el.style.top = `${y}px`;
        }
    }, [selContextMenu]);
    useLayoutEffect(() => {
        if (!bondContextMenu) return;
        const el = bondContextMenuRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let { x, y } = bondContextMenu;
        if (x + rect.width > vw) x = Math.max(0, vw - rect.width - 4);
        if (y + rect.height > vh) y = Math.max(0, vh - rect.height - 4);
        if (x !== bondContextMenu.x || y !== bondContextMenu.y) {
            el.style.left = `${x}px`;
            el.style.top = `${y}px`;
        }
    }, [bondContextMenu]);
    useLayoutEffect(() => {
        if (!atomContextMenu) return;
        const el = atomContextMenuRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let { x, y } = atomContextMenu;
        if (x + rect.width > vw) x = Math.max(0, vw - rect.width - 4);
        if (y + rect.height > vh) y = Math.max(0, vh - rect.height - 4);
        if (x !== atomContextMenu.x || y !== atomContextMenu.y) {
            el.style.left = `${x}px`;
            el.style.top = `${y}px`;
        }
    }, [atomContextMenu]);
    useLayoutEffect(() => {
        if (!apContextMenu) return;
        const el = apContextMenuRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let { x, y } = apContextMenu;
        if (x + rect.width > vw) x = Math.max(0, vw - rect.width - 4);
        if (y + rect.height > vh) y = Math.max(0, vh - rect.height - 4);
        if (x !== apContextMenu.x || y !== apContextMenu.y) {
            el.style.left = `${x}px`;
            el.style.top = `${y}px`;
        }
    }, [apContextMenu]);
    useEffect(() => {
        if (!moreMenuOpen && !importMenuOpen && !exportMenuOpen
            && !configureViewOpen && !helpMenuOpen && !bgContextMenu
            && !selContextMenu && !bondContextMenu && !atomContextMenu
            && !apContextMenu) return;
        function onDocMouseDown(e: globalThis.MouseEvent): void {
            const t = e.target as Node;
            if (moreMenuOpen && moreMenuWrapperRef.current
                && !moreMenuWrapperRef.current.contains(t)) {
                setMoreMenuOpen(false);
            }
            if (importMenuOpen && importMenuWrapperRef.current
                && !importMenuWrapperRef.current.contains(t)) {
                setImportMenuOpen(false);
            }
            if (exportMenuOpen && exportMenuWrapperRef.current
                && !exportMenuWrapperRef.current.contains(t)) {
                setExportMenuOpen(false);
            }
            if (configureViewOpen && configureViewWrapperRef.current
                && !configureViewWrapperRef.current.contains(t)) {
                setConfigureViewOpen(false);
            }
            if (helpMenuOpen && helpMenuWrapperRef.current
                && !helpMenuWrapperRef.current.contains(t)) {
                setHelpMenuOpen(false);
            }
            if (bgContextMenu && bgContextMenuRef.current
                && !bgContextMenuRef.current.contains(t)) {
                setBgContextMenu(null);
            }
            if (selContextMenu && selContextMenuRef.current
                && !selContextMenuRef.current.contains(t)) {
                setSelContextMenu(null);
            }
            if (bondContextMenu && bondContextMenuRef.current
                && !bondContextMenuRef.current.contains(t)) {
                setBondContextMenu(null);
            }
            if (atomContextMenu && atomContextMenuRef.current
                && !atomContextMenuRef.current.contains(t)) {
                setAtomContextMenu(null);
            }
            if (apContextMenu && apContextMenuRef.current
                && !apContextMenuRef.current.contains(t)) {
                setApContextMenu(null);
            }
        }
        document.addEventListener('mousedown', onDocMouseDown);
        return () => {
            document.removeEventListener('mousedown', onDocMouseDown);
        };
    }, [moreMenuOpen, importMenuOpen, exportMenuOpen, configureViewOpen,
        helpMenuOpen, bgContextMenu, selContextMenu, bondContextMenu,
        atomContextMenu, apContextMenu]);

    const onCanvasClick = useCallback(
        (e: ReactMouseEvent<HTMLCanvasElement>): void => {
            if (suppressNextClickRef.current) {
                // The click event fires immediately after a drag-select
                // mouseUp; ignore it here so we don't override the rectangle
                // selection we just committed.
                suppressNextClickRef.current = false;
                return;
            }
            const canvas = canvasRef.current;
            const model = modelRef.current;
            if (!canvas || !model) return;
            const rect = canvas.getBoundingClientRect();
            const px = e.clientX - rect.left;
            const py = e.clientY - rect.top;

            let rd: RenderDesc = BLANK_DESC;
            try {
                rd = JSON.parse(model.description()) as RenderDesc;
            } catch {
                rd = BLANK_DESC;
            }
            const hit = nearestAtomIndex(canvas, viewRef.current, rd.atoms, px, py);

            if (tool === 'select') {
                // Modifier convention mirrors Qt's SelectSceneTool::getSelectMode
                // (tool/select_erase_scene_tool.cpp:166-176): Ctrl=TOGGLE,
                // Shift=SELECT(add), plain=SELECT_ONLY(replace). Empty-area
                // click with no modifier clears; with Ctrl/Shift it's a no-op.
                const toggle = e.ctrlKey || e.metaKey;
                const add = !toggle && e.shiftKey;
                const replace = !toggle && !add;
                const bondHit = hit < 0
                    ? nearestBondIndex(canvas, viewRef.current, rd, px, py)
                    : -1;
                if (hit < 0 && bondHit < 0) {
                    if (replace && model.hasSelection()) {
                        model.clearSelection();
                        setStatus('cleared selection');
                    } else if (replace) {
                        setStatus(
                            'select mode: click an atom or bond (or use Select All)',
                        );
                    }
                    return;
                }
                const isAtom = hit >= 0;
                const idx = isAtom ? hit : bondHit;
                const isSel = isAtom
                    ? model.isAtomSelected(idx)
                    : model.isBondSelected(idx);
                if (replace) {
                    model.clearSelection();
                    if (isAtom) model.setAtomSelected(idx, true);
                    else model.setBondSelected(idx, true);
                    setStatus(`select ${isAtom ? 'atom' : 'bond'} #${idx}`);
                } else if (toggle) {
                    if (isAtom) model.setAtomSelected(idx, !isSel);
                    else model.setBondSelected(idx, !isSel);
                    setStatus(
                        `${isSel ? 'deselect' : 'select'} ${isAtom ? 'atom' : 'bond'} #${idx}`,
                    );
                } else { // add
                    if (isAtom) model.setAtomSelected(idx, true);
                    else model.setBondSelected(idx, true);
                    setStatus(
                        `add ${isAtom ? 'atom' : 'bond'} #${idx} to selection`,
                    );
                }
                return;
            }

            if (tool === 'move-rotate') {
                // All move-rotate logic lives in the mousedown/move/up
                // pipeline. The click event that fires after the gesture
                // shouldn't do anything (and must not fall through to the
                // bond tool's "click on an atom to start a bond" message,
                // which would overwrite the move-rotate status).
                return;
            }

            if (tool === 'erase') {
                // Qt EraseSceneTool::onLeftButtonClick
                // (tool/select_erase_scene_tool.cpp:256-275):
                //  - click atom → remove it (and incident bonds)
                //  - click multi-bond → decrement order (TRIPLE→DOUBLE,
                //    DOUBLE→SINGLE) — does NOT delete the bond
                //  - click single bond → remove it
                //  - click empty → no-op (drag-erase handles regions)
                if (hit >= 0) {
                    model.removeAtom(hit);
                    setStatus(`erased atom #${hit}`);
                    return;
                }
                const bondHit = nearestBondIndex(
                    canvas, viewRef.current, rd, px, py,
                );
                if (bondHit < 0) {
                    return;
                }
                const b = rd.bonds[bondHit];
                if (b.o === 3) {
                    model.setBondTypeUndoable(b.a, b.b, 2 /*DOUBLE*/);
                    setStatus(`bond #${bondHit}: triple → double`);
                } else if (b.o === 2) {
                    model.setBondTypeUndoable(b.a, b.b, 1 /*SINGLE*/);
                    setStatus(`bond #${bondHit}: double → single`);
                } else {
                    model.removeBond(b.a, b.b);
                    setStatus(`erased bond #${bondHit}`);
                }
                return;
            }

            if (tool === 'atom') {
                if (hit >= 0) {
                    setStatus(
                        `atom #${hit} already here — pick the bond tool to connect it`,
                    );
                    return;
                }
                const { x, y } = modelFromPixel(canvas, viewRef.current, px, py);
                model.addAtom(element, x, y);
                setStatus(`added ${element} at (${x.toFixed(2)}, ${y.toFixed(2)})`);
                return;
            }

            if (tool === 'atom-query') {
                // Atom-query (A▾) tool — Qt's DrawAtomSceneTool armed with a
                // wildcard. Clicking an existing atom converts it in place;
                // clicking empty canvas drops a new query atom.
                if (hit >= 0) {
                    model.mutateAtomToWildcard(hit, atomQueryMode);
                    setStatus(`atom #${hit} → ${atomQueryMode}`);
                    return;
                }
                const { x, y } = modelFromPixel(canvas, viewRef.current, px, py);
                model.addWildcardAtom(atomQueryMode, x, y);
                setStatus(`added ${atomQueryMode} at `
                    + `(${x.toFixed(2)}, ${y.toFixed(2)})`);
                return;
            }

            if (tool === 'monomer') {
                // Monomer draw tool — Qt's DrawMonomerSceneTool. Clicking an
                // existing monomer bead chains new content off it; clicking
                // empty canvas drops it free. A full nucleotide (RNA/DNA tile)
                // routes through addNucleotide; a single monomer (amino-acid or
                // NA building-block tile) through addMonomer.
                const beadHit = hit >= 0
                    ? rd.atoms.find((a) => a.i === hit) : undefined;
                if (nucleotideSpec) {
                    const { sugar, base, phos } = nucleotideSpec;
                    if (beadHit) {
                        model.addBoundNucleotide(sugar, base, phos,
                            beadHit.x + MONOMER_BOND_LENGTH, beadHit.y, hit);
                        setStatus(`chained ${sugar}(${base})${phos} nucleotide `
                            + `to monomer #${hit}`);
                        return;
                    }
                    const { x, y } =
                        modelFromPixel(canvas, viewRef.current, px, py);
                    model.addNucleotide(sugar, base, phos, x, y);
                    setStatus(`placed ${sugar}(${base})${phos} nucleotide at `
                        + `(${x.toFixed(2)}, ${y.toFixed(2)})`);
                    return;
                }
                if (beadHit) {
                    // Clicking a monomer of the SAME kind but a DIFFERENT
                    // residue mutates it in place (Qt clickShouldMutate);
                    // otherwise chain a new monomer off it.
                    const armed =
                        armedMonomerSubtype(monomerChainType, monomerResName);
                    if (beadHit.mon === armed && beadHit.lbl !== monomerResName) {
                        model.mutateMonomer(hit, monomerResName);
                        setStatus(`mutated monomer #${hit} to ${monomerResName}`);
                        return;
                    }
                    model.addBoundMonomer(monomerResName, monomerChainType,
                        beadHit.x + MONOMER_BOND_LENGTH, beadHit.y, hit);
                    setStatus(`chained ${monomerResName} to monomer #${hit}`);
                    return;
                }
                const { x, y } = modelFromPixel(canvas, viewRef.current, px, py);
                model.addMonomer(monomerResName, monomerChainType, x, y);
                setStatus(`placed ${monomerResName} at `
                    + `(${x.toFixed(2)}, ${y.toFixed(2)})`);
                return;
            }

            if (tool === 'ring') {
                // Click anywhere — empty canvas or atom — drops a fresh ring
                // centered on the click. Mirrors the Qt sketcher's ring-tool
                // behavior (the new ring isn't fused with any existing atom in
                // this skeleton; that's a future enhancement).
                const { x, y } = modelFromPixel(canvas, viewRef.current, px, py);
                model.addRing(ring.size, x, y, ring.aromatic);
                setStatus(
                    `${ring.label.toLowerCase()} at (${x.toFixed(2)}, ${y.toFixed(2)})`,
                );
                return;
            }

            if (tool === 'rgroup') {
                // R-Group tool: clicking an existing atom attaches a new R to
                // it (single bond, offset down-right); clicking empty area
                // drops a free-standing R. The R-group number auto-increments
                // — pick the smallest positive integer not already taken by an
                // existing rlabel. Mirrors Qt's EnumerationSceneTool flow,
                // which calls MolModel::addRGroup(next_num, coords, target).
                const used = new Set<number>();
                for (const a of rd.atoms) {
                    if (typeof a.rlabel === 'number') used.add(a.rlabel);
                }
                let nextNum = 1;
                while (used.has(nextNum)) nextNum++;
                if (hit >= 0) {
                    // Offset the new R atom one bond-length down-right of the
                    // anchor so it doesn't sit on top.
                    const anchor = rd.atoms[hit];
                    const x = anchor.x + 0.75;
                    const y = anchor.y - 0.75;
                    model.addRGroup(nextNum, x, y, hit);
                    setStatus(
                        `attached R${nextNum} to atom #${hit}`,
                    );
                } else {
                    const { x, y } = modelFromPixel(canvas, viewRef.current, px, py);
                    model.addRGroup(nextNum, x, y, -1);
                    setStatus(
                        `added R${nextNum} at (${x.toFixed(2)}, ${y.toFixed(2)})`,
                    );
                }
                return;
            }

            if (tool === 'reaction') {
                // Reaction tool: drop an arrow (RXN_ARROW) or plus (RXN_PLUS)
                // at the click position. Qt: ArrowPlusSceneTool::onLeftButtonClick
                // (tool/arrow_plus_scene_tool.cpp:21-26) calls
                // MolModel::addNonMolecularObject(type, scene_xy). Only one
                // arrow allowed — second click while an arrow already exists
                // surfaces a friendly status (the C++ throws).
                const { x, y } = modelFromPixel(canvas, viewRef.current, px, py);
                try {
                    if (reactionMode === 'arrow') {
                        model.addRxnArrow(x, y);
                        setStatus(
                            `placed reaction arrow at (${x.toFixed(2)}, ${y.toFixed(2)})`,
                        );
                    } else {
                        model.addRxnPlus(x, y);
                        setStatus(
                            `placed reaction plus at (${x.toFixed(2)}, ${y.toFixed(2)})`,
                        );
                    }
                } catch (err) {
                    setStatus(`reaction: ${String(err)}`);
                }
                return;
            }
            if (tool === 'attachment-point') {
                // Attachment-point tool: REQUIRES clicking an existing atom —
                // an AP is always bonded (RDKit's is_attachment_point_dummy
                // requires totalDegree == 1). The number auto-increments to
                // max(existing) + 1, matching Qt's get_next_attachment_point_number
                // (rdkit/rgroup.cpp). Mirrors Qt's DrawAttachmentPointSceneTool
                // (tool/attachment_point_scene_tool.cpp) which calls
                // MolModel::addAttachmentPoint(next_num, coords, atom).
                if (hit < 0) {
                    setStatus(
                        'attachment-point: click an existing atom to attach',
                    );
                    return;
                }
                let nextNum = 0;
                for (const a of rd.atoms) {
                    if (typeof a.ap === 'number' && a.ap > nextNum) {
                        nextNum = a.ap;
                    }
                }
                nextNum += 1;
                const anchor = rd.atoms[hit];
                // Offset down-right one half-bond so the squiggle clears the
                // anchor label; the bond direction is what orients the wavy
                // line, so any non-zero offset works.
                const x = anchor.x + 0.75;
                const y = anchor.y - 0.75;
                try {
                    model.addAttachmentPoint(nextNum, x, y, hit);
                    setStatus(
                        `attached AP${nextNum} to atom #${hit}`,
                    );
                } catch (err) {
                    setStatus(`attachment-point failed: ${String(err)}`);
                }
                return;
            }

            if (tool === 'bond-query') {
                // Bond-query (B▾) tool — two-click bonding like the bond tool,
                // but the completed bond is stamped with the armed query (or
                // aromatic). Clicking two atoms creates/converts in one step.
                if (hit < 0) {
                    setStatus('click an atom to start a query bond');
                    setPendingBondAtom(null);
                    return;
                }
                if (pendingRef.current === null) {
                    setPendingBondAtom(hit);
                    setStatus(`query bond start: atom #${hit}`);
                    return;
                }
                if (pendingRef.current === hit) {
                    setPendingBondAtom(null);
                    setStatus('query bond cancelled');
                    return;
                }
                const cppLabel = BOND_QUERY_CPP_LABEL[bondQueryMode];
                model.addQueryBondBetweenAtoms(
                    pendingRef.current, hit, cppLabel);
                setStatus(
                    `query bond: ${pendingRef.current}-${hit} (${cppLabel})`);
                setPendingBondAtom(null);
                return;
            }

            // Bond tool.
            if (hit < 0) {
                setStatus('click on an atom to start a bond');
                setPendingBondAtom(null);
                return;
            }
            if (pendingRef.current === null) {
                setPendingBondAtom(hit);
                setStatus(
                    `bond start: atom #${hit} — click another atom to finish`,
                );
                return;
            }
            if (pendingRef.current === hit) {
                setPendingBondAtom(null);
                setStatus('bond cancelled');
                return;
            }
            try {
                const { order, dir } = bondModeToOrderAndDir(bondModeRef.current);
                model.addBondWithDir(pendingRef.current, hit, order, dir);
                const stereoLabel =
                    dir === BOND_DIR_WEDGE
                        ? ' wedge'
                        : dir === BOND_DIR_DASH
                          ? ' dash'
                          : '';
                setStatus(
                    `bond: ${pendingRef.current}-${hit} (order ${order}${stereoLabel})`,
                );
            } catch (err) {
                setStatus(`bond failed: ${String(err)}`);
            } finally {
                setPendingBondAtom(null);
            }
        },
        [tool, element, ring, reactionMode, atomQueryMode, bondQueryMode,
         monomerResName, monomerChainType, nucleotideSpec],
    );

    const onCanvasMove = useCallback(
        (e: ReactMouseEvent<HTMLCanvasElement>): void => {
            const canvas = canvasRef.current;
            const model = modelRef.current;
            if (!canvas || !model) return;
            const rect = canvas.getBoundingClientRect();
            const px = e.clientX - rect.left;
            const py = e.clientY - rect.top;
            const rd_rot = rotateDragRef.current;
            if (rd_rot) {
                const curAngle = Math.atan2(py - rd_rot.pivotPy,
                                            px - rd_rot.pivotPx);
                // Pixel-space y grows downward; model-space y grows upward
                // (modelFromPixel:142). So a CCW gesture in pixels is a CW
                // rotation in model space — negate the delta so the visible
                // structure tracks the visible handle.
                const delta = -(curAngle - rd_rot.startAngleRad);
                if (!rd_rot.moved && Math.abs(delta) < 0.005) {
                    return; // hairline movement — treat as still pressed
                }
                rd_rot.moved = true;
                const cosT = Math.cos(delta);
                const sinT = Math.sin(delta);
                for (const a of rd_rot.atoms) {
                    const dx = a.fromX - rd_rot.pivotX;
                    const dy = a.fromY - rd_rot.pivotY;
                    const nx = rd_rot.pivotX + dx * cosT - dy * sinT;
                    const ny = rd_rot.pivotY + dx * sinT + dy * cosT;
                    model.setAtomPos(a.idx, nx, ny);
                }
                return;
            }
            const ad = atomDragRef.current;
            if (ad) {
                const dpx = px - ad.startPx;
                const dpy = py - ad.startPy;
                if (!ad.moved &&
                    Math.abs(dpx) < ATOM_DRAG_THRESHOLD &&
                    Math.abs(dpy) < ATOM_DRAG_THRESHOLD) {
                    return; // still within "click" tolerance
                }
                ad.moved = true;
                // Convert the grabbed atom's destination into a model-space
                // delta, then translate every dragged atom by that delta.
                // For a single-atom drag this collapses to the simple case.
                const { x: grabbedToX, y: grabbedToY } = modelFromPixel(
                    canvas,
                    viewRef.current,
                    px,
                    py,
                );
                const dx = grabbedToX - ad.grabbedFromX;
                const dy = grabbedToY - ad.grabbedFromY;
                for (const a of ad.atoms) {
                    model.setAtomPos(a.idx, a.fromX + dx, a.fromY + dy);
                }
                return;
            }
            if (dragShape) {
                if (dragShape.kind === 'lasso') {
                    // Append a point on every move so the captured polygon
                    // tracks the user's freehand path (Qt LassoSelectSceneTool
                    // onMouseMove: m_path.addPoint(point) while pressed).
                    const nextPoints = dragShape.lassoPoints
                        ? [...dragShape.lassoPoints, { px, py }]
                        : [{ px: dragShape.startPx, py: dragShape.startPy },
                           { px, py }];
                    setDragShape({
                        ...dragShape,
                        curPx: px,
                        curPy: py,
                        lassoPoints: nextPoints,
                    });
                } else {
                    setDragShape({ ...dragShape, curPx: px, curPy: py });
                }
                return;
            }
            if (chainDrag) {
                setChainDrag({ ...chainDrag, curPx: px, curPy: py });
                return;
            }
            if (tool !== 'bond') {
                if (hoverAtom !== null) setHoverAtom(null);
                return;
            }
            let atoms: AtomDesc[] = [];
            try {
                atoms = (JSON.parse(model.description()) as RenderDesc).atoms;
            } catch {
                atoms = [];
            }
            const hit = nearestAtomIndex(canvas, viewRef.current, atoms, px, py);
            const next = hit >= 0 ? hit : null;
            if (next !== hoverAtom) setHoverAtom(next);
        },
        [tool, hoverAtom, dragShape, chainDrag],
    );

    const onCanvasMouseDown = useCallback(
        (e: ReactMouseEvent<HTMLCanvasElement>): void => {
            if (e.button !== 0) return;
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const px = e.clientX - rect.left;
            const py = e.clientY - rect.top;
            const model = modelRef.current;
            if (!model) return;

            if (tool === 'move-rotate') {
                // Qt move_rotate_scene_tool.cpp:95-121 — at mousedown:
                //   1) inside rotation handle → ROTATE
                //   2) inside selection bbox  → TRANSLATE
                //   3) else                   → no-op (status hint)
                // Rotation works on the selected set when there is one and
                // the entire molecule otherwise; translation requires a
                // selection (Qt's setObjectsToMove is gated on the bbox-
                // contains check, which is empty for empty selection).
                let rd: RenderDesc = BLANK_DESC;
                try {
                    rd = JSON.parse(model.description()) as RenderDesc;
                } catch {
                    rd = BLANK_DESC;
                }
                // Rotation handle check first — same priority as Qt.
                const rh = computeRotationHandle(rd);
                if (rh != null) {
                    const inHandle = distanceSq(px, py, rh.handlePx, rh.handlePy)
                        <= ROTATION_HANDLE_RADIUS * ROTATION_HANDLE_RADIUS;
                    if (inHandle) {
                        const selected = rd.atoms.filter((a) => a.sel === true);
                        const target = selected.length > 0 ? selected : rd.atoms;
                        const pivotModel = modelFromPixel(
                            canvas, viewRef.current, rh.pivotPx, rh.pivotPy,
                        );
                        rotateDragRef.current = {
                            pivotX: pivotModel.x,
                            pivotY: pivotModel.y,
                            pivotPx: rh.pivotPx,
                            pivotPy: rh.pivotPy,
                            atoms: target.map((a) => ({
                                idx: a.i,
                                fromX: a.x,
                                fromY: a.y,
                            })),
                            startAngleRad: Math.atan2(
                                py - rh.pivotPy,
                                px - rh.pivotPx,
                            ),
                            moved: false,
                        };
                        return;
                    }
                }
                const selected = rd.atoms.filter((a) => a.sel === true);
                if (selected.length === 0) {
                    setStatus('move/rotate: select atoms first');
                    return;
                }
                // Compute the selection bbox in pixel space.
                let minPx = Infinity, minPy = Infinity;
                let maxPx = -Infinity, maxPy = -Infinity;
                for (const a of selected) {
                    const p = pixelFromModel(canvas, viewRef.current, a.x, a.y);
                    if (p.px < minPx) minPx = p.px;
                    if (p.px > maxPx) maxPx = p.px;
                    if (p.py < minPy) minPy = p.py;
                    if (p.py > maxPy) maxPy = p.py;
                }
                // Qt uses the strict scene-rect bbox; we add a small padding
                // so single-atom selections (zero-area bbox) are still
                // grabbable from a few pixels around the atom dot.
                const pad = 8;
                const insideBbox = px >= minPx - pad && px <= maxPx + pad &&
                    py >= minPy - pad && py <= maxPy + pad;
                if (!insideBbox) {
                    setStatus('move/rotate: drag from inside the selection');
                    return;
                }
                // Pivot for the delta math: use the bbox centroid; the actual
                // grabbed atom is just for status text.
                const grabbedCenter = modelFromPixel(canvas, viewRef.current,
                    (minPx + maxPx) / 2, (minPy + maxPy) / 2);
                atomDragRef.current = {
                    grabbedIdx: selected[0].i,
                    grabbedFromX: grabbedCenter.x,
                    grabbedFromY: grabbedCenter.y,
                    atoms: selected.map((x) => ({
                        idx: x.i,
                        fromX: x.x,
                        fromY: x.y,
                    })),
                    startPx: px,
                    startPy: py,
                    moved: false,
                };
                return;
            }

            if (tool === 'atom-chain') {
                // Qt DrawChainSceneTool::onLeftButtonDragStart
                // (tool/draw_chain_scene_tool.cpp:58-63 + getStartPosAndAtom
                // at :91-105) — if the press lands on an existing atom, the
                // chain starts at that atom's coords + remembers the atom
                // index so the first new atom gets bonded to it on commit.
                let rd: RenderDesc = BLANK_DESC;
                try {
                    rd = JSON.parse(model.description()) as RenderDesc;
                } catch {
                    rd = BLANK_DESC;
                }
                const hit = nearestAtomIndex(
                    canvas, viewRef.current, rd.atoms, px, py,
                );
                let startX: number;
                let startY: number;
                if (hit >= 0) {
                    startX = rd.atoms[hit].x;
                    startY = rd.atoms[hit].y;
                } else {
                    const m = modelFromPixel(canvas, viewRef.current, px, py);
                    startX = m.x;
                    startY = m.y;
                }
                setChainDrag({
                    startPx: px,
                    startPy: py,
                    curPx: px,
                    curPy: py,
                    startX,
                    startY,
                    startAtomIdx: hit,
                });
                return;
            }

            if (tool !== 'select' && tool !== 'erase') return;

            let rd: RenderDesc = BLANK_DESC;
            try {
                rd = JSON.parse(model.description()) as RenderDesc;
            } catch {
                rd = BLANK_DESC;
            }
            // Qt's select tool does NOT drag-move atoms — it only rubber-band
            // selects. Drag-move lives on the Move/Rotate tool. So we let
            // mousedown on an atom/bond fall through to onClick (which applies
            // the modifier-based select / the erase action), and only start a
            // rubber-band when mousedown lands on empty canvas.
            if (nearestAtomIndex(canvas, viewRef.current, rd.atoms, px, py) >= 0) return;
            if (nearestBondIndex(canvas, viewRef.current, rd, px, py) >= 0) return;

            // Erase always uses a rectangle (Qt EraseSceneTool extends
            // RectSelectSceneTool, no popup); Select uses the popup-chosen
            // shape from selectShapeRef.
            const kind: SelectShape =
                tool === 'erase' ? 'rect' : selectShapeRef.current;
            setDragShape({
                kind,
                startPx: px,
                startPy: py,
                curPx: px,
                curPy: py,
                lassoPoints: kind === 'lasso' ? [{ px, py }] : undefined,
                additive: e.shiftKey,
                mode: tool === 'erase' ? 'erase' : 'select',
            });
        },
        [tool],
    );

    const onCanvasMouseUp = useCallback(
        (e: ReactMouseEvent<HTMLCanvasElement>): void => {
            const rd_rot = rotateDragRef.current;
            if (rd_rot) {
                rotateDragRef.current = null;
                if (!rd_rot.moved) {
                    // Click without drag on the rotate handle — no commit.
                    return;
                }
                const canvas = canvasRef.current;
                const model = modelRef.current;
                if (!canvas || !model) return;
                const rect = canvas.getBoundingClientRect();
                const px = e.clientX - rect.left;
                const py = e.clientY - rect.top;
                const curAngle = Math.atan2(py - rd_rot.pivotPy,
                                            px - rd_rot.pivotPx);
                // See preview branch: model-y is flipped from pixel-y, so
                // the visible CCW gesture is a model-space CW rotation.
                const delta = -(curAngle - rd_rot.startAngleRad);
                const cosT = Math.cos(delta);
                const sinT = Math.sin(delta);
                const toXs: number[] = [];
                const toYs: number[] = [];
                for (const a of rd_rot.atoms) {
                    const dx = a.fromX - rd_rot.pivotX;
                    const dy = a.fromY - rd_rot.pivotY;
                    toXs.push(rd_rot.pivotX + dx * cosT - dy * sinT);
                    toYs.push(rd_rot.pivotY + dx * sinT + dy * cosT);
                }
                model.moveAtomsUndoable(
                    rd_rot.atoms.map((a) => a.idx),
                    rd_rot.atoms.map((a) => a.fromX),
                    rd_rot.atoms.map((a) => a.fromY),
                    toXs,
                    toYs,
                );
                suppressNextClickRef.current = true;
                const deg = (delta * 180 / Math.PI).toFixed(1);
                setStatus(`rotated ${rd_rot.atoms.length} atom` +
                    `${rd_rot.atoms.length === 1 ? '' : 's'} by ${deg}°`);
                return;
            }
            const ad = atomDragRef.current;
            if (ad) {
                atomDragRef.current = null;
                if (!ad.moved) {
                    // Below threshold: let the click handler do its toggle.
                    return;
                }
                const canvas = canvasRef.current;
                const model = modelRef.current;
                if (!canvas || !model) return;
                const rect = canvas.getBoundingClientRect();
                const px = e.clientX - rect.left;
                const py = e.clientY - rect.top;
                const { x: grabbedToX, y: grabbedToY } = modelFromPixel(
                    canvas,
                    viewRef.current,
                    px,
                    py,
                );
                const dx = grabbedToX - ad.grabbedFromX;
                const dy = grabbedToY - ad.grabbedFromY;
                // setAtomPos previews have already moved every atom; commit
                // a single batch undo command (one undo step for the whole
                // gesture, even when multiple atoms moved). Single-atom
                // gestures still go through this — moveAtomsUndoable with
                // a one-row macro produces the same undo behavior as the
                // bare moveAtomUndoable, just with a "Move atoms" label.
                model.moveAtomsUndoable(
                    ad.atoms.map((a) => a.idx),
                    ad.atoms.map((a) => a.fromX),
                    ad.atoms.map((a) => a.fromY),
                    ad.atoms.map((a) => a.fromX + dx),
                    ad.atoms.map((a) => a.fromY + dy),
                );
                suppressNextClickRef.current = true;
                if (ad.atoms.length === 1) {
                    setStatus(
                        `moved atom #${ad.grabbedIdx} to ` +
                            `(${grabbedToX.toFixed(2)}, ${grabbedToY.toFixed(2)})`,
                    );
                } else {
                    setStatus(
                        `moved ${ad.atoms.length} atoms by ` +
                            `(${dx.toFixed(2)}, ${dy.toFixed(2)})`,
                    );
                }
                return;
            }
            if (chainDrag) {
                const canvas = canvasRef.current;
                const model = modelRef.current;
                if (!canvas || !model) {
                    setChainDrag(null);
                    return;
                }
                const rect = canvas.getBoundingClientRect();
                const px = e.clientX - rect.left;
                const py = e.clientY - rect.top;
                const { x: endX, y: endY } = modelFromPixel(
                    canvas, viewRef.current, px, py,
                );
                const coords = computeChainAtomCoords(
                    chainDrag.startX, chainDrag.startY, endX, endY,
                );
                // When anchored to an existing atom, drop coords[0] (it
                // coincides with the existing atom) and let addAtomChain
                // bond the first new atom to it.
                const startIdx = chainDrag.startAtomIdx;
                const slice = startIdx >= 0 ? coords.slice(1) : coords;
                setChainDrag(null);
                if (slice.length === 0) {
                    setStatus('chain: drag farther to add atoms');
                    return;
                }
                const xs = slice.map((c) => c.x);
                const ys = slice.map((c) => c.y);
                model.addAtomChain(xs, ys, startIdx);
                suppressNextClickRef.current = true;
                setStatus(
                    `added chain (${slice.length} atom` +
                        `${slice.length === 1 ? '' : 's'})`,
                );
                return;
            }
            if (!dragShape) return;
            const canvas = canvasRef.current;
            const model = modelRef.current;
            if (!canvas || !model) {
                setDragShape(null);
                return;
            }
            const { x1, y1, x2, y2 } = dragShapeBounds(dragShape);
            const w = x2 - x1;
            const h = y2 - y1;
            const isRealDrag = w > 3 && h > 3;
            setDragShape(null);
            if (!isRealDrag) {
                // Treat a tiny drag as a click — let onClick handle it.
                return;
            }
            // Suppress the click event that React will fire next from this
            // same mouse gesture.
            suppressNextClickRef.current = true;

            let rd: RenderDesc = BLANK_DESC;
            try {
                rd = JSON.parse(model.description()) as RenderDesc;
            } catch {
                rd = BLANK_DESC;
            }
            const isErase = dragShape.mode === 'erase';
            // Erase reuses the rubber-band machinery (per Qt EraseSceneTool
            // extending RectSelectSceneTool). We stage the contained items
            // into the selection set and then call deleteSelected so the
            // whole drag is one undo step. Preserve any pre-existing
            // selection by snapshotting it first.
            let priorAtomSel: number[] = [];
            let priorBondSel: number[] = [];
            if (isErase) {
                for (let i = 0; i < rd.atoms.length; ++i) {
                    if (model.isAtomSelected(i)) priorAtomSel.push(i);
                }
                for (let i = 0; i < rd.bonds.length; ++i) {
                    if (model.isBondSelected(i)) priorBondSel.push(i);
                }
                model.clearSelection();
            } else if (!dragShape.additive) {
                model.clearSelection();
            }
            let nSelected = 0;
            for (const a of rd.atoms) {
                const { px, py } = pixelFromModel(canvas, viewRef.current, a.x, a.y);
                if (pointInDragShape(dragShape, px, py)) {
                    if (!model.isAtomSelected(a.i)) {
                        model.setAtomSelected(a.i, true);
                    }
                    ++nSelected;
                }
            }
            // Bonds by MIDPOINT (Qt getCollidingItemsUsingBondMidpoints —
            // identical convention for rect / lasso / ellipse). Replaces the
            // older "both endpoints inside" rule which diverged from Qt.
            let nBondsSelected = 0;
            for (let i = 0; i < rd.bonds.length; ++i) {
                const b = rd.bonds[i];
                const ax = rd.atoms[b.a].x;
                const ay = rd.atoms[b.a].y;
                const bx = rd.atoms[b.b].x;
                const by = rd.atoms[b.b].y;
                const mid = pixelFromModel(
                    canvas, viewRef.current, (ax + bx) / 2, (ay + by) / 2,
                );
                if (pointInDragShape(dragShape, mid.px, mid.py)) {
                    if (!model.isBondSelected(i)) {
                        model.setBondSelected(i, true);
                    }
                    ++nBondsSelected;
                }
            }
            const shapeName =
                dragShape.kind === 'rect' ? 'rectangle'
                : dragShape.kind === 'lasso' ? 'lasso'
                : 'ellipse';
            if (isErase) {
                if (nSelected + nBondsSelected === 0) {
                    // Nothing in the shape — restore the prior selection so
                    // an empty drag doesn't silently nuke it.
                    for (const i of priorAtomSel) model.setAtomSelected(i, true);
                    for (const i of priorBondSel) model.setBondSelected(i, true);
                    setStatus(`erase: ${shapeName} was empty`);
                } else {
                    model.deleteSelected();
                    setStatus(
                        `erased ${nSelected} atom${nSelected === 1 ? '' : 's'}` +
                            ` and ${nBondsSelected} bond` +
                            `${nBondsSelected === 1 ? '' : 's'}`,
                    );
                }
            } else {
                setStatus(
                    `${shapeName}: ${nSelected} atom${nSelected === 1 ? '' : 's'}, ` +
                        `${nBondsSelected} bond${nBondsSelected === 1 ? '' : 's'}` +
                        (dragShape.additive ? ' (added)' : ''),
                );
            }
            void e; // silence unused-param lint without changing the signature
        },
        [dragShape, chainDrag],
    );

    const onCanvasMouseLeave = useCallback((): void => {
        setHoverAtom(null);
        // Don't commit a drag-select that left the canvas — just cancel it.
        if (dragShape) {
            setDragShape(null);
        }
        // Cancel a rotate-drag that left the canvas: restore every dragged
        // atom's original position so the preview doesn't leave the
        // structure half-rotated.
        const rd_rot = rotateDragRef.current;
        if (rd_rot) {
            rotateDragRef.current = null;
            if (rd_rot.moved) {
                const m = modelRef.current;
                if (m) {
                    for (const a of rd_rot.atoms) {
                        m.setAtomPos(a.idx, a.fromX, a.fromY);
                    }
                }
                setStatus(`rotation cancelled (${rd_rot.atoms.length} atoms)`);
            }
        }
        // Cancel an atom-drag that left the canvas: restore every dragged
        // atom's original position so the preview doesn't leave anything
        // stranded. Works for single- and multi-atom drags alike.
        const ad = atomDragRef.current;
        if (ad) {
            atomDragRef.current = null;
            if (ad.moved) {
                const m = modelRef.current;
                if (m) {
                    for (const a of ad.atoms) {
                        m.setAtomPos(a.idx, a.fromX, a.fromY);
                    }
                }
                setStatus(
                    ad.atoms.length === 1
                        ? `move cancelled (atom #${ad.grabbedIdx})`
                        : `move cancelled (${ad.atoms.length} atoms)`,
                );
            }
        }
        // Cancel an in-flight chain-draw — chain is purely a preview until
        // mouseUp, so cancellation just drops the hint.
        if (chainDrag) {
            setChainDrag(null);
            setStatus('chain cancelled');
        }
    }, [dragShape, chainDrag]);

    // Right-click on the canvas — Qt's SketcherView::contextMenuEvent
    // (molviewer/sketcher_view.cpp) dispatches to one of:
    //   SelectionContextMenu (if hit-test hit a selected item)
    //   AtomContextMenu / BondContextMenu / etc. (if hit-test hit a single
    //     unselected item)
    //   BackgroundContextMenu (else)
    // The React port currently implements: selection → SelectionContext;
    // hits a bond (no selection) → BondContext; else → BackgroundContext.
    // Atom right-click is a follow-up — selection-context still works for
    // the "select-then-act" path.
    const onCanvasContextMenu = useCallback(
        (e: ReactMouseEvent<HTMLCanvasElement>): void => {
            e.preventDefault();
            const m = modelRef.current;
            const canvas = canvasRef.current;
            // Snapshot scene state once — used by all menu paths.
            let sceneEmpty = true;
            let selAtoms = 0;
            let selBonds = 0;
            let rd: RenderDesc = BLANK_DESC;
            if (m) {
                try {
                    rd = JSON.parse(m.description()) as RenderDesc;
                    if (rd.atoms.length > 0) sceneEmpty = false;
                    if (rd.nonMol && rd.nonMol.length > 0) sceneEmpty = false;
                    for (const a of rd.atoms) if (a.sel) selAtoms++;
                    for (const b of rd.bonds) if (b.sel) selBonds++;
                } catch {
                    // empty description → keep defaults
                }
            }
            // Selection menu wins over per-item menus — matches Qt's
            // dispatch: a right-click anywhere while a selection is active
            // operates on the selection.
            if (selAtoms > 0 || selBonds > 0) {
                // Snapshot the selected atom indices + whether any of them
                // still carry implicit Hs (mirrors Qt's
                // has_any_implicit_Hs(element_atoms) check in
                // ModifyAtomsMenu::updateActions). The Add/Remove Explicit
                // Hydrogens label flips based on this snapshot.
                const selAtomIndices: number[] = [];
                let selHasImplicitH = false;
                // Radical clamps for the selection ± Unpaired Electrons
                // entries — gated to [0, 4] (Qt MIN/MAX_UNPAIRED_E,
                // molviewer/constants.h:41-42). When the selection is
                // empty, both default to 0 so the entry hides.
                let selMinRadical = Number.POSITIVE_INFINITY;
                let selMaxRadical = 0;
                for (const a of rd.atoms) {
                    if (a.sel) {
                        selAtomIndices.push(a.i);
                        if ((a.nh ?? 0) > 0) selHasImplicitH = true;
                        const n = a.nrad ?? 0;
                        if (n < selMinRadical) selMinRadical = n;
                        if (n > selMaxRadical) selMaxRadical = n;
                    }
                }
                if (selAtomIndices.length === 0) {
                    selMinRadical = 0;
                }
                setSelContextMenu({
                    x: e.clientX,
                    y: e.clientY,
                    nAtoms: selAtoms,
                    nBonds: selBonds,
                    selAtomIndices,
                    selHasImplicitH,
                    selMinRadical,
                    selMaxRadical,
                });
                setBgContextMenu(null);
                setBondContextMenu(null);
                setAtomContextMenu(null);
                setApContextMenu(null);
                return;
            }
            // Item hit-tests run in Qt's per-item z-order: atoms before
            // bonds (a click landing inside an atom's hit-radius hits the
            // atom even when a bond passes through). Both need the canvas
            // to compute pixel coords relative to the viewport.
            if (canvas && rd.atoms.length > 0) {
                const rect = canvas.getBoundingClientRect();
                const px = e.clientX - rect.left;
                const py = e.clientY - rect.top;
                const atomIdx = nearestAtomIndex(
                    canvas, viewRef.current, rd.atoms, px, py,
                );
                if (atomIdx >= 0) {
                    const ad = rd.atoms.find((a) => a.i === atomIdx);
                    if (ad) {
                        // Attachment-point dummies get Qt's dedicated tiny
                        // menu (just Delete), not the generic atom menu —
                        // matches AttachmentPointContextMenu in
                        // menu/attachment_point_context_menu.cpp:11.
                        if (typeof ad.ap === 'number') {
                            setApContextMenu({
                                x: e.clientX,
                                y: e.clientY,
                                atomIdx,
                            });
                            setBgContextMenu(null);
                            setSelContextMenu(null);
                            setBondContextMenu(null);
                            setAtomContextMenu(null);
                            return;
                        }
                        setAtomContextMenu({
                            x: e.clientX,
                            y: e.clientY,
                            atomIdx,
                            el: ad.el,
                            q: ad.q ?? 0,
                            nh: ad.nh ?? 0,
                            nrad: ad.nrad ?? 0,
                            isRGroupOrAp:
                                typeof ad.rlabel === 'number'
                                || typeof ad.ap === 'number'
                                // Wildcard query atoms are non-element atoms
                                // too — Qt's element_atoms filter excludes
                                // hasQuery(), so element / charge / H / radical
                                // edits are disabled on them just like R-groups.
                                || typeof ad.qlabel === 'string',
                            existingRGroups:
                                existingRGroupNumbers(rd.atoms),
                            nextRGroup: nextRGroupNumber(
                                existingRGroupNumbers(rd.atoms)),
                        });
                        setBgContextMenu(null);
                        setSelContextMenu(null);
                        setBondContextMenu(null);
                        setApContextMenu(null);
                        return;
                    }
                }
            }
            if (canvas && rd.bonds.length > 0) {
                const rect = canvas.getBoundingClientRect();
                const px = e.clientX - rect.left;
                const py = e.clientY - rect.top;
                const bondIdx = nearestBondIndex(
                    canvas, viewRef.current, rd, px, py,
                );
                if (bondIdx >= 0) {
                    const bd = rd.bonds[bondIdx];
                    setBondContextMenu({
                        x: e.clientX,
                        y: e.clientY,
                        bondIdx,
                        a: bd.a,
                        b: bd.b,
                        type: bd.o,
                        dir: bd.dir ?? 0,
                        bt: bd.bt,
                        inRing: bondIsInRing(rd.bonds, bd.a, bd.b),
                        qlabel: bd.qlabel,
                        topo: bd.topo,
                    });
                    setBgContextMenu(null);
                    setSelContextMenu(null);
                    setAtomContextMenu(null);
                    setApContextMenu(null);
                    return;
                }
            }
            // No item hit → background context menu.
            setBgContextMenu({ x: e.clientX, y: e.clientY, sceneEmpty });
            setSelContextMenu(null);
            setBondContextMenu(null);
            setAtomContextMenu(null);
            setApContextMenu(null);
        },
        [],
    );

    const doUndo = (): void => {
        modelRef.current?.undo();
        setPendingBondAtom(null);
        setStatus('undo');
    };
    const doRedo = (): void => {
        modelRef.current?.redo();
        setPendingBondAtom(null);
        setStatus('redo');
    };
    const doClear = (): void => {
        modelRef.current?.clear();
        setPendingBondAtom(null);
        setStatus('cleared');
    };
    const doSelectAll = (): void => {
        const model = modelRef.current;
        if (!model) return;
        model.selectAll();
        setStatus('selected all');
    };
    const doDeleteSelected = (): void => {
        const model = modelRef.current;
        if (!model) return;
        if (!model.hasSelection()) {
            setStatus('nothing selected to delete');
            return;
        }
        model.deleteSelected();
        setPendingBondAtom(null);
        setStatus('deleted selection');
    };
    // Picking a bond-mode button (Single, Double, Triple, Wedge, Dash) does
    // two things, mirroring Qt's bond_group radio behavior:
    //   1. Switch the active draw mode so the next bond uses (order, dir).
    //   2. If the user has bonds selected, apply (order, dir) to those bonds
    //      as a one-step undoable mutation — equivalent to Qt's "click a bond
    //      type while bonds are selected re-types those bonds" behavior.
    const pickBondModeApplying = (mode: BondMode, label: string): void => {
        const model = modelRef.current;
        const { dir } = bondModeToOrderAndDir(mode);
        if (model && model.hasSelection()) {
            // setBondDirForSelectedBonds handles wedge/dash; an order edit on
            // selected bonds isn't in the current embind surface, so for now
            // we only mirror the stereo half on selection. Order picks just
            // switch the draw mode.
            if (dir !== BOND_DIR_NONE || mode === 'single') {
                model.setBondDirForSelectedBonds(dir);
            }
        }
        pickBondMode(mode);
        setStatus(`bond mode: ${label}`);
    };
    const writeToClipboard = async (
        text: string,
        kind: string,
    ): Promise<void> => {
        try {
            await navigator.clipboard.writeText(text);
            // Status carries kind + short preview (full text would overflow).
            const preview = text.length > 80 ? text.slice(0, 77) + '...' : text;
            setStatus(`copied ${kind}: ${preview}`);
        } catch {
            // Clipboard write can fail in non-secure contexts / headless
            // browsers without permission. Surface the failure so the user
            // can fall back to Export → Save Image / Import → Paste in Text.
            setStatus(`copy ${kind} failed — clipboard access denied`);
        }
    };
    // Generic Copy As handler — routes through `MolModel.toFormatString`.
    // Mirrors Qt's CutCopyActionManager::copy semantics (cut_copy_action_manager
    // .cpp:131-135): when a selection exists, export just the selection;
    // otherwise export the whole mol. Status reports the user-visible label so
    // it matches the menu item the user just clicked.
    const doCopyAs = async (
        formatName: string,
        label: string,
    ): Promise<void> => {
        const model = modelRef.current;
        if (!model) return;
        const selectionOnly = model.hasSelection();
        const text = model.toFormatString(formatName, selectionOnly);
        if (!text) {
            setStatus('nothing to copy — sketch something first');
            return;
        }
        await writeToClipboard(text, label);
    };
    const doCopyMolBlockV3000 = async (): Promise<void> => {
        // Qt's CutCopyActionManager default format is MDL_MOLV3000
        // (cut_copy_action_manager.cpp:16), so Ctrl+C maps here.
        await doCopyAs('mdl_molv3000', 'MOL V3000');
    };
    const doPaste = async (): Promise<void> => {
        // Qt's sketcher_widget.cpp:676 routes clipboard text through
        // addTextToMolModel with AUTO_DETECT — the same flat list
        // loadFromText already handles. Single undo step (the paste).
        const model = modelRef.current;
        if (!model) return;
        let text: string;
        try {
            text = await navigator.clipboard.readText();
        } catch {
            setStatus('paste failed — clipboard access denied');
            return;
        }
        if (!text.trim()) {
            setStatus('clipboard is empty');
            return;
        }
        try {
            model.loadFromText(text);
            setPendingBondAtom(null);
            const kind = text.includes('\n') ||
                text.includes('V2000') ||
                text.includes('V3000')
                ? 'MOL'
                : 'SMILES';
            setStatus(`pasted ${kind} (${model.numAtoms()} atoms)`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setStatus(`paste failed: ${msg || 'unrecognized format'}`);
        }
    };
    const doCut = async (): Promise<void> => {
        // Qt's CutCopyActionManager (cut_copy_action_manager.cpp:131-135)
        // does copy(SELECTION) followed by removeSelected on the model. The
        // copy uses MDL_MOLV3000 by default. Selection auto-extends to bond
        // endpoints inside the selection-aware exporter.
        const model = modelRef.current;
        if (!model) return;
        if (!model.hasSelection()) {
            setStatus('nothing to cut — select something first');
            return;
        }
        const mb = model.toFormatString('mdl_molv3000', /*selectionOnly=*/true);
        if (!mb) {
            setStatus('nothing to cut — select something first');
            return;
        }
        await writeToClipboard(mb, 'MOL V3000');
        model.deleteSelected();
        setPendingBondAtom(null);
    };

    // Import-from-File: programmatically open the hidden <input type=file>
    // and pipe the chosen file's text through loadFromText. Qt opens a
    // QFileDialog::getOpenFileContent with format filters built from
    // get_import_formats (widget/sketcher_top_bar.cpp:248-254); we accept
    // the same flat list and let rdkit_extensions AUTO_DETECT figure it out.
    const triggerFileImport = (): void => {
        setImportMenuOpen(false);
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
            fileInputRef.current.click();
        }
    };
    const onImportFile = async (
        e: ChangeEvent<HTMLInputElement>,
    ): Promise<void> => {
        const file = e.target.files?.[0];
        if (!file) return;
        const model = modelRef.current;
        if (!model) return;
        try {
            const text = await file.text();
            if (replaceCurrentContent) {
                model.loadFromText(text);
            } else {
                model.addMolFromText(text);
            }
            setPendingBondAtom(null);
            const verb = replaceCurrentContent ? 'imported' : 'appended';
            setStatus(`${verb} ${file.name} (${model.numAtoms()} atoms)`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setStatus(`import failed: ${msg || 'unrecognized format'}`);
        }
    };
    const openPasteModal = (): void => {
        setImportMenuOpen(false);
        setPasteText('');
        setPasteModalOpen(true);
    };
    const submitPasteModal = (): void => {
        const model = modelRef.current;
        if (!model) return;
        if (!pasteText.trim()) {
            setStatus('paste some text first');
            return;
        }
        try {
            if (replaceCurrentContent) {
                model.loadFromText(pasteText);
            } else {
                model.addMolFromText(pasteText);
            }
            setPendingBondAtom(null);
            const kind = pasteText.includes('\n') ||
                pasteText.includes('V2000') ||
                pasteText.includes('V3000')
                ? 'MOL'
                : 'SMILES';
            const verb = replaceCurrentContent ? 'loaded' : 'appended';
            setStatus(`${verb} ${kind} (${model.numAtoms()} atoms)`);
            setPasteModalOpen(false);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setStatus(`load failed: ${msg || 'unrecognized format'}`);
        }
    };

    const openExportModal = (): void => {
        setExportMenuOpen(false);
        setExportModalOpen(true);
    };
    const computeExport = useCallback((fmt: ExportFormat): string => {
        const model = modelRef.current;
        if (!model || model.numAtoms() === 0) return '';
        if (fmt === 'smiles') return model.toSmiles();
        return model.toMolBlock(fmt === 'mol-v3000');
    }, []);
    const doExportCopy = async (): Promise<void> => {
        const text = computeExport(exportFormat);
        if (!text) {
            setStatus('nothing to export — sketch something first');
            return;
        }
        const label = EXPORT_FORMAT_CHOICES
            .find((c) => c.value === exportFormat)?.label ?? exportFormat;
        try {
            await navigator.clipboard.writeText(text);
            setStatus(`copied ${label} to clipboard`);
        } catch {
            setStatus(`${label} ready — copy manually from the text area`);
        }
    };
    const doExportDownload = (): void => {
        const text = computeExport(exportFormat);
        if (!text) {
            setStatus('nothing to export — sketch something first');
            return;
        }
        const choice = EXPORT_FORMAT_CHOICES
            .find((c) => c.value === exportFormat);
        const ext = choice?.ext ?? 'txt';
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `sketch.${ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setStatus(`downloaded sketch.${ext}`);
    };

    const openImageModal = (): void => {
        setExportMenuOpen(false);
        setImageModalOpen(true);
    };

    // Help menu actions — mirror HelpMenu's three QActions
    // (menu/sketcher_top_bar_menus.cpp:130-151).
    const openHelpDocs = (): void => {
        setHelpMenuOpen(false);
        // Qt uses QDesktopServices::openUrl; the browser equivalent is
        // window.open with a new tab + noopener for safety.
        window.open(HELP_DOCS_URL, '_blank', 'noopener,noreferrer');
        setStatus('opened docs in a new tab');
    };
    const openWelcomeModal = (): void => {
        setHelpMenuOpen(false);
        setWelcomeModalOpen(true);
    };
    const openAboutModal = (): void => {
        setHelpMenuOpen(false);
        setAboutModalOpen(true);
    };
    // Render the current sketch into a fresh offscreen canvas at (w, h) and
    // download as PNG. Mirrors Qt's FileSaveImageDialog → get_image_bytes
    // path, which re-renders the scene at the requested size rather than
    // scaling a snapshot of the main canvas (so PNG output is crisp at any
    // size). Transparent=true skips the background fill; otherwise a white
    // background is composited behind the strokes.
    const doSaveImage = (): void => {
        const model = modelRef.current;
        if (!model) return;
        const w = Math.max(IMAGE_SIZE_MIN,
            Math.min(IMAGE_SIZE_MAX, Math.round(imageWidth)));
        const h = Math.max(IMAGE_SIZE_MIN,
            Math.min(IMAGE_SIZE_MAX, Math.round(imageHeight)));
        let rd: RenderDesc = BLANK_DESC;
        try {
            rd = JSON.parse(model.description()) as RenderDesc;
        } catch {
            rd = BLANK_DESC;
        }
        const nonMol = rd.nonMol ?? [];
        // "Nothing to save" = no atoms AND no non-mol objects. A pure
        // reaction scheme (arrow + pluses, no atoms) is exportable now —
        // bbox math below seeds from non-mol coords when there are no
        // atoms. Each non-mol shape contributes its drawing extent so
        // the chevrons / plus arms don't get clipped at the bbox edge.
        if (rd.atoms.length === 0 && nonMol.length === 0) {
            setStatus('nothing to save — sketch something first');
            return;
        }
        // Compute a fit-to-bbox view for the offscreen canvas — same math
        // as doFit but parameterized by (w, h) instead of the live canvas.
        // Seed the bbox from whichever the model has (atoms or non-mol);
        // both are then folded in so reaction schemes get the right frame.
        const seed = rd.atoms.length > 0
            ? { x: rd.atoms[0].x, y: rd.atoms[0].y }
            : { x: nonMol[0].x, y: nonMol[0].y };
        let minX = seed.x;
        let maxX = seed.x;
        let minY = seed.y;
        let maxY = seed.y;
        for (const a of rd.atoms) {
            if (a.x < minX) minX = a.x;
            if (a.x > maxX) maxX = a.x;
            if (a.y < minY) minY = a.y;
            if (a.y > maxY) maxY = a.y;
        }
        // Non-mol extents in model units: an arrow spans ±half-length
        // horizontally and ±tip-half-width vertically; a plus is
        // ±half-length both ways. Without these the chevrons / arms
        // would clip at the bbox edge in a tight reaction-only fit.
        const ARROW_HX = RXN_ARROW_LENGTH_MODEL / 2;
        const ARROW_HY = RXN_ARROW_TIP_HALF_WIDTH_MODEL;
        const PLUS_H = RXN_PLUS_HALF_LENGTH_MODEL;
        for (const n of nonMol) {
            const hx = n.type === 'arrow' ? ARROW_HX : PLUS_H;
            const hy = n.type === 'arrow' ? ARROW_HY : PLUS_H;
            if (n.x - hx < minX) minX = n.x - hx;
            if (n.x + hx > maxX) maxX = n.x + hx;
            if (n.y - hy < minY) minY = n.y - hy;
            if (n.y + hy > maxY) maxY = n.y + hy;
        }
        const bboxW = Math.max(maxX - minX, 1e-6);
        const bboxH = Math.max(maxY - minY, 1e-6);
        const marginPx = Math.min(40, Math.floor(Math.min(w, h) * 0.1));
        const usableW = Math.max(w - 2 * marginPx, 1);
        const usableH = Math.max(h - 2 * marginPx, 1);
        // Single-atom (or single non-mol object) → no real bbox; use
        // DEFAULT_SCALE so we don't divide by ~0 and zoom to infinity.
        const fitScale = (rd.atoms.length + nonMol.length) === 1
            ? DEFAULT_SCALE
            : Math.min(usableW / bboxW, usableH / bboxH);
        const scale = Math.min(fitScale, DEFAULT_SCALE * 2);
        const cxModel = (minX + maxX) / 2;
        const cyModel = (minY + maxY) / 2;
        const offView: View = {
            scale,
            offsetX: -cxModel * scale,
            offsetY: cyModel * scale,
        };
        const off = document.createElement('canvas');
        off.width = w;
        off.height = h;
        const choice = IMAGE_FORMAT_CHOICES
            .find((c) => c.value === imageFormat);
        const mime = choice?.mime ?? 'image/png';
        const ext = choice?.ext ?? 'png';
        const bg = imageTransparent ? 'Transparent' : 'White';
        const finishDownload = (blob: Blob | null): void => {
            if (!blob) {
                setStatus('save image failed');
                return;
            }
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `sketch.${ext}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            setStatus(
                `saved sketch.${ext} — ${bg} background, ${w} x ${h} px`,
            );
            setImageModalOpen(false);
        };
        if (imageFormat === 'svg') {
            // SVG path: buildSketchSvg emits the same geometry as
            // drawSketch, just as SVG primitives. Mirrors Qt's
            // QSvgGenerator paint device in image_generation.cpp:358-368.
            const svg = buildSketchSvg(
                off, offView, rd, w, h, displayOptions, !imageTransparent,
            );
            finishDownload(new Blob([svg], { type: mime }));
            return;
        }
        // PNG path: drawSketch clearRects at the start, so anything we
        // fill first would be wiped. Instead let drawSketch paint on
        // transparent, then composite the background behind the strokes
        // for the opaque case.
        drawSketch(off, offView, rd, null, null, null, null, null,
            displayOptions);
        if (!imageTransparent) {
            const ctx = off.getContext('2d');
            if (ctx) {
                ctx.globalCompositeOperation = 'destination-over';
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, w, h);
                ctx.globalCompositeOperation = 'source-over';
            }
        }
        off.toBlob(finishDownload, mime);
    };

    const adjustCharge = (delta: number): void => {
        const model = modelRef.current;
        if (!model) return;
        if (!model.hasSelection()) {
            setStatus('select atoms first to change their charge');
            return;
        }
        model.adjustChargeOnSelectedAtoms(delta);
        setStatus(delta > 0 ? 'charge +1' : 'charge −1');
    };

    // Per-atom charge edit driven by the right-click AtomContextMenu. The
    // lean MolModel doesn't expose a single-atom charge primitive, so we
    // adopt the temp-selection dance: select only the target atom, call
    // the existing selection-based charge primitive, then clear selection.
    // Safe because (a) atom right-click only fires when no selection is
    // present (the dispatch routes to SelectionContextMenu otherwise), and
    // (b) adjustChargeOnSelectedAtoms captures (idx, old_charge) inside
    // its doCommand closure, so undo reverses only this one atom even
    // though the selection state at undo time may differ. The selection
    // mutations are non-undoable so only the charge edit hits the undo
    // stack — single Ctrl+Z unwinds it.
    const adjustChargeOnAtom = (atomIdx: number, delta: number): void => {
        const model = modelRef.current;
        if (!model) return;
        model.clearSelection();
        model.setAtomSelected(atomIdx, true);
        model.adjustChargeOnSelectedAtoms(delta);
        model.clearSelection();
        setStatus(delta > 0 ? 'charge +1' : 'charge −1');
    };

    const doAddHydrogens = (): void => {
        const model = modelRef.current;
        if (!model) return;
        if (model.numAtoms() === 0) {
            setStatus('nothing to expand — sketch something first');
            return;
        }
        const before = model.numAtoms();
        model.addHydrogens();
        const added = model.numAtoms() - before;
        setStatus(added > 0 ? `added ${added} explicit H${added === 1 ? '' : 's'}` : 'all Hs already explicit');
    };

    const doRemoveHydrogens = (): void => {
        const model = modelRef.current;
        if (!model) return;
        if (model.numAtoms() === 0) {
            setStatus('nothing to contract — sketch something first');
            return;
        }
        const before = model.numAtoms();
        model.removeHydrogens();
        const removed = before - model.numAtoms();
        setStatus(removed > 0 ? `removed ${removed} explicit H${removed === 1 ? '' : 's'}` : 'no removable Hs');
    };

    const doAromatize = (): void => {
        const model = modelRef.current;
        if (!model) return;
        if (model.numAtoms() === 0) {
            setStatus('nothing to aromatize — sketch something first');
            return;
        }
        model.aromatize();
        setStatus('aromatized');
    };

    const doKekulize = (): void => {
        const model = modelRef.current;
        if (!model) return;
        if (model.numAtoms() === 0) {
            setStatus('nothing to kekulize — sketch something first');
            return;
        }
        model.kekulize();
        setStatus('kekulized');
    };

    const doCleanUp = (): void => {
        const model = modelRef.current;
        if (!model) return;
        if (model.numAtoms() === 0) {
            setStatus('nothing to clean up — sketch something first');
            return;
        }
        model.cleanUp();
        setStatus('cleaned up layout');
    };

    // Flip applies to the current selection (or the whole mol when nothing is
    // selected — mirrors Qt's "Modify All" Flip Horizontal/Vertical actions).
    const doFlip = (horizontal: boolean, label: string): void => {
        const model = modelRef.current;
        if (!model) return;
        if (model.numAtoms() === 0) {
            setStatus('nothing to flip — sketch something first');
            return;
        }
        model.flipSelectedAtoms(horizontal);
        const scope = model.hasSelection() ? 'selection' : 'all atoms';
        setStatus(`${label} (${scope})`);
    };

    const doFit = (): void => {
        const model = modelRef.current;
        const canvas = canvasRef.current;
        if (!model || !canvas) return;
        if (model.numAtoms() === 0) {
            setView(DEFAULT_VIEW);
            setStatus('view reset (empty sketch)');
            return;
        }
        let rd: RenderDesc = BLANK_DESC;
        try {
            rd = JSON.parse(model.description()) as RenderDesc;
        } catch {
            rd = BLANK_DESC;
        }
        if (rd.atoms.length === 0) {
            setView(DEFAULT_VIEW);
            return;
        }
        let minX = rd.atoms[0].x;
        let maxX = rd.atoms[0].x;
        let minY = rd.atoms[0].y;
        let maxY = rd.atoms[0].y;
        for (const a of rd.atoms) {
            if (a.x < minX) minX = a.x;
            if (a.x > maxX) maxX = a.x;
            if (a.y < minY) minY = a.y;
            if (a.y > maxY) maxY = a.y;
        }
        // Pick a scale so the bbox fits with ~10% margin on each side; leave
        // extra padding on the canvas Y axis for labels (H counts hang below
        // an atom by a few px). Single-atom mol falls back to DEFAULT_SCALE.
        const bboxW = Math.max(maxX - minX, 1e-6);
        const bboxH = Math.max(maxY - minY, 1e-6);
        const marginPx = 40;
        const usableW = Math.max(canvas.width - 2 * marginPx, 1);
        const usableH = Math.max(canvas.height - 2 * marginPx, 1);
        const fitScale =
            rd.atoms.length === 1
                ? DEFAULT_SCALE
                : Math.min(usableW / bboxW, usableH / bboxH);
        // Clamp so single-bond or tiny mols don't blow up past a usable size.
        const scale = Math.min(fitScale, DEFAULT_SCALE * 2);
        // Center the bbox in the canvas. modelFromPixel maps:
        //   canvas_center + offset → bbox center in model space → 0,
        // so offset = scale * bboxCenter (but Y flipped for screen coords).
        const cxModel = (minX + maxX) / 2;
        const cyModel = (minY + maxY) / 2;
        const offsetX = -cxModel * scale;
        const offsetY = cyModel * scale;
        setView({ scale, offsetX, offsetY });
        setStatus(`fit ${rd.atoms.length} atoms to canvas`);
    };

    // Keyboard shortcuts mirror the Qt sketcher. Sources cross-referenced:
    //   - undo/redo/cut/copy/paste/select-all/clear/invert/fit:
    //     menu/sketcher_top_bar_menus.cpp:65-88
    //   - Space + Backspace/Delete: sketcher_widget.cpp:1198-1224
    //   - 0/1/2/3 (bond order), D/T (isotope), single-letter elements,
    //     +/-/= (charge): sketcher_widget.cpp:1238-1308
    //   - arrow-key pan with KEY_SCROLL_BOND_LENGTH_RATIO=0.5:
    //     molviewer/view.cpp:230-251, constants.h:240
    // We listen on window so the user doesn't have to focus the canvas first.
    // Single-letter element shortcuts only cover atoms whose symbol is one
    // character: H/B/C/N/O/F/P/S/K/V/Y/I/W/U in Qt; our React UI only
    // currently exposes C/H/N/O/F/P/S as buttons (Cl/Si are 2-char so
    // unreachable from a single keypress, matching Qt's limitation).
    useEffect(() => {
        function onKey(e: KeyboardEvent): void {
            const model = modelRef.current;
            if (!model) return;
            const target = e.target as HTMLElement | null;
            const tag = target?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) {
                return;
            }
            const mod = e.ctrlKey || e.metaKey;
            const key = e.key;
            const lower = key.toLowerCase();

            // -- Ctrl/Cmd combos first (avoid colliding with letter shortcuts).
            if (mod && !e.shiftKey && lower === 'z') {
                e.preventDefault(); doUndo(); return;
            }
            if (mod && ((e.shiftKey && lower === 'z') || lower === 'y')) {
                e.preventDefault(); doRedo(); return;
            }
            if (mod && lower === 'a') {
                e.preventDefault(); doSelectAll(); return;
            }
            if (mod && lower === 'd') {
                e.preventDefault(); doClearSelection(); return;
            }
            if (mod && lower === 'i') {
                e.preventDefault(); doInvertSelection(); return;
            }
            if (mod && lower === 'f') {
                e.preventDefault(); doFit(); return;
            }
            if (mod && lower === 'c') {
                // Qt's CutCopyActionManager (cut_copy_action_manager.cpp:16)
                // defaults Ctrl+C to MDL_MOLV3000 for atomistic mode. Match.
                e.preventDefault();
                void doCopyMolBlockV3000();
                return;
            }
            if (mod && lower === 'v') {
                // Qt's sketcher_widget.cpp:676 routes paste through
                // addTextToMolModel with AUTO_DETECT.
                e.preventDefault();
                void doPaste();
                return;
            }
            if (mod && lower === 'x') {
                // Qt's CutCopyActionManager (cut_copy_action_manager.cpp:131)
                // does Copy(MOLV3000) + removeSelected. Cut is enabled only
                // when there's a selection (Qt: cut_copy_action_manager.cpp:55).
                e.preventDefault();
                void doCut();
                return;
            }

            // -- Non-mod shortcuts (skip if Ctrl/Cmd/Alt held).
            if (mod || e.altKey) return;

            if (key === 'Delete' || key === 'Backspace') {
                if (model.hasSelection()) {
                    e.preventDefault();
                    doDeleteSelected();
                }
                return;
            }

            // Arrow-key pan (Qt molviewer/view.cpp:230-251). Half a bond
            // length per keypress, in pixel terms = 0.5 * scale.
            if (key === 'ArrowUp' || key === 'ArrowDown' ||
                key === 'ArrowLeft' || key === 'ArrowRight') {
                e.preventDefault();
                const v = viewRef.current;
                const dPx = 0.5 * v.scale;
                let dx = 0, dy = 0;
                if (key === 'ArrowUp') dy = -dPx;
                else if (key === 'ArrowDown') dy = +dPx;
                else if (key === 'ArrowRight') dx = +dPx;
                else dx = -dPx;
                setView({ ...v, offsetX: v.offsetX + dx, offsetY: v.offsetY + dy });
                return;
            }

            // Space → switch to Select tool (only if scene is non-empty,
            // per Qt sketcher_widget.cpp:1217). Use Space not " " because
            // ' ' would scroll the page on some browsers.
            if (key === ' ' || key === 'Spacebar') {
                if (model.numAtoms() > 0) {
                    e.preventDefault();
                    setTool('select');
                    setPendingBondAtom(null);
                    setStatus('select mode');
                }
                return;
            }

            // 0/1/2/3 → bond order (Qt sketcher_widget.cpp:1252-1269).
            if (key === '1') {
                e.preventDefault();
                pickBondMode('single');
                setStatus('bond mode: single');
                return;
            }
            if (key === '2' || key === '3') {
                // Mirror Qt: pressing the order key also swaps which mode
                // the bond_order ModularToolButton displays. So '3' sets
                // the bond-order slot icon to triple AND makes it active.
                e.preventDefault();
                const next: BondMode = key === '2' ? 'double' : 'triple';
                pickBondMode(next);
                setBondOrderMode(next);
                setStatus(`bond mode: ${next}`);
                return;
            }
            if (key === '0') {
                // Qt Key_0 → BondTool::ZERO (sketcher_widget.cpp:1257).
                // Arm zero-order bond mode + swap the bond-order slot to it.
                e.preventDefault();
                pickBondMode('zero');
                setBondOrderMode('zero');
                setStatus('bond mode: zero order');
                return;
            }

            // + / = → adjust charge +1; - → -1. Qt requires a selection
            // OR an atom under the cursor (it can apply on the fly); we
            // only do the selection path here since cursor-targeting
            // would need pointer-tracking state we don't carry yet.
            if (key === '+' || key === '=') {
                if (model.hasSelection()) {
                    e.preventDefault();
                    adjustCharge(+1);
                }
                return;
            }
            if (key === '-') {
                if (model.hasSelection()) {
                    e.preventDefault();
                    adjustCharge(-1);
                }
                return;
            }

            // D / T → mutate selected atoms to deuterium / tritium (Qt
            // sketcher_widget.cpp:1272-1283). Backed by lean MolModel's
            // setSelectedAtomsToHydrogenIsotope. No-op on empty selection;
            // surface a status either way so the user can tell.
            if (lower === 'd' || lower === 't') {
                e.preventDefault();
                const iso = lower === 'd' ? 2 : 3;
                const label = lower === 'd' ? 'Deuterium' : 'Tritium';
                const m = modelRef.current;
                if (!m || !m.hasSelection()) {
                    setStatus(`${label} (D/T): select atoms first`);
                    return;
                }
                m.setSelectedAtomsToHydrogenIsotope(iso);
                setStatus(`mutated selection to ${label} (H, isotope ${iso})`);
                return;
            }

            // Single-letter element shortcuts (Qt sketcher_widget.cpp:1287-1306).
            // Only the elements present in our atom palette and whose symbol
            // is a single character. Cl/Si are excluded since one keypress
            // can't produce two characters.
            const elementMap: Record<string, Element> = {
                c: 'C', h: 'H', n: 'N', o: 'O',
                p: 'P', s: 'S', f: 'F',
            };
            const upcase = lower.toUpperCase() as Element;
            if (elementMap[lower] === upcase) {
                e.preventDefault();
                setTool('atom');
                setElement(elementMap[lower]);
                setStatus(`element: ${elementMap[lower]}`);
                return;
            }
        }
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [setView]);

    // Features whose Qt counterparts exist in the UI files but whose C++ port
    // isn't here yet. Showing the buttons keeps the visual layout matching the
    // Qt original (per feedback_qt_removal_fidelity); clicking surfaces the
    // gap rather than silently doing nothing.
    const comingSoon = (name: string): void => {
        setStatus(`${name} — not yet implemented in the Qt-free port`);
    };

    // Invert selection — Qt's SelectOptionsWidget "Invert" button. No
    // dedicated C++ entry point yet, so do it client-side: get the full atom
    // list and flip each selection bit. Idempotent (no re-entry guard needed
    // since setAtomSelected emits selectionChanged once per call).
    const doInvertSelection = (): void => {
        const model = modelRef.current;
        if (!model) return;
        let rd: RenderDesc = BLANK_DESC;
        try {
            rd = JSON.parse(model.description()) as RenderDesc;
        } catch {
            return;
        }
        for (const a of rd.atoms) {
            model.setAtomSelected(a.i, !a.sel);
        }
        for (let i = 0; i < rd.bonds.length; ++i) {
            const b = rd.bonds[i];
            model.setBondSelected(i, !b.sel);
        }
        setStatus('inverted selection');
    };

    const doClearSelection = (): void => {
        const model = modelRef.current;
        if (!model) return;
        model.clearSelection();
        setStatus('cleared selection');
    };

    // More Actions submenu items — mirror Qt's MoreActionsMenu "Modify All"
    // submenu (sketcher_top_bar_menus.cpp:91-101) using exact Qt labels and
    // separator placement. Flattened into one popover here (not a true
    // nested submenu) as a known minor divergence; tracked in audit memory.
    const moreActions = (
        <div style={styles.moreMenu} data-testid='more-actions-menu'>
            <div style={styles.moreSectionLabel}>Modify All</div>
            <MoreItem label='Flip Horizontal' testid='flip-horizontal'
                onClick={() => { setMoreMenuOpen(false); doFlip(true, 'flipped horizontal'); }} />
            <MoreItem label='Flip Vertical' testid='flip-vertical'
                onClick={() => { setMoreMenuOpen(false); doFlip(false, 'flipped vertical'); }} />
            <div style={styles.moreDivider} />
            <MoreItem label='Aromatize' testid='aromatize'
                onClick={() => { setMoreMenuOpen(false); doAromatize(); }} />
            <MoreItem label='Kekulize' testid='kekulize'
                onClick={() => { setMoreMenuOpen(false); doKekulize(); }} />
            <div style={styles.moreDivider} />
            <MoreItem label='Add Explicit Hydrogens' testid='hydrogens-add'
                onClick={() => { setMoreMenuOpen(false); doAddHydrogens(); }} />
            <MoreItem label='Remove Explicit Hydrogens' testid='hydrogens-remove'
                onClick={() => { setMoreMenuOpen(false); doRemoveHydrogens(); }} />
            <div style={styles.moreDivider} />
            {/* Copy As — Qt's CutCopyActionManager builds this submenu
                dynamically from get_standard_export_formats() (
                file_import_export.cpp:75-90). Order + labels match Qt
                exactly. Qt explicitly forbids MDL_MOLV2000 on export
                because of stereo ambiguities, so V2000 is intentionally
                NOT in this menu (Ctrl+V import still accepts V2000 via
                AUTO_DETECT). Image / reaction formats are deferred. */}
            <div style={styles.moreSectionLabel}>Copy As</div>
            <MoreItem label='MDL SD V3000' testid='copy-as-mol-v3000'
                onClick={() => { setMoreMenuOpen(false); void doCopyAs('mdl_molv3000', 'MOL V3000'); }} />
            <MoreItem label='Maestro' testid='copy-as-maestro'
                onClick={() => { setMoreMenuOpen(false); void doCopyAs('maestro', 'Maestro'); }} />
            <MoreItem label='SMILES' testid='copy-as-smiles'
                onClick={() => { setMoreMenuOpen(false); void doCopyAs('smiles', 'SMILES'); }} />
            <MoreItem label='Extended SMILES' testid='copy-as-extended-smiles'
                onClick={() => { setMoreMenuOpen(false); void doCopyAs('extended_smiles', 'Extended SMILES'); }} />
            <MoreItem label='SMARTS' testid='copy-as-smarts'
                onClick={() => { setMoreMenuOpen(false); void doCopyAs('smarts', 'SMARTS'); }} />
            <MoreItem label='Extended SMARTS' testid='copy-as-extended-smarts'
                onClick={() => { setMoreMenuOpen(false); void doCopyAs('extended_smarts', 'Extended SMARTS'); }} />
            <MoreItem label='InChI' testid='copy-as-inchi'
                onClick={() => { setMoreMenuOpen(false); void doCopyAs('inchi', 'InChI'); }} />
            <MoreItem label='InChIKey' testid='copy-as-inchikey'
                onClick={() => { setMoreMenuOpen(false); void doCopyAs('inchikey', 'InChIKey'); }} />
            <MoreItem label='PDB' testid='copy-as-pdb'
                onClick={() => { setMoreMenuOpen(false); void doCopyAs('pdb', 'PDB'); }} />
            <MoreItem label='XYZ' testid='copy-as-xyz'
                onClick={() => { setMoreMenuOpen(false); void doCopyAs('xyz', 'XYZ'); }} />
            <MoreItem label='Marvin Document' testid='copy-as-mrv'
                onClick={() => { setMoreMenuOpen(false); void doCopyAs('mrv', 'Marvin'); }} />
            {/* Sequence formats — always offered (Qt get_standard_export_formats
                comment: rdkit_extensions::to_string converts atomistic↔monomeric
                on the fly; conversion failures surface as an empty copy). */}
            <MoreItem label='HELM' testid='copy-as-helm'
                onClick={() => { setMoreMenuOpen(false); void doCopyAs('helm', 'HELM'); }} />
            <MoreItem label='FASTA' testid='copy-as-fasta'
                onClick={() => { setMoreMenuOpen(false); void doCopyAs('fasta', 'FASTA'); }} />
        </div>
    );

    return (
        <section style={styles.shell}>
            {/* Top bar — sketcher_top_bar.ui order:
                undo redo fit cleanup more | <spacer> | clear import export | settings help.
                All 32×32 icon buttons (30×32 SVG iconSize, no border,
                checked #d4e6f1, hover #edf7fc — sketcher_css_style.h). */}
            <div style={styles.topBar}>
                <div style={styles.topBarGroup}>
                    <IconButton icon='topbar_undo' onClick={doUndo}
                        testid='undo' title='Undo (Ctrl+Z)' />
                    <IconButton icon='topbar_redo' onClick={doRedo}
                        testid='redo' title='Redo (Ctrl+Y)' />
                    <IconButton icon='topbar_fit' onClick={doFit}
                        testid='fit-to-screen' title='Fit to Screen' />
                    <IconButton icon='topbar_cleanup' onClick={doCleanUp}
                        testid='clean-up' title='Clean Up' />
                    <div ref={moreMenuWrapperRef}
                        style={{ position: 'relative' }}
                        data-testid='more-actions-wrapper'>
                        <IconButton icon='topbar_more_actions'
                            onClick={() => setMoreMenuOpen((v) => !v)}
                            testid='more-actions-btn'
                            title='More Actions'
                            active={moreMenuOpen} />
                        {moreMenuOpen && moreActions}
                    </div>
                </div>
                <div style={styles.topSpacer} />
                <div style={styles.topBarGroup}>
                    <span style={styles.topDivider} />
                    <IconButton icon='topbar_clear_sketcher' onClick={doClear}
                        testid='clear' title='Clear Sketcher' />
                    {/* Import / Export dropdowns mirror Qt's
                        ImportMenu/ExportMenu (menu/sketcher_top_bar_menus.cpp).
                        InstantPopup-style: click opens the menu under the
                        button. */}
                    <div ref={importMenuWrapperRef}
                        style={{ position: 'relative' }}
                        data-testid='import-wrapper'>
                        <IconButton icon='topbar_import'
                            onClick={() => setImportMenuOpen((v) => !v)}
                            testid='import' title='Import'
                            active={importMenuOpen} />
                        {importMenuOpen && (
                            <div style={styles.moreMenu}
                                data-testid='import-menu'>
                                <MoreItem label='Import from File...'
                                    testid='import-from-file'
                                    onClick={triggerFileImport} />
                                <MoreItem label='Paste in Text...'
                                    testid='import-paste-in-text'
                                    onClick={openPasteModal} />
                                <div style={styles.moreDivider} />
                                <ToggleMenuItem
                                    label='Replace Current Content'
                                    testid='import-replace-content'
                                    checked={replaceCurrentContent}
                                    onToggle={() =>
                                        setReplaceCurrentContent((v) => !v)} />
                            </div>
                        )}
                    </div>
                    <div ref={exportMenuWrapperRef}
                        style={{ position: 'relative' }}
                        data-testid='export-wrapper'>
                        <IconButton icon='topbar_export'
                            onClick={() => setExportMenuOpen((v) => !v)}
                            testid='export' title='Export'
                            active={exportMenuOpen} />
                        {exportMenuOpen && (
                            <div style={styles.moreMenu}
                                data-testid='export-menu'>
                                {/* Save Image opens the width/height/
                                    transparent-bg dialog. Mirrors Qt's
                                    FileSaveImageDialog. PNG only for now;
                                    SVG would need a vector renderer. */}
                                <MoreItem label='Save Image...'
                                    testid='export-save-image'
                                    onClick={openImageModal} />
                                <MoreItem label='Export to File...'
                                    testid='export-to-file'
                                    onClick={openExportModal} />
                            </div>
                        )}
                    </div>
                    <input
                        ref={fileInputRef}
                        type='file'
                        accept='.mol,.sdf,.smi,.smiles,.smarts,.mol2,.pdb,.xyz,.mrv,.cdxml,.inchi,.txt'
                        style={{ display: 'none' }}
                        data-testid='import-file-input'
                        onChange={(e) => { void onImportFile(e); }}
                    />
                    <span style={styles.topDivider} />
                    {/* Configure View dropdown — Qt's ConfigureViewMenu
                        (menu/sketcher_top_bar_menus.cpp:109-128). Same
                        InstantPopup pattern as Import/Export. The gear
                        icon (topbar_settings) was already the
                        ConfigureView trigger in Qt
                        (ui/sketcher_top_bar.ui:250). */}
                    <div ref={configureViewWrapperRef}
                        style={{ position: 'relative' }}
                        data-testid='configure-view-wrapper'>
                        <IconButton icon='topbar_settings'
                            onClick={() => setConfigureViewOpen((v) => !v)}
                            testid='settings' title='Configure View'
                            active={configureViewOpen} />
                        {configureViewOpen && (
                            <div style={styles.moreMenu}
                                data-testid='configure-view-menu'>
                                <ToggleMenuItem
                                    label='Valence Errors'
                                    testid='view-valence-errors'
                                    checked={displayOptions.showValenceErrors}
                                    onToggle={() =>
                                        toggleDisplayOption('showValenceErrors')
                                    } />
                                <ToggleMenuItem
                                    label='Heteroatom Colors'
                                    testid='view-color-heteroatoms'
                                    checked={displayOptions.colorHeteroatoms}
                                    onToggle={() =>
                                        toggleDisplayOption('colorHeteroatoms')
                                    } />
                                <ToggleMenuItem
                                    label='Stereo Labels'
                                    testid='view-stereo-labels'
                                    checked={displayOptions.showStereoLabels}
                                    onToggle={() =>
                                        toggleDisplayOption('showStereoLabels')
                                    } />
                                <ToggleMenuItem
                                    label='Implicit Hydrogens'
                                    testid='view-implicit-hydrogens'
                                    checked={
                                        displayOptions.useImplicitHydrogens
                                    }
                                    onToggle={() =>
                                        toggleDisplayOption(
                                            'useImplicitHydrogens',
                                        )
                                    } />
                                <div style={styles.moreDivider} />
                                {/* "Preferences..." opens Qt's
                                    RenderingSettingsDialog ("2D Settings").
                                    Toggles in this submenu (Color
                                    Heteroatoms / Stereo Labels) and the
                                    Preferences modal share the same
                                    `displayOptions` state, matching Qt
                                    where both surfaces write the same
                                    SketcherModel keys. */}
                                <MoreItem label='Preferences...'
                                    testid='view-preferences'
                                    onClick={() => {
                                        setConfigureViewOpen(false);
                                        setPreferencesOpen(true);
                                    }} />
                            </div>
                        )}
                    </div>
                    {/* Help dropdown — Qt's HelpMenu (menu/
                        sketcher_top_bar_menus.cpp:130-151). Same
                        InstantPopup pattern as Import/Export/Configure
                        View. */}
                    <div ref={helpMenuWrapperRef}
                        style={{ position: 'relative' }}
                        data-testid='help-wrapper'>
                        <IconButton icon='topbar_help'
                            onClick={() => setHelpMenuOpen((v) => !v)}
                            testid='help' title='Help'
                            active={helpMenuOpen} />
                        {helpMenuOpen && (
                            <div style={styles.moreMenu}
                                data-testid='help-menu'>
                                <MoreItem label='Help...'
                                    testid='help-docs'
                                    onClick={openHelpDocs} />
                                <MoreItem label='Getting Started...'
                                    testid='help-welcome'
                                    onClick={openWelcomeModal} />
                                <MoreItem label='About Sketcher...'
                                    testid='help-about'
                                    onClick={openAboutModal} />
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <div style={styles.workspace}>
                {/* Left sidebar — sketcher_side_bar.ui, 117px wide.
                    Top-to-bottom: SELECT block, hr, DRAW label + atomistic/
                    monomeric toggle, atomistic_page (SetAtomWidget grid +
                    H/charge row, hr, bond_frame 2×3, hr, RingToolWidget 3×3,
                    hr, EnumerationToolWidget). */}
                <aside style={styles.sidebar}>
                    {/* SELECT — select_options_widget.ui. Background tints
                        sage (#f3f6f0 SELECTION_ACTIVE_STYLE) when the
                        Select tool is active. */}
                    <div style={{
                        ...styles.selectSection,
                        ...(tool === 'select' || tool === 'move-rotate'
                            || tool === 'erase'
                            ? styles.selectSectionActive
                            : {}),
                    }}>
                        <div style={styles.sectionLabel}>SELECT</div>
                        <div style={styles.row3}>
                            <IconButtonWithPopup<SelectShape>
                                icon={SELECT_SHAPE_ICON[selectShape]}
                                testid='tool-select'
                                title={`${SELECT_SHAPE_TITLE[selectShape]} (Ctrl=toggle, Shift=add) – press & hold to change shape`}
                                active={tool === 'select'}
                                choices={SELECT_SHAPE_CHOICES}
                                onClick={() => {
                                    setTool('select');
                                    setPendingBondAtom(null);
                                    setStatus(
                                        `${SELECT_SHAPE_TITLE[selectShape].toLowerCase()} mode`,
                                    );
                                }}
                                onPick={(v) => pickSelectShape(v)}
                            />
                            <IconButton icon='select_move_rotate'
                                testid='tool-move-rotate'
                                title='Move and Rotate (drag from inside selection)'
                                active={tool === 'move-rotate'}
                                onClick={() => {
                                    setTool('move-rotate');
                                    setPendingBondAtom(null);
                                    setStatus('move/rotate mode');
                                }} />
                            <IconButton icon='mode_erase'
                                testid='tool-erase'
                                title='Erase — click to remove an atom or bond, drag to erase a region'
                                active={tool === 'erase'}
                                onClick={() => {
                                    setTool('erase');
                                    setPendingBondAtom(null);
                                    setStatus('erase mode');
                                }} />
                        </div>
                        <div style={styles.row3}>
                            <TextLinkButton label='All' testid='select-all'
                                title='Select All (Ctrl+A)'
                                onClick={doSelectAll} />
                            <TextLinkButton label='Invert' testid='select-invert'
                                title='Invert Selection'
                                onClick={doInvertSelection} />
                            <TextLinkButton label='None' testid='select-none'
                                title='Clear Selection'
                                onClick={doClearSelection} />
                        </div>
                    </div>

                    <hr style={styles.hr} />

                    {/* DRAW label + atomistic/monomeric toggle. Mirrors Qt's
                        sketcher_side_bar.cpp:55-188 — picking one button
                        flips `atomistic_or_monomeric_stack` to the matching
                        page. Monomeric draw tools themselves are still
                        stubbed; flipping pages just swaps which widget
                        column the user sees. */}
                    <div style={styles.sectionLabel}>DRAW</div>
                    <div style={styles.row2}>
                        <IconButton icon='mode_compound'
                            testid='mode-atomistic'
                            title='Atomistic'
                            active={mode === 'atomistic'}
                            onClick={() => {
                                if (mode === 'atomistic') return;
                                setMode('atomistic');
                                setPendingBondAtom(null);
                                setStatus('atomistic mode');
                            }} />
                        <IconButton icon='mode_monomer'
                            testid='mode-monomeric'
                            title='Monomeric'
                            active={mode === 'monomeric'}
                            onClick={() => {
                                if (mode === 'monomeric') return;
                                setMode('monomeric');
                                setPendingBondAtom(null);
                                setStatus('monomeric mode (draw tools coming soon)');
                            }} />
                    </div>

                    {mode === 'atomistic' && (<>
                    {/* SetAtomWidget — 3 cols, 4 rows. Qt order:
                        row 0 C H N, row 1 O P S, row 2 F Cl <last_picked>,
                        row 3 atom_query (1 col) + periodic_table (2 cols).
                        The last_picked slot defaults to Si (Qt
                        set_atom_widget.cpp:27) and updates whenever the
                        periodic-table popup picks something outside the
                        fixed 8. */}
                    <div style={styles.elementGrid}>
                        {FIXED_ELEMENTS.map((el) => (
                            <LetterButton key={el} label={el}
                                color={ELEMENT_COLORS[el]}
                                active={tool === 'atom' && element === el}
                                testid={`element-${el}`}
                                title={`Draw ${el} atoms`}
                                onClick={() => pickElement(el)} />
                        ))}
                        <LetterButton label={lastPickedElement}
                            color={ELEMENT_COLORS[lastPickedElement]}
                            active={tool === 'atom' && element === lastPickedElement}
                            testid='last-picked-element'
                            title={`Draw ${lastPickedElement} atoms (last picked from periodic table)`}
                            onClick={() => pickElement(lastPickedElement)} />
                    </div>
                    <div style={styles.atomQueryRow}>
                        <IconButtonWithPopup<AtomQueryChoice>
                            icon=''
                            label={`${atomQueryMode}▾`}
                            testid='atom-query'
                            title='Atom Query – press & hold to change'
                            active={tool === 'atom-query'}
                            choices={ATOM_QUERY_CHOICES}
                            onClick={() => {
                                setTool('atom-query');
                                setPendingBondAtom(null);
                            }}
                            onPick={(q) => {
                                setAtomQueryMode(q);
                                setTool('atom-query');
                                setPendingBondAtom(null);
                            }}
                        />
                        <PeriodicTableButton testid='periodic-table'
                            onPick={pickElement} />
                    </div>

                    {/* explicit_h / charge± row */}
                    <div style={styles.row3}>
                        <IconButton icon='atom_explicit_H'
                            testid='explicit-h'
                            title='Add Explicit Hydrogens'
                            onClick={doAddHydrogens} />
                        <IconButton icon='atom_charge_plus'
                            testid='charge-plus'
                            title='Increase charge on selected atoms'
                            onClick={() => adjustCharge(+1)} />
                        <IconButton icon='atom_charge_minus'
                            testid='charge-minus'
                            title='Decrease charge on selected atoms'
                            onClick={() => adjustCharge(-1)} />
                    </div>

                    <hr style={styles.hr} />

                    {/* bond_frame 2×3 — draw_tools_widget.ui:
                        row 0: single, stereo_bond1 (default Up), stereo_bond2
                        (default Down) — both are ModularToolButtons with the
                        4-item StereoBondPopup.
                        row 1: bond_order (ModularToolButton, default Double,
                        popup adds Triple), bond_query (popup, deferred),
                        atom_chain (deferred). All in one bond_group radio (Qt). */}
                    <div style={styles.bondGrid}>
                        <IconButton icon='bond_single' testid='bond-single'
                            title='Single Bond'
                            active={tool === 'bond' && bondMode === 'single'}
                            onClick={() => pickBondModeApplying('single', 'single')} />
                        {/* testid stays bond-wedge / bond-dash / bond-double
                            so existing PW tests don't churn — the slot name
                            reflects the *default* mode each ModularToolButton
                            ships with (matching Qt). After a popup pick the
                            slot can display any of its 4 (stereo) or 2 (order)
                            modes; the testid is stable. */}
                        <IconButtonWithPopup<BondMode>
                            icon={bondModeIcon(stereo1Mode)}
                            testid='bond-wedge'
                            title={`${bondModeTitle(stereo1Mode)} – press & hold to change`}
                            active={tool === 'bond' && bondMode === stereo1Mode}
                            choices={STEREO_CHOICES}
                            onClick={() => pickBondModeApplying(stereo1Mode, bondModeTitle(stereo1Mode).toLowerCase())}
                            onPick={(v) => {
                                setStereo1Mode(v);
                                pickBondModeApplying(v, bondModeTitle(v).toLowerCase());
                            }}
                        />
                        <IconButtonWithPopup<BondMode>
                            icon={bondModeIcon(stereo2Mode)}
                            testid='bond-dash'
                            title={`${bondModeTitle(stereo2Mode)} – press & hold to change`}
                            active={tool === 'bond' && bondMode === stereo2Mode}
                            choices={STEREO_CHOICES}
                            onClick={() => pickBondModeApplying(stereo2Mode, bondModeTitle(stereo2Mode).toLowerCase())}
                            onPick={(v) => {
                                setStereo2Mode(v);
                                pickBondModeApplying(v, bondModeTitle(v).toLowerCase());
                            }}
                        />
                        <IconButtonWithPopup<BondMode>
                            icon={bondModeIcon(bondOrderMode)}
                            testid='bond-double'
                            title={`${bondModeTitle(bondOrderMode)} – press & hold to change`}
                            active={tool === 'bond' && bondMode === bondOrderMode}
                            choices={BOND_ORDER_CHOICES}
                            onClick={() => pickBondModeApplying(bondOrderMode, bondModeTitle(bondOrderMode).toLowerCase())}
                            onPick={(v) => {
                                setBondOrderMode(v);
                                pickBondModeApplying(v, bondModeTitle(v).toLowerCase());
                            }}
                        />
                        <IconButtonWithPopup<BondQueryChoice>
                            icon={bondQueryMode === 'aromatic'
                                ? 'bond_aromatic' : ''}
                            label={BOND_QUERY_FACE[bondQueryMode]}
                            testid='bond-query'
                            title='Bond Query – press & hold to change'
                            active={tool === 'bond-query'}
                            choices={BOND_QUERY_CHOICES}
                            onClick={() => {
                                setTool('bond-query');
                                setPendingBondAtom(null);
                            }}
                            onPick={(q) => {
                                setBondQueryMode(q);
                                setTool('bond-query');
                                setPendingBondAtom(null);
                            }}
                        />
                        <IconButton icon='bond_chain' testid='atom-chain'
                            title='Atom Chain'
                            active={tool === 'atom-chain'}
                            onClick={() => {
                                setTool('atom-chain');
                                setPendingBondAtom(null);
                            }} />
                    </div>

                    <hr style={styles.hr} />

                    {/* RingToolWidget 3×3 — ring_tool_widget.ui:
                        row 0: cyclohexane, benzene, cycloheptane
                        row 1: cyclopentane, cyclopentadiene, cyclooctane
                        row 2: cyclobutane, cyclopropane (last cell empty). */}
                    <div style={styles.ringGrid}>
                        {RING_PRESETS.map((spec) => (
                            <IconButton key={spec.label}
                                icon={spec.iconName}
                                testid={`ring-${spec.label.toLowerCase()}`}
                                title={`Draw ${spec.label}`}
                                active={tool === 'ring' && ring.label === spec.label}
                                onClick={() => {
                                    setRing(spec);
                                    setTool('ring');
                                    setPendingBondAtom(null);
                                }} />
                        ))}
                    </div>

                    <hr style={styles.hr} />

                    {/* EnumerationToolWidget — rgroup, attachment_point,
                        reaction. All three are wired (Qt:
                        MolModel::addRGroup / addAttachmentPoint /
                        addNonMolecularObject for reaction arrow + plus).
                        The reaction slot is a ModularToolButton in Qt;
                        long-press opens ReactionPopup (arrow / plus /
                        map / unmap). Mapping is deferred — needs reaction
                        atom-map plumbing in the lean MolModel. */}
                    <div style={styles.row3}>
                        <LetterButton label='R' testid='rgroup'
                            title='R-Group'
                            active={tool === 'rgroup'}
                            onClick={() => {
                                setTool('rgroup');
                                setPendingBondAtom(null);
                                setStatus(
                                    'r-group mode: click empty area to add R, click an atom to attach R',
                                );
                            }} />
                        <IconButton icon='enumeration_attachment_point'
                            testid='attachment-point'
                            title='Attachment Point'
                            active={tool === 'attachment-point'}
                            onClick={() => {
                                setTool('attachment-point');
                                setPendingBondAtom(null);
                                setStatus(
                                    'attachment-point mode: click an atom to attach',
                                );
                            }} />
                        <IconButtonWithPopup<ReactionMode>
                            icon={REACTION_ICON[reactionMode]}
                            testid='reaction'
                            title={`${REACTION_TITLE[reactionMode]} – press & hold to change`}
                            active={tool === 'reaction'}
                            choices={REACTION_CHOICES}
                            onClick={() => {
                                setTool('reaction');
                                setPendingBondAtom(null);
                                setStatus(
                                    `reaction mode: click to place ${reactionMode}`,
                                );
                            }}
                            onPick={(v) => {
                                setReactionMode(v);
                                setTool('reaction');
                                setPendingBondAtom(null);
                                setStatus(
                                    `reaction mode: click to place ${v}`,
                                );
                            }}
                        />
                    </div>
                    </>)}

                    {mode === 'monomeric' && (
                    /* MonomerToolWidget port — Qt's monomer_tool_widget.ui:
                       AMINO/NUCLEIC toggle row (AminoOrNucleicToggleButton
                       pair, amino_or_nucleic_group), then a QStackedWidget
                       (`amino_or_nucleic_stack`) with `amino_page` (3×7
                       LetterButton grid, one button per natural amino acid)
                       and `nucleic_page` (still placeholder — Batch 33).
                       The amino tile clicks stub to comingSoon since the
                       lean MolModel doesn't speak monomer yet. */
                    <div style={styles.monomericPage} data-testid='monomeric-page'>
                        <div style={styles.row2}>
                            <button type='button'
                                style={{
                                    ...styles.monomerTabBtn,
                                    ...(monomerSubMode === 'amino'
                                        ? styles.monomerTabBtnActive : {}),
                                }}
                                data-testid='monomer-amino'
                                aria-pressed={monomerSubMode === 'amino'}
                                title='Amino acids'
                                onClick={() => {
                                    if (monomerSubMode === 'amino') return;
                                    setMonomerSubMode('amino');
                                    setStatus('amino acid monomers');
                                }}>
                                AMINO
                            </button>
                            <button type='button'
                                style={{
                                    ...styles.monomerTabBtn,
                                    ...(monomerSubMode === 'nucleic'
                                        ? styles.monomerTabBtnActive : {}),
                                }}
                                data-testid='monomer-nucleic'
                                aria-pressed={monomerSubMode === 'nucleic'}
                                title='Nucleic acids'
                                onClick={() => {
                                    if (monomerSubMode === 'nucleic') return;
                                    setMonomerSubMode('nucleic');
                                    setStatus('nucleic acid monomers');
                                }}>
                                NUCLEIC
                            </button>
                        </div>
                        {monomerSubMode === 'amino' && (
                        <div style={styles.elementGrid}
                            data-testid='amino-acid-grid'>
                            {AMINO_ACIDS.map(([id, sym, full]) => {
                                const variants = peptideAnalogs[sym] ?? [];
                                const armMonomer = (
                                    s: string, label: string,
                                ): void => {
                                    setMonomerResName(s);
                                    setMonomerChainType(0); // PEPTIDE
                                    setNucleotideSpec(null);
                                    setTool('monomer');
                                    setPendingBondAtom(null);
                                    setStatus(`monomer: ${label} `
                                        + '— click canvas to place');
                                };
                                // A tile is "armed" when its natural residue OR
                                // any of its variants is the active monomer.
                                const armed = tool === 'monomer'
                                    && !nucleotideSpec
                                    && monomerChainType === 0
                                    && (monomerResName === sym
                                        || variants.some(
                                            (v) => v.s === monomerResName));
                                if (variants.length === 0) {
                                    return (
                                        <LetterButton key={id}
                                            label={sym}
                                            testid={`monomer-aa-${id}`}
                                            title={`Draw ${full} (${sym})`}
                                            active={armed}
                                            onClick={() =>
                                                armMonomer(sym,
                                                    `${full} (${sym})`)} />
                                    );
                                }
                                // Press & hold surfaces the D-/N-methyl (etc.)
                                // analogs from the monomer DB (SKETCH-2482).
                                const choices = variants.map((v) => ({
                                    value: v.s,
                                    label: v.s,
                                    title: `${v.n} (${v.s})`,
                                    testid: `monomer-aa-analog-${v.s}`,
                                }));
                                return (
                                    <IconButtonWithPopup<string>
                                        key={id}
                                        label={sym}
                                        testid={`monomer-aa-${id}`}
                                        title={`Draw ${full} (${sym}) `
                                            + '— press & hold for analogs'}
                                        active={armed}
                                        choices={choices}
                                        onClick={() =>
                                            armMonomer(sym, `${full} (${sym})`)}
                                        onPick={(s) => armMonomer(s, s)}
                                    />
                                );
                            })}
                        </div>
                        )}
                        {monomerSubMode === 'nucleic' && (
                        <div style={styles.nucleicGrid}
                            data-testid='nucleic-acid-grid'>
                            {/* RNA / DNA nucleotide selectors — Qt
                                NucleotidePopup: click places the last base
                                (default U/T); press & hold picks A/C/G/U-or-T/N.
                                */}
                            <IconButtonWithPopup<string>
                                label='RNA'
                                testid='monomer-na-rna'
                                title='Add an RNA nucleotide — press & hold to pick a base'
                                buttonStyle={styles.nucleicWideBtn}
                                active={tool === 'monomer'
                                    && nucleotideSpec?.id === 'rna'}
                                choices={RNA_BASE_CHOICES}
                                onClick={() => armNucleotide('rna',
                                    nucleotideSpec?.id === 'rna'
                                        ? nucleotideSpec.base : 'U')}
                                onPick={(b) => armNucleotide('rna', b)}
                            />
                            <IconButtonWithPopup<string>
                                label='DNA'
                                testid='monomer-na-dna'
                                title='Add a DNA nucleotide — press & hold to pick a base'
                                buttonStyle={styles.nucleicWideBtn}
                                active={tool === 'monomer'
                                    && nucleotideSpec?.id === 'dna'}
                                choices={DNA_BASE_CHOICES}
                                onClick={() => armNucleotide('dna',
                                    nucleotideSpec?.id === 'dna'
                                        ? nucleotideSpec.base : 'T')}
                                onPick={(b) => armNucleotide('dna', b)}
                            />
                            <button type='button'
                                style={styles.nucleicWideBtn}
                                data-testid='monomer-na-custom'
                                title='Build a custom sugar / base / phosphate nucleotide'
                                onClick={() => comingSoon(
                                    'Custom nucleotide')}>
                                Custom
                            </button>
                            <div style={styles.elementGrid}>
                                {NUCLEIC_LETTERS.map(
                                    ([id, sym, full]) => (
                                    <LetterButton key={id}
                                        label={sym}
                                        testid={`monomer-na-${id}`}
                                        title={`Draw ${full} (${sym})`}
                                        active={tool === 'monomer'
                                            && !nucleotideSpec
                                            && monomerChainType === 1
                                            && monomerResName === sym}
                                        onClick={() => {
                                            setMonomerResName(sym);
                                            setMonomerChainType(1); // RNA
                                            setNucleotideSpec(null);
                                            setTool('monomer');
                                            setPendingBondAtom(null);
                                            setStatus(`monomer: ${full} (${sym})`
                                                + ' — click canvas to place');
                                        }} />
                                ))}
                            </div>
                            <div style={styles.elementGrid}>
                                {NUCLEIC_BUILDING_BLOCKS.map(
                                    ([id, sym, full]) => (
                                    <LetterButton key={id}
                                        label={sym}
                                        testid={`monomer-na-${id}`}
                                        title={`Draw ${full} (${sym})`}
                                        active={tool === 'monomer'
                                            && !nucleotideSpec
                                            && monomerChainType === 1
                                            && monomerResName === sym}
                                        onClick={() => {
                                            setMonomerResName(sym);
                                            setMonomerChainType(1); // RNA
                                            setNucleotideSpec(null);
                                            setTool('monomer');
                                            setPendingBondAtom(null);
                                            setStatus(`monomer: ${full} (${sym})`
                                                + ' — click canvas to place');
                                        }} />
                                ))}
                            </div>
                        </div>
                        )}
                    </div>
                    )}
                </aside>

                <div style={styles.canvasColumn}>
                    <canvas
                        ref={canvasRef}
                        width={CANVAS_W}
                        height={CANVAS_H}
                        style={{
                            ...styles.canvas,
                            // Background must match the renderer's
                            // palette so dark-mode schemes don't show a
                            // white frame around the painted area.
                            background: getPalette(displayOptions).bg,
                            cursor: tool === 'move-rotate' ? 'move'
                                : tool === 'erase' ? 'not-allowed'
                                : 'crosshair',
                        }}
                        onClick={onCanvasClick}
                        onMouseDown={onCanvasMouseDown}
                        onMouseMove={onCanvasMove}
                        onMouseUp={onCanvasMouseUp}
                        onMouseLeave={onCanvasMouseLeave}
                        onContextMenu={onCanvasContextMenu}
                        data-testid='sketcher-canvas'
                    />
                    <div style={styles.statusBox} data-testid='sketcher-status'>
                        {status}
                    </div>
                </div>
            </div>
            {/* Background context menu — mirrors Qt's BackgroundContextMenu
                (menu/background_context_menu.cpp). Order, labels, separators,
                and enable-states all follow that file. Copy As is inlined as
                a labelled section (same flattening choice as the More Actions
                menu) rather than a nested submenu — known minor divergence.
                Qt's plain "Copy" emits DEFAULT_FORMAT = MDL_MOLV3000 (
                cut_copy_action_manager.cpp:16,45), which is exactly what the
                Ctrl+C path here already does. */}
            {bgContextMenu && (
                <div
                    ref={bgContextMenuRef}
                    style={{
                        ...styles.bgContextMenu,
                        left: bgContextMenu.x,
                        top: bgContextMenu.y,
                    }}
                    data-testid='bg-context-menu'
                    onContextMenu={(e) => e.preventDefault()}
                >
                    <MoreItem label='Save Image...' testid='ctx-save-image'
                        disabled={bgContextMenu.sceneEmpty}
                        onClick={() => {
                            setBgContextMenu(null);
                            setImageModalOpen(true);
                        }} />
                    <MoreItem label='Export to File...' testid='ctx-export'
                        disabled={bgContextMenu.sceneEmpty}
                        onClick={() => {
                            setBgContextMenu(null);
                            setExportModalOpen(true);
                        }} />
                    <div style={styles.moreDivider} />
                    <MoreItem label='Flip All Horizontal'
                        testid='ctx-flip-horizontal'
                        disabled={bgContextMenu.sceneEmpty}
                        onClick={() => {
                            setBgContextMenu(null);
                            doFlip(true, 'flipped horizontal');
                        }} />
                    <MoreItem label='Flip All Vertical'
                        testid='ctx-flip-vertical'
                        disabled={bgContextMenu.sceneEmpty}
                        onClick={() => {
                            setBgContextMenu(null);
                            doFlip(false, 'flipped vertical');
                        }} />
                    <div style={styles.moreDivider} />
                    {/* Qt disables undo/redo via getUndoStackData(), but the
                        existing React top-bar undo/redo buttons don't gate
                        either — leaving these always-enabled keeps the two
                        surfaces consistent. */}
                    <MoreItem label='Undo' testid='ctx-undo'
                        onClick={() => { setBgContextMenu(null); doUndo(); }} />
                    <MoreItem label='Redo' testid='ctx-redo'
                        onClick={() => { setBgContextMenu(null); doRedo(); }} />
                    <div style={styles.moreDivider} />
                    <MoreItem label='Select All' testid='ctx-select-all'
                        disabled={bgContextMenu.sceneEmpty}
                        onClick={() => {
                            setBgContextMenu(null);
                            doSelectAll();
                        }} />
                    <MoreItem label='Copy' testid='ctx-copy'
                        disabled={bgContextMenu.sceneEmpty}
                        onClick={() => {
                            setBgContextMenu(null);
                            void doCopyMolBlockV3000();
                        }} />
                    <div style={styles.moreSectionLabel}>Copy As</div>
                    <MoreItem label='MDL SD V3000' testid='ctx-copy-as-mol-v3000'
                        disabled={bgContextMenu.sceneEmpty}
                        onClick={() => {
                            setBgContextMenu(null);
                            void doCopyAs('mdl_molv3000', 'MOL V3000');
                        }} />
                    <MoreItem label='Maestro' testid='ctx-copy-as-maestro'
                        disabled={bgContextMenu.sceneEmpty}
                        onClick={() => {
                            setBgContextMenu(null);
                            void doCopyAs('maestro', 'Maestro');
                        }} />
                    <MoreItem label='SMILES' testid='ctx-copy-as-smiles'
                        disabled={bgContextMenu.sceneEmpty}
                        onClick={() => {
                            setBgContextMenu(null);
                            void doCopyAs('smiles', 'SMILES');
                        }} />
                    <MoreItem label='Extended SMILES'
                        testid='ctx-copy-as-extended-smiles'
                        disabled={bgContextMenu.sceneEmpty}
                        onClick={() => {
                            setBgContextMenu(null);
                            void doCopyAs('extended_smiles', 'Extended SMILES');
                        }} />
                    <MoreItem label='SMARTS' testid='ctx-copy-as-smarts'
                        disabled={bgContextMenu.sceneEmpty}
                        onClick={() => {
                            setBgContextMenu(null);
                            void doCopyAs('smarts', 'SMARTS');
                        }} />
                    <MoreItem label='Extended SMARTS'
                        testid='ctx-copy-as-extended-smarts'
                        disabled={bgContextMenu.sceneEmpty}
                        onClick={() => {
                            setBgContextMenu(null);
                            void doCopyAs('extended_smarts', 'Extended SMARTS');
                        }} />
                    <MoreItem label='InChI' testid='ctx-copy-as-inchi'
                        disabled={bgContextMenu.sceneEmpty}
                        onClick={() => {
                            setBgContextMenu(null);
                            void doCopyAs('inchi', 'InChI');
                        }} />
                    <MoreItem label='InChIKey' testid='ctx-copy-as-inchikey'
                        disabled={bgContextMenu.sceneEmpty}
                        onClick={() => {
                            setBgContextMenu(null);
                            void doCopyAs('inchikey', 'InChIKey');
                        }} />
                    <MoreItem label='PDB' testid='ctx-copy-as-pdb'
                        disabled={bgContextMenu.sceneEmpty}
                        onClick={() => {
                            setBgContextMenu(null);
                            void doCopyAs('pdb', 'PDB');
                        }} />
                    <MoreItem label='XYZ' testid='ctx-copy-as-xyz'
                        disabled={bgContextMenu.sceneEmpty}
                        onClick={() => {
                            setBgContextMenu(null);
                            void doCopyAs('xyz', 'XYZ');
                        }} />
                    <MoreItem label='Marvin Document'
                        testid='ctx-copy-as-mrv'
                        disabled={bgContextMenu.sceneEmpty}
                        onClick={() => {
                            setBgContextMenu(null);
                            void doCopyAs('mrv', 'Marvin');
                        }} />
                    {/* Paste is always-enabled in Qt (clipboard agnostic) */}
                    <MoreItem label='Paste' testid='ctx-paste'
                        onClick={() => {
                            setBgContextMenu(null);
                            void doPaste();
                        }} />
                    <div style={styles.moreDivider} />
                    <MoreItem label='Clear Sketcher' testid='ctx-clear'
                        onClick={() => { setBgContextMenu(null); doClear(); }} />
                </div>
            )}
            {/* Selection context menu — mirrors Qt's SelectionContextMenu
                (menu/selection_context_menu.cpp). Order/labels follow that
                file; sections that need infrastructure not yet ported are
                intentionally omitted (Clean Up Region: needs
                is_contiguous_region; Modify Atoms / Modify Bonds submenus:
                large dependency; Add to Selection: needs bracket subgroup +
                variable attachment bond). Flip is
                always rendered as the "Flip Molecule" submenu form
                (Horizontally/Vertically) since the bond-crossing-count
                logic that picks between "Flip" and "Flip Molecule" needs
                adjacency data we don't surface client-side yet — the
                submenu form is the more general of the two. */}
            {selContextMenu && (
                <div
                    ref={selContextMenuRef}
                    style={{
                        ...styles.bgContextMenu,
                        left: selContextMenu.x,
                        top: selContextMenu.y,
                    }}
                    data-testid='sel-context-menu'
                    onContextMenu={(e) => e.preventDefault()}
                >
                    <MoreItem label='Invert Selection'
                        testid='sel-ctx-invert'
                        onClick={() => {
                            setSelContextMenu(null);
                            doInvertSelection();
                        }} />
                    <div style={styles.moreDivider} />
                    <MoreItem label='Cut' testid='sel-ctx-cut'
                        onClick={() => {
                            setSelContextMenu(null);
                            void doCut();
                        }} />
                    <MoreItem label='Copy' testid='sel-ctx-copy'
                        onClick={() => {
                            setSelContextMenu(null);
                            void doCopyMolBlockV3000();
                        }} />
                    <div style={styles.moreSectionLabel}>Copy As</div>
                    <MoreItem label='MDL SD V3000'
                        testid='sel-ctx-copy-as-mol-v3000'
                        onClick={() => {
                            setSelContextMenu(null);
                            void doCopyAs('mdl_molv3000', 'MOL V3000');
                        }} />
                    <MoreItem label='Maestro' testid='sel-ctx-copy-as-maestro'
                        onClick={() => {
                            setSelContextMenu(null);
                            void doCopyAs('maestro', 'Maestro');
                        }} />
                    <MoreItem label='SMILES' testid='sel-ctx-copy-as-smiles'
                        onClick={() => {
                            setSelContextMenu(null);
                            void doCopyAs('smiles', 'SMILES');
                        }} />
                    <MoreItem label='Extended SMILES'
                        testid='sel-ctx-copy-as-extended-smiles'
                        onClick={() => {
                            setSelContextMenu(null);
                            void doCopyAs('extended_smiles', 'Extended SMILES');
                        }} />
                    <MoreItem label='SMARTS' testid='sel-ctx-copy-as-smarts'
                        onClick={() => {
                            setSelContextMenu(null);
                            void doCopyAs('smarts', 'SMARTS');
                        }} />
                    <MoreItem label='Extended SMARTS'
                        testid='sel-ctx-copy-as-extended-smarts'
                        onClick={() => {
                            setSelContextMenu(null);
                            void doCopyAs('extended_smarts', 'Extended SMARTS');
                        }} />
                    <MoreItem label='InChI' testid='sel-ctx-copy-as-inchi'
                        onClick={() => {
                            setSelContextMenu(null);
                            void doCopyAs('inchi', 'InChI');
                        }} />
                    <MoreItem label='InChIKey' testid='sel-ctx-copy-as-inchikey'
                        onClick={() => {
                            setSelContextMenu(null);
                            void doCopyAs('inchikey', 'InChIKey');
                        }} />
                    <MoreItem label='PDB' testid='sel-ctx-copy-as-pdb'
                        onClick={() => {
                            setSelContextMenu(null);
                            void doCopyAs('pdb', 'PDB');
                        }} />
                    <MoreItem label='XYZ' testid='sel-ctx-copy-as-xyz'
                        onClick={() => {
                            setSelContextMenu(null);
                            void doCopyAs('xyz', 'XYZ');
                        }} />
                    <MoreItem label='Marvin Document'
                        testid='sel-ctx-copy-as-mrv'
                        onClick={() => {
                            setSelContextMenu(null);
                            void doCopyAs('mrv', 'Marvin');
                        }} />
                    <div style={styles.moreDivider} />
                    <div style={styles.moreSectionLabel}>Flip Molecule</div>
                    <MoreItem label='Horizontally'
                        testid='sel-ctx-flip-horizontal'
                        onClick={() => {
                            setSelContextMenu(null);
                            doFlip(true, 'flipped horizontal');
                        }} />
                    <MoreItem label='Vertically'
                        testid='sel-ctx-flip-vertical'
                        onClick={() => {
                            setSelContextMenu(null);
                            doFlip(false, 'flipped vertical');
                        }} />
                    <div style={styles.moreDivider} />
                    {/* Modify Atoms (Qt: ModifyAtomsMenu) — flattened into an
                        inline section instead of a hover-out submenu since the
                        React port already nests context-menu content directly.
                        Set Element grid mirrors the per-atom strip; ± Charge
                        items reuse the existing selection-wide primitive
                        (adjustChargeOnSelectedAtoms). Element picks call the
                        new selection-wide setElementForSelectedAtoms primitive
                        so a Ctrl+Z undoes the whole batch. */}
                    <div style={styles.moreSectionLabel}>Modify Atoms</div>
                    <div style={styles.atomCtxElementGrid}>
                        {FIXED_ELEMENTS.map((el) => (
                            <LetterButton
                                key={el}
                                label={el}
                                color={ELEMENT_COLORS[el]}
                                testid={`sel-ctx-set-${el}`}
                                title={`Set element: ${el}`}
                                onClick={() => {
                                    setSelContextMenu(null);
                                    modelRef.current?.setElementForSelectedAtoms(
                                        FIXED_ELEMENT_ATOMIC_NUMS[el]);
                                    setStatus(`Set element: ${el}`);
                                }} />
                        ))}
                    </div>
                    {/* Periodic-table popup launcher (Qt:
                        SetAtomMenuWidget's ui->periodic_table_btn —
                        set_atom_widget.cpp:34-38). Mirrors the toolbar
                        PT button but in the menu's MoreItem row form.
                        Hidden when the selection contains no atoms —
                        setElementForSelectedAtoms would be a no-op. */}
                    {selContextMenu.selAtomIndices.length > 0 && (
                        <PeriodicTableMenuItem
                            testid='sel-ctx-periodic-table'
                            onPick={(sym, atomicNum) => {
                                setSelContextMenu(null);
                                modelRef.current
                                    ?.setElementForSelectedAtoms(atomicNum);
                                setStatus(`Set element: ${sym}`);
                            }} />
                    )}
                    <MoreItem label='+ Charge' testid='sel-ctx-charge-plus'
                        onClick={() => {
                            setSelContextMenu(null);
                            adjustCharge(+1);
                        }} />
                    <MoreItem label='− Charge' testid='sel-ctx-charge-minus'
                        onClick={() => {
                            setSelContextMenu(null);
                            adjustCharge(-1);
                        }} />
                    {/* Add/Remove Explicit Hydrogens — selection-wide
                        counterpart to the per-atom action. Label flips based
                        on whether any selected atom still has implicit Hs
                        (Qt: ModifyAtomsMenu::updateActions uses
                        has_any_implicit_Hs across the whole atom set).
                        Hidden when the selection contains no atoms (only
                        bonds) — Qt disables in that case; we just hide for
                        a cleaner menu since the action wouldn't do anything
                        useful and the selection-wide primitive would be a
                        no-op anyway. */}
                    {selContextMenu.selAtomIndices.length > 0 && (
                        <MoreItem
                            label={selContextMenu.selHasImplicitH
                                ? 'Add Explicit Hydrogens'
                                : 'Remove Explicit Hydrogens'}
                            testid='sel-ctx-explicit-h'
                            onClick={() => {
                                const sm = selContextMenu;
                                setSelContextMenu(null);
                                if (sm.selHasImplicitH) {
                                    modelRef.current?.addExplicitHsToAtoms(
                                        sm.selAtomIndices);
                                    setStatus('added explicit Hs to selection');
                                } else {
                                    modelRef.current
                                        ?.removeExplicitHsFromAtoms(
                                            sm.selAtomIndices);
                                    setStatus(
                                        'removed explicit Hs from selection');
                                }
                            }} />
                    )}
                    {/* ± Unpaired Electrons (Qt:
                        ModifyAtomsMenu::m_add_remove_unpaired_e_acts wired
                        into the selection menu via SelectionContextMenu).
                        Disabled when every selected atom is at the clamp
                        boundary so the underlying adjust is a no-op. Hidden
                        when the selection contains no atoms. */}
                    {selContextMenu.selAtomIndices.length > 0 && (
                        <>
                            <MoreItem
                                label='+ Unpaired Electron'
                                testid='sel-ctx-radical-plus'
                                // Disabled only when EVERY selected atom is
                                // already at MAX_UNPAIRED_E=4. A mixed
                                // selection (some at max, some below) keeps
                                // the action enabled — the per-atom clamp
                                // inside adjustRadicalElectronsOnAtoms swallows
                                // the saturated atoms while still incrementing
                                // the ones with room.
                                disabled={selContextMenu.selMinRadical >= 4}
                                onClick={() => {
                                    const sm = selContextMenu;
                                    setSelContextMenu(null);
                                    modelRef.current
                                        ?.adjustRadicalElectronsOnAtoms(
                                            sm.selAtomIndices, +1);
                                    setStatus(
                                        'added unpaired electron to selection');
                                }} />
                            <MoreItem
                                label='− Unpaired Electron'
                                testid='sel-ctx-radical-minus'
                                // Symmetric: disabled only when EVERY selected
                                // atom is already at MIN_UNPAIRED_E=0.
                                disabled={selContextMenu.selMaxRadical <= 0}
                                onClick={() => {
                                    const sm = selContextMenu;
                                    setSelContextMenu(null);
                                    modelRef.current
                                        ?.adjustRadicalElectronsOnAtoms(
                                            sm.selAtomIndices, -1);
                                    setStatus(
                                        'removed unpaired electron from selection');
                                }} />
                        </>
                    )}
                    <div style={styles.moreDivider} />
                    {/* Modify Bonds (Qt: ModifyBondsMenu) — flattened from
                        the submenu form. Flip Substituent is hidden in the
                        selection branch (Qt setFlipVisible(false), so we
                        skip it too). Query (Any/S-D/D-A/S-A) + Topology
                        (In Ring / Not In a Ring / Either) both ship below.
                        Each item is a no-op when no bonds are in the selection —
                        the selection-wide primitives already early-return
                        on empty bond sets. Other Type items (Coordinate /
                        Zero / wavy / crossed) use the combined
                        setBondTypeAndDirForSelectedBonds primitive so type
                        + dir collapse to one undo step. */}
                    <div style={styles.moreSectionLabel}>Modify Bonds</div>
                    <MoreItem label='Single' testid='sel-ctx-bond-single'
                        onClick={() => {
                            setSelContextMenu(null);
                            modelRef.current?.setBondTypeForSelectedBonds(1);
                            setStatus('selected bonds → single');
                        }} />
                    <MoreItem label='Double' testid='sel-ctx-bond-double'
                        onClick={() => {
                            setSelContextMenu(null);
                            modelRef.current?.setBondTypeForSelectedBonds(2);
                            setStatus('selected bonds → double');
                        }} />
                    <MoreItem label='Triple' testid='sel-ctx-bond-triple'
                        onClick={() => {
                            setSelContextMenu(null);
                            modelRef.current?.setBondTypeForSelectedBonds(3);
                            setStatus('selected bonds → triple');
                        }} />
                    <MoreItem label='Aromatic' testid='sel-ctx-bond-aromatic'
                        onClick={() => {
                            setSelContextMenu(null);
                            modelRef.current?.setBondTypeForSelectedBonds(12);
                            setStatus('selected bonds → aromatic');
                        }} />
                    <MoreItem label='Up' testid='sel-ctx-bond-up'
                        onClick={() => {
                            setSelContextMenu(null);
                            modelRef.current?.setBondDirForSelectedBonds(
                                BOND_DIR_WEDGE);
                            setStatus('selected bonds → up wedge');
                        }} />
                    <MoreItem label='Down' testid='sel-ctx-bond-down'
                        onClick={() => {
                            setSelContextMenu(null);
                            modelRef.current?.setBondDirForSelectedBonds(
                                BOND_DIR_DASH);
                            setStatus('selected bonds → down dash');
                        }} />
                    <MoreItem label='Coordinate'
                        testid='sel-ctx-bond-coordinate'
                        onClick={() => {
                            setSelContextMenu(null);
                            modelRef.current
                                ?.setBondTypeAndDirForSelectedBonds(
                                    BOND_TYPE_DATIVE, BOND_DIR_NONE);
                            setStatus('selected bonds → coordinate');
                        }} />
                    <MoreItem label='Zero Order'
                        testid='sel-ctx-bond-zero'
                        onClick={() => {
                            setSelContextMenu(null);
                            modelRef.current
                                ?.setBondTypeAndDirForSelectedBonds(
                                    BOND_TYPE_ZERO, BOND_DIR_NONE);
                            setStatus('selected bonds → zero order');
                        }} />
                    <MoreItem label='Single Up/Down'
                        testid='sel-ctx-bond-single-either'
                        onClick={() => {
                            setSelContextMenu(null);
                            modelRef.current
                                ?.setBondTypeAndDirForSelectedBonds(
                                    BOND_TYPE_SINGLE, BOND_DIR_UNKNOWN);
                            setStatus('selected bonds → wavy single');
                        }} />
                    <MoreItem label='Double Cis/Trans'
                        testid='sel-ctx-bond-double-either'
                        onClick={() => {
                            setSelContextMenu(null);
                            modelRef.current
                                ?.setBondTypeAndDirForSelectedBonds(
                                    BOND_TYPE_DOUBLE,
                                    BOND_DIR_EITHERDOUBLE);
                            setStatus('selected bonds → crossed double');
                        }} />
                    {/* Query — Qt's ModifyBondsMenu::createQueryMenu applied
                        to the selection. Each replaces every selected bond
                        with the query bond via mutateSelectedBondsToQuery. */}
                    {([
                        ['Any', 'Query: Any'],
                        ['S/D', 'Query: Single/Double'],
                        ['D/A', 'Query: Double/Aromatic'],
                        ['S/A', 'Query: Single/Aromatic'],
                    ] as [string, string][]).map(([code, label]) => (
                        <MoreItem
                            key={`sel-bond-query-${code}`}
                            label={label}
                            testid={`sel-ctx-bond-query-${code.replace('/', '')}`}
                            onClick={() => {
                                setSelContextMenu(null);
                                modelRef.current
                                    ?.mutateSelectedBondsToQuery(code);
                                setStatus(`selected bonds → query ${code}`);
                            }} />
                    ))}
                    {/* Topology — applied to every selected bond. */}
                    {([
                        ['ring', 'Topology: In Ring'],
                        ['notring', 'Topology: Not In a Ring'],
                        ['either', 'Topology: Either'],
                    ] as [string, string][]).map(([code, label]) => (
                        <MoreItem
                            key={`sel-bond-topo-${code}`}
                            label={label}
                            testid={`sel-ctx-bond-topo-${code}`}
                            onClick={() => {
                                setSelContextMenu(null);
                                modelRef.current
                                    ?.setSelectedBondsTopology(code);
                                setStatus(`selected bonds → topology ${code}`);
                            }} />
                    ))}
                    <div style={styles.moreDivider} />
                    <MoreItem label='Delete' testid='sel-ctx-delete'
                        onClick={() => {
                            setSelContextMenu(null);
                            doDeleteSelected();
                        }} />
                </div>
            )}
            {/* Bond context menu — mirrors Qt's BondContextMenu
                (menu/bond_context_menu.cpp). Order/labels follow that file.
                Query (Any/S-D/D-A/S-A) and Topology (In Ring / Not In a Ring
                / Either) both ship below. Active bond-type / bond-dir / query
                / topology items show a leading checkmark so the user can see
                the current state — Qt uses checkable QAction groups for the
                same purpose. */}
            {bondContextMenu && (
                <div
                    ref={bondContextMenuRef}
                    style={{
                        ...styles.bgContextMenu,
                        left: bondContextMenu.x,
                        top: bondContextMenu.y,
                    }}
                    data-testid='bond-context-menu'
                    onContextMenu={(e) => e.preventDefault()}
                >
                    {/* Flip Substituent — Qt adds this first in
                        ModifyBondsMenu (bond_context_menu.cpp:22), disabled
                        for ring bonds (updateActions:38). Reflects the
                        smaller substituent across the bond axis. */}
                    <MoreItem
                        label='Flip Substituent'
                        testid='bond-ctx-flip-substituent'
                        disabled={bondContextMenu.inRing}
                        onClick={() => {
                            const bm = bondContextMenu;
                            setBondContextMenu(null);
                            modelRef.current?.flipSubstituentAroundBond(
                                bm.a, bm.b,
                            );
                            setStatus('flipped substituent');
                        }} />
                    <div style={styles.moreDivider} />
                    <MoreItem
                        label={(bondContextMenu.type === 1 ? '✓ ' : '   ')
                            + 'Single'}
                        testid='bond-ctx-single'
                        onClick={() => {
                            const bm = bondContextMenu;
                            setBondContextMenu(null);
                            modelRef.current?.setBondTypeUndoable(
                                bm.a, bm.b, 1,
                            );
                        }} />
                    <MoreItem
                        label={(bondContextMenu.type === 2 ? '✓ ' : '   ')
                            + 'Double'}
                        testid='bond-ctx-double'
                        onClick={() => {
                            const bm = bondContextMenu;
                            setBondContextMenu(null);
                            modelRef.current?.setBondTypeUndoable(
                                bm.a, bm.b, 2,
                            );
                        }} />
                    <MoreItem
                        label={(bondContextMenu.type === 3 ? '✓ ' : '   ')
                            + 'Triple'}
                        testid='bond-ctx-triple'
                        onClick={() => {
                            const bm = bondContextMenu;
                            setBondContextMenu(null);
                            modelRef.current?.setBondTypeUndoable(
                                bm.a, bm.b, 3,
                            );
                        }} />
                    <MoreItem
                        label={(bondContextMenu.type === 12 ? '✓ ' : '   ')
                            + 'Aromatic'}
                        testid='bond-ctx-aromatic'
                        onClick={() => {
                            const bm = bondContextMenu;
                            setBondContextMenu(null);
                            modelRef.current?.setBondTypeUndoable(
                                bm.a, bm.b, 12,
                            );
                        }} />
                    <div style={styles.moreDivider} />
                    <MoreItem
                        label={(bondContextMenu.dir === 1 ? '✓ ' : '   ')
                            + 'Up'}
                        testid='bond-ctx-wedge-up'
                        onClick={() => {
                            const bm = bondContextMenu;
                            setBondContextMenu(null);
                            modelRef.current?.setBondDirUndoable(
                                bm.a, bm.b, 1,
                            );
                        }} />
                    <MoreItem
                        label={(bondContextMenu.dir === 2 ? '✓ ' : '   ')
                            + 'Down'}
                        testid='bond-ctx-wedge-down'
                        onClick={() => {
                            const bm = bondContextMenu;
                            setBondContextMenu(null);
                            modelRef.current?.setBondDirUndoable(
                                bm.a, bm.b, 2,
                            );
                        }} />
                    <MoreItem
                        label={(bondContextMenu.dir === 0 ? '✓ ' : '   ')
                            + 'None'}
                        testid='bond-ctx-wedge-none'
                        onClick={() => {
                            const bm = bondContextMenu;
                            setBondContextMenu(null);
                            modelRef.current?.setBondDirUndoable(
                                bm.a, bm.b, 0,
                            );
                        }} />
                    {/* Other Type — Qt's bond_context_menu.cpp:55-72 puts
                        these in a nested submenu. Flattened here to match
                        the rest of this context menu's layout. Each item
                        applies type AND dir in one undo step via the lean
                        `setBondTypeAndDirUndoable` macro so Ctrl+Z restores
                        the bond in a single press. Coordinate / Zero match
                        Qt's COORDINATE / ZERO BondTool entries; Single
                        Up/Down is the "wavy" stereo (BondDir::UNKNOWN);
                        Double Cis/Trans is the "crossed" double bond
                        (BondDir::EITHERDOUBLE). */}
                    <div style={styles.moreDivider} />
                    <MoreItem
                        label={(bondContextMenu.bt === BOND_TYPE_DATIVE
                            ? '✓ ' : '   ') + 'Coordinate'}
                        testid='bond-ctx-coordinate'
                        onClick={() => {
                            const bm = bondContextMenu;
                            setBondContextMenu(null);
                            modelRef.current?.setBondTypeAndDirUndoable(
                                bm.a, bm.b, BOND_TYPE_DATIVE, BOND_DIR_NONE,
                            );
                        }} />
                    <MoreItem
                        label={(bondContextMenu.bt === BOND_TYPE_ZERO
                            ? '✓ ' : '   ') + 'Zero Order'}
                        testid='bond-ctx-zero'
                        onClick={() => {
                            const bm = bondContextMenu;
                            setBondContextMenu(null);
                            modelRef.current?.setBondTypeAndDirUndoable(
                                bm.a, bm.b, BOND_TYPE_ZERO, BOND_DIR_NONE,
                            );
                        }} />
                    <MoreItem
                        label={(bondContextMenu.type === BOND_TYPE_SINGLE
                            && bondContextMenu.dir === BOND_DIR_UNKNOWN
                            ? '✓ ' : '   ') + 'Single Up/Down'}
                        testid='bond-ctx-single-either'
                        onClick={() => {
                            const bm = bondContextMenu;
                            setBondContextMenu(null);
                            modelRef.current?.setBondTypeAndDirUndoable(
                                bm.a, bm.b,
                                BOND_TYPE_SINGLE, BOND_DIR_UNKNOWN,
                            );
                        }} />
                    <MoreItem
                        label={(bondContextMenu.type === BOND_TYPE_DOUBLE
                            && bondContextMenu.dir === BOND_DIR_EITHERDOUBLE
                            ? '✓ ' : '   ') + 'Double Cis/Trans'}
                        testid='bond-ctx-double-either'
                        onClick={() => {
                            const bm = bondContextMenu;
                            setBondContextMenu(null);
                            modelRef.current?.setBondTypeAndDirUndoable(
                                bm.a, bm.b,
                                BOND_TYPE_DOUBLE, BOND_DIR_EITHERDOUBLE,
                            );
                        }} />
                    {/* Query — Qt's ModifyBondsMenu::createQueryMenu
                        (bond_context_menu.cpp:74). Any / Single-Double /
                        Double-Aromatic / Single-Aromatic. Flattened from the
                        submenu; each replaces the bond with a query bond via
                        mutateBondToQuery. The active query carries a check. */}
                    <div style={styles.moreDivider} />
                    <div style={styles.moreSectionLabel}>Query</div>
                    {([
                        ['Any', 'Any'],
                        ['S/D', 'Single/Double'],
                        ['D/A', 'Double/Aromatic'],
                        ['S/A', 'Single/Aromatic'],
                    ] as [string, string][]).map(([code, label]) => (
                        <MoreItem
                            key={`bond-query-${code}`}
                            label={(bondContextMenu.qlabel === code
                                ? '✓ ' : '   ') + label}
                            testid={`bond-ctx-query-${code.replace('/', '')}`}
                            onClick={() => {
                                const bm = bondContextMenu;
                                setBondContextMenu(null);
                                modelRef.current?.mutateBondToQuery(
                                    bm.a, bm.b, code);
                                setStatus(`bond query: ${code}`);
                            }} />
                    ))}
                    {/* Topology — Qt's ModifyBondsMenu::createTopologyMenu
                        (bond_context_menu.cpp:92). In Ring / Not In a Ring /
                        Either (clear). Routes through setBondTopologyForBond;
                        the active constraint carries a check. */}
                    <div style={styles.moreDivider} />
                    <div style={styles.moreSectionLabel}>Topology</div>
                    {([
                        ['ring', 'In Ring'],
                        ['notring', 'Not In a Ring'],
                        ['either', 'Either'],
                    ] as [string, string][]).map(([code, label]) => (
                        <MoreItem
                            key={`bond-topo-${code}`}
                            label={((code === 'either'
                                ? !bondContextMenu.topo
                                : bondContextMenu.topo === code)
                                ? '✓ ' : '   ') + label}
                            testid={`bond-ctx-topo-${code}`}
                            onClick={() => {
                                const bm = bondContextMenu;
                                setBondContextMenu(null);
                                modelRef.current?.setBondTopologyForBond(
                                    bm.a, bm.b, code);
                                setStatus(`bond topology: ${label}`);
                            }} />
                    ))}
                    <div style={styles.moreDivider} />
                    <MoreItem label='Delete' testid='bond-ctx-delete'
                        onClick={() => {
                            const bm = bondContextMenu;
                            setBondContextMenu(null);
                            modelRef.current?.removeBond(bm.a, bm.b);
                        }} />
                </div>
            )}
            {/* Atom context menu — mirrors Qt's AtomContextMenu
                (menu/atom_context_menu.cpp). Qt's menu order: Set Element /
                + Charge / – Charge / -- / Add Explicit H + Add/Remove
                Unpaired e– / -- / Edit Atom Properties... / Add Brackets...
                / Replace with > / -- / Delete. The lean MolModel only
                exposes adjustChargeOnSelectedAtoms + removeAtom right now,
                so this batch ships the minimal subset (Charge ±, Delete).
                Set Element / Add Explicit Hydrogens / Unpaired Electrons /
                Edit Atom Properties / Brackets / Replace with all require
                C++ primitives that aren't yet ported — they'll land in
                follow-up batches. Charge actions use a temp-selection
                dance: clearSelection → setAtomSelected(idx, true) →
                adjustChargeOnSelectedAtoms(±1) → clearSelection. Selection
                is non-undoable so the dance only adds one undo step (the
                charge edit itself). adjustChargeOnSelectedAtoms uses
                doCommand not doMutation, so the selection survives the
                edit and the trailing clearSelection cleans up. R-groups
                and attachment points can't take charges (Qt's is_r_group
                gate in ModifyAtomsMenu::updateActions) — both ± items are
                disabled when isRGroupOrAp. Charge cap is ±8 (Qt's
                ATOM_CHARGE_LIMIT in molviewer/constants.h:29). */}
            {atomContextMenu && (
                <div
                    ref={atomContextMenuRef}
                    style={{
                        ...styles.bgContextMenu,
                        left: atomContextMenu.x,
                        top: atomContextMenu.y,
                    }}
                    data-testid='atom-context-menu'
                    onContextMenu={(e) => e.preventDefault()}
                >
                    <div style={styles.moreSectionLabel}>
                        {atomContextMenu.el}
                        {atomContextMenu.q !== 0
                            ? ` (${atomContextMenu.q > 0 ? '+' : '−'}${
                                Math.abs(atomContextMenu.q)})`
                            : ''}
                    </div>
                    {/* Set Element submenu (Qt: ModifyAtomsMenu::createElementMenu
                        → SetAtomMenuWidget). Inline 4-col strip of the 8 fixed
                        elements; periodic-table popup is deferred to a follow-up
                        batch. Disabled for R-groups / attachment-points since
                        replaceAtom would discard their dummy properties. */}
                    <div style={styles.moreSectionLabel}>Set Element</div>
                    <div style={styles.atomCtxElementGrid}>
                        {FIXED_ELEMENTS.map((el) => {
                            const active = atomContextMenu.el === el;
                            const disabled = atomContextMenu.isRGroupOrAp
                                || active;
                            return (
                                <LetterButton
                                    key={el}
                                    label={el}
                                    color={ELEMENT_COLORS[el]}
                                    active={active}
                                    disabled={disabled}
                                    testid={`atom-ctx-set-${el}`}
                                    title={disabled ? (active
                                        ? `Already ${el}`
                                        : 'Cannot change R-group / attachment')
                                        : `Set to ${el}`}
                                    onClick={() => {
                                        if (disabled) return;
                                        const am = atomContextMenu;
                                        setAtomContextMenu(null);
                                        modelRef.current?.setAtomElement(
                                            am.atomIdx,
                                            FIXED_ELEMENT_ATOMIC_NUMS[el]);
                                        setStatus(`Set element: ${el}`);
                                    }} />
                            );
                        })}
                    </div>
                    {/* Periodic-table popup launcher (Qt:
                        SetAtomMenuWidget's ui->periodic_table_btn —
                        set_atom_widget.cpp:34-38). Same component the
                        toolbar uses; in the atom menu it's gated to
                        non-R-group atoms (replaceAtom would discard
                        their dummy properties) and won't re-fire if
                        the picked element matches what the atom already
                        is. */}
                    <PeriodicTableMenuItem
                        testid='atom-ctx-periodic-table'
                        disabled={atomContextMenu.isRGroupOrAp}
                        onPick={(sym, atomicNum) => {
                            const am = atomContextMenu;
                            setAtomContextMenu(null);
                            if (am.el === sym) {
                                setStatus(`Already ${sym}`);
                                return;
                            }
                            modelRef.current?.setAtomElement(
                                am.atomIdx, atomicNum);
                            setStatus(`Set element: ${sym}`);
                        }} />
                    <div style={styles.moreDivider} />
                    {/* Add/Remove Explicit Hydrogens (Qt:
                        ModifyAtomsMenu::m_add_remove_explicit_h_act,
                        atom_context_menu.cpp:57). Single action that toggles
                        label based on whether the clicked atom still has
                        implicit Hs (Qt: has_any_implicit_Hs). Disabled for
                        R-groups / attachment-points (queries, in Qt). */}
                    <MoreItem
                        label={atomContextMenu.nh > 0
                            ? 'Add Explicit Hydrogens'
                            : 'Remove Explicit Hydrogens'}
                        testid='atom-ctx-explicit-h'
                        disabled={atomContextMenu.isRGroupOrAp}
                        onClick={() => {
                            const am = atomContextMenu;
                            setAtomContextMenu(null);
                            if (am.nh > 0) {
                                modelRef.current?.addExplicitHsToAtoms(
                                    [am.atomIdx]);
                                setStatus('added explicit Hs to atom');
                            } else {
                                modelRef.current?.removeExplicitHsFromAtoms(
                                    [am.atomIdx]);
                                setStatus('removed explicit Hs from atom');
                            }
                        }} />
                    <MoreItem
                        label='+ Charge'
                        testid='atom-ctx-charge-plus'
                        disabled={atomContextMenu.isRGroupOrAp
                            || atomContextMenu.q >= 8}
                        onClick={() => {
                            const am = atomContextMenu;
                            setAtomContextMenu(null);
                            adjustChargeOnAtom(am.atomIdx, +1);
                        }} />
                    <MoreItem
                        label='− Charge'
                        testid='atom-ctx-charge-minus'
                        disabled={atomContextMenu.isRGroupOrAp
                            || atomContextMenu.q <= -8}
                        onClick={() => {
                            const am = atomContextMenu;
                            setAtomContextMenu(null);
                            adjustChargeOnAtom(am.atomIdx, -1);
                        }} />
                    {/* ± Unpaired Electrons (Qt:
                        ModifyAtomsMenu::m_add_remove_unpaired_e_acts,
                        atom_context_menu.cpp:62-72). Disabled on R-groups /
                        attachment points; gated to [MIN_UNPAIRED_E=0,
                        MAX_UNPAIRED_E=4] (molviewer/constants.h:41-42). */}
                    <MoreItem
                        label='+ Unpaired Electron'
                        testid='atom-ctx-radical-plus'
                        disabled={atomContextMenu.isRGroupOrAp
                            || atomContextMenu.nrad >= 4}
                        onClick={() => {
                            const am = atomContextMenu;
                            setAtomContextMenu(null);
                            modelRef.current?.adjustRadicalElectronsOnAtoms(
                                [am.atomIdx], +1);
                            setStatus('added unpaired electron');
                        }} />
                    <MoreItem
                        label='− Unpaired Electron'
                        testid='atom-ctx-radical-minus'
                        disabled={atomContextMenu.isRGroupOrAp
                            || atomContextMenu.nrad <= 0}
                        onClick={() => {
                            const am = atomContextMenu;
                            setAtomContextMenu(null);
                            modelRef.current?.adjustRadicalElectronsOnAtoms(
                                [am.atomIdx], -1);
                            setStatus('removed unpaired electron');
                        }} />
                    {/* Replace with — Qt's ReplaceAtomsWithMenu
                        (atom_context_menu.cpp:167). Wildcard (query atoms) +
                        R-Group branches ship here via the lean
                        mutateAtomToWildcard / mutateAtomToRGroup primitives.
                        Allowed List (needs the Edit Atom Properties dialog)
                        stays deferred. "New R-Group" picks the first free
                        number; each existing Rn offers an in-place renumber.
                        Wildcard order mirrors Qt's createWildcardMenu:
                        A/Q/M/X, then AH/QH/MH/XH. */}
                    <div style={styles.moreDivider} />
                    <div style={styles.moreSectionLabel}>Replace with</div>
                    {([
                        ['A', 'A (Any heavy atom)'],
                        ['Q', 'Q (Heteroatom)'],
                        ['M', 'M (Metal)'],
                        ['X', 'X (Halogen)'],
                        ['AH', 'AH (Any or H)'],
                        ['QH', 'QH (Hetero or H)'],
                        ['MH', 'MH (Metal or H)'],
                        ['XH', 'XH (Halogen or H)'],
                    ] as [string, string][]).map(([code, label]) => (
                        <MoreItem
                            key={`wildcard-${code}`}
                            label={label}
                            testid={`atom-ctx-replace-wildcard-${code}`}
                            onClick={() => {
                                const am = atomContextMenu;
                                setAtomContextMenu(null);
                                modelRef.current?.mutateAtomToWildcard(
                                    am.atomIdx, code);
                                setStatus(`Replaced with ${code}`);
                            }} />
                    ))}
                    <div style={styles.moreDivider} />
                    <MoreItem
                        label={`New R-Group (R${atomContextMenu.nextRGroup})`}
                        testid='atom-ctx-replace-new-rgroup'
                        onClick={() => {
                            const am = atomContextMenu;
                            setAtomContextMenu(null);
                            modelRef.current?.mutateAtomToRGroup(
                                am.atomIdx, am.nextRGroup);
                            setStatus(`Replaced with R${am.nextRGroup}`);
                        }} />
                    {atomContextMenu.existingRGroups.map((n) => (
                        <MoreItem
                            key={`rgroup-${n}`}
                            label={`R${n}`}
                            testid={`atom-ctx-replace-rgroup-${n}`}
                            onClick={() => {
                                const am = atomContextMenu;
                                setAtomContextMenu(null);
                                modelRef.current?.mutateAtomToRGroup(
                                    am.atomIdx, n);
                                setStatus(`Replaced with R${n}`);
                            }} />
                    ))}
                    <div style={styles.moreDivider} />
                    <MoreItem label='Delete' testid='atom-ctx-delete'
                        onClick={() => {
                            const am = atomContextMenu;
                            setAtomContextMenu(null);
                            modelRef.current?.removeAtom(am.atomIdx);
                        }} />
                </div>
            )}
            {/* AttachmentPointContextMenu (Qt:
                menu/attachment_point_context_menu.cpp:8). Just a title +
                Delete; reuses removeAtom which already strips the bond. */}
            {apContextMenu && (
                <div
                    ref={apContextMenuRef}
                    style={{
                        ...styles.bgContextMenu,
                        left: apContextMenu.x,
                        top: apContextMenu.y,
                    }}
                    data-testid='ap-context-menu'
                    onContextMenu={(e) => e.preventDefault()}
                >
                    <div style={styles.moreSectionLabel}>Attachment Point</div>
                    <MoreItem label='Delete' testid='ap-ctx-delete'
                        onClick={() => {
                            const am = apContextMenu;
                            setApContextMenu(null);
                            modelRef.current?.removeAtom(am.atomIdx);
                        }} />
                </div>
            )}
            {pasteModalOpen && (
                <div style={styles.modalOverlay}
                    data-testid='paste-text-modal'
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            setPasteModalOpen(false);
                        }
                    }}>
                    <div style={styles.modalCard}>
                        <div style={styles.modalTitle}>Paste in Text</div>
                        <textarea
                            value={pasteText}
                            onChange={(e) => setPasteText(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Escape') {
                                    e.preventDefault();
                                    setPasteModalOpen(false);
                                } else if (e.key === 'Enter' &&
                                    (e.ctrlKey || e.metaKey)) {
                                    e.preventDefault();
                                    submitPasteModal();
                                }
                            }}
                            placeholder='Paste SMILES (c1ccccc1) or a MOL block — Cmd+Enter to Load'
                            style={styles.modalTextarea}
                            data-testid='paste-text-input'
                            spellCheck={false}
                            autoFocus
                        />
                        <div style={styles.modalButtons}>
                            <button type='button' style={styles.modalBtn}
                                data-testid='paste-text-cancel'
                                onClick={() => setPasteModalOpen(false)}>
                                Cancel
                            </button>
                            <button type='button' style={styles.modalBtnPrimary}
                                data-testid='paste-text-load'
                                onClick={submitPasteModal}>
                                Load
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {exportModalOpen && (
                <div style={styles.modalOverlay}
                    data-testid='export-modal'
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            setExportModalOpen(false);
                        }
                    }}>
                    <div style={styles.modalCard}>
                        <div style={styles.modalTitle}>Export to File</div>
                        <div style={styles.modalRow}>
                            <label htmlFor='export-format-select'
                                style={styles.modalLabel}>
                                Format
                            </label>
                            <select
                                id='export-format-select'
                                data-testid='export-format-select'
                                value={exportFormat}
                                onChange={(e) =>
                                    setExportFormat(
                                        e.target.value as ExportFormat,
                                    )
                                }
                                style={styles.modalSelect}>
                                {EXPORT_FORMAT_CHOICES.map((c) => (
                                    <option key={c.value} value={c.value}>
                                        {c.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <textarea
                            readOnly
                            value={computeExport(exportFormat)}
                            style={styles.modalTextarea}
                            data-testid='export-text'
                            spellCheck={false}
                        />
                        <div style={styles.modalButtons}>
                            <button type='button' style={styles.modalBtn}
                                data-testid='export-close'
                                onClick={() => setExportModalOpen(false)}>
                                Close
                            </button>
                            <button type='button' style={styles.modalBtn}
                                data-testid='export-download'
                                onClick={doExportDownload}>
                                Download
                            </button>
                            <button type='button' style={styles.modalBtnPrimary}
                                data-testid='export-copy'
                                onClick={() => { void doExportCopy(); }}>
                                Copy
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {imageModalOpen && (
                <div style={styles.modalOverlay}
                    data-testid='save-image-modal'
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            setImageModalOpen(false);
                        }
                    }}>
                    <div style={styles.modalCard}>
                        <div style={styles.modalTitle}>Save Image</div>
                        <div style={styles.modalRow}>
                            <label htmlFor='save-image-format-select'
                                style={styles.modalLabel}>
                                Format
                            </label>
                            <select
                                id='save-image-format-select'
                                data-testid='save-image-format-select'
                                value={imageFormat}
                                onChange={(e) =>
                                    setImageFormat(
                                        e.target.value as ImageFormat,
                                    )
                                }
                                style={styles.modalSelect}>
                                {IMAGE_FORMAT_CHOICES.map((c) => (
                                    <option key={c.value} value={c.value}>
                                        {c.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div style={styles.modalRow}>
                            <label htmlFor='save-image-width'
                                style={styles.modalLabel}>
                                Width
                            </label>
                            <input
                                id='save-image-width'
                                type='number'
                                min={IMAGE_SIZE_MIN}
                                max={IMAGE_SIZE_MAX}
                                step={1}
                                value={imageWidth}
                                data-testid='save-image-width'
                                onChange={(e) => {
                                    const n = Number(e.target.value);
                                    if (Number.isFinite(n)) setImageWidth(n);
                                }}
                                style={styles.modalNumber}
                            />
                            <label htmlFor='save-image-height'
                                style={styles.modalLabel}>
                                Height
                            </label>
                            <input
                                id='save-image-height'
                                type='number'
                                min={IMAGE_SIZE_MIN}
                                max={IMAGE_SIZE_MAX}
                                step={1}
                                value={imageHeight}
                                data-testid='save-image-height'
                                onChange={(e) => {
                                    const n = Number(e.target.value);
                                    if (Number.isFinite(n)) setImageHeight(n);
                                }}
                                style={styles.modalNumber}
                            />
                            <label style={{
                                ...styles.modalLabel,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                                cursor: 'pointer',
                            }}>
                                <input
                                    type='checkbox'
                                    checked={imageTransparent}
                                    data-testid='save-image-transparent'
                                    onChange={(e) =>
                                        setImageTransparent(e.target.checked)
                                    }
                                />
                                Transparent background
                            </label>
                        </div>
                        <div style={styles.modalStatus}
                            data-testid='save-image-status'>
                            {imageTransparent ? 'Transparent' : 'White'}
                            {' '}background, {Math.max(IMAGE_SIZE_MIN,
                                Math.min(IMAGE_SIZE_MAX,
                                    Math.round(imageWidth)))}
                            {' x '}
                            {Math.max(IMAGE_SIZE_MIN,
                                Math.min(IMAGE_SIZE_MAX,
                                    Math.round(imageHeight)))}
                            {' px'}
                        </div>
                        <div style={styles.modalButtons}>
                            <button type='button' style={styles.modalBtn}
                                data-testid='save-image-cancel'
                                onClick={() => setImageModalOpen(false)}>
                                Cancel
                            </button>
                            <button type='button' style={styles.modalBtnPrimary}
                                data-testid='save-image-save'
                                onClick={doSaveImage}>
                                Save
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {welcomeModalOpen && (
                <div style={styles.modalOverlay}
                    data-testid='welcome-modal'
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            setWelcomeModalOpen(false);
                        }
                    }}>
                    <div style={{ ...styles.modalCard, maxWidth: 520 }}>
                        <div style={styles.modalTitle}>
                            Schrödinger Sketcher — Welcome
                        </div>
                        <div style={{ font: '12px sans-serif', color: '#333' }}>
                            Welcome to the Schrödinger Sketcher! Here are some
                            tips to help you get started:
                        </div>
                        <div style={styles.welcomeTip}>
                            <div style={styles.welcomeTipHeading}>
                                Select Mode
                            </div>
                            <div style={styles.welcomeTipBody}>
                                When structure has been selected, only the
                                tools that can be used with the selection
                                will remain available. Click a tool or use
                                a keyboard shortcut to take an action on
                                the selection. To restore normal drawing,
                                clear the selection.
                            </div>
                        </div>
                        <div style={styles.welcomeTip}>
                            <div style={styles.welcomeTipHeading}>
                                Chooser Buttons
                            </div>
                            <div style={styles.welcomeTipBody}>
                                Buttons showing a little triangle in the
                                bottom right corner offer a choice of
                                related tools. To use the currently
                                displayed tool, just click the button. To
                                choose a different tool, press and hold
                                the button to open the chooser.
                            </div>
                        </div>
                        <div style={styles.welcomeTip}>
                            <div style={styles.welcomeTipHeading}>
                                Mouse Actions
                            </div>
                            <div style={styles.welcomeTipBody}>
                                All the tools work with the left-mouse
                                button, but you can also translate and
                                rotate the structure or selected parts of
                                it by dragging with your right- or
                                middle-mouse button. Right-clicking on an
                                atom or bond will bring up a useful
                                context menu.
                            </div>
                        </div>
                        <div style={styles.modalButtons}>
                            <button type='button' style={styles.modalBtnPrimary}
                                data-testid='welcome-ok'
                                onClick={() => setWelcomeModalOpen(false)}>
                                OK
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {aboutModalOpen && (
                <div style={styles.modalOverlay}
                    data-testid='about-modal'
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            setAboutModalOpen(false);
                        }
                    }}>
                    <div style={{ ...styles.modalCard, maxWidth: 420 }}>
                        <div style={styles.modalTitle}>
                            About Schrödinger 2D Sketcher
                        </div>
                        <div style={styles.aboutLine}
                            data-testid='about-version'>
                            Release {SKETCHER_VERSION}
                        </div>
                        <div style={styles.aboutLine}>
                            Qt-free Port
                        </div>
                        <div style={styles.aboutLine}>
                            © {new Date().getFullYear()} Schrödinger, Inc.
                        </div>
                        <div style={{
                            ...styles.aboutLine,
                            paddingTop: 4,
                        }}>
                            <a href={EULA_URL}
                                target='_blank'
                                rel='noopener noreferrer'
                                data-testid='about-eula'
                                style={styles.aboutLink}>
                                License Agreement
                            </a>
                        </div>
                        <div style={styles.modalButtons}>
                            <button type='button' style={styles.modalBtnPrimary}
                                data-testid='about-close'
                                onClick={() => setAboutModalOpen(false)}>
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {/*
                Preferences (2D Settings) modal — mirrors
                ui/rendering_settings_dialog.ui windowTitle "2D Settings".
                Qt lays this out as a row of font/line-width spinboxes
                above a 2-column grid of toggle groups; we keep the same
                grouping (settings shipped today: font size, bond width,
                show stereo annotations + 'ABS' prefix, color heteroatoms)
                so users coming from Qt find the same knobs in the same
                places. Carbon-label modes / color-mode comboboxes are
                tracked as follow-up batches in project_qt_removal.md.
              */}
            {preferencesOpen && (
                <div style={styles.modalOverlay}
                    data-testid='preferences-modal'
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            setPreferencesOpen(false);
                        }
                    }}>
                    <div style={{ ...styles.modalCard, maxWidth: 480 }}>
                        <div style={styles.modalTitle}>2D Settings</div>
                        <div style={styles.prefsRow}>
                            <label style={styles.modalLabel}
                                htmlFor='preferences-font-size'>
                                Atom font size:
                            </label>
                            <input id='preferences-font-size' type='number'
                                data-testid='preferences-font-size'
                                style={styles.modalNumber}
                                min={1} max={200} step={1}
                                value={displayOptions.atomFontSize}
                                onChange={(e) => {
                                    const n = Number(e.target.value);
                                    if (!Number.isFinite(n)) return;
                                    const clamped = Math.max(
                                        1, Math.min(200, Math.round(n)));
                                    setDisplayOptions((opt) => ({
                                        ...opt, atomFontSize: clamped,
                                    }));
                                }} />
                            <label style={{ ...styles.modalLabel,
                                marginLeft: 16 }}
                                htmlFor='preferences-bond-width'>
                                Bond line width:
                            </label>
                            <input id='preferences-bond-width' type='number'
                                data-testid='preferences-bond-width'
                                style={styles.modalNumber}
                                min={0.1} max={20} step={0.1}
                                value={displayOptions.bondLineWidth}
                                onChange={(e) => {
                                    const n = Number(e.target.value);
                                    if (!Number.isFinite(n) || n < 0.1) {
                                        return;
                                    }
                                    setDisplayOptions((opt) => ({
                                        ...opt, bondLineWidth: n,
                                    }));
                                }} />
                        </div>
                        <div style={styles.prefsSeparator} />
                        <div style={styles.prefsGrid}>
                            <div>
                                {/* Qt's m_label_carbons_cb +
                                    m_label_terminal_C_rb / m_label_all_C_rb
                                    (rendering_settings_dialog.ui:103-225).
                                    Default is unchecked (NONE); first toggle
                                    selects Terminal-only to match Qt's
                                    `<bool>true</bool>` on m_label_terminal_C_rb.
                                    Radios disable when the checkbox is off. */}
                                <label style={styles.prefsCheckRow}>
                                    <input type='checkbox'
                                        data-testid={
                                            'preferences-label-carbons'}
                                        checked={
                                            displayOptions.carbonLabels
                                                !== 'none'}
                                        onChange={(e) => {
                                            setDisplayOptions((opt) => ({
                                                ...opt,
                                                carbonLabels: e.target.checked
                                                    ? 'terminal'
                                                    : 'none',
                                            }));
                                        }} />
                                    Label carbons:
                                </label>
                                <label style={{ ...styles.prefsCheckRow,
                                    ...styles.prefsIndented,
                                    opacity:
                                        displayOptions.carbonLabels !== 'none'
                                            ? 1 : 0.5 }}>
                                    <input type='radio'
                                        name='preferences-label-carbons-mode'
                                        data-testid={
                                            'preferences-label-terminal-rb'}
                                        disabled={
                                            displayOptions.carbonLabels
                                                === 'none'}
                                        checked={
                                            displayOptions.carbonLabels
                                                === 'terminal'}
                                        onChange={() => {
                                            setDisplayOptions((opt) => ({
                                                ...opt,
                                                carbonLabels: 'terminal',
                                            }));
                                        }} />
                                    Terminal only
                                </label>
                                <label style={{ ...styles.prefsCheckRow,
                                    ...styles.prefsIndented,
                                    opacity:
                                        displayOptions.carbonLabels !== 'none'
                                            ? 1 : 0.5 }}>
                                    <input type='radio'
                                        name='preferences-label-carbons-mode'
                                        data-testid={
                                            'preferences-label-all-rb'}
                                        disabled={
                                            displayOptions.carbonLabels
                                                === 'none'}
                                        checked={
                                            displayOptions.carbonLabels
                                                === 'all'}
                                        onChange={() => {
                                            setDisplayOptions((opt) => ({
                                                ...opt,
                                                carbonLabels: 'all',
                                            }));
                                        }} />
                                    All
                                </label>
                            </div>
                            <div>
                                <label style={styles.prefsCheckRow}>
                                    <input type='checkbox'
                                        data-testid={
                                            'preferences-show-stereo'}
                                        checked={
                                            displayOptions.showStereoLabels}
                                        onChange={() =>
                                            toggleDisplayOption(
                                                'showStereoLabels')} />
                                    Show stereo annotations
                                </label>
                                <label style={{ ...styles.prefsCheckRow,
                                    ...styles.prefsIndented,
                                    opacity: displayOptions.showStereoLabels
                                        ? 1 : 0.5 }}>
                                    <input type='checkbox'
                                        data-testid='preferences-abs-prefix'
                                        disabled={
                                            !displayOptions.showStereoLabels}
                                        checked={
                                            displayOptions.explicitAbsLabels}
                                        onChange={() =>
                                            toggleDisplayOption(
                                                'explicitAbsLabels')} />
                                    Use &lsquo;ABS&rsquo; prefix
                                </label>
                                <label style={{ ...styles.prefsCheckRow,
                                    ...styles.prefsIndented,
                                    opacity: displayOptions.showStereoLabels
                                        ? 1 : 0.5 }}>
                                    <input type='checkbox'
                                        data-testid={
                                            'preferences-include-undefined-stereo'}
                                        disabled={
                                            !displayOptions.showStereoLabels}
                                        checked={
                                            displayOptions
                                                .includeUndefinedStereoCenters}
                                        onChange={() =>
                                            toggleDisplayOption(
                                                'includeUndefinedStereoCenters')} />
                                    Include undefined centers
                                </label>
                                <label style={styles.prefsCheckRow}>
                                    <input type='checkbox'
                                        data-testid={
                                            'preferences-color-heteroatoms'}
                                        checked={
                                            displayOptions.colorHeteroatoms}
                                        onChange={() =>
                                            toggleDisplayOption(
                                                'colorHeteroatoms')} />
                                    Color heteroatoms
                                </label>
                                {/* Qt's m_color_mode_combo / m_bw_mode_combo
                                    (rendering_settings_dialog.ui:137-154 +
                                    rendering_settings_dialog.cpp:67-82,
                                    111-130). Only one combo shows at a
                                    time, gated by Color Heteroatoms.
                                    Picking "Dark" in one combo mirrors
                                    the Dark bit to the other (mirrors
                                    the sync_comboboxes lambda) so
                                    toggling Color Heteroatoms preserves
                                    the user's light/dark intent. */}
                                <label style={{ ...styles.prefsCheckRow,
                                    ...styles.prefsIndented }}>
                                    Color mode:
                                    {displayOptions.colorHeteroatoms ? (
                                        <select
                                            data-testid={
                                                'preferences-color-mode'}
                                            value={displayOptions.colorScheme}
                                            onChange={(e) => {
                                                const v: ColorScheme =
                                                    e.target.value as ColorScheme;
                                                setDisplayOptions((opt) => ({
                                                    ...opt,
                                                    colorScheme: v,
                                                    bwColorScheme:
                                                        v === 'dark'
                                                            ? 'dark'
                                                            : 'default',
                                                }));
                                            }}>
                                            <option value='default'>
                                                Default
                                            </option>
                                            <option value='avalon'>
                                                Avalon
                                            </option>
                                            <option value='cdk'>
                                                CDK
                                            </option>
                                            <option value='dark'>
                                                Dark
                                            </option>
                                        </select>
                                    ) : (
                                        <select
                                            data-testid={
                                                'preferences-bw-mode'}
                                            value={
                                                displayOptions.bwColorScheme}
                                            onChange={(e) => {
                                                const v: BWColorScheme =
                                                    e.target.value as BWColorScheme;
                                                setDisplayOptions((opt) => ({
                                                    ...opt,
                                                    bwColorScheme: v,
                                                    colorScheme:
                                                        v === 'dark'
                                                            ? 'dark'
                                                            : (opt.colorScheme
                                                                === 'dark'
                                                                ? 'default'
                                                                : opt.colorScheme),
                                                }));
                                            }}>
                                            <option value='default'>
                                                Default
                                            </option>
                                            <option value='dark'>
                                                Dark
                                            </option>
                                        </select>
                                    )}
                                </label>
                            </div>
                        </div>
                        <div style={styles.modalButtons}>
                            <button type='button' style={styles.modalBtn}
                                data-testid='preferences-reset'
                                onClick={() => setDisplayOptions((opt) => ({
                                    ...opt,
                                    atomFontSize: DEFAULT_ATOM_FONT_SIZE,
                                    bondLineWidth: DEFAULT_BOND_LINE_WIDTH,
                                    colorHeteroatoms: true,
                                    showStereoLabels: true,
                                    explicitAbsLabels: false,
                                    includeUndefinedStereoCenters: true,
                                    carbonLabels: 'none',
                                    colorScheme: 'default',
                                    bwColorScheme: 'default',
                                }))}>
                                Reset to Defaults
                            </button>
                            <button type='button' style={styles.modalBtnPrimary}
                                data-testid='preferences-close'
                                onClick={() => setPreferencesOpen(false)}>
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </section>
    );
}

interface MoreItemProps {
    label: string;
    onClick: () => void;
    testid: string;
    disabled?: boolean;
}

function MoreItem(
    { label, onClick, testid, disabled = false }: MoreItemProps,
): JSX.Element {
    const [hover, setHover] = useState(false);
    return (
        <button
            type='button'
            style={{
                ...styles.moreItem,
                ...(hover && !disabled ? styles.moreItemHover : {}),
                ...(disabled ? styles.moreItemDisabled : {}),
            }}
            onClick={onClick}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            data-testid={testid}
            disabled={disabled}
            aria-disabled={disabled || undefined}
        >
            {label}
        </button>
    );
}

// Checkable dropdown item — mirrors Qt's `QAction::setCheckable(true)` on
// the four ConfigureViewMenu actions. A leading ✓ glyph appears when
// `checked`; clicking flips state via `onToggle`. The menu stays open so
// the user can toggle multiple items in one go, matching Qt's
// InstantPopup + non-exclusive QAction behavior.
interface ToggleMenuItemProps {
    label: string;
    checked: boolean;
    onToggle: () => void;
    testid: string;
}

function ToggleMenuItem({
    label, checked, onToggle, testid,
}: ToggleMenuItemProps): JSX.Element {
    const [hover, setHover] = useState(false);
    return (
        <button
            type='button'
            role='menuitemcheckbox'
            aria-checked={checked}
            style={{
                ...styles.moreItem,
                ...(hover ? styles.moreItemHover : {}),
                display: 'flex',
                alignItems: 'center',
                gap: 6,
            }}
            onClick={onToggle}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            data-testid={testid}
        >
            <span style={{
                width: 12,
                display: 'inline-block',
                color: '#3d5d71',
                fontWeight: 700,
            }}>
                {checked ? '✓' : ''}
            </span>
            {label}
        </button>
    );
}

// 32×32 tool button rendering /icons/{icon}.svg (auto _dis variant when
// disabled). Matches Qt QToolButton style: no border, transparent bg,
// checked #d4e6f1, hover #edf7fc.
interface IconButtonProps {
    icon: string;
    onClick: () => void;
    testid: string;
    title?: string;
    active?: boolean;
    disabled?: boolean;
    wide?: boolean; // double-width cell (periodic_table colspan=2)
}

function IconButton({
    icon, onClick, testid, title, active, disabled, wide,
}: IconButtonProps): JSX.Element {
    const [hover, setHover] = useState(false);
    const src = `/icons/${icon}${disabled ? '_dis' : ''}.svg`;
    return (
        <button
            type='button'
            style={{
                ...styles.iconBtn,
                ...(wide ? styles.iconBtnWide : {}),
                ...(hover && !active && !disabled ? styles.iconBtnHover : {}),
                ...(active ? styles.iconBtnActive : {}),
            }}
            onClick={onClick}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            data-testid={testid}
            disabled={disabled}
            aria-pressed={active}
            title={title}
        >
            <img src={src} alt='' draggable={false} style={styles.iconImg} />
        </button>
    );
}

// ModularToolButton equivalent — a 32×32 icon button that opens a popup on
// long-press (250 ms) OR on click-when-already-active. Wedge indicator at
// the bottom-right corner shows the popup is available. Picking from the
// popup fires `onPick(choice)` and closes the popup.
//
// Qt sources: widget/modular_tool_button.cpp (icon swap on selectionChanged
// + click()), widget/tool_button_with_popup.cpp (250 ms popup timer +
// onClicked-when-checked opens popup), widget/modular_popup.cpp (popup
// emits selectionChanged on button click, closes immediately).
interface PopupChoice<T extends string> {
    value: T;
    icon?: string;   // omit for text-only choices (e.g. atom-query A/Q/M/X)
    label?: string;  // text rendered on the button face when icon is unset
    title: string;
    testid: string;
}

interface IconButtonWithPopupProps<T extends string> {
    // Either `icon` (renders an svg) or `label` (renders bold text) must be
    // set. The atom-query button (Qt: "A" 14pt bold italic, no icon) uses
    // `label`; everything else uses `icon`.
    icon?: string;
    label?: string;
    onClick: () => void;
    testid: string;
    title?: string;
    active?: boolean;
    choices: PopupChoice<T>[];
    onPick: (value: T) => void;
    // Optional override for the trigger button's style (e.g. the wide RNA/DNA
    // nucleotide selectors). Defaults to the letter/icon button look.
    buttonStyle?: React.CSSProperties;
}

const POPUP_DELAY_MS = 250; // Qt ToolButtonWithPopup::m_popup_delay default

function IconButtonWithPopup<T extends string>({
    icon, label, onClick, testid, title, active, choices, onPick, buttonStyle,
}: IconButtonWithPopupProps<T>): JSX.Element {
    const [hover, setHover] = useState(false);
    const [popupOpen, setPopupOpen] = useState(false);
    // Set true when the long-press timer fires — we use this to suppress the
    // click event that would otherwise follow the mouseup (which would
    // double-fire onClick on top of the popup we already showed).
    const longPressFiredRef = useRef(false);
    const longPressTimerRef = useRef<number | null>(null);
    const wrapperRef = useRef<HTMLDivElement | null>(null);

    const cancelLongPress = useCallback((): void => {
        if (longPressTimerRef.current !== null) {
            window.clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    }, []);

    const handleMouseDown = useCallback((): void => {
        longPressFiredRef.current = false;
        cancelLongPress();
        longPressTimerRef.current = window.setTimeout(() => {
            longPressFiredRef.current = true;
            setPopupOpen(true);
        }, POPUP_DELAY_MS);
    }, [cancelLongPress]);

    const handleClick = useCallback((): void => {
        if (longPressFiredRef.current) {
            // Long-press already opened the popup — swallow the trailing click.
            longPressFiredRef.current = false;
            return;
        }
        if (active) {
            // Qt ToolButtonWithPopup::onClicked (line 113 in .h): a click
            // while the button is already checked re-opens the popup so the
            // user can pick a different sub-option without a second long press.
            setPopupOpen(true);
            return;
        }
        onClick();
    }, [active, onClick]);

    // Close popup on outside click. We listen on document mousedown so a
    // press starting outside the popup closes it before the click resolves
    // on whatever was actually clicked.
    useEffect(() => {
        if (!popupOpen) return;
        function onDocMouseDown(e: globalThis.MouseEvent): void {
            const target = e.target as Node;
            if (wrapperRef.current && !wrapperRef.current.contains(target)) {
                setPopupOpen(false);
            }
        }
        document.addEventListener('mousedown', onDocMouseDown);
        return () => {
            document.removeEventListener('mousedown', onDocMouseDown);
        };
    }, [popupOpen]);

    return (
        <div ref={wrapperRef} style={{ position: 'relative' }}>
            <button
                type='button'
                style={{
                    ...(buttonStyle
                        ?? (label !== undefined ? styles.letterBtn
                            : styles.iconBtn)),
                    ...(hover && !active ? styles.iconBtnHover : {}),
                    ...(active ? styles.iconBtnActive : {}),
                    position: 'relative',
                }}
                onMouseDown={handleMouseDown}
                onMouseUp={cancelLongPress}
                onMouseEnter={() => setHover(true)}
                onMouseLeave={() => { setHover(false); cancelLongPress(); }}
                onClick={handleClick}
                data-testid={testid}
                aria-pressed={active}
                aria-haspopup='menu'
                aria-expanded={popupOpen}
                title={title}
            >
                {label !== undefined
                    ? label
                    : <img src={`/icons/${icon}.svg`} alt='' draggable={false}
                        style={styles.iconImg} />}
                <span style={styles.popupWedge} aria-hidden='true' />
            </button>
            {popupOpen && (
                <div style={styles.iconPopup}
                    data-testid={`${testid}-popup`}
                    role='menu'>
                    {choices.map((c) => (
                        <PopupChoiceButton
                            key={c.testid}
                            choice={c}
                            onPick={() => {
                                setPopupOpen(false);
                                onPick(c.value);
                            }}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

interface PopupChoiceButtonProps<T extends string> {
    choice: PopupChoice<T>;
    onPick: () => void;
}

function PopupChoiceButton<T extends string>({
    choice, onPick,
}: PopupChoiceButtonProps<T>): JSX.Element {
    const [hover, setHover] = useState(false);
    const hasLabel = choice.label !== undefined;
    return (
        <button
            type='button'
            style={{
                ...(hasLabel ? styles.letterBtn : styles.iconBtn),
                ...(hover ? styles.iconBtnHover : {}),
            }}
            onClick={onPick}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            data-testid={choice.testid}
            // Qt ModularPopup::getToolTip appends "– press & hold to change"
            // to every popup item. Mirror that here so a user hovering the
            // chosen item in the parent button later sees the same hint.
            title={`${choice.title} – press & hold to change`}
            role='menuitem'
        >
            {hasLabel
                ? choice.label
                : <img src={`/icons/${choice.icon}.svg`} alt=''
                    draggable={false} style={styles.iconImg} />}
        </button>
    );
}

// 32×32 letter button — atom elements + the "A▾" atom-query button.
// Matches Qt ATOM_ELEMENT_OR_MONOMER_STYLE: 14pt Arimo bold #333333.
interface LetterButtonProps {
    label: string;
    onClick: () => void;
    testid: string;
    title?: string;
    active?: boolean;
    color?: string;
    disabled?: boolean;
}

function LetterButton({
    label, onClick, testid, title, active, color, disabled,
}: LetterButtonProps): JSX.Element {
    const [hover, setHover] = useState(false);
    return (
        <button
            type='button'
            style={{
                ...styles.letterBtn,
                ...(color && !active && !disabled ? { color } : {}),
                ...(hover && !active && !disabled ? styles.iconBtnHover : {}),
                ...(active ? styles.iconBtnActive : {}),
                ...(disabled
                    ? { opacity: 0.4, cursor: 'not-allowed' }
                    : {}),
            }}
            onClick={onClick}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            data-testid={testid}
            aria-pressed={active}
            aria-disabled={disabled}
            disabled={disabled}
            title={title}
        >
            {label}
        </button>
    );
}

// Layout + element-class palette extracted verbatim from
// src/schrodinger/sketcher/ui/periodic_table_widget.ui — the Qt form file
// is the source of truth for both row/col positions and the
// QToolButton[class='…'] CSS bucketing in PERIODIC_TABLE_STYLE.
// 10 rows × 18 cols. null = empty cell (group 3 in periods 6–7 sits in
// the lanthanide/actinide rows below).
type PTCell = readonly [symbol: string, cssClass: string] | null;
const PT_LAYOUT: readonly (readonly PTCell[])[] = [
    [['H','hydrogen'], null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, ['He','noble_gases']],
    [['Li','alkali_metals'], ['Be','alkaline_earth_metals'], null, null, null, null, null, null, null, null, null, null, ['B','metalloids'], ['C','non_metals'], ['N','non_metals'], ['O','non_metals'], ['F','halogens'], ['Ne','noble_gases']],
    [['Na','alkali_metals'], ['Mg','alkaline_earth_metals'], null, null, null, null, null, null, null, null, null, null, ['Al','other_metals'], ['Si','metalloids'], ['P','non_metals'], ['S','non_metals'], ['Cl','halogens'], ['Ar','noble_gases']],
    [['K','alkali_metals'], ['Ca','alkaline_earth_metals'], ['Sc','transition_metals'], ['Ti','transition_metals'], ['V','transition_metals'], ['Cr','transition_metals'], ['Mn','transition_metals'], ['Fe','transition_metals'], ['Co','transition_metals'], ['Ni','transition_metals'], ['Cu','transition_metals'], ['Zn','transition_metals'], ['Ga','other_metals'], ['Ge','metalloids'], ['As','metalloids'], ['Se','non_metals'], ['Br','halogens'], ['Kr','noble_gases']],
    [['Rb','alkali_metals'], ['Sr','alkaline_earth_metals'], ['Y','transition_metals'], ['Zr','transition_metals'], ['Nb','transition_metals'], ['Mo','transition_metals'], ['Tc','transition_metals'], ['Ru','transition_metals'], ['Rh','transition_metals'], ['Pd','transition_metals'], ['Ag','transition_metals'], ['Cd','transition_metals'], ['In','other_metals'], ['Sn','other_metals'], ['Sb','metalloids'], ['Te','metalloids'], ['I','halogens'], ['Xe','noble_gases']],
    [['Cs','alkali_metals'], ['Ba','alkaline_earth_metals'], null, ['Hf','transition_metals'], ['Ta','transition_metals'], ['W','transition_metals'], ['Re','transition_metals'], ['Os','transition_metals'], ['Ir','transition_metals'], ['Pt','transition_metals'], ['Au','transition_metals'], ['Hg','transition_metals'], ['Tl','other_metals'], ['Pb','other_metals'], ['Bi','other_metals'], ['Po','metalloids'], ['At','halogens'], ['Rn','noble_gases']],
    [['Fr','alkali_metals'], ['Ra','alkaline_earth_metals'], null, ['Rf','transition_metals'], ['Db','transition_metals'], ['Sg','transition_metals'], ['Bh','transition_metals'], ['Hs','transition_metals'], ['Mt','transition_metals'], ['Ds','transition_metals'], ['Rg','transition_metals'], ['Cn','transition_metals'], ['Nh','other_metals'], ['Fl','other_metals'], ['Mc','other_metals'], ['Lv','other_metals'], ['Ts','halogens'], ['Og','noble_gases']],
    [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
    [null, null, ['La','lanthanides'], ['Ce','lanthanides'], ['Pr','lanthanides'], ['Nd','lanthanides'], ['Pm','lanthanides'], ['Sm','lanthanides'], ['Eu','lanthanides'], ['Gd','lanthanides'], ['Tb','lanthanides'], ['Dy','lanthanides'], ['Ho','lanthanides'], ['Er','lanthanides'], ['Tm','lanthanides'], ['Yb','lanthanides'], ['Lu','lanthanides'], null],
    [null, null, ['Ac','actinides'], ['Th','actinides'], ['Pa','actinides'], ['U','actinides'], ['Np','actinides'], ['Pu','actinides'], ['Am','actinides'], ['Cm','actinides'], ['Bk','actinides'], ['Cf','actinides'], ['Es','actinides'], ['Fm','actinides'], ['Md','actinides'], ['No','actinides'], ['Lr','actinides'], null],
];

// Symbol → atomic number for every element in PT_LAYOUT. Used by the
// periodic-table popup when wired into the atom / selection context menus
// so the picked element can be routed through MolModel.setAtomElement /
// setElementForSelectedAtoms (both take atomic numbers, mirroring RDKit's
// PeriodicTable::getAtomicNumber). Listed in atomic-number order — H=1
// through Og=118.
const SYMBOL_TO_ATOMIC_NUM: Record<string, number> = {
    H: 1, He: 2, Li: 3, Be: 4, B: 5, C: 6, N: 7, O: 8, F: 9, Ne: 10,
    Na: 11, Mg: 12, Al: 13, Si: 14, P: 15, S: 16, Cl: 17, Ar: 18,
    K: 19, Ca: 20, Sc: 21, Ti: 22, V: 23, Cr: 24, Mn: 25, Fe: 26,
    Co: 27, Ni: 28, Cu: 29, Zn: 30, Ga: 31, Ge: 32, As: 33, Se: 34,
    Br: 35, Kr: 36, Rb: 37, Sr: 38, Y: 39, Zr: 40, Nb: 41, Mo: 42,
    Tc: 43, Ru: 44, Rh: 45, Pd: 46, Ag: 47, Cd: 48, In: 49, Sn: 50,
    Sb: 51, Te: 52, I: 53, Xe: 54, Cs: 55, Ba: 56, La: 57, Ce: 58,
    Pr: 59, Nd: 60, Pm: 61, Sm: 62, Eu: 63, Gd: 64, Tb: 65, Dy: 66,
    Ho: 67, Er: 68, Tm: 69, Yb: 70, Lu: 71, Hf: 72, Ta: 73, W: 74,
    Re: 75, Os: 76, Ir: 77, Pt: 78, Au: 79, Hg: 80, Tl: 81, Pb: 82,
    Bi: 83, Po: 84, At: 85, Rn: 86, Fr: 87, Ra: 88, Ac: 89, Th: 90,
    Pa: 91, U: 92, Np: 93, Pu: 94, Am: 95, Cm: 96, Bk: 97, Cf: 98,
    Es: 99, Fm: 100, Md: 101, No: 102, Lr: 103, Rf: 104, Db: 105,
    Sg: 106, Bh: 107, Hs: 108, Mt: 109, Ds: 110, Rg: 111, Cn: 112,
    Nh: 113, Fl: 114, Mc: 115, Lv: 116, Ts: 117, Og: 118,
};

// Element-class background colors, copied verbatim from
// PERIODIC_TABLE_STYLE in sketcher_css_style.h.
const PT_CLASS_BG: Record<string, string> = {
    hydrogen: '#b2bcc2',
    alkali_metals: '#b7d9ec',
    alkaline_earth_metals: '#8fbed9',
    transition_metals: '#f2d2c6',
    other_metals: '#f2d2c6',
    metalloids: '#e1baad',
    non_metals: '#f2e8b7',
    halogens: '#f2e392',
    noble_gases: '#eccc75',
    lanthanides: '#cce5c3',
    actinides: '#afd1a2',
};

// Qt PeriodicTableWidget: free-floating Qt::Popup, opens on click (no
// long-press, no popup wedge — setPopupDelay(0), showPopupIndicator(false)
// upstream). React port renders the popup as an absolutely-positioned grid
// dropdown beneath the trigger button; outside-click closes it.
interface PeriodicTableButtonProps {
    testid: string;
    onPick: (element: string, atomicNum: number) => void;
}
function PeriodicTableButton({
    testid, onPick,
}: PeriodicTableButtonProps): JSX.Element {
    const [hover, setHover] = useState(false);
    const [open, setOpen] = useState(false);
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    usePeriodicTableOutsideClick(open, setOpen, wrapperRef);

    return (
        <div ref={wrapperRef} style={{ position: 'relative' }}>
            <button
                type='button'
                style={{
                    ...styles.iconBtn,
                    ...styles.iconBtnWide,
                    ...(hover ? styles.iconBtnHover : {}),
                }}
                onClick={() => setOpen((o) => !o)}
                onMouseEnter={() => setHover(true)}
                onMouseLeave={() => setHover(false)}
                data-testid={testid}
                aria-haspopup='dialog'
                aria-expanded={open}
                title='Periodic table'
            >
                <img src='/icons/periodic_table.svg' alt=''
                    draggable={false} style={styles.iconImg} />
            </button>
            {open && (
                <PeriodicTablePopupGrid
                    testid={`${testid}-popup`}
                    onPick={(sym, num) => { setOpen(false); onPick(sym, num); }}
                />
            )}
        </div>
    );
}

// Context-menu trigger for the periodic-table popup. Renders as a
// MoreItem-style row labeled "Periodic Table..." (matching the convention
// for popup-launching menu items); clicking opens the same PT grid the
// toolbar uses, anchored to the right of the menu row so it doesn't
// overlap the surrounding context-menu items.
interface PeriodicTableMenuItemProps {
    testid: string;
    onPick: (element: string, atomicNum: number) => void;
    disabled?: boolean;
}
function PeriodicTableMenuItem({
    testid, onPick, disabled,
}: PeriodicTableMenuItemProps): JSX.Element {
    const [hover, setHover] = useState(false);
    const [open, setOpen] = useState(false);
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    usePeriodicTableOutsideClick(open, setOpen, wrapperRef);

    return (
        <div ref={wrapperRef} style={styles.periodicTableMenuItemWrap}>
            <button
                type='button'
                disabled={disabled}
                style={{
                    ...styles.moreItem,
                    ...(hover && !disabled ? styles.moreItemHover : {}),
                    ...(disabled ? styles.moreItemDisabled : {}),
                }}
                onClick={() => { if (!disabled) setOpen((o) => !o); }}
                onMouseEnter={() => setHover(true)}
                onMouseLeave={() => setHover(false)}
                data-testid={testid}
                aria-haspopup='dialog'
                aria-expanded={open}
            >
                Periodic Table...
            </button>
            {open && (
                <PeriodicTablePopupGrid
                    testid={`${testid}-popup`}
                    anchor='right'
                    onPick={(sym, num) => { setOpen(false); onPick(sym, num); }}
                />
            )}
        </div>
    );
}

// Shared close-on-outside-click hook used by both PT triggers. Listens
// for mousedown anywhere outside the wrapper while the popup is open.
function usePeriodicTableOutsideClick(
    open: boolean,
    setOpen: (v: boolean) => void,
    wrapperRef: React.RefObject<HTMLDivElement>,
): void {
    useEffect(() => {
        if (!open) return;
        function onDocMouseDown(e: globalThis.MouseEvent): void {
            const target = e.target as Node;
            if (wrapperRef.current && !wrapperRef.current.contains(target)) {
                setOpen(false);
            }
        }
        document.addEventListener('mousedown', onDocMouseDown);
        return () => {
            document.removeEventListener('mousedown', onDocMouseDown);
        };
    }, [open, setOpen, wrapperRef]);
}

// The popup grid itself — extracted so both the toolbar and the context-
// menu triggers share one renderer. `anchor='right'` positions the popup
// to the right of its trigger (used by the menu variant so the popup
// doesn't cover the rest of the menu items).
interface PeriodicTablePopupGridProps {
    testid: string;
    onPick: (sym: string, atomicNum: number) => void;
    anchor?: 'below' | 'right';
}
function PeriodicTablePopupGrid({
    testid, onPick, anchor = 'below',
}: PeriodicTablePopupGridProps): JSX.Element {
    const anchorStyle = anchor === 'right'
        ? styles.periodicTablePopupRight
        : styles.periodicTablePopup;
    return (
        <div style={anchorStyle}
            data-testid={testid}
            role='dialog'
            aria-label='Periodic table'>
            {PT_LAYOUT.map((row, r) =>
                row.map((cell, c) => {
                    if (!cell) return null;
                    const [sym, cls] = cell;
                    return (
                        <PTCellButton key={`${r}-${c}`}
                            sym={sym}
                            bg={PT_CLASS_BG[cls] ?? '#eee'}
                            row={r} col={c}
                            onPick={(s) => {
                                const num = SYMBOL_TO_ATOMIC_NUM[s];
                                onPick(s, num);
                            }} />
                    );
                }),
            )}
        </div>
    );
}

interface PTCellButtonProps {
    sym: string;
    bg: string;
    row: number;
    col: number;
    onPick: (sym: string) => void;
}
function PTCellButton({
    sym, bg, row, col, onPick,
}: PTCellButtonProps): JSX.Element {
    const [hover, setHover] = useState(false);
    return (
        <button
            type='button'
            style={{
                ...styles.ptCell,
                background: bg,
                gridRow: row + 1,
                gridColumn: col + 1,
                ...(hover ? { filter: 'brightness(0.94)' } : {}),
            }}
            onClick={() => onPick(sym)}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            data-testid={`pt-${sym}`}
            title={sym}
        >
            {sym}
        </button>
    );
}

// All / Invert / None text-link buttons. Qt TEXT_LINK_STYLE:
// 10pt bold #3d5d71, hover #5b8aa8, transparent bg, no border.
interface TextLinkButtonProps {
    label: string;
    onClick: () => void;
    testid: string;
    title?: string;
}

function TextLinkButton({
    label, onClick, testid, title,
}: TextLinkButtonProps): JSX.Element {
    const [hover, setHover] = useState(false);
    return (
        <button
            type='button'
            style={{
                ...styles.textLinkBtn,
                ...(hover ? styles.textLinkBtnHover : {}),
            }}
            onClick={onClick}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            data-testid={testid}
            title={title}
        >
            {label}
        </button>
    );
}

// Palette comes from Qt's sketcher_css_style.h, applied literally so the
// React port reads as the same widget:
//   QToolButton                          { border: none }
//   QToolButton:checked                  { background: #d4e6f1 }  // light blue
//   QToolButton:hover:!checked           { background: #edf7fc }
//   SELECTION_ACTIVE_STYLE (Select tool) { background: #f3f6f0 }  // sage
//   PALETTE_TITLE_STYLE                  { 9px bold #666666 }
//   TEXT_LINK_STYLE                      { 10px bold #3d5d71, hover #5b8aa8 }
//   ATOM_ELEMENT_OR_MONOMER_STYLE        { 14px bold #333333 }
const TOP_BAR_BG = 'white';
const SIDEBAR_BG = 'white';
const BORDER_COLOR = '#cfcfcf';
const CHECKED_BG = '#d4e6f1';
const HOVER_BG = '#edf7fc';
const SELECT_ACTIVE_BG = '#f3f6f0';
const SECTION_LABEL_COLOR = '#666666';
const TEXT_LINK_COLOR = '#3d5d71';
const TEXT_LINK_HOVER = '#5b8aa8';
const ATOM_LETTER_COLOR = '#333333';

const ICON_BTN_SIZE = 32;

const styles: Record<string, CSSProperties> = {
    shell: {
        marginTop: 12,
        border: `1px solid ${BORDER_COLOR}`,
        borderRadius: 4,
        background: 'white',
        overflow: 'hidden',
        font: '13px Arimo, "Helvetica Neue", Arial, sans-serif',
        color: '#222',
        display: 'flex',
        flexDirection: 'column',
    },
    topBar: {
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: '2px 4px',
        background: TOP_BAR_BG,
        borderBottom: `1px solid ${BORDER_COLOR}`,
        minHeight: 35,
    },
    topBarGroup: { display: 'flex', gap: 2, alignItems: 'center' },
    topDivider: {
        display: 'inline-block',
        width: 1,
        height: 22,
        background: BORDER_COLOR,
        margin: '0 4px',
    },
    topSpacer: { flex: '1 1 auto' },
    workspace: { display: 'flex', alignItems: 'stretch' },
    sidebar: {
        // sketcher_side_bar.ui — 117px wide, VBox spacing=2.
        width: 117,
        flex: '0 0 117px',
        background: SIDEBAR_BG,
        borderRight: `1px solid ${BORDER_COLOR}`,
        padding: '4px 2px',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        boxSizing: 'border-box',
        overflow: 'hidden',
    },
    selectSection: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '2px 0',
        borderRadius: 3,
    },
    monomericPage: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '4px 0',
    },
    monomericPlaceholder: {
        fontSize: 9,
        color: SECTION_LABEL_COLOR,
        textAlign: 'center',
        padding: '12px 4px',
        fontStyle: 'italic',
        lineHeight: 1.3,
    },
    monomerTabBtn: {
        // AminoOrNucleicToggleButton in Qt (monomer_tool_widget.ui:38) is
        // a checkable QPushButton with point-size 8 bold; the side bar
        // gives it 46–50 px width. We reproduce the look as two side-by-
        // side tab buttons inside the existing row2 grid.
        height: ICON_BTN_SIZE,
        background: 'transparent',
        border: `1px solid ${BORDER_COLOR}`,
        borderRadius: 3,
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: 0.5,
        color: SECTION_LABEL_COLOR,
        cursor: 'pointer',
        padding: 0,
    },
    monomerTabBtnActive: { background: CHECKED_BG },
    nucleicGrid: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
    },
    nucleicWideBtn: {
        // Qt's na_rna_btn / na_dna_btn / na_custom_nt_btn are 90-96 px
        // wide × 32 px tall ModularToolButtons. Inside the 117 px sidebar
        // (less padding) they span ~3 element-grid columns; matching the
        // 3*ICON_BTN_SIZE + 2*gap track reproduces the Qt geometry.
        height: ICON_BTN_SIZE,
        width: ICON_BTN_SIZE * 3 + 4,
        background: 'transparent',
        border: `1px solid ${BORDER_COLOR}`,
        borderRadius: 3,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0.5,
        color: SECTION_LABEL_COLOR,
        cursor: 'pointer',
        padding: 0,
        alignSelf: 'center',
    },
    selectSectionActive: { background: SELECT_ACTIVE_BG },
    sectionLabel: {
        fontSize: 9,
        fontWeight: 700,
        color: SECTION_LABEL_COLOR,
        textAlign: 'center',
        padding: '2px 0',
        letterSpacing: 0.3,
    },
    hr: {
        height: 1,
        background: BORDER_COLOR,
        border: 'none',
        margin: '2px 0',
        width: '100%',
    },
    row2: {
        display: 'grid',
        gridTemplateColumns: `repeat(2, ${ICON_BTN_SIZE}px)`,
        gap: 2,
        justifyContent: 'center',
    },
    row3: {
        display: 'grid',
        gridTemplateColumns: `repeat(3, ${ICON_BTN_SIZE}px)`,
        gap: 2,
        justifyContent: 'center',
    },
    elementGrid: {
        display: 'grid',
        gridTemplateColumns: `repeat(3, ${ICON_BTN_SIZE}px)`,
        gap: 2,
        justifyContent: 'center',
    },
    atomCtxElementGrid: {
        display: 'grid',
        gridTemplateColumns: `repeat(4, ${ICON_BTN_SIZE}px)`,
        gap: 2,
        justifyContent: 'center',
        padding: '2px 6px',
    },
    atomQueryRow: {
        display: 'grid',
        gridTemplateColumns: `${ICON_BTN_SIZE}px ${ICON_BTN_SIZE * 2 + 2}px`,
        gap: 2,
        justifyContent: 'center',
    },
    bondGrid: {
        display: 'grid',
        gridTemplateColumns: `repeat(3, ${ICON_BTN_SIZE}px)`,
        gap: 2,
        justifyContent: 'center',
    },
    ringGrid: {
        display: 'grid',
        gridTemplateColumns: `repeat(3, ${ICON_BTN_SIZE}px)`,
        gap: 2,
        justifyContent: 'center',
    },
    iconBtn: {
        width: ICON_BTN_SIZE,
        height: ICON_BTN_SIZE,
        padding: 0,
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 2,
    },
    iconBtnWide: { width: ICON_BTN_SIZE * 2 + 2 },
    iconBtnHover: { background: HOVER_BG },
    iconBtnActive: { background: CHECKED_BG },
    // Bottom-right wedge indicator: signals "there's a popup here, long-
    // press or click-while-active to open." Qt draws this via QStyle's
    // CC_ToolButton menu indicator; we use a clip-path triangle on a tiny
    // square — readable at 32 px, no extra asset.
    popupWedge: {
        position: 'absolute',
        bottom: 2,
        right: 2,
        width: 6,
        height: 6,
        background: '#777',
        clipPath: 'polygon(100% 0, 100% 100%, 0 100%)',
        pointerEvents: 'none',
    },
    iconPopup: {
        position: 'absolute',
        top: '100%',
        left: 0,
        marginTop: 2,
        background: 'white',
        border: `1px solid ${BORDER_COLOR}`,
        borderRadius: 3,
        boxShadow: '0 2px 6px rgba(0,0,0,0.12)',
        zIndex: 20,
        padding: 2,
        display: 'flex',
        gap: 2,
        // Qt popups are 32 px tall × N×32 wide. flex sizes itself.
    },
    // Qt PeriodicTableWidget: 395×210 px, 10px font, 21×21 cells. We
    // anchor it under the trigger and let the sidebar's `overflow:hidden`
    // *not* clip it — `position: absolute` escapes the parent's grid.
    periodicTablePopup: {
        position: 'absolute',
        top: '100%',
        left: 0,
        marginTop: 2,
        background: 'white',
        border: `1px solid ${BORDER_COLOR}`,
        borderRadius: 3,
        boxShadow: '0 2px 6px rgba(0,0,0,0.12)',
        zIndex: 30,
        padding: 4,
        display: 'grid',
        gridTemplateColumns: 'repeat(18, 21px)',
        gridTemplateRows: 'repeat(10, 21px)',
        gap: 1,
        // The sidebar is 117 px; the popup is ~390 px wide so it extends
        // well past the right edge. That's fine — popups float above.
    },
    // Right-anchored variant used by the context-menu PT trigger: the
    // popup sits to the right of the menu row rather than below it,
    // so it doesn't overlap the rest of the items. zIndex bumped above
    // the host context-menu (which uses bgContextMenu at z=15) so the PT
    // grid lands on top.
    periodicTablePopupRight: {
        position: 'absolute',
        top: 0,
        left: '100%',
        marginLeft: 2,
        background: 'white',
        border: `1px solid ${BORDER_COLOR}`,
        borderRadius: 3,
        boxShadow: '0 2px 6px rgba(0,0,0,0.12)',
        zIndex: 30,
        padding: 4,
        display: 'grid',
        gridTemplateColumns: 'repeat(18, 21px)',
        gridTemplateRows: 'repeat(10, 21px)',
        gap: 1,
    },
    // Wrapper for the context-menu PT trigger row. `position: relative`
    // so the right-anchored popup positions against this element.
    periodicTableMenuItemWrap: {
        position: 'relative',
    },
    ptCell: {
        width: 21,
        height: 21,
        padding: 0,
        border: 'none',
        borderRadius: 2,
        fontFamily: 'Arimo, "Helvetica Neue", Arial, sans-serif',
        fontSize: 10,
        fontWeight: 400,
        color: 'black',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
    },
    iconImg: {
        // Qt iconSize is 30×32; the button itself is 32×32 with 1px margin.
        width: 30,
        height: 32,
        pointerEvents: 'none',
        userSelect: 'none',
    },
    letterBtn: {
        width: ICON_BTN_SIZE,
        height: ICON_BTN_SIZE,
        padding: 0,
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        fontFamily: 'Arimo, "Helvetica Neue", Arial, sans-serif',
        fontSize: 14,
        fontWeight: 700,
        color: ATOM_LETTER_COLOR,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 2,
    },
    textLinkBtn: {
        height: 18,
        padding: '0 2px',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        fontFamily: 'Arimo, "Helvetica Neue", Arial, sans-serif',
        fontSize: 10,
        fontWeight: 700,
        color: TEXT_LINK_COLOR,
    },
    textLinkBtnHover: {
        color: TEXT_LINK_HOVER,
        background: 'transparent',
    },
    moreMenu: {
        position: 'absolute',
        top: '100%',
        left: 0,
        marginTop: 2,
        background: 'white',
        border: `1px solid ${BORDER_COLOR}`,
        borderRadius: 3,
        boxShadow: '0 2px 6px rgba(0,0,0,0.12)',
        zIndex: 10,
        minWidth: 200,
        padding: '4px 0',
    },
    moreSectionLabel: {
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        color: '#888',
        padding: '4px 12px 2px',
        fontWeight: 600,
    },
    moreDivider: {
        height: 1,
        background: BORDER_COLOR,
        margin: '4px 0',
    },
    moreItem: {
        font: 'inherit',
        fontSize: 12,
        padding: '5px 12px',
        border: 'none',
        background: 'transparent',
        color: '#222',
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        display: 'block',
    },
    moreItemHover: { background: HOVER_BG },
    moreItemDisabled: {
        color: '#aaa',
        cursor: 'default',
        background: 'transparent',
    },
    bgContextMenu: {
        position: 'fixed',
        background: 'white',
        border: `1px solid ${BORDER_COLOR}`,
        borderRadius: 3,
        boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
        zIndex: 50,
        minWidth: 200,
        padding: '4px 0',
        // Tall menu (21 items) — Qt's QMenu auto-flips upward when it would
        // clip; the layout effect below does the same here.
        maxHeight: '90vh',
        overflowY: 'auto',
    },
    modalOverlay: {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
    },
    modalCard: {
        background: 'white',
        border: `1px solid ${BORDER_COLOR}`,
        borderRadius: 4,
        boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
        padding: 16,
        minWidth: 440,
        maxWidth: 560,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
    },
    modalTitle: {
        font: '600 14px sans-serif',
        color: '#222',
    },
    modalRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
    },
    modalLabel: {
        font: '12px sans-serif',
        color: '#444',
    },
    modalSelect: {
        font: '12px sans-serif',
        padding: '3px 6px',
        border: `1px solid ${BORDER_COLOR}`,
        borderRadius: 3,
        background: 'white',
    },
    modalNumber: {
        font: '12px sans-serif',
        padding: '3px 6px',
        border: `1px solid ${BORDER_COLOR}`,
        borderRadius: 3,
        background: 'white',
        width: 72,
    },
    modalStatus: {
        font: '11px sans-serif',
        color: '#666',
    },
    modalTextarea: {
        font: '11px Menlo, Consolas, monospace',
        padding: 6,
        border: `1px solid ${BORDER_COLOR}`,
        borderRadius: 3,
        minHeight: 160,
        resize: 'vertical',
        outline: 'none',
    },
    modalButtons: {
        display: 'flex',
        justifyContent: 'flex-end',
        gap: 6,
    },
    modalBtn: {
        font: '12px sans-serif',
        padding: '4px 12px',
        border: `1px solid ${BORDER_COLOR}`,
        borderRadius: 3,
        background: 'white',
        cursor: 'pointer',
    },
    modalBtnPrimary: {
        font: '12px sans-serif',
        padding: '4px 12px',
        border: '1px solid #3d5d71',
        borderRadius: 3,
        background: '#3d5d71',
        color: 'white',
        cursor: 'pointer',
    },
    prefsRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
    },
    prefsSeparator: {
        height: 1,
        background: BORDER_COLOR,
        margin: '4px 0',
    },
    prefsGrid: {
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '8px 16px',
    },
    prefsCheckRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        font: '12px sans-serif',
        color: '#222',
        cursor: 'pointer',
    },
    prefsIndented: {
        marginLeft: 18,
    },
    welcomeTip: {
        borderLeft: '3px solid #3d5d71',
        paddingLeft: 10,
        marginTop: 4,
    },
    welcomeTipHeading: {
        font: '600 12px sans-serif',
        color: '#222',
        marginBottom: 2,
    },
    welcomeTipBody: {
        font: '12px sans-serif',
        color: '#444',
        lineHeight: 1.4,
    },
    aboutLine: {
        font: '12px sans-serif',
        color: '#333',
    },
    aboutLink: {
        color: '#3d5d71',
        textDecoration: 'underline',
        cursor: 'pointer',
    },
    canvasColumn: {
        flex: '1 1 auto',
        display: 'flex',
        flexDirection: 'column',
        background: 'white',
    },
    canvas: {
        background: 'white',
        display: 'block',
        cursor: 'crosshair',
        // Explicit dimensions prevent the flex parent from stretching the
        // canvas over the sidebar (the canvas is a replaced element whose
        // intrinsic size comes from its width/height attributes, but flex
        // can still grow it past those values).
        width: CANVAS_W,
        height: CANVAS_H,
        flex: '0 0 auto',
    },
    statusBox: {
        font: '11px Menlo, Consolas, monospace',
        background: '#fafafa',
        borderTop: `1px solid ${BORDER_COLOR}`,
        padding: '4px 10px',
        color: '#555',
        minHeight: 22,
    },
};
