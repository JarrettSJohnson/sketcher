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

type Tool = 'atom' | 'bond';
type Element = 'C' | 'O' | 'N';
type BondOrder = 1 | 2 | 3;

interface AtomDesc {
    i: number;
    el: string;
    x: number;
    y: number;
}
interface BondDesc {
    a: number;
    b: number;
    o: number;
}
interface RenderDesc {
    atoms: AtomDesc[];
    bonds: BondDesc[];
}

const CANVAS_W = 540;
const CANVAS_H = 360;
const SCALE = 40; // pixels per RDKit model unit
const ATOM_HIT_RADIUS = 18; // pixels for click hit-test
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

function drawSketch(
    canvas: HTMLCanvasElement,
    rd: RenderDesc,
    pendingAtomIdx: number | null,
    hoverAtomIdx: number | null,
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

    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1.5;
    for (const b of rd.bonds) {
        const p1 = pixelFromModel(canvas, rd.atoms[b.a].x, rd.atoms[b.a].y);
        const p2 = pixelFromModel(canvas, rd.atoms[b.b].x, rd.atoms[b.b].y);
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
        if (isPending || isHover) {
            ctx.fillStyle = isPending ? '#fbbf24' : '#dbeafe';
            ctx.beginPath();
            ctx.arc(px, py, 13, 0, 2 * Math.PI);
            ctx.fill();
        }
        if (a.el === 'C' && !isPending && !isHover) {
            // Carbon: just a dot so the user can see something's there.
            ctx.fillStyle = '#333';
            ctx.beginPath();
            ctx.arc(px, py, 2.5, 0, 2 * Math.PI);
            ctx.fill();
            continue;
        }
        ctx.fillStyle = 'white';
        ctx.fillRect(px - 9, py - 9, 18, 18);
        ctx.fillStyle = ELEMENT_COLORS[a.el] ?? '#333';
        ctx.fillText(a.el, px, py);
    }
}

interface SketcherProps {
    module: SketcherLeanModule;
}

export function Sketcher({ module: Module }: SketcherProps): JSX.Element {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const modelRef = useRef<MolModelInstance | null>(null);
    const subscriptionRef = useRef<number | null>(null);
    const pendingRef = useRef<number | null>(null);

    const [tool, setTool] = useState<Tool>('atom');
    const [element, setElement] = useState<Element>('C');
    const [bondOrder, setBondOrder] = useState<BondOrder>(1);
    const [pendingBondAtom, setPendingBondAtom] = useState<number | null>(null);
    const [hoverAtom, setHoverAtom] = useState<number | null>(null);
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
        modelRef.current = model;
        subscriptionRef.current = handle;
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
        drawSketch(canvas, rd, pendingBondAtom, hoverAtom);
    });

    // Keep a ref in sync so the cleanup callback (which doesn't re-create on
    // every render) can clear it without stale state.
    useEffect(() => {
        pendingRef.current = pendingBondAtom;
    }, [pendingBondAtom]);

    const onCanvasClick = useCallback(
        (e: ReactMouseEvent<HTMLCanvasElement>): void => {
            const canvas = canvasRef.current;
            const model = modelRef.current;
            if (!canvas || !model) return;
            const rect = canvas.getBoundingClientRect();
            const px = e.clientX - rect.left;
            const py = e.clientY - rect.top;

            let atoms: AtomDesc[] = [];
            try {
                atoms = (JSON.parse(model.description()) as RenderDesc).atoms;
            } catch {
                atoms = [];
            }
            const hit = nearestAtomIndex(canvas, atoms, px, py);

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
            if (tool !== 'bond') {
                if (hoverAtom !== null) setHoverAtom(null);
                return;
            }
            const rect = canvas.getBoundingClientRect();
            const px = e.clientX - rect.left;
            const py = e.clientY - rect.top;
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
        [tool, hoverAtom],
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

    return (
        <section style={styles.body}>
            <h2 style={styles.h2}>Interactive sketcher</h2>
            <p style={styles.meta}>
                Drives <code>sketcher_core::MolModel</code> via embind — same
                undo stack the C++ Boost tests cover. No Qt under the hood.
            </p>

            <div style={styles.toolbar}>
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
                    onMouseMove={onCanvasMove}
                    onMouseLeave={() => setHoverAtom(null)}
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
