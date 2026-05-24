import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The lean WASM bundle lives outside the web/ tree, produced by `pixi run
// wasm-lean-build`. We serve SketcherLean.js/.wasm from that directory both in
// `vite dev` (via middleware below) and `vite build` (copied into dist/ via
// closeBundle). This avoids forcing developers to symlink or copy the bundle.
const LEAN_BUNDLE_DIR = resolve(
    __dirname,
    '../sketcher_lean_wasm_build/sketcher_lean_app',
);

const LEAN_BUNDLE_FILES = ['SketcherLean.js', 'SketcherLean.wasm'] as const;

const CONTENT_TYPES: Record<string, string> = {
    '.js': 'application/javascript; charset=utf-8',
    '.wasm': 'application/wasm',
};

function leanBundlePlugin(): Plugin {
    return {
        name: 'sketcher-lean-bundle',
        configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
                if (!req.url) return next();
                // Strip query/hash so '/SketcherLean.wasm?foo' still matches.
                const path = req.url.split('?')[0].split('#')[0];
                const match = LEAN_BUNDLE_FILES.find(
                    (f) => path === `/${f}`,
                );
                if (!match) return next();

                try {
                    const filePath = resolve(LEAN_BUNDLE_DIR, match);
                    const body = await readFile(filePath);
                    const ext = match.slice(match.lastIndexOf('.'));
                    res.setHeader(
                        'Content-Type',
                        CONTENT_TYPES[ext] ?? 'application/octet-stream',
                    );
                    res.setHeader('Cache-Control', 'no-cache');
                    res.end(body);
                } catch (err) {
                    res.statusCode = 404;
                    res.end(
                        `lean bundle not found at ${LEAN_BUNDLE_DIR}. ` +
                            `Run \`pixi run wasm-lean-build\` first. (${err})`,
                    );
                }
            });
        },
        async closeBundle() {
            // Emit the bundle into dist/ for production builds.
            const { mkdir, copyFile } = await import('node:fs/promises');
            const outDir = resolve(__dirname, 'dist');
            await mkdir(outDir, { recursive: true });
            for (const f of LEAN_BUNDLE_FILES) {
                const src = resolve(LEAN_BUNDLE_DIR, f);
                try {
                    await stat(src);
                    await copyFile(src, resolve(outDir, f));
                } catch {
                    this.warn(
                        `lean bundle file ${f} not found at ${src}; ` +
                            `skipping copy. Run \`pixi run wasm-lean-build\`.`,
                    );
                }
            }
        },
    };
}

export default defineConfig({
    plugins: [react(), leanBundlePlugin()],
    server: {
        port: 5173,
        fs: {
            // Allow reading files outside web/ so the middleware above can
            // serve the lean bundle from sibling directories.
            allow: [__dirname, LEAN_BUNDLE_DIR],
        },
    },
});
