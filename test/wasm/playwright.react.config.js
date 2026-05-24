// Playwright config for the React + Vite scaffold around the lean WASM
// bundle. Separate from playwright.lean.config.js (which targets the
// plain lean.html) so the two suites can run independently.
//
// Assumes `pixi run wasm-lean-build` (to produce the WASM bundle) and
// `pixi run web-install` (to install web/ dependencies) have already
// been run.
import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: '.',
    testMatch: 'react_*.test.js',
    webServer: {
        command: 'cd ../../web && npx vite --port 5174 --strictPort',
        url: 'http://localhost:5174',
        reuseExistingServer: !process.env.CI,
        timeout: 60000,
    },
    use: {
        baseURL: 'http://localhost:5174',
        viewport: { width: 900, height: 700 },
        actionTimeout: 10000,
    },
    retries: process.env.CI ? 1 : 0,
});
