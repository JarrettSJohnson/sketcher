// Loader for the lean Emscripten bundle.
//
// SketcherLean.js is *not* an ES module — it's the classic Emscripten output
// that defines a global `sketcher_lean_entry` factory. We therefore inject it
// via a <script> tag, wait for the global to appear, and then call the
// factory. Both the .js loader and the .wasm payload are served from / by
// the vite middleware in vite.config.ts (dev) or copied to dist/ (prod).

export interface SketcherLeanModule {
    render_description_from_smiles(smiles: string): string;
    getExceptionMessage?: (ptr: number) => string[];
    // MolModel / Counter classes also exist but are unused here.
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
