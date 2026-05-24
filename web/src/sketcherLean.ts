// Loader for the lean Emscripten bundle.
//
// SketcherLean.js is *not* an ES module — it's the classic Emscripten output
// that defines a global `sketcher_lean_entry` factory. We therefore inject it
// via a <script> tag, wait for the global to appear, and then call the
// factory. Both the .js loader and the .wasm payload are served from / by
// the vite middleware in vite.config.ts (dev) or copied to dist/ (prod).

export interface MolModelInstance {
    addAtom(element: string, x: number, y: number): void;
    addBond(begin: number, end: number, bondType: number): void;
    removeAtom(idx: number): void;
    removeBond(begin: number, end: number): void;
    clear(): void;
    setAtomPos(idx: number, x: number, y: number): void;
    moveAtomUndoable(
        idx: number,
        fromX: number,
        fromY: number,
        toX: number,
        toY: number,
    ): void;
    /**
     * Batched moveAtomUndoable — every (idx, from, to) row commits inside
     * a single undo macro so the whole gesture collapses to one undo.
     */
    moveAtomsUndoable(
        indices: number[],
        fromXs: number[],
        fromYs: number[],
        toXs: number[],
        toYs: number[],
    ): void;
    /** dir is RDKit::Bond::BondDir as int: 0=NONE, 1=BEGINWEDGE, 2=BEGINDASH. */
    setBondDirUndoable(begin: number, end: number, dir: number): void;
    setBondDirForSelectedBonds(dir: number): void;
    addRing(size: number, cx: number, cy: number, aromatic: boolean): void;
    adjustChargeOnSelectedAtoms(delta: number): void;
    /** Replace mol with parsed SMILES. Throws if SMILES is malformed. */
    loadFromSmiles(smiles: string): void;
    /** Replace mol with parsed text (auto-detects SMILES, MOL, etc.). Throws on failure. */
    loadFromText(text: string): void;
    /** Canonical SMILES for the current mol; empty string if mol is empty. */
    toSmiles(): string;
    /** MDL MOL block (V3000 if `v3000` else V2000); empty for empty mol. */
    toMolBlock(v3000: boolean): string;
    /** Promote every implicit hydrogen to an explicit atom. Single undo step. */
    addHydrogens(): void;
    /** Strip explicit hydrogens back to implicit. Single undo step. */
    removeHydrogens(): void;
    /** Perceive aromaticity — sets arom flag on atoms/bonds. Single undo step. */
    aromatize(): void;
    /** Kekulize aromatic bonds back to explicit SINGLE/DOUBLE alternation. Single undo step. */
    kekulize(): void;
    undo(): void;
    redo(): void;
    numAtoms(): number;
    numBonds(): number;
    setAtomSelected(idx: number, selected: boolean): void;
    setBondSelected(idx: number, selected: boolean): void;
    isAtomSelected(idx: number): boolean;
    isBondSelected(idx: number): boolean;
    hasSelection(): boolean;
    selectAll(): void;
    clearSelection(): void;
    deleteSelected(): void;
    description(): string;
    delete(): void;
}

interface MolModelConstructor {
    new (): MolModelInstance;
}

export interface SketcherLeanModule {
    render_description_from_smiles(smiles: string): string;
    MolModel: MolModelConstructor;
    mol_model_subscribe(m: MolModelInstance, cb: () => void): number;
    mol_model_unsubscribe(handle: number): void;
    mol_model_selection_subscribe(m: MolModelInstance, cb: () => void): number;
    mol_model_selection_unsubscribe(handle: number): void;
    getExceptionMessage?: (ptr: number) => string[];
    [key: string]: unknown;
}

type SketcherLeanFactory = (opts?: {
    locateFile?: (path: string) => string;
    getExceptionMessage?: unknown;
}) => Promise<SketcherLeanModule>;

declare global {
    interface Window {
        sketcher_lean_entry?: SketcherLeanFactory;
    }
}

const SCRIPT_URL = '/SketcherLean.js';
const WASM_URL = '/SketcherLean.wasm';

let factoryPromise: Promise<SketcherLeanFactory> | null = null;
let modulePromise: Promise<SketcherLeanModule> | null = null;

function loadFactory(): Promise<SketcherLeanFactory> {
    if (factoryPromise) return factoryPromise;
    factoryPromise = new Promise<SketcherLeanFactory>((resolve, reject) => {
        if (window.sketcher_lean_entry) {
            resolve(window.sketcher_lean_entry);
            return;
        }
        const existing = document.querySelector<HTMLScriptElement>(
            `script[data-sketcher-lean='true']`,
        );
        const script = existing ?? document.createElement('script');
        if (!existing) {
            script.src = SCRIPT_URL;
            script.async = true;
            script.dataset.sketcherLean = 'true';
        }
        script.addEventListener('load', () => {
            if (window.sketcher_lean_entry) {
                resolve(window.sketcher_lean_entry);
            } else {
                reject(
                    new Error(
                        'SketcherLean.js loaded but sketcher_lean_entry not defined',
                    ),
                );
            }
        });
        script.addEventListener('error', () =>
            reject(new Error(`failed to load ${SCRIPT_URL}`)),
        );
        if (!existing) document.head.appendChild(script);
    });
    return factoryPromise;
}

export function loadSketcherLean(): Promise<SketcherLeanModule> {
    if (modulePromise) return modulePromise;
    modulePromise = loadFactory().then((factory) =>
        factory({
            // Tell Emscripten where to fetch the .wasm binary. Without this
            // it tries to resolve relative to SketcherLean.js, which works
            // here but is brittle if the script ever moves.
            locateFile: (path: string) =>
                path.endsWith('.wasm') ? WASM_URL : path,
        }),
    );
    return modulePromise;
}
