import {
    useCallback,
    useEffect,
    useReducer,
    useRef,
    useState,
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

type Tool = 'atom' | 'bond' | 'select' | 'ring';
// SetAtomWidget.ui ships C/H/N/O/P/S/F/Cl/Si on the atomistic panel.
type Element = 'C' | 'H' | 'N' | 'O' | 'P' | 'S' | 'F' | 'Cl' | 'Si';
// Qt's bond_group is a single radio group covering single/double/triple plus
// the stereo variants — picking any one button replaces the previously-active
// bond mode. We mirror that here: BondMode collapses "what order is the next
// bond?" and "what stereo dir does it get?" into one selection.
type BondMode = 'single' | 'double' | 'triple' | 'wedge' | 'dash';

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
interface RenderDesc {
    atoms: AtomDesc[];
    bonds: BondDesc[];
}

const CANVAS_W = 540;
const CANVAS_H = 360;
const DEFAULT_SCALE = 40; // pixels per RDKit model unit
const ATOM_HIT_RADIUS = 18; // pixels for click hit-test
const BOND_HIT_RADIUS = 6; // pixels perpendicular to bond line
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

interface DragRect {
    startPx: number;
    startPy: number;
    curPx: number;
    curPy: number;
    additive: boolean;
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

// Qt's QGraphicsView wheel zoom (sketcher_view.cpp `wheelEvent`) uses
// scale_factor = 2^(angleDelta.y / 2400) and caps zoom-in at the default
// "fit" scale — you can never zoom in past that resting view. We mirror
// both: factor formula and the DEFAULT_SCALE upper bound.
const MIN_VIEW_SCALE = 4;

function dragRectBounds(d: DragRect): {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
} {
    return {
        x1: Math.min(d.startPx, d.curPx),
        y1: Math.min(d.startPy, d.curPy),
        x2: Math.max(d.startPx, d.curPx),
        y2: Math.max(d.startPy, d.curPy),
    };
}

function drawSketch(
    canvas: HTMLCanvasElement,
    view: View,
    rd: RenderDesc,
    pendingAtomIdx: number | null,
    hoverAtomIdx: number | null,
    dragRect: DragRect | null,
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
        if (!b.arom && (b.o === 2 || b.o === 3)) {
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
        ctx.fillStyle = ELEMENT_COLORS[a.el] ?? '#333';
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

    if (dragRect) {
        const { x1, y1, x2, y2 } = dragRectBounds(dragRect);
        ctx.fillStyle = 'rgba(119, 156, 89, 0.12)';
        ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
        ctx.strokeStyle = ACCENT_GREEN;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(x1 + 0.5, y1 + 0.5, x2 - x1 - 1, y2 - y1 - 1);
        ctx.setLineDash([]);
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
    // View transform — mirrors viewState into a ref so event handlers (which
    // capture the closure at mount) always read the current viewport.
    const viewRef = useRef<View>(DEFAULT_VIEW);

    const [tool, setTool] = useState<Tool>('atom');
    const [element, setElement] = useState<Element>('C');
    // Qt's bond_group is one radio group — picking Single clears any active
    // stereo, picking Wedge implies single+wedge. bondMode collapses both.
    const [bondMode, setBondMode] = useState<BondMode>('single');
    const [ring, setRing] = useState<RingSpec>(RING_BENZENE);
    const [pendingBondAtom, setPendingBondAtom] = useState<number | null>(null);
    const [hoverAtom, setHoverAtom] = useState<number | null>(null);
    const [dragRect, setDragRect] = useState<DragRect | null>(null);
    const [status, setStatus] = useState<string>('ready');
    const [smilesInput, setSmilesInput] = useState<string>('');
    const [view, setViewState] = useState<View>(DEFAULT_VIEW);
    const [moreMenuOpen, setMoreMenuOpen] = useState<boolean>(false);
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

    // BondMode → (order, dir) for addBondWithDir / setBondDirForSelectedBonds.
    const bondModeToOrderAndDir = (mode: BondMode): { order: number; dir: number } => {
        switch (mode) {
            case 'single': return { order: 1, dir: BOND_DIR_NONE };
            case 'double': return { order: 2, dir: BOND_DIR_NONE };
            case 'triple': return { order: 3, dir: BOND_DIR_NONE };
            case 'wedge':  return { order: 1, dir: BOND_DIR_WEDGE };
            case 'dash':   return { order: 1, dir: BOND_DIR_DASH };
        }
    };

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
        drawSketch(canvas, view, rd, pendingBondAtom, hoverAtom, dragRect);
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
                if (hit >= 0) {
                    const wasSelected = model.isAtomSelected(hit);
                    model.setAtomSelected(hit, !wasSelected);
                    setStatus(
                        `${wasSelected ? 'deselect' : 'select'} atom #${hit}`,
                    );
                    return;
                }
                const bondHit = nearestBondIndex(canvas, viewRef.current, rd, px, py);
                if (bondHit >= 0) {
                    const wasSelected = model.isBondSelected(bondHit);
                    model.setBondSelected(bondHit, !wasSelected);
                    setStatus(
                        `${wasSelected ? 'deselect' : 'select'} bond #${bondHit}`,
                    );
                    return;
                }
                // Click on empty area clears the selection.
                if (model.hasSelection()) {
                    model.clearSelection();
                    setStatus('cleared selection');
                } else {
                    setStatus(
                        'select mode: click an atom or bond (or use Select All)',
                    );
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
            if (dragRect) {
                setDragRect({ ...dragRect, curPx: px, curPy: py });
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
        [tool, hoverAtom, dragRect],
    );

    const onCanvasMouseDown = useCallback(
        (e: ReactMouseEvent<HTMLCanvasElement>): void => {
            if (e.button !== 0) return;
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const px = e.clientX - rect.left;
            const py = e.clientY - rect.top;
            if (tool !== 'select') return;
            const model = modelRef.current;
            if (!model) return;

            let rd: RenderDesc = BLANK_DESC;
            try {
                rd = JSON.parse(model.description()) as RenderDesc;
            } catch {
                rd = BLANK_DESC;
            }
            const atomHit = nearestAtomIndex(canvas, viewRef.current, rd.atoms, px, py);
            if (atomHit >= 0) {
                // Press on an atom: prepare a drag-to-move. If the user just
                // releases without crossing the threshold, the click handler
                // will treat it as a select toggle.
                const grabbed = rd.atoms.find((x) => x.i === atomHit);
                if (!grabbed) return;
                // If the grabbed atom is part of a multi-atom selection, drag
                // every selected atom together. Single-atom selection or
                // grabbing an unselected atom both fall through to a
                // single-atom move (the original behavior).
                const grabbedIsSelected = grabbed.sel === true;
                const selectedAtoms = grabbedIsSelected
                    ? rd.atoms.filter((x) => x.sel === true)
                    : [grabbed];
                atomDragRef.current = {
                    grabbedIdx: atomHit,
                    grabbedFromX: grabbed.x,
                    grabbedFromY: grabbed.y,
                    atoms: selectedAtoms.map((x) => ({
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
            // Press on a bond: let onClick handle the bond toggle.
            if (nearestBondIndex(canvas, viewRef.current, rd, px, py) >= 0) return;

            setDragRect({
                startPx: px,
                startPy: py,
                curPx: px,
                curPy: py,
                additive: e.shiftKey,
            });
        },
        [tool],
    );

    const onCanvasMouseUp = useCallback(
        (e: ReactMouseEvent<HTMLCanvasElement>): void => {
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
            if (!dragRect) return;
            const canvas = canvasRef.current;
            const model = modelRef.current;
            if (!canvas || !model) {
                setDragRect(null);
                return;
            }
            const { x1, y1, x2, y2 } = dragRectBounds(dragRect);
            const w = x2 - x1;
            const h = y2 - y1;
            const isRealDrag = w > 3 && h > 3;
            setDragRect(null);
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
            if (!dragRect.additive) {
                model.clearSelection();
            }
            let nSelected = 0;
            const atomInRect = new Array<boolean>(rd.atoms.length).fill(false);
            for (const a of rd.atoms) {
                const { px, py } = pixelFromModel(canvas, viewRef.current, a.x, a.y);
                if (px >= x1 && px <= x2 && py >= y1 && py <= y2) {
                    atomInRect[a.i] = true;
                    if (!model.isAtomSelected(a.i)) {
                        model.setAtomSelected(a.i, true);
                    }
                    ++nSelected;
                }
            }
            // Select a bond when both endpoints fell inside the rectangle.
            // Strict containment avoids surprising partial selections.
            let nBondsSelected = 0;
            for (let i = 0; i < rd.bonds.length; ++i) {
                const b = rd.bonds[i];
                if (atomInRect[b.a] && atomInRect[b.b]) {
                    if (!model.isBondSelected(i)) {
                        model.setBondSelected(i, true);
                    }
                    ++nBondsSelected;
                }
            }
            setStatus(
                `rectangle: ${nSelected} atom${nSelected === 1 ? '' : 's'}, ` +
                    `${nBondsSelected} bond${nBondsSelected === 1 ? '' : 's'}` +
                    (dragRect.additive ? ' (added)' : ''),
            );
            void e; // silence unused-param lint without changing the signature
        },
        [dragRect],
    );

    const onCanvasMouseLeave = useCallback((): void => {
        setHoverAtom(null);
        // Don't commit a drag-select that left the canvas — just cancel it.
        if (dragRect) {
            setDragRect(null);
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
    }, [dragRect]);

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
    const doLoadInput = (): void => {
        const model = modelRef.current;
        if (!model) return;
        // Pass the raw text through — MOL blocks start with an empty title
        // line, so stripping leading whitespace breaks the 3-header-line
        // contract SDMolSupplier expects.
        if (!smilesInput.trim()) {
            setStatus('paste a SMILES or MOL block first');
            return;
        }
        try {
            // loadFromText auto-detects SMILES / MOL V2000 / MOL V3000 /
            // SMARTS / InChI — one entry point covers every text format
            // the user might paste.
            model.loadFromText(smilesInput);
            setPendingBondAtom(null);
            const kind = smilesInput.includes('\n') ||
                smilesInput.includes('V2000') ||
                smilesInput.includes('V3000')
                ? 'MOL'
                : 'SMILES';
            setStatus(`loaded ${kind} (${model.numAtoms()} atoms)`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setStatus(`load failed: ${msg || 'unrecognized format'}`);
        }
    };
    const writeToClipboardWithFallback = async (
        text: string,
        kind: string,
    ): Promise<void> => {
        setSmilesInput(text);
        try {
            await navigator.clipboard.writeText(text);
            // Status carries kind + short preview (full text would overflow).
            const preview = text.length > 80 ? text.slice(0, 77) + '...' : text;
            setStatus(`copied ${kind}: ${preview}`);
        } catch {
            // Clipboard write can fail in non-secure contexts / headless
            // browsers. The input still shows the text so the user can
            // copy manually.
            setStatus(`${kind} in input field — copy manually`);
        }
    };
    const doCopySmiles = async (): Promise<void> => {
        const model = modelRef.current;
        if (!model) return;
        const smi = model.toSmiles();
        if (!smi) {
            setStatus('nothing to copy — sketch something first');
            return;
        }
        await writeToClipboardWithFallback(smi, 'SMILES');
    };
    const doCopyMolBlock = async (): Promise<void> => {
        const model = modelRef.current;
        if (!model) return;
        // V2000 is the more widely supported flavor for round-tripping into
        // older tools; V3000 export can come later if users want it.
        const mb = model.toMolBlock(false);
        if (!mb) {
            setStatus('nothing to copy — sketch something first');
            return;
        }
        await writeToClipboardWithFallback(mb, 'MOL');
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

    // Keyboard shortcuts match the Qt sketcher: Ctrl/Cmd+Z undo,
    // Ctrl/Cmd+Shift+Z or Ctrl+Y redo, Del/Backspace deletes the selection,
    // Ctrl/Cmd+A selects everything. We listen on window so the user doesn't
    // have to focus the canvas first.
    useEffect(() => {
        function onKey(e: KeyboardEvent): void {
            const model = modelRef.current;
            if (!model) return;
            // Ignore key events when the user is typing into an input.
            const target = e.target as HTMLElement | null;
            const tag = target?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) {
                return;
            }
            const mod = e.ctrlKey || e.metaKey;
            if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                doUndo();
                return;
            }
            if (mod && ((e.shiftKey && e.key.toLowerCase() === 'z') || e.key.toLowerCase() === 'y')) {
                e.preventDefault();
                doRedo();
                return;
            }
            if (mod && e.key.toLowerCase() === 'a') {
                e.preventDefault();
                doSelectAll();
                return;
            }
            if ((e.key === 'Delete' || e.key === 'Backspace') && !mod) {
                if (model.hasSelection()) {
                    e.preventDefault();
                    doDeleteSelected();
                }
            }
        }
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

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
                    <div style={{ position: 'relative' }}
                        data-testid='more-actions-wrapper'
                        onMouseLeave={() => setMoreMenuOpen(false)}>
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
                    <IconButton icon='topbar_import'
                        onClick={() => comingSoon('Import')}
                        testid='import' title='Import' />
                    <IconButton icon='topbar_export'
                        onClick={() => comingSoon('Export')}
                        testid='export' title='Export' />
                    <span style={styles.topDivider} />
                    <IconButton icon='topbar_settings'
                        onClick={() => comingSoon('Settings')}
                        testid='settings' title='Settings' />
                    <IconButton icon='topbar_help'
                        onClick={() => comingSoon('Help')}
                        testid='help' title='Help' />
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
                        ...(tool === 'select' ? styles.selectSectionActive : {}),
                    }}>
                        <div style={styles.sectionLabel}>SELECT</div>
                        <div style={styles.row3}>
                            <IconButton icon='select_square' testid='tool-select'
                                title='Select'
                                active={tool === 'select'}
                                onClick={() => {
                                    setTool('select');
                                    setPendingBondAtom(null);
                                    setStatus('select mode');
                                }} />
                            <IconButton icon='select_move_rotate'
                                testid='tool-move-rotate'
                                title='Move and Rotate'
                                onClick={() => comingSoon('Move/Rotate tool')} />
                            <IconButton icon='mode_erase'
                                testid='tool-erase'
                                title='Erase'
                                onClick={() => comingSoon('Erase tool')} />
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
                        The last_picked slot is pinned to Si by default in
                        this port (no live last-picked tracking yet). */}
                    <div style={styles.elementGrid}>
                        {(['C','H','N','O','P','S','F','Cl','Si'] as const).map((el) => (
                            <LetterButton key={el} label={el}
                                color={ELEMENT_COLORS[el]}
                                active={tool === 'atom' && element === el}
                                testid={`element-${el}`}
                                title={`Draw ${el} atoms`}
                                onClick={() => {
                                    setElement(el);
                                    setTool('atom');
                                    setPendingBondAtom(null);
                                }} />
                        ))}
                    </div>
                    <div style={styles.atomQueryRow}>
                        <LetterButton label='A▾' testid='atom-query'
                            title='Atom Query'
                            onClick={() => comingSoon('Atom query popup')} />
                        <IconButton icon='periodic_table'
                            testid='periodic-table'
                            title='Periodic Table'
                            wide
                            onClick={() => comingSoon('Periodic table')} />
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
                        row 0: single, wedge (stereo_bond1), dash (stereo_bond2)
                        row 1: bond_order (Double; Triple is the popup option,
                        deferred), bond_query (popup, deferred), atom_chain
                        (deferred). All in one bond_group radio (Qt). */}
                    <div style={styles.bondGrid}>
                        <IconButton icon='bond_single' testid='bond-single'
                            title='Single Bond'
                            active={tool === 'bond' && bondMode === 'single'}
                            onClick={() => pickBondModeApplying('single', 'single')} />
                        <IconButton icon='bond_up' testid='bond-wedge'
                            title='Up Bond (Wedge)'
                            active={tool === 'bond' && bondMode === 'wedge'}
                            onClick={() => pickBondModeApplying('wedge', 'wedge')} />
                        <IconButton icon='bond_down' testid='bond-dash'
                            title='Down Bond (Dash)'
                            active={tool === 'bond' && bondMode === 'dash'}
                            onClick={() => pickBondModeApplying('dash', 'dash')} />
                        <IconButton icon='bond_double' testid='bond-double'
                            title='Double Bond (Triple deferred to popup batch)'
                            active={tool === 'bond' && bondMode === 'double'}
                            onClick={() => pickBondModeApplying('double', 'double')} />
                        <IconButton icon='bond_aromatic' testid='bond-query'
                            title='Bond Query'
                            onClick={() => comingSoon('Bond query popup')} />
                        <IconButton icon='bond_chain' testid='atom-chain'
                            title='Atom Chain'
                            onClick={() => comingSoon('Atom chain tool')} />
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
                        style={styles.canvas}
                        onClick={onCanvasClick}
                        onMouseDown={onCanvasMouseDown}
                        onMouseMove={onCanvasMove}
                        onMouseUp={onCanvasMouseUp}
                        onMouseLeave={onCanvasMouseLeave}
                        data-testid='sketcher-canvas'
                    />
                    <div style={styles.smilesBar}>
                        <textarea
                            value={smilesInput}
                            onChange={(e) => setSmilesInput(e.target.value)}
                            onKeyDown={(e) => {
                                // Cmd/Ctrl+Enter triggers Load; plain Enter
                                // inserts a newline so multi-line MOL blocks
                                // can be pasted naturally.
                                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                                    e.preventDefault();
                                    doLoadInput();
                                }
                            }}
                            placeholder='Paste SMILES (c1ccccc1) or MOL block — Cmd+Enter to Load'
                            style={{
                                ...styles.smilesInput,
                                height: smilesInput.includes('\n') ? 96 : 26,
                            }}
                            data-testid='smiles-input'
                            spellCheck={false}
                            rows={smilesInput.includes('\n') ? 6 : 1}
                        />
                        <div style={styles.smilesButtons}>
                            <button type='button' style={styles.smilesBtn}
                                data-testid='smiles-load'
                                onClick={doLoadInput}
                                title='Parse input (SMILES or MOL) into the sketch — Cmd+Enter'>Load</button>
                            <button type='button' style={styles.smilesBtn}
                                data-testid='smiles-copy'
                                onClick={() => { void doCopySmiles(); }}
                                title='Write current sketch SMILES to clipboard'>Copy SMILES</button>
                            <button type='button' style={styles.smilesBtn}
                                data-testid='mol-copy'
                                onClick={() => { void doCopyMolBlock(); }}
                                title='Write current sketch as a V2000 MOL block to clipboard'>Copy MOL</button>
                        </div>
                    </div>
                    <div style={styles.statusBox} data-testid='sketcher-status'>
                        {status}
                    </div>
                </div>
            </div>
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
    smilesBar: {
        display: 'flex',
        gap: 6,
        alignItems: 'flex-start',
        padding: '6px 8px',
        background: '#f7f7f7',
        borderTop: `1px solid ${BORDER_COLOR}`,
    },
    smilesInput: {
        flex: '1 1 auto',
        font: '12px Menlo, Consolas, monospace',
        padding: '4px 6px',
        border: `1px solid ${BORDER_COLOR}`,
        borderRadius: 3,
        color: '#222',
        background: 'white',
        minWidth: 0,
        resize: 'vertical',
        verticalAlign: 'top',
    },
    smilesButtons: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        flex: '0 0 auto',
    },
    smilesBtn: {
        font: 'inherit',
        fontSize: 12,
        padding: '4px 10px',
        minHeight: 24,
        border: `1px solid ${BORDER_COLOR}`,
        background: 'white',
        color: '#222',
        borderRadius: 3,
        cursor: 'pointer',
    },
};
