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

type Tool = 'atom' | 'bond' | 'select';
type Element = 'C' | 'O' | 'N';
type BondOrder = 1 | 2 | 3;

interface AtomDesc {
    i: number;
    el: string;
    x: number;
    y: number;
    sel?: boolean;
}
interface BondDesc {
    a: number;
    b: number;
    o: number;
    sel?: boolean;
}
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

const ELEMENT_COLORS: Record<string, string> = {
    O: '#c00',
    N: '#06c',
    C: '#333',
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

    // Faint grid so the click-to-place behavior feels intentional.
    ctx.strokeStyle = '#eef2f7';
    ctx.lineWidth = 1;
    for (let gx = 0; gx <= canvas.width; gx += SCALE) {
        ctx.beginPath();
        ctx.moveTo(gx, 0);
        ctx.lineTo(gx, canvas.height);
        ctx.stroke();
    }
    for (let gy = 0; gy <= canvas.height; gy += SCALE) {
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.lineTo(canvas.width, gy);
        ctx.stroke();
    }

    for (let i = 0; i < rd.bonds.length; ++i) {
        const b = rd.bonds[i];
        const p1 = pixelFromModel(canvas, rd.atoms[b.a].x, rd.atoms[b.a].y);
        const p2 = pixelFromModel(canvas, rd.atoms[b.b].x, rd.atoms[b.b].y);
        if (b.sel) {
            // Wide translucent highlight underneath the bond strokes.
            ctx.strokeStyle = '#bfdbfe';
            ctx.lineWidth = 8;
            ctx.beginPath();
            ctx.moveTo(p1.px, p1.py);
            ctx.lineTo(p2.px, p2.py);
            ctx.stroke();
        }
        ctx.strokeStyle = b.sel ? '#1d4ed8' : '#333';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(p1.px, p1.py);
        ctx.lineTo(p2.px, p2.py);
        ctx.stroke();
        if (b.o === 2 || b.o === 3) {
            const dx = p2.px - p1.px;
            const dy = p2.py - p1.py;
            const len = Math.hypot(dx, dy);
            const ox = (-dy / len) * 4;
            const oy = (dx / len) * 4;
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
            // Selection ring sits behind the hover/pending fills so it doesn't
            // disappear when the user mouses over a selected atom.
            ctx.fillStyle = '#1d4ed8';
            ctx.beginPath();
            ctx.arc(px, py, 13, 0, 2 * Math.PI);
            ctx.fill();
            ctx.fillStyle = '#dbeafe';
            ctx.beginPath();
            ctx.arc(px, py, 10, 0, 2 * Math.PI);
            ctx.fill();
        }
        if (isPending || isHover) {
            ctx.fillStyle = isPending ? '#fbbf24' : '#dbeafe';
            ctx.beginPath();
            ctx.arc(px, py, 13, 0, 2 * Math.PI);
            ctx.fill();
        }
        if (a.el === 'C' && !isPending && !isHover && !a.sel) {
            // Carbon: just a dot so the user can see something's there.
            ctx.fillStyle = '#333';
            ctx.beginPath();
            ctx.arc(px, py, 2.5, 0, 2 * Math.PI);
            ctx.fill();
            continue;
        }
        if (a.el !== 'C') {
            ctx.fillStyle = 'white';
            ctx.fillRect(px - 9, py - 9, 18, 18);
        }
        ctx.fillStyle = ELEMENT_COLORS[a.el] ?? '#333';
        if (a.el === 'C' && a.sel && !isPending && !isHover) {
            ctx.beginPath();
            ctx.arc(px, py, 2.5, 0, 2 * Math.PI);
            ctx.fill();
        } else {
            ctx.fillText(a.el, px, py);
        }
    }

    if (dragRect) {
        const { x1, y1, x2, y2 } = dragRectBounds(dragRect);
        ctx.fillStyle = 'rgba(29, 78, 216, 0.10)';
        ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
        ctx.strokeStyle = '#1d4ed8';
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

    const [tool, setTool] = useState<Tool>('atom');
    const [element, setElement] = useState<Element>('C');
    const [bondOrder, setBondOrder] = useState<BondOrder>(1);
    const [pendingBondAtom, setPendingBondAtom] = useState<number | null>(null);
    const [hoverAtom, setHoverAtom] = useState<number | null>(null);
    const [dragRect, setDragRect] = useState<DragRect | null>(null);
    const [status, setStatus] = useState<string>('ready');
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
        [tool, element, bondOrder],
    );

    const onCanvasMove = useCallback(
        (e: ReactMouseEvent<HTMLCanvasElement>): void => {
            const canvas = canvasRef.current;
            const model = modelRef.current;
            if (!canvas || !model) return;
            const rect = canvas.getBoundingClientRect();
            const px = e.clientX - rect.left;
            const py = e.clientY - rect.top;
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
            // If the press lands on an atom or bond, let the click handler
            // do its toggle — only empty-area presses start a rectangle.
            if (nearestAtomIndex(canvas, rd.atoms, px, py) >= 0) return;
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

    return (
        <section style={styles.body}>
            <h2 style={styles.h2}>Interactive sketcher</h2>
            <p style={styles.meta}>
                Drives <code>sketcher_core::MolModel</code> via embind — same
                undo stack the C++ Boost tests cover. No Qt under the hood.
            </p>

            <div style={styles.toolbar}>
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
                <span style={styles.divider} />
                {(['C', 'O', 'N'] as const).map((el) => (
                    <ToolButton
                        key={el}
                        label={el}
                        active={element === el}
                        onClick={() => setElement(el)}
                        testid={`element-${el}`}
                    />
                ))}
                <span style={styles.divider} />
                {([1, 2, 3] as const).map((o) => (
                    <ToolButton
                        key={o}
                        label={o === 1 ? 'Single' : o === 2 ? 'Double' : 'Triple'}
                        active={bondOrder === o}
                        onClick={() => setBondOrder(o)}
                        testid={`bond-${o}`}
                    />
                ))}
                <span style={styles.divider} />
                <ActionButton
                    label='Select all'
                    onClick={doSelectAll}
                    testid='select-all'
                />
                <ActionButton
                    label='Delete selected'
                    onClick={doDeleteSelected}
                    testid='delete-selected'
                />
                <ActionButton label='Undo' onClick={doUndo} testid='undo' />
                <ActionButton label='Redo' onClick={doRedo} testid='redo' />
                <ActionButton label='Clear' onClick={doClear} testid='clear' />
            </div>

            <div style={styles.row}>
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
                <div style={styles.statusBox} data-testid='sketcher-status'>
                    {status}
                </div>
            </div>
        </section>
    );
}

interface ToolButtonProps {
    label: string;
    active: boolean;
    onClick: () => void;
    testid: string;
}

function ToolButton({ label, active, onClick, testid }: ToolButtonProps): JSX.Element {
    return (
        <button
            style={{
                ...styles.toolBtn,
                ...(active ? styles.toolBtnActive : {}),
            }}
            onClick={onClick}
            data-testid={testid}
            aria-pressed={active}
        >
            {label}
        </button>
    );
}

interface ActionButtonProps {
    label: string;
    onClick: () => void;
    testid: string;
}

function ActionButton({ label, onClick, testid }: ActionButtonProps): JSX.Element {
    return (
        <button
            style={styles.actionBtn}
            onClick={onClick}
            data-testid={testid}
        >
            {label}
        </button>
    );
}

const styles: Record<string, CSSProperties> = {
    body: { marginTop: 32 },
    h2: { fontSize: 16, margin: '0 0 4px' },
    meta: { color: '#666', fontSize: 12, margin: '0 0 12px' },
    toolbar: {
        display: 'flex',
        gap: 6,
        marginBottom: 10,
        alignItems: 'center',
        flexWrap: 'wrap',
    },
    divider: {
        display: 'inline-block',
        width: 1,
        height: 22,
        background: '#ddd',
        margin: '0 4px',
    },
    toolBtn: {
        font: '12px sans-serif',
        padding: '4px 10px',
        border: '1px solid #bbb',
        background: 'white',
        color: '#333',
        borderRadius: 4,
        cursor: 'pointer',
    },
    toolBtnActive: {
        borderColor: '#2b6cb0',
        background: '#2b6cb0',
        color: 'white',
    },
    actionBtn: {
        font: '12px sans-serif',
        padding: '4px 10px',
        border: '1px solid #aaa',
        background: '#f7f7f8',
        color: '#222',
        borderRadius: 4,
        cursor: 'pointer',
    },
    row: { display: 'flex', gap: 12, alignItems: 'flex-start' },
    canvas: {
        border: '1px solid #ddd',
        borderRadius: 4,
        background: 'white',
        display: 'block',
        cursor: 'crosshair',
    },
    statusBox: {
        flex: '1 1 auto',
        font: '12px monospace',
        background: '#f4f4f6',
        border: '1px solid #ddd',
        borderRadius: 4,
        padding: '8px 10px',
        color: '#333',
        minHeight: 40,
    },
};
