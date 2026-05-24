// Playwright config for the Qt-removal lean WASM bundle (Phase 0 spike).
// Mirrors playwright.config.js but points at sketcher_lean_wasm_build on
// port 8001 so it doesn't collide with the full-Qt WASM tests.
import { defineConfig } from '@playwright/test';

const buildDir = process.env.SKETCHER_LEAN_WASM_BUILD_DIR
    || 'sketcher_lean_wasm_build';

export default defineConfig({
    testDir: '.',
    testMatch: 'lean_*.test.js',
    webServer: {
        command: `python3 -m http.server 8001 --directory ../../${buildDir}/sketcher_lean_app`,
        url: 'http://localhost:8001',
        reuseExistingServer: !process.env.CI,
    },
    use: {
        baseURL: 'http://localhost:8001',
        viewport: { width: 800, height: 600 },
        actionTimeout: 10000,
    },
    retries: process.env.CI ? 1 : 0,
});
