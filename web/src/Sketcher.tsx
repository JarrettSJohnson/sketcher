import {
    useCallback,
    useEffect,
    useReducer,
    useRef,
    useState,
    type CSSProperties,
    type JSX,
    type MouseEvent as ReactMouseEvent,
    type ReactNode,
} from 'react';
import type { MolModelInstance, SketcherLeanModule } from './sketcherLean';

// Pure interactive demo that drives sketcher_core::MolModel via embind.
// Click empty canvas to add an atom of the current element; click an existing
// atom (with the bond tool selected) to start a bond, then click a second atom
// to commit it. Undo/redo/clear go through the same UndoStack the C++ Boost
// tests cover.

type Tool = 'atom' | 'bond' | 'select' | 'ring';
type Element = 'C' | 'O' | 'N' | 'H' | 'Cl';
type BondOrder = 1 | 2 | 3;

interface RingSpec {
    size: number;
    aromatic: boolean;
    label: string;
}
const RING_BENZENE: RingSpec = { size: 6, aromatic: true, label: 'Benzene' };
const RING_CYCLOHEXANE: RingSpec = { size: 6, aromatic: false, label: 'Cyclohexane' };
const RING_CYCLOPENTANE: RingSpec = { size: 5, aromatic: false, label: 'Cyclopentane' };

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
const SCALE = 40; // pixels per RDKit model unit
const ATOM_HIT_RADIUS = 18; // pixels for click hit-test
const BOND_HIT_RADIUS = 6; // pixels perpendicular to bond line
const BLANK_DESC: RenderDesc = { atoms: [], bonds: [] };

// Element colors approximate the CPK conventions the original uses.
// Chlorine is the deeper green used in the Qt build — pure #0c0 fights
// the sage accent for attention.
const ELEMENT_COLORS: Record<string, string> = {
    C: '#222',
    O: '#c0392b',
    N: '#1f4faa',
    H: '#888',
    Cl: '#3fa54f',
};

function modelFromPixel(
    canvas: HTMLCanvasElement,
    pixelX: number,
    pixelY: number,
): { x: number; y: number } {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    return { x: (pixelX - cx) / SCALE, y: -(pixelY - cy) / SCALE };
}

function pixelFromModel(
    canvas: HTMLCanvasElement,
    x: number,
    y: number,
): { px: number; py: number } {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    return { px: x * SCALE + cx, py: -y * SCALE + cy };
}

