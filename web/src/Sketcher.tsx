import {
    useCallback,
    useEffect,
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
    | 'atom-chain';
// SetAtomWidget.ui ships C/H/N/O/P/S/F/Cl/Si on the atomistic panel.
// Element symbol — any RDKit-recognized symbol. The sidebar exposes
// 8 fixed elements via dedicated buttons; everything else flows through
// the periodic-table popup + last-picked-element slot.
type Element = string;
const FIXED_ELEMENTS: readonly Element[] =
    ['C', 'H', 'N', 'O', 'P', 'S', 'F', 'Cl'] as const;
const LAST_PICKED_DEFAULT: Element = 'Si';

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
// Qt's bond_group is a single radio group covering single/double/triple plus
// the stereo variants — picking any one button replaces the previously-active
// bond mode. We mirror that here: BondMode collapses "what order is the next
// bond?" and "what stereo dir does it get?" into one selection.
//   wavy    = single bond with BondDir::UNKNOWN  (stereo_bond_popup single_either)
//   crossed = double bond with BondDir::EITHERDOUBLE (stereo_bond_popup double_either)
type BondMode =
    'single' | 'double' | 'triple' | 'wedge' | 'dash' | 'wavy' | 'crossed';

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
}
interface BondDesc {
    a: number;
    b: number;
    o: number;
    sel?: boolean;
    arom?: boolean;
    dir?: number; // RDKit::Bond::BondDir: 1=BEGINWEDGE, 2=BEGINDASH
}

// Mirror RDKit::Bond::BondDir for the values we render.
const BOND_DIR_NONE = 0;
const BOND_DIR_WEDGE = 1;
const BOND_DIR_DASH = 2;
const BOND_DIR_EITHERDOUBLE = 5; // crossed double (cis/trans unknown)
const BOND_DIR_UNKNOWN = 6;       // wavy single (up/down unknown)
interface RenderDesc {
    atoms: AtomDesc[];
    bonds: BondDesc[];
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
// the sage accent for attention.
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
// (dialog/file_save_image_dialog.cpp) offers PNG and SVG. SVG would require
// a separate vector renderer (our drawSketch is canvas-only), so SVG is
// deferred to a follow-up batch; the dropdown still renders so the visual
// shape of the dialog matches Qt, but only PNG is selectable today.
type ImageFormat = 'png';
const IMAGE_FORMAT_CHOICES: { value: ImageFormat; label: string;
    ext: string; mime: string }[] = [
    { value: 'png', label: 'PNG', ext: 'png', mime: 'image/png' },
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
}
const DEFAULT_DISPLAY_OPTIONS: DisplayOptions = {
    showValenceErrors: true,
    colorHeteroatoms: true,
    showStereoLabels: true,
    useImplicitHydrogens: false,
};

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
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Original sketcher has no grid — a clean white canvas reads as the
    // working area without competing for attention with the structure.

