import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type ChangeEvent,
    type CSSProperties,
    type JSX,
} from 'react';
import { loadSketcherLean, type SketcherLeanModule } from './sketcherLean';

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

const DEFAULT_SMILES = 'CC(=O)Oc1ccccc1C(=O)O';

function drawDescription(canvas: HTMLCanvasElement, rd: RenderDesc): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!rd.atoms.length) return;

    const xs = rd.atoms.map((a) => a.x);
    const ys = rd.atoms.map((a) => a.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const pad = 40;
    const scale = Math.min(
        (canvas.width - 2 * pad) / Math.max(maxX - minX, 1),
        (canvas.height - 2 * pad) / Math.max(maxY - minY, 1),
    );
    const cx = (canvas.width - (minX + maxX) * scale) / 2;
    const cy = (canvas.height + (minY + maxY) * scale) / 2;
    const px = (a: AtomDesc): number => a.x * scale + cx;
    const py = (a: AtomDesc): number => -a.y * scale + cy;

    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1.5;
    for (const b of rd.bonds) {
        const a1 = rd.atoms[b.a];
        const a2 = rd.atoms[b.b];
        const x1 = px(a1);
        const y1 = py(a1);
        const x2 = px(a2);
        const y2 = py(a2);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        if (b.o === 2) {
            const dx = x2 - x1;
            const dy = y2 - y1;
            const len = Math.hypot(dx, dy);
            const ox = (-dy / len) * 4;
            const oy = (dx / len) * 4;
            ctx.beginPath();
            ctx.moveTo(x1 + ox, y1 + oy);
            ctx.lineTo(x2 + ox, y2 + oy);
            ctx.stroke();
        }
    }

    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const a of rd.atoms) {
        if (a.el === 'C') continue;
        const x = px(a);
        const y = py(a);
        ctx.fillStyle = 'white';
        ctx.fillRect(x - 9, y - 9, 18, 18);
        ctx.fillStyle =
            a.el === 'O' ? '#c00' : a.el === 'N' ? '#06c' : '#333';
        ctx.fillText(a.el, x, y);
    }
}

export function App(): JSX.Element {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const moduleRef = useRef<SketcherLeanModule | null>(null);
    const [smiles, setSmiles] = useState<string>(DEFAULT_SMILES);
    const [status, setStatus] = useState<string>('loading WASM module...');
    const [statusError, setStatusError] = useState<boolean>(false);
    const [outputJson, setOutputJson] = useState<string>(
        '(render description JSON will appear here)',
    );
    const [moduleReady, setModuleReady] = useState<boolean>(false);

    const renderSmiles = useCallback((smi: string): void => {
        const trimmed = smi.trim();
        const canvas = canvasRef.current;
        const Module = moduleRef.current;
        if (!trimmed || !canvas || !Module) return;
        try {
            const json = Module.render_description_from_smiles(trimmed);
            const rd = JSON.parse(json) as RenderDesc;
            setOutputJson(JSON.stringify(rd, null, 2));
            drawDescription(canvas, rd);
            setStatus(
                `ready - ${rd.atoms.length} atoms, ${rd.bonds.length} bonds`,
            );
            setStatusError(false);
        } catch (e: unknown) {
            let msg: string;
            if (typeof e === 'number' && Module.getExceptionMessage) {
                msg = Module.getExceptionMessage(e).join(': ');
            } else if (e instanceof Error) {
                msg = e.message;
            } else {
                msg = String(e);
            }
            setOutputJson('error: ' + msg);
            setStatus('parse failed');
            setStatusError(true);
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        loadSketcherLean()
            .then((Module) => {
                if (cancelled) return;
                moduleRef.current = Module;
                // Expose for Playwright / console poking, mirroring lean.html.
                (window as unknown as { Module: SketcherLeanModule }).Module =
                    Module;
                setModuleReady(true);
                setStatus('ready');
                setStatusError(false);
                renderSmiles(smiles);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setStatus(`WASM load failed: ${String(err)}`);
                setStatusError(true);
            });
        return () => {
            cancelled = true;
        };
        // We intentionally run this once on mount; renderSmiles is stable
        // and the initial smiles value is captured for the first render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const onSmilesChange = (e: ChangeEvent<HTMLInputElement>): void => {
        const next = e.target.value;
        setSmiles(next);
        if (moduleReady) renderSmiles(next);
    };

    const onGoClick = (): void => {
        if (moduleReady) renderSmiles(smiles);
    };

    return (
        <div style={styles.body}>
            <h1 style={styles.h1}>Sketcher Lean WASM - React spike</h1>
            <p style={styles.meta}>
                Loads only <code>rdkit_extensions</code> + RDKit. No Qt. React
                + Vite + TS scaffold mirroring{' '}
                <code>wasm/public/lean.html</code>.
            </p>

            <div style={styles.row}>
                <input
                    style={styles.input}
                    type='text'
                    value={smiles}
                    onChange={onSmilesChange}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') onGoClick();
                    }}
                />
                <button style={styles.button} onClick={onGoClick}>
                    Parse + draw
                </button>
                <span
                    style={{
                        ...styles.status,
                        ...(statusError ? styles.err : {}),
                    }}
                >
                    {status}
                </span>
            </div>

            <div style={styles.grid}>
                <canvas
                    ref={canvasRef}
                    width={500}
                    height={400}
                    style={styles.canvas}
                />
                <pre style={styles.pre}>{outputJson}</pre>
            </div>
        </div>
    );
}

const styles: Record<string, CSSProperties> = {
    body: {
        font: '14px/1.5 -apple-system, BlinkMacSystemFont, sans-serif',
        maxWidth: 1100,
        margin: '24px auto',
        padding: '0 16px',
    },
    h1: { fontSize: 18, margin: '0 0 6px' },
    meta: { color: '#666', fontSize: 12, marginBottom: 16 },
    row: {
        display: 'flex',
        gap: 12,
        marginBottom: 12,
        alignItems: 'center',
        flexWrap: 'wrap',
    },
    input: {
        font: '13px monospace',
        padding: '6px 8px',
        flex: '1 1 320px',
        border: '1px solid #bbb',
        borderRadius: 4,
    },
    button: {
        font: '13px sans-serif',
        padding: '6px 12px',
        border: '1px solid #2b6cb0',
        background: '#2b6cb0',
        color: 'white',
        borderRadius: 4,
        cursor: 'pointer',
    },
    status: { fontSize: 12, color: '#666' },
    err: { color: '#b91c1c' },
    grid: {
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 12,
    },
    canvas: {
        border: '1px solid #ddd',
        borderRadius: 4,
        background: 'white',
        display: 'block',
    },
    pre: {
        background: '#f4f4f6',
        border: '1px solid #ddd',
        borderRadius: 4,
        padding: 10,
        maxHeight: '60vh',
        overflow: 'auto',
        fontSize: 12,
    },
};
