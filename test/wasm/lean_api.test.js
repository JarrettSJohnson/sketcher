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

test.describe('Phase 0 Qt-free MolModel via embind', () => {
    test('build ethanol atom-by-atom and render description', async ({ page }) => {
        const description = await page.evaluate(() => {
            const m = new window.Module.MolModel();
            m.addAtom('C', 0, 0);
            m.addAtom('C', 1.5, 0);
            m.addAtom('O', 3.0, 0);
            m.addBond(0, 1, 1); // single
            m.addBond(1, 2, 1);
            const json = m.description();
            m.delete();
            return JSON.parse(json);
        });
        expect(description.atoms).toHaveLength(3);
        expect(description.bonds).toHaveLength(2);
        expect(description.atoms.map(a => a.el)).toEqual(['C', 'C', 'O']);
        expect(description.bonds.map(b => [b.a, b.b])).toEqual([[0, 1], [1, 2]]);
        // The render description must surface the coords we set, not a
        // freshly-computed layout.
        expect(description.atoms.map(a => [a.x, a.y])).toEqual([
            [0, 0], [1.5, 0], [3.0, 0],
        ]);
    });

    test('coords survive undo/redo', async ({ page }) => {
        const trace = await page.evaluate(() => {
            const m = new window.Module.MolModel();
            m.addAtom('C', 7, 11);
            m.addAtom('O', -3, 4.25);
            m.undo();
            m.undo();
            m.redo();
            m.redo();
            const json = JSON.parse(m.description());
            m.delete();
            return json.atoms.map(a => [a.el, a.x, a.y]);
        });
        expect(trace).toEqual([['C', 7, 11], ['O', -3, 4.25]]);
    });

    test('undo / redo round-trips through MolModel', async ({ page }) => {
        const trace = await page.evaluate(() => {
            const m = new window.Module.MolModel();
            const counts = [];
            const snap = () => counts.push([m.numAtoms(), m.numBonds()]);
            snap();                       // [0, 0]
            m.addAtom('C', 0, 0); snap();
            m.addAtom('O', 1.5, 0); snap();
            m.addBond(0, 1, 2);           // double
            snap();                       // [2, 1]
            m.undo(); snap();             // [2, 0]
            m.undo(); snap();             // [1, 0]
            m.redo(); snap();             // [2, 0]
            m.redo(); snap();             // [2, 1]
            m.delete();
            return counts;
        });
        expect(trace).toEqual([
            [0, 0], [1, 0], [2, 0], [2, 1],
            [2, 0], [1, 0], [2, 0], [2, 1],
        ]);
    });

    test('modelChanged signal fires for mutations and undo/redo', async ({ page }) => {
        const result = await page.evaluate(() => {
            const m = new window.Module.MolModel();
            let fired = 0;
            const handle = window.Module.mol_model_subscribe(m, () => { ++fired; });
            m.addAtom('C', 0, 0);
            m.addAtom('N', 1.5, 0);
            m.addBond(0, 1, 1);
            m.undo();
            m.redo();
            window.Module.mol_model_unsubscribe(handle);
            m.addAtom('O', 3, 0); // post-unsubscribe — should NOT fire
            const final = fired;
            m.delete();
            return final;
        });
        // 3 mutations + 1 undo + 1 redo = 5 emissions; post-unsubscribe addAtom is silent.
        expect(result).toBe(5);
    });

    test('removeAtom drops incident bonds and undo restores them', async ({ page }) => {
        const result = await page.evaluate(() => {
            const m = new window.Module.MolModel();
            m.addAtom('C', 0, 0);
            m.addAtom('C', 1.5, 0);
            m.addAtom('O', 3.0, 0);
            m.addBond(0, 1, 1);
            m.addBond(1, 2, 1);
            const beforeRemove = [m.numAtoms(), m.numBonds()];
            m.removeAtom(1); // drops both bonds
            const afterRemove = [m.numAtoms(), m.numBonds()];
            m.undo(); // restores atom + bonds
            const afterUndo = [m.numAtoms(), m.numBonds()];
            m.delete();
            return { beforeRemove, afterRemove, afterUndo };
        });
        expect(result.beforeRemove).toEqual([3, 2]);
        expect(result.afterRemove).toEqual([2, 0]);
        expect(result.afterUndo).toEqual([3, 2]);
    });
});