    const BOND_STROKE = 2;
    const BOND_DOUBLE_OFFSET = 4.5;

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
        ctx.strokeStyle = '#222';
        ctx.fillStyle = '#222';
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
    }

    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const a of rd.atoms) {
        const { px, py } = pixelFromModel(canvas, view, a.x, a.y);
        const isPending = pendingAtomIdx === a.i;
        const isHover = hoverAtomIdx === a.i;
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
        // Carbons get only a dot unless they carry a charge — otherwise the
        // canvas turns into a wall of "C" labels for every backbone atom.
        const dotOnly =
            a.el === 'C' && !hasCharge && !isPending && !isHover && !a.sel;
        if (dotOnly) {
            ctx.fillStyle = '#333';
            ctx.beginPath();
            ctx.arc(px, py, 2.5, 0, 2 * Math.PI);
            ctx.fill();
            continue;
        }
        if (a.el !== 'C') {
            // White backdrop punches a hole in any bond line passing through.
            ctx.fillStyle = 'white';
            ctx.fillRect(px - 9, py - 9, 18, 18);
        }
        // ConfigureView "Heteroatom Colors" toggle. When OFF, every atom
        // renders in the mono "carbon" color, matching Qt's behavior
        // when COLOR_HETEROATOMS is unchecked (model/sketcher_model.cpp:
        // 348-354 swaps the color scheme to the all-mono variant).
        ctx.fillStyle = displayOptions.colorHeteroatoms
            ? (ELEMENT_COLORS[a.el] ?? '#333')
            : ELEMENT_COLORS.C;
        if (a.el === 'C' && a.sel && !isPending && !isHover && !hasCharge) {
            ctx.beginPath();
            ctx.arc(px, py, 2.5, 0, 2 * Math.PI);
            ctx.fill();
        } else {
            ctx.font = '13px sans-serif';
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
                    ctx.font = '9px sans-serif';
                    const hWidth = ctx.measureText('H').width;
                    ctx.fillText(String(a.nh), hX + hWidth + 1, py + 4);
                }
                ctx.textAlign = 'center';
                ctx.font = '13px sans-serif';
            }
            // Charge: superscript to the upper-right. "+" / "−" alone for ±1,
            // otherwise "n+" / "n−". Unicode minus sign reads better than "-".
            if (hasCharge) {
                const q = a.q as number;
                const sign = q > 0 ? '+' : '−';
                const chargeText =
                    Math.abs(q) === 1 ? sign : `${Math.abs(q)}${sign}`;
                ctx.font = '9px sans-serif';
                ctx.textAlign = 'left';
                const labelWidth = ctx.measureText(a.el).width;
                // Push past the H label if one is rendered.
                let chargeX = px + labelWidth / 2 + 1;
                if (a.el !== 'C' && typeof a.nh === 'number' && a.nh > 0) {
                    ctx.font = '13px sans-serif';
                    chargeX += ctx.measureText('H').width;
                    if (a.nh > 1) {
                        ctx.font = '9px sans-serif';
                        chargeX += ctx.measureText(String(a.nh)).width + 1;
                    }
                    ctx.font = '9px sans-serif';
                }
                ctx.fillText(chargeText, chargeX, py - 4);
                ctx.textAlign = 'center';
                ctx.font = '13px sans-serif';
            }
        }
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
    const toggleDisplayOption = (key: keyof DisplayOptions): void => {
        setDisplayOptions((opt) => ({ ...opt, [key]: !opt[key] }));
    };
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
    // Coordinate, Zero). Coordinate / Zero need BondType::DATIVE/ZERO support
    // in mol_model, which the lean MolModel doesn't expose yet — defer those.
    const BOND_ORDER_CHOICES: PopupChoice<BondMode>[] = [
        { value: 'double', icon: 'bond_double', title: 'Double Bond', testid: 'order-popup-double' },
        { value: 'triple', icon: 'bond_triple', title: 'Triple Bond', testid: 'order-popup-triple' },
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
    useEffect(() => {
        if (!moreMenuOpen && !importMenuOpen && !exportMenuOpen
            && !configureViewOpen && !helpMenuOpen) return;
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
        }
        document.addEventListener('mousedown', onDocMouseDown);
        return () => {
            document.removeEventListener('mousedown', onDocMouseDown);
        };
    }, [moreMenuOpen, importMenuOpen, exportMenuOpen, configureViewOpen,
        helpMenuOpen]);

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
        [tool, element, ring],
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
            model.loadFromText(text);
            setPendingBondAtom(null);
            setStatus(`imported ${file.name} (${model.numAtoms()} atoms)`);
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
            model.loadFromText(pasteText);
            setPendingBondAtom(null);
            const kind = pasteText.includes('\n') ||
                pasteText.includes('V2000') ||
                pasteText.includes('V3000')
                ? 'MOL'
                : 'SMILES';
            setStatus(`loaded ${kind} (${model.numAtoms()} atoms)`);
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
        if (model.numAtoms() === 0) {
            setStatus('nothing to save — sketch something first');
            return;
        }
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
        if (rd.atoms.length === 0) return;
        // Compute a fit-to-bbox view for the offscreen canvas — same math
        // as doFit but parameterized by (w, h) instead of the live canvas.
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
        const bboxW = Math.max(maxX - minX, 1e-6);
        const bboxH = Math.max(maxY - minY, 1e-6);
        const marginPx = Math.min(40, Math.floor(Math.min(w, h) * 0.1));
        const usableW = Math.max(w - 2 * marginPx, 1);
        const usableH = Math.max(h - 2 * marginPx, 1);
        const fitScale = rd.atoms.length === 1
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
        // drawSketch clearRects at the start, so anything we fill first
        // would be wiped. Instead let drawSketch paint on transparent, then
        // composite the background behind the strokes for the opaque case.
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
        const choice = IMAGE_FORMAT_CHOICES
            .find((c) => c.value === imageFormat);
        const mime = choice?.mime ?? 'image/png';
        const ext = choice?.ext ?? 'png';
        off.toBlob((blob) => {
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
            const bg = imageTransparent ? 'Transparent' : 'White';
            setStatus(`saved sketch.${ext} — ${bg} background, ${w} x ${h} px`);
            setImageModalOpen(false);
        }, mime);
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
                e.preventDefault();
                comingSoon('Zero bond');
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
                                {/* "Preferences..." opens the full
                                    RenderingSettingsDialog in Qt. That
                                    dialog has its own batch (font/line/
                                    color-mode controls); stub for now. */}
                                <MoreItem label='Preferences...'
                                    testid='view-preferences'
                                    onClick={() => {
                                        setConfigureViewOpen(false);
                                        comingSoon('Preferences');
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

                    {/* DRAW label + atomistic/monomeric toggle. Monomeric
                        mode isn't ported yet — stub it. */}
                    <div style={styles.sectionLabel}>DRAW</div>
                    <div style={styles.row2}>
                        <IconButton icon='mode_compound'
                            testid='mode-atomistic'
                            title='Atomistic'
                            active
                            onClick={() => { /* already atomistic */ }} />
                        <IconButton icon='mode_monomer'
                            testid='mode-monomeric'
                            title='Monomeric'
                            onClick={() => comingSoon('Monomeric mode')} />
                    </div>

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
                            label='A▾'
                            testid='atom-query'
                            title='Atom Query – press & hold to change'
                            active={false}
                            choices={ATOM_QUERY_CHOICES}
                            onClick={() => comingSoon('Atom query (needs RDKit query atom support)')}
                            onPick={(q) => comingSoon(`Atom query "${q}" (needs RDKit query atom support)`)}
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
                            icon='bond_aromatic'
                            testid='bond-query'
                            title='Bond Query – press & hold to change'
                            active={false}
                            choices={BOND_QUERY_CHOICES}
                            onClick={() => comingSoon('Bond query (needs RDKit query bond support)')}
                            onPick={(q) => comingSoon(`Bond query "${q.replace('_', '/')}" (needs RDKit query bond support)`)}
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
                        reaction. Not ported yet — stub all three. */}
                    <div style={styles.row3}>
                        <LetterButton label='R' testid='rgroup'
                            title='R-Group'
                            onClick={() => comingSoon('R-Group')} />
                        <IconButton icon='enumeration_attachment_point'
                            testid='attachment-point'
                            title='Attachment Point'
                            onClick={() => comingSoon('Attachment point')} />
                        <IconButton icon='reaction_arrow'
                            testid='reaction'
                            title='Reaction'
                            onClick={() => comingSoon('Reaction tool')} />
                    </div>
                </aside>

                <div style={styles.canvasColumn}>
                    <canvas
                        ref={canvasRef}
                        width={CANVAS_W}
                        height={CANVAS_H}
                        style={{
                            ...styles.canvas,
                            cursor: tool === 'move-rotate' ? 'move'
                                : tool === 'erase' ? 'not-allowed'
                                : 'crosshair',
                        }}
                        onClick={onCanvasClick}
                        onMouseDown={onCanvasMouseDown}
                        onMouseMove={onCanvasMove}
                        onMouseUp={onCanvasMouseUp}
                        onMouseLeave={onCanvasMouseLeave}
                        data-testid='sketcher-canvas'
                    />
                    <div style={styles.statusBox} data-testid='sketcher-status'>
                        {status}
                    </div>
                </div>
            </div>
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
        </section>
    );
}

