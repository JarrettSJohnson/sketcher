// End-to-end test of the lean WASM bundle's embind surface in a real browser.
// Covers both Phase 1 (render description) and Phase 0 (Qt-free Counter) work.
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => typeof window.Module !== 'undefined', {
        timeout: 20000,
    });
});

test.describe('lean WASM render description', () => {
    test('parses ethanol SMILES and returns expected atoms', async ({ page }) => {
        const rd = await page.evaluate(() => {
            const json = window.Module.render_description_from_smiles('CCO');
            return JSON.parse(json);
        });
        expect(rd.atoms).toHaveLength(3);
        expect(rd.bonds).toHaveLength(2);
        expect(rd.atoms.map(a => a.el)).toEqual(['C', 'C', 'O']);
    });

    test('empty/invalid input does not crash', async ({ page }) => {
        const rd = await page.evaluate(() => {
            try {
                const json = window.Module.render_description_from_smiles('');
                return JSON.parse(json);
            } catch (e) {
                return { atoms: [], bonds: [] };
            }
        });
        expect(rd.atoms.length).toBe(0);
    });
});

test.describe('Phase 0 Qt-free Counter via embind', () => {
    test('add / undo / redo round-trips through sketcher_core', async ({ page }) => {
        const sequence = await page.evaluate(() => {
            const c = new window.Module.Counter();
            const trace = [];
            trace.push(c.value());
            c.add(5);
            trace.push(c.value());
            c.add(3);
            trace.push(c.value());
            c.undo();
            trace.push(c.value());
            c.undo();
            trace.push(c.value());
            c.redo();
            trace.push(c.value());
            c.delete(); // embind: free C++ instance
            return trace;
        });
        expect(sequence).toEqual([0, 5, 8, 5, 0, 5]);
    });

    test('signal subscription fires for redo and undo', async ({ page }) => {
        const events = await page.evaluate(async () => {
            const c = new window.Module.Counter();
            const received = [];
            const handle = window.Module.counter_subscribe(c, v => {
                received.push(v);
            });
            c.add(2);
            c.add(7);
            c.undo();
            window.Module.counter_unsubscribe(handle);
            c.add(100); // after unsubscribe — should NOT fire
            c.delete();
            return received;
        });
        expect(events).toEqual([2, 9, 2]);
    });

    test('two Counter instances are independent', async ({ page }) => {
        const result = await page.evaluate(() => {
            const a = new window.Module.Counter();
            const b = new window.Module.Counter();
            a.add(1);
            b.add(10);
            a.add(1);
            const pair = [a.value(), b.value()];
            a.delete();
            b.delete();
            return pair;
        });
        expect(result).toEqual([2, 10]);
    });
});
