// End-to-end test of the React + Vite frontend driving sketcher_core::MolModel
// through the lean WASM embind surface. Exercises the interactive demo: click
// to place atoms, click two atoms to bond them, and undo/redo/clear.
import { expect, test } from '@playwright/test';

async function waitForReady(page) {
    // Wait for both the WASM module *and* the Sketcher component to mount.
    await page.waitForFunction(
        () =>
            typeof window.Module !== 'undefined' &&
            typeof window.SketcherModel !== 'undefined',
        { timeout: 30000 },
    );
}

async function snapshot(page) {
    return await page.evaluate(() =>
        JSON.parse(window.SketcherModel.description()),
    );
}

test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForReady(page);
});

test.describe('React Sketcher', () => {
    test('SMILES parser still works inside the React shell', async ({ page }) => {
        const rd = await page.evaluate(() => {
            const json = window.Module.render_description_from_smiles('CCO');
            return JSON.parse(json);
        });
        expect(rd.atoms).toHaveLength(3);
    });

    test('click empty canvas adds an atom of the current element', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');

        // Default tool is 'atom', default element is 'C'.
        await canvas.click({ position: { x: 100, y: 100 } });
        await canvas.click({ position: { x: 200, y: 100 } });

        // Switch element to O for the third click.
        await page.getByTestId('element-O').click();
        await canvas.click({ position: { x: 300, y: 100 } });

        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(3);
        expect(rd.atoms.map((a) => a.el)).toEqual(['C', 'C', 'O']);
        // Atoms must be placed at distinct, non-zero coords (proves coord
        // round-trip through MolModel works end-to-end).
        const xs = rd.atoms.map((a) => a.x);
        expect(new Set(xs).size).toBe(3);
    });

    test('two-click bond tool connects existing atoms', async ({ page }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });

        await page.getByTestId('tool-bond').click();
        await page.getByTestId('bond-2').click(); // double bond
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });

        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(2);
        expect(rd.bonds).toHaveLength(1);
        expect(rd.bonds[0]).toMatchObject({ a: 0, b: 1, o: 2 });
    });

    test('undo / redo round-trips and clear wipes the model', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 100, y: 200 } });
        await canvas.click({ position: { x: 220, y: 200 } });
        await page.getByTestId('tool-bond').click();
        await canvas.click({ position: { x: 100, y: 200 } });
        await canvas.click({ position: { x: 220, y: 200 } });

        let rd = await snapshot(page);
        expect([rd.atoms.length, rd.bonds.length]).toEqual([2, 1]);

        await page.getByTestId('undo').click(); // removes bond
        rd = await snapshot(page);
        expect([rd.atoms.length, rd.bonds.length]).toEqual([2, 0]);

        await page.getByTestId('redo').click(); // restores bond
        rd = await snapshot(page);
        expect([rd.atoms.length, rd.bonds.length]).toEqual([2, 1]);

        await page.getByTestId('clear').click();
        rd = await snapshot(page);
        expect([rd.atoms.length, rd.bonds.length]).toEqual([0, 0]);

        // Clear is undoable.
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect([rd.atoms.length, rd.bonds.length]).toEqual([2, 1]);
    });

    test('select tool toggles atom selection and renders sel flag', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 400, y: 180 } });

        await page.getByTestId('tool-select').click();
        // Toggle atoms 0 and 2 by clicking at their pixel positions.
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 400, y: 180 } });

        let rd = await snapshot(page);
        expect(rd.atoms.map((a) => !!a.sel)).toEqual([true, false, true]);
        expect(
            await page.evaluate(() => window.SketcherModel.hasSelection()),
        ).toBe(true);

        // Re-click atom 0 to deselect it.
        await canvas.click({ position: { x: 120, y: 180 } });
        rd = await snapshot(page);
        expect(rd.atoms.map((a) => !!a.sel)).toEqual([false, false, true]);

        // Click empty area to clear remaining selection.
        await canvas.click({ position: { x: 50, y: 50 } });
        rd = await snapshot(page);
        expect(rd.atoms.some((a) => a.sel)).toBe(false);
        expect(
            await page.evaluate(() => window.SketcherModel.hasSelection()),
        ).toBe(false);
    });

    test('delete-selected removes the selection and is undoable', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 400, y: 180 } });
        await page.getByTestId('tool-bond').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 400, y: 180 } });

        let rd = await snapshot(page);
        expect([rd.atoms.length, rd.bonds.length]).toEqual([3, 2]);

        // Select middle atom and delete: drops the atom + both incident bonds.
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('delete-selected').click();

        rd = await snapshot(page);
        expect([rd.atoms.length, rd.bonds.length]).toEqual([2, 0]);

        // Undo restores everything; selection stays cleared (intentionally).
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect([rd.atoms.length, rd.bonds.length]).toEqual([3, 2]);
        expect(rd.atoms.some((a) => a.sel)).toBe(false);
    });

    test('rubber-band drag selects atoms inside the rectangle', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 400, y: 180 } });

        await page.getByTestId('tool-select').click();
        // Drag a rectangle that encloses only the first two atoms.
        const box = await canvas.boundingBox();
        const startX = box.x + 60;
        const startY = box.y + 100;
        const endX = box.x + 320;
        const endY = box.y + 260;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX + 30, startY + 30, { steps: 4 });
        await page.mouse.move(endX, endY, { steps: 6 });
        await page.mouse.up();

        let rd = await snapshot(page);
        expect(rd.atoms.map((a) => !!a.sel)).toEqual([true, true, false]);

        // Plain drag elsewhere replaces the selection (does not add).
        await page.mouse.move(box.x + 360, box.y + 100);
        await page.mouse.down();
        await page.mouse.move(box.x + 470, box.y + 260, { steps: 6 });
        await page.mouse.up();
        rd = await snapshot(page);
        expect(rd.atoms.map((a) => !!a.sel)).toEqual([false, false, true]);

        // Shift-drag adds to the existing selection.
        await page.keyboard.down('Shift');
        await page.mouse.move(box.x + 60, box.y + 100);
        await page.mouse.down();
        await page.mouse.move(box.x + 200, box.y + 260, { steps: 6 });
        await page.mouse.up();
        await page.keyboard.up('Shift');
        rd = await snapshot(page);
        expect(rd.atoms.map((a) => !!a.sel)).toEqual([true, false, true]);
    });

    test('rubber-band drag selects a bond when both endpoints fall inside', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('tool-bond').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });

        await page.getByTestId('tool-select').click();
        const box = await canvas.boundingBox();
        await page.mouse.move(box.x + 60, box.y + 100);
        await page.mouse.down();
        await page.mouse.move(box.x + 320, box.y + 260, { steps: 6 });
        await page.mouse.up();

        const rd = await snapshot(page);
        expect(rd.atoms.every((a) => a.sel)).toBe(true);
        expect(rd.bonds.every((b) => b.sel)).toBe(true);
    });

    test('select-all selects everything and a mutation clears selection', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('tool-bond').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });

        await page.getByTestId('select-all').click();
        let rd = await snapshot(page);
        expect(rd.atoms.every((a) => a.sel)).toBe(true);
        expect(rd.bonds.every((b) => b.sel)).toBe(true);

        // Any mutation (here: another atom add via the atom tool) clears
        // the selection — index-based selection isn't stable across edits.
        await page.getByTestId('tool-atom').click();
        await canvas.click({ position: { x: 400, y: 200 } });
        rd = await snapshot(page);
        expect(rd.atoms.some((a) => a.sel)).toBe(false);
        expect(rd.bonds.some((b) => b.sel)).toBe(false);
    });
});