interface MoreItemProps {
    label: string;
    onClick: () => void;
    testid: string;
}

function MoreItem({ label, onClick, testid }: MoreItemProps): JSX.Element {
    const [hover, setHover] = useState(false);
    return (
        <button
            type='button'
            style={{
                ...styles.moreItem,
                ...(hover ? styles.moreItemHover : {}),
            }}
            onClick={onClick}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            data-testid={testid}
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
}

const POPUP_DELAY_MS = 250; // Qt ToolButtonWithPopup::m_popup_delay default

function IconButtonWithPopup<T extends string>({
    icon, label, onClick, testid, title, active, choices, onPick,
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
                    ...(label !== undefined ? styles.letterBtn : styles.iconBtn),
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
}

function LetterButton({
    label, onClick, testid, title, active, color,
}: LetterButtonProps): JSX.Element {
    const [hover, setHover] = useState(false);
    return (
        <button
            type='button'
            style={{
                ...styles.letterBtn,
                ...(color && !active ? { color } : {}),
                ...(hover && !active ? styles.iconBtnHover : {}),
                ...(active ? styles.iconBtnActive : {}),
            }}
            onClick={onClick}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            data-testid={testid}
            aria-pressed={active}
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
    onPick: (element: string) => void;
}
function PeriodicTableButton({
    testid, onPick,
}: PeriodicTableButtonProps): JSX.Element {
    const [hover, setHover] = useState(false);
    const [open, setOpen] = useState(false);
    const wrapperRef = useRef<HTMLDivElement | null>(null);

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
    }, [open]);

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
                <div style={styles.periodicTablePopup}
                    data-testid={`${testid}-popup`}
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
                                        setOpen(false);
                                        onPick(s);
                                    }} />
                            );
                        }),
                    )}
                </div>
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