function nearestAtomIndex(
    canvas: HTMLCanvasElement,
    atoms: AtomDesc[],
    pixelX: number,
    pixelY: number,
): number {
    let bestIdx = -1;
    let bestDist = ATOM_HIT_RADIUS;
    for (const a of atoms) {
        const { px, py } = pixelFromModel(canvas, a.x, a.y);
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
        const p1 = pixelFromModel(canvas, a1.x, a1.y);
        const p2 = pixelFromModel(canvas, a2.x, a2.y);
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
    idx: number;
    fromX: number; // model coords at drag start (for undo command)
    fromY: number;
    startPx: number; // pixel coords at drag start (for threshold check)
    startPy: number;
    moved: boolean; // true once we crossed the move threshold
}

const ATOM_DRAG_THRESHOLD = 3; // pixels — below this, treat as a click

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

    for (let i = 0; i < rd.bonds.length; ++i) {
        const b = rd.bonds[i];
        const p1 = pixelFromModel(canvas, rd.atoms[b.a].x, rd.atoms[b.a].y);
        const p2 = pixelFromModel(canvas, rd.atoms[b.b].x, rd.atoms[b.b].y);
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
        } else {
            ctx.lineWidth = BOND_STROKE;
            ctx.beginPath();
            ctx.moveTo(p1.px, p1.py);
            ctx.lineTo(p2.px, p2.py);
            ctx.stroke();
        }
        if (b.o === 2 || b.o === 3) {
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
        const { px, py } = pixelFromModel(canvas, a.x, a.y);
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

    const [tool, setTool] = useState<Tool>('atom');
    const [element, setElement] = useState<Element>('C');
    const [bondOrder, setBondOrder] = useState<BondOrder>(1);
    const [ring, setRing] = useState<RingSpec>(RING_BENZENE);
    const [pendingBondAtom, setPendingBondAtom] = useState<number | null>(null);
    const [hoverAtom, setHoverAtom] = useState<number | null>(null);
    const [dragRect, setDragRect] = useState<DragRect | null>(null);
    const [status, setStatus] = useState<string>('ready');
    const [smilesInput, setSmilesInput] = useState<string>('');
    const [, bumpVersion] = useReducer((v: number) => v + 1, 0);

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
        drawSketch(canvas, rd, pendingBondAtom, hoverAtom, dragRect);
    });

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
            const hit = nearestAtomIndex(canvas, rd.atoms, px, py);

            if (tool === 'select') {
                if (hit >= 0) {
                    const wasSelected = model.isAtomSelected(hit);
                    model.setAtomSelected(hit, !wasSelected);
                    setStatus(
                        `${wasSelected ? 'deselect' : 'select'} atom #${hit}`,
                    );
                    return;
                }
                const bondHit = nearestBondIndex(canvas, rd, px, py);
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
                const { x, y } = modelFromPixel(canvas, px, py);
                model.addAtom(element, x, y);
                setStatus(`added ${element} at (${x.toFixed(2)}, ${y.toFixed(2)})`);
                return;
            }

            if (tool === 'ring') {
                // Click anywhere — empty canvas or atom — drops a fresh ring
                // centered on the click. Mirrors the Qt sketcher's ring-tool
                // behavior (the new ring isn't fused with any existing atom in
                // this skeleton; that's a future enhancement).
                const { x, y } = modelFromPixel(canvas, px, py);
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
                model.addBond(pendingRef.current, hit, bondOrder);
                setStatus(
                    `bond: ${pendingRef.current}-${hit} (order ${bondOrder})`,
                );
            } catch (err) {
                setStatus(`bond failed: ${String(err)}`);
            } finally {
                setPendingBondAtom(null);
            }
        },
        [tool, element, bondOrder, ring],
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
                const { x, y } = modelFromPixel(canvas, px, py);
                model.setAtomPos(ad.idx, x, y);
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
            const hit = nearestAtomIndex(canvas, atoms, px, py);
            const next = hit >= 0 ? hit : null;
            if (next !== hoverAtom) setHoverAtom(next);
        },
        [tool, hoverAtom, dragRect],
    );

    const onCanvasMouseDown = useCallback(
        (e: ReactMouseEvent<HTMLCanvasElement>): void => {
            if (tool !== 'select') return;
            if (e.button !== 0) return;
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
            const atomHit = nearestAtomIndex(canvas, rd.atoms, px, py);
            if (atomHit >= 0) {
                // Press on an atom: prepare a drag-to-move. If the user just
                // releases without crossing the threshold, the click handler
                // will treat it as a select toggle.
                const a = rd.atoms.find((x) => x.i === atomHit);
                if (!a) return;
                atomDragRef.current = {
                    idx: atomHit,
                    fromX: a.x,
                    fromY: a.y,
                    startPx: px,
                    startPy: py,
                    moved: false,
                };
                return;
            }
            // Press on a bond: let onClick handle the bond toggle.
            if (nearestBondIndex(canvas, rd, px, py) >= 0) return;

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
                const { x: toX, y: toY } = modelFromPixel(canvas, px, py);
                // setAtomPos previews have already moved the conformer; commit
                // a single undo command capturing the original→final delta.
                model.moveAtomUndoable(ad.idx, ad.fromX, ad.fromY, toX, toY);
                suppressNextClickRef.current = true;
                setStatus(
                    `moved atom #${ad.idx} to ` +
                        `(${toX.toFixed(2)}, ${toY.toFixed(2)})`,
                );
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
                const { px, py } = pixelFromModel(canvas, a.x, a.y);
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
        // Cancel an atom-drag that left the canvas: restore the original
        // position so the preview doesn't leave the atom stranded.
        const ad = atomDragRef.current;
        if (ad) {
            atomDragRef.current = null;
            if (ad.moved) {
                modelRef.current?.setAtomPos(ad.idx, ad.fromX, ad.fromY);
                setStatus(`move cancelled (atom #${ad.idx})`);
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
    const applyStereo = (dir: number, label: string): void => {
        const model = modelRef.current;
        if (!model) return;
        if (!model.hasSelection()) {
            setStatus('select a bond first');
            return;
        }
        model.setBondDirForSelectedBonds(dir);
        setStatus(label);
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

    return (
        <section style={styles.shell}>
            <div style={styles.topBar}>
                <div style={styles.topBarGroup}>
                    <ActionButton label='Undo' onClick={doUndo} testid='undo' title='Undo (Ctrl+Z)' />
                    <ActionButton label='Redo' onClick={doRedo} testid='redo' title='Redo (Ctrl+Y)' />
                </div>
                <span style={styles.topDivider} />
                <div style={styles.topBarGroup}>
                    <ActionButton
                        label='Select all'
                        onClick={doSelectAll}
                        testid='select-all'
                        title='Select all (Ctrl+A)'
                    />
                    <ActionButton
                        label='Delete'
                        onClick={doDeleteSelected}
                        testid='delete-selected'
                        title='Delete selection (Del)'
                    />
                </div>
                <span style={styles.topDivider} />
                <div style={styles.topBarGroup}>
                    <ActionButton label='Clear' onClick={doClear} testid='clear' />
                </div>
                <div style={styles.topSpacer} />
                <div style={styles.titleBlock}>
                    <span style={styles.title}>2D Sketcher</span>
                    <span style={styles.subtitle}>Qt-free preview</span>
                </div>
            </div>

            <div style={styles.workspace}>
                <aside style={styles.sidebar}>
                    <Section label='Tools'>
                        <ToolButton
                            label='Select'
                            active={tool === 'select'}
                            onClick={() => {
                                setTool('select');
                                setPendingBondAtom(null);
                            }}
                            testid='tool-select'
                        />
                        <ToolButton
                            label='Atom'
                            active={tool === 'atom'}
                            onClick={() => {
                                setTool('atom');
                                setPendingBondAtom(null);
                            }}
                            testid='tool-atom'
                        />
                        <ToolButton
                            label='Bond'
                            active={tool === 'bond'}
                            onClick={() => {
                                setTool('bond');
                                setPendingBondAtom(null);
                            }}
                            testid='tool-bond'
                        />
                    </Section>
                    <Section label='Atoms'>
                        {(['C', 'N', 'O', 'H', 'Cl'] as const).map((el) => (
                            <ToolButton
                                key={el}
                                label={el}
                                active={element === el}
                                onClick={() => {
                                    setElement(el);
                                    setTool('atom');
                                    setPendingBondAtom(null);
                                }}
                                testid={`element-${el}`}
                                color={ELEMENT_COLORS[el]}
                            />
                        ))}
                    </Section>
                    <Section label='Bonds'>
                        {([1, 2, 3] as const).map((o) => (
                            <ToolButton
                                key={o}
                                label={o === 1 ? 'Single' : o === 2 ? 'Double' : 'Triple'}
                                active={bondOrder === o}
                                onClick={() => {
                                    setBondOrder(o);
                                    setTool('bond');
                                    setPendingBondAtom(null);
                                }}
                                testid={`bond-${o}`}
                            />
                        ))}
                    </Section>
                    <Section label='Rings'>
                        {([RING_BENZENE, RING_CYCLOHEXANE, RING_CYCLOPENTANE] as const).map((spec) => (
                            <ToolButton
                                key={spec.label}
                                label={spec.label}
                                active={tool === 'ring' && ring.label === spec.label}
                                onClick={() => {
                                    setRing(spec);
                                    setTool('ring');
                                    setPendingBondAtom(null);
                                }}
                                testid={`ring-${spec.label.toLowerCase()}`}
                            />
                        ))}
                    </Section>
                    <Section label='Charge'>
                        <ActionButton
                            label='+'
                            onClick={() => adjustCharge(+1)}
                            testid='charge-plus'
                            title='Increase charge on selected atoms'
                        />
                        <ActionButton
                            label='−'
                            onClick={() => adjustCharge(-1)}
                            testid='charge-minus'
                            title='Decrease charge on selected atoms'
                        />
                    </Section>
                    <Section label='Stereo'>
                        <ActionButton
                            label='Wedge'
                            onClick={() => applyStereo(BOND_DIR_WEDGE, 'wedge applied')}
                            testid='stereo-wedge'
                        />
                        <ActionButton
                            label='Dash'
                            onClick={() => applyStereo(BOND_DIR_DASH, 'dash applied')}
                            testid='stereo-dash'
                        />
                        <ActionButton
                            label='No stereo'
                            onClick={() => applyStereo(BOND_DIR_NONE, 'stereo cleared')}
                            testid='stereo-none'
                        />
                    </Section>
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
                                // Grow taller when content looks like a MOL block
                                // (multi-line) so the user can see what they pasted.
                                height: smilesInput.includes('\n') ? 96 : 26,
                            }}
                            data-testid='smiles-input'
                            spellCheck={false}
                            rows={smilesInput.includes('\n') ? 6 : 1}
                        />
                        <div style={styles.smilesButtons}>
                            <ActionButton
                                label='Load'
                                onClick={doLoadInput}
                                testid='smiles-load'
                                title='Parse input (SMILES or MOL) into the sketch — Cmd+Enter'
                            />
                            <ActionButton
                                label='Copy SMILES'
                                onClick={() => {
                                    void doCopySmiles();
                                }}
                                testid='smiles-copy'
                                title='Write current sketch SMILES to clipboard'
                            />
                            <ActionButton
                                label='Copy MOL'
                                onClick={() => {
                                    void doCopyMolBlock();
                                }}
                                testid='mol-copy'
                                title='Write current sketch as a V2000 MOL block to clipboard'
                            />
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

function Section({ label, children }: { label: string; children: ReactNode }): JSX.Element {
    return (
        <div style={styles.section}>
            <div style={styles.sectionLabel}>{label}</div>
            <div style={styles.sectionGrid}>{children}</div>
        </div>
    );
}

interface ToolButtonProps {
    label: string;
    active: boolean;
    onClick: () => void;
    testid: string;
    color?: string;
    title?: string;
}

function ToolButton({ label, active, onClick, testid, color, title }: ToolButtonProps): JSX.Element {
    const [hover, setHover] = useState(false);
    return (
        <button
            style={{
                ...styles.toolBtn,
                ...(hover && !active ? styles.toolBtnHover : {}),
                ...(active ? styles.toolBtnActive : {}),
                ...(color && !active ? { color } : {}),
            }}
            onClick={onClick}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            data-testid={testid}
            aria-pressed={active}
            title={title ?? label}
        >
            {label}
        </button>
    );
}

interface ActionButtonProps {
    label: string;
    onClick: () => void;
    testid: string;
    title?: string;
}

function ActionButton({ label, onClick, testid, title }: ActionButtonProps): JSX.Element {
    const [hover, setHover] = useState(false);
    return (
        <button
            style={{
                ...styles.actionBtn,
                ...(hover ? styles.actionBtnHover : {}),
            }}
            onClick={onClick}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            data-testid={testid}
            title={title ?? label}
        >
            {label}
        </button>
    );
}

// Palette echoes the original Qt QSS: accent sage green, sky-blue "checked"
// state (matches Qt's QToolButton:checked), beige hover. The whole layout
// (left sidebar + top action bar + canvas) mirrors sketcher_widget.ui so a
// returning Qt user lands in the same place.
const TOP_BAR_BG = '#f4f4f4';
const SIDEBAR_BG = '#f4f4f4';
const BORDER_COLOR = '#cfcfcf';
const CHECKED_BG = '#d4e6f1';
const CHECKED_BORDER = '#7fa9c7';
const ACTION_HOVER_BG = '#edf7fc';

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
        gap: 6,
        padding: '6px 8px',
        background: TOP_BAR_BG,
        borderBottom: `1px solid ${BORDER_COLOR}`,
        minHeight: 35,
    },
    topBarGroup: { display: 'flex', gap: 4, alignItems: 'center' },
    topDivider: {
        display: 'inline-block',
        width: 1,
        height: 22,
        background: BORDER_COLOR,
        margin: '0 2px',
    },
    topSpacer: { flex: '1 1 auto' },
    titleBlock: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        lineHeight: 1.1,
    },
    title: { fontSize: 13, fontWeight: 600, color: '#333' },
    subtitle: { fontSize: 10, color: '#888' },
    workspace: { display: 'flex', alignItems: 'stretch' },
    sidebar: {
        width: 117,
        flex: '0 0 117px',
        background: SIDEBAR_BG,
        borderRight: `1px solid ${BORDER_COLOR}`,
        padding: '8px 6px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        boxSizing: 'border-box',
        overflow: 'hidden',
    },
    section: { display: 'flex', flexDirection: 'column', gap: 4 },
    sectionLabel: {
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        color: '#777',
        padding: '0 2px',
    },
    sectionGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(2, 1fr)',
        gap: 3,
    },
    canvasColumn: {
        flex: '1 1 auto',
        display: 'flex',
        flexDirection: 'column',
        background: 'white',
    },
    toolBtn: {
        font: 'inherit',
        fontSize: 12,
        padding: '5px 4px',
        minHeight: 28,
        // minWidth:0 + overflow rules let the button shrink into its grid
        // cell. Without these, long labels like "Cyclohexane" overflow and
        // the visible button center can land on top of the adjacent canvas,
        // which then intercepts pointer events on the button.
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        border: `1px solid ${BORDER_COLOR}`,
        background: 'white',
        color: '#222',
        borderRadius: 3,
        cursor: 'pointer',
        textAlign: 'center',
    },
    toolBtnHover: {
        background: ACTION_HOVER_BG,
        borderColor: CHECKED_BORDER,
    },
    toolBtnActive: {
        background: CHECKED_BG,
        borderColor: CHECKED_BORDER,
        color: '#111',
        fontWeight: 600,
    },
    actionBtn: {
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
    actionBtnHover: {
        background: ACTION_HOVER_BG,
        borderColor: CHECKED_BORDER,
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
        // Inherit the cell's vertical-aligned baseline so the input and
        // adjacent buttons line up when the textarea is single-line.
        verticalAlign: 'top',
    },
    smilesButtons: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        flex: '0 0 auto',
    },
};
