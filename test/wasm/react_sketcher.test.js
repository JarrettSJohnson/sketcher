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

        // bond-double is part of Qt's bond_group radio — clicking it picks
        // the Double bond mode and switches tool to 'bond' in one step.
        await page.getByTestId('bond-double').click();
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
        await page.getByTestId('bond-single').click();
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

    test('select tool: plain=replace, Ctrl=toggle, Shift=add (Qt modifiers)', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 400, y: 180 } });

        await page.getByTestId('tool-select').click();

        // Plain click on atom 0 → replace selection with just atom 0.
        await canvas.click({ position: { x: 120, y: 180 } });
        let rd = await snapshot(page);
        expect(rd.atoms.map((a) => !!a.sel)).toEqual([true, false, false]);

        // Shift+click on atom 2 → add atom 2 (keeps atom 0).
        await canvas.click({ position: { x: 400, y: 180 }, modifiers: ['Shift'] });
        rd = await snapshot(page);
        expect(rd.atoms.map((a) => !!a.sel)).toEqual([true, false, true]);

        // Ctrl+click on atom 0 → toggle atom 0 off (atom 2 stays selected).
        await canvas.click({ position: { x: 120, y: 180 }, modifiers: ['ControlOrMeta'] });
        rd = await snapshot(page);
        expect(rd.atoms.map((a) => !!a.sel)).toEqual([false, false, true]);

        // Ctrl+click on atom 1 → toggle atom 1 on (additive).
        await canvas.click({ position: { x: 260, y: 180 }, modifiers: ['ControlOrMeta'] });
        rd = await snapshot(page);
        expect(rd.atoms.map((a) => !!a.sel)).toEqual([false, true, true]);

        // Plain click on empty area → clears.
        await canvas.click({ position: { x: 50, y: 50 } });
        rd = await snapshot(page);
        expect(rd.atoms.some((a) => a.sel)).toBe(false);
        expect(
            await page.evaluate(() => window.SketcherModel.hasSelection()),
        ).toBe(false);

        // Plain click on atom while another atom is selected → replace.
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        rd = await snapshot(page);
        expect(rd.atoms.map((a) => !!a.sel)).toEqual([false, true, false]);
    });

    test('delete-selected removes the selection and is undoable', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 400, y: 180 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 400, y: 180 } });

        let rd = await snapshot(page);
        expect([rd.atoms.length, rd.bonds.length]).toEqual([3, 2]);

        // Select middle atom and delete: drops the atom + both incident bonds.
        // Qt only exposes Delete via the keyboard (no toolbar button), so we
        // dispatch the key here too — mirrors how a Qt sketcher user deletes.
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.keyboard.press('Delete');

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

    test('rubber-band drag selects a bond when its midpoint falls inside (Qt getCollidingItemsUsingBondMidpoints)', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('bond-single').click();
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

    test('rubber-band rect selects a bond by midpoint even when endpoints are OUTSIDE', async ({
        page,
    }) => {
        // Qt convention: bonds collide with the selection shape iff their
        // *midpoint* (not endpoints) is inside. So a thin horizontal rect
        // that misses both endpoint atoms but covers the bond midpoint must
        // still pick up the bond. The endpoints themselves stay unselected.
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });

        await page.getByTestId('tool-select').click();
        const box = await canvas.boundingBox();
        // Drag a narrow vertical band around x = 190 (midpoint of x=120..260).
        // Endpoints at x=120 and x=260 are outside this band.
        await page.mouse.move(box.x + 170, box.y + 140);
        await page.mouse.down();
        await page.mouse.move(box.x + 210, box.y + 240, { steps: 6 });
        await page.mouse.up();

        const rd = await snapshot(page);
        expect(rd.atoms.every((a) => !a.sel)).toBe(true);
        expect(rd.bonds.every((b) => b.sel)).toBe(true);
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/rectangle: 0 atoms, 1 bond/);
    });

    test('drag-to-move atom (move-rotate tool): live preview + undoable commit', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        // Place two atoms.
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });

        // Capture original coords of atom 0.
        const before = await snapshot(page);
        const a0Before = before.atoms[0];
        const a1Before = before.atoms[1];

        // Qt's move-rotate tool only drags atoms inside the selection bbox.
        // Select atom 0 first, then switch to move-rotate.
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await page.getByTestId('tool-move-rotate').click();

        // Drag atom 0 to a clearly different pixel position.
        const box = await canvas.boundingBox();
        await page.mouse.move(box.x + 120, box.y + 180);
        await page.mouse.down();
        await page.mouse.move(box.x + 200, box.y + 250, { steps: 6 });
        // Mid-drag: preview must have updated the model.
        const mid = await snapshot(page);
        expect(mid.atoms[0].x).not.toBeCloseTo(a0Before.x, 3);
        await page.mouse.move(box.x + 220, box.y + 280, { steps: 3 });
        await page.mouse.up();

        const after = await snapshot(page);
        expect(after.atoms[0].x).not.toBeCloseTo(a0Before.x, 3);
        expect(after.atoms[0].y).not.toBeCloseTo(a0Before.y, 3);
        // Atom 1 (unselected) didn't move.
        expect(after.atoms[1].x).toBeCloseTo(a1Before.x, 3);
        expect(after.atoms[1].y).toBeCloseTo(a1Before.y, 3);
        // Atom 0's selection survives the move (per Qt, drag-translate
        // doesn't reindex so selection is preserved).
        expect(
            await page.evaluate(() => window.SketcherModel.isAtomSelected(0)),
        ).toBe(true);

        // Undo restores the original position.
        await page.getByTestId('undo').click();
        const undone = await snapshot(page);
        expect(undone.atoms[0].x).toBeCloseTo(a0Before.x, 3);
        expect(undone.atoms[0].y).toBeCloseTo(a0Before.y, 3);

        // Redo replays the move.
        await page.getByTestId('redo').click();
        const redone = await snapshot(page);
        expect(redone.atoms[0].x).toBeCloseTo(after.atoms[0].x, 3);
        expect(redone.atoms[0].y).toBeCloseTo(after.atoms[0].y, 3);
    });

    test('move-rotate tool refuses to drag when nothing is selected', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        const before = await snapshot(page);

        await page.getByTestId('tool-move-rotate').click();
        // No selection → drag is a no-op + status message.
        const box = await canvas.boundingBox();
        await page.mouse.move(box.x + 120, box.y + 180);
        await page.mouse.down();
        await page.mouse.move(box.x + 220, box.y + 280, { steps: 6 });
        await page.mouse.up();

        const after = await snapshot(page);
        expect(after.atoms[0].x).toBeCloseTo(before.atoms[0].x, 3);
        expect(after.atoms[0].y).toBeCloseTo(before.atoms[0].y, 3);
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/select atoms first/);
    });

    test('move-rotate tool refuses to drag from outside the selection bbox', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 400, y: 180 } });
        const before = await snapshot(page);

        // Select only atom 0 (left side).
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 120, y: 180 } });

        await page.getByTestId('tool-move-rotate').click();
        // Drag starts on atom 1 (right side, NOT selected, outside the
        // bbox of the selection which is just atom 0).
        const box = await canvas.boundingBox();
        await page.mouse.move(box.x + 400, box.y + 180);
        await page.mouse.down();
        await page.mouse.move(box.x + 450, box.y + 250, { steps: 6 });
        await page.mouse.up();

        const after = await snapshot(page);
        // Nothing moved.
        expect(after.atoms[0].x).toBeCloseTo(before.atoms[0].x, 3);
        expect(after.atoms[1].x).toBeCloseTo(before.atoms[1].x, 3);
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/inside the selection/);
    });

    test('drag-to-move on a multi-atom selection translates the whole group as one undo step', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        // Place three atoms so we have something outside the selection too.
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 400, y: 180 } });

        const before = await snapshot(page);
        const a0Before = before.atoms[0];
        const a1Before = before.atoms[1];
        const a2Before = before.atoms[2];

        // Rubber-band select atoms 0 and 1; atom 2 stays unselected.
        await page.getByTestId('tool-select').click();
        const box = await canvas.boundingBox();
        await page.mouse.move(box.x + 60, box.y + 100);
        await page.mouse.down();
        await page.mouse.move(box.x + 320, box.y + 260, { steps: 6 });
        await page.mouse.up();
        const selected = await snapshot(page);
        expect(selected.atoms.map((a) => !!a.sel)).toEqual([true, true, false]);

        // Switch to move-rotate tool — drag-translate lives there per Qt.
        await page.getByTestId('tool-move-rotate').click();
        // Grab atom 0 (selected, inside bbox) and drag it — atom 1 should
        // follow by the same delta; atom 2 must stay put.
        await page.mouse.move(box.x + 120, box.y + 180);
        await page.mouse.down();
        await page.mouse.move(box.x + 180, box.y + 250, { steps: 8 });
        await page.mouse.up();

        const after = await snapshot(page);
        const dx0 = after.atoms[0].x - a0Before.x;
        const dy0 = after.atoms[0].y - a0Before.y;
        const dx1 = after.atoms[1].x - a1Before.x;
        const dy1 = after.atoms[1].y - a1Before.y;
        // Atom 0 actually moved.
        expect(Math.hypot(dx0, dy0)).toBeGreaterThan(0.1);
        // Atom 1 moved by the same delta as atom 0 (within float tolerance).
        expect(dx1).toBeCloseTo(dx0, 3);
        expect(dy1).toBeCloseTo(dy0, 3);
        // Atom 2 did not move.
        expect(after.atoms[2].x).toBeCloseTo(a2Before.x, 3);
        expect(after.atoms[2].y).toBeCloseTo(a2Before.y, 3);

        // One undo restores both moved atoms in a single step.
        await page.getByTestId('undo').click();
        const undone = await snapshot(page);
        expect(undone.atoms[0].x).toBeCloseTo(a0Before.x, 3);
        expect(undone.atoms[0].y).toBeCloseTo(a0Before.y, 3);
        expect(undone.atoms[1].x).toBeCloseTo(a1Before.x, 3);
        expect(undone.atoms[1].y).toBeCloseTo(a1Before.y, 3);
    });

    test('tiny drag on atom falls through to click-toggle', async ({ page }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });

        const before = await snapshot(page);
        await page.getByTestId('tool-select').click();
        const box = await canvas.boundingBox();
        // A 1-pixel "drag" should be treated as a click → select toggle.
        await page.mouse.move(box.x + 120, box.y + 180);
        await page.mouse.down();
        await page.mouse.move(box.x + 121, box.y + 181);
        await page.mouse.up();

        const after = await snapshot(page);
        expect(after.atoms[0].x).toBeCloseTo(before.atoms[0].x, 3);
        expect(after.atoms[0].y).toBeCloseTo(before.atoms[0].y, 3);
        expect(after.atoms[0].sel).toBe(true);
    });

    test('select-all selects everything and a mutation clears selection', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });

        await page.getByTestId('select-all').click();
        let rd = await snapshot(page);
        expect(rd.atoms.every((a) => a.sel)).toBe(true);
        expect(rd.bonds.every((b) => b.sel)).toBe(true);

        // Any mutation (here: another atom add via the atom tool) clears
        // the selection — index-based selection isn't stable across edits.
        // Picking element-C re-activates the atom tool with C selected.
        await page.getByTestId('element-C').click();
        await canvas.click({ position: { x: 400, y: 200 } });
        rd = await snapshot(page);
        expect(rd.atoms.some((a) => a.sel)).toBe(false);
        expect(rd.bonds.some((b) => b.sel)).toBe(false);
    });

    test('bond-wedge / bond-dash apply dir to selected bonds; bond-single clears it', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        // Build a two-atom skeleton with one bond.
        await canvas.click({ position: { x: 160, y: 200 } });
        await canvas.click({ position: { x: 320, y: 200 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 160, y: 200 } });
        await canvas.click({ position: { x: 320, y: 200 } });

        // Select the bond.
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 240, y: 200 } });

        let rd = await snapshot(page);
        expect(rd.bonds[0].sel).toBe(true);
        expect(rd.bonds[0].dir).toBeUndefined();

        // Picking Wedge while a bond is selected applies the dir (Qt's
        // bond_group behavior: clicking any radio member while bonds are
        // selected re-types those bonds).
        await page.getByTestId('bond-wedge').click();
        rd = await snapshot(page);
        expect(rd.bonds[0].dir).toBe(1);
        expect(rd.bonds[0].sel).toBe(true);

        await page.getByTestId('bond-dash').click();
        rd = await snapshot(page);
        expect(rd.bonds[0].dir).toBe(2);

        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.bonds[0].dir).toBe(1);

        // Picking Single (still with the bond selected) clears the dir.
        await page.getByTestId('bond-single').click();
        rd = await snapshot(page);
        expect(rd.bonds[0].dir).toBeUndefined();
    });

    test('Flip Horizontal / Vertical (via More Actions menu) negate coords about centroid', async ({
        page,
    }) => {
        // Load a benzene so we have a known structure without worrying about
        // click-pixel-to-model conversion noise.
        await page.getByTestId('smiles-input').fill('c1ccccc1');
        await page.getByTestId('smiles-load').click();
        const before = await snapshot(page);
        expect(before.atoms).toHaveLength(6);

        const sumXY = (atoms) =>
            atoms.reduce((s, a) => s + a.x + a.y, 0);

        // Open the More Actions popover and pick Flip Horizontal — Qt's
        // sketcher_top_bar_menus.cpp puts this under MoreActionsMenu →
        // "Modify All" → "Flip Horizontal".
        await page.getByTestId('more-actions-btn').click();
        await page.getByTestId('flip-horizontal').click();
        const flipped = await snapshot(page);
        // sum of all X+Y is invariant under flip about centroid (each atom's
        // displacement from centroid is negated, so the sum is preserved).
        expect(sumXY(flipped.atoms)).toBeCloseTo(sumXY(before.atoms), 4);
        // Coordinates actually changed.
        const samePos = flipped.atoms.every(
            (a, i) =>
                Math.abs(a.x - before.atoms[i].x) < 1e-9 &&
                Math.abs(a.y - before.atoms[i].y) < 1e-9,
        );
        expect(samePos).toBe(false);

        await page.getByTestId('undo').click();
        const undone = await snapshot(page);
        for (let i = 0; i < before.atoms.length; ++i) {
            expect(undone.atoms[i].x).toBeCloseTo(before.atoms[i].x, 6);
            expect(undone.atoms[i].y).toBeCloseTo(before.atoms[i].y, 6);
        }

        // Flip Vertical via the same menu path.
        await page.getByTestId('more-actions-btn').click();
        await page.getByTestId('flip-vertical').click();
        const flippedV = await snapshot(page);
        expect(sumXY(flippedV.atoms)).toBeCloseTo(sumXY(before.atoms), 4);

        // Flip-on-empty is a friendly no-op with a status message.
        await page.getByTestId('clear').click();
        await page.getByTestId('more-actions-btn').click();
        await page.getByTestId('flip-horizontal').click();
        await expect(page.getByTestId('sketcher-status')).toContainText(
            'nothing to flip',
        );
    });

    test('bond-wedge picks wedge draw mode; bond-single switches back to plain bonds', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        // Three carbons in a row.
        await canvas.click({ position: { x: 140, y: 200 } });
        await canvas.click({ position: { x: 280, y: 200 } });
        await canvas.click({ position: { x: 420, y: 200 } });

        // Pick Wedge — switches tool to 'bond' and arms wedge as the draw
        // mode. Visible via aria-pressed on the radio button.
        await page.getByTestId('bond-wedge').click();
        await expect(page.getByTestId('bond-wedge')).toHaveAttribute(
            'aria-pressed',
            'true',
        );

        // Draw the first bond — it should pick up the wedge automatically.
        await canvas.click({ position: { x: 140, y: 200 } });
        await canvas.click({ position: { x: 280, y: 200 } });

        let rd = await snapshot(page);
        expect(rd.bonds).toHaveLength(1);
        expect(rd.bonds[0].dir).toBe(1); // BEGINWEDGE

        // Draw a second bond — wedge mode persists across creations (the
        // radio member stays "checked" until another bond_group button is
        // picked, mirroring Qt's bond_group semantics).
        await canvas.click({ position: { x: 280, y: 200 } });
        await canvas.click({ position: { x: 420, y: 200 } });
        rd = await snapshot(page);
        expect(rd.bonds).toHaveLength(2);
        expect(rd.bonds[1].dir).toBe(1);

        // Picking Single switches the active mode to plain single — its
        // radio pressed-state turns on, Wedge's turns off.
        await page.getByTestId('bond-single').click();
        await expect(page.getByTestId('bond-single')).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await expect(page.getByTestId('bond-wedge')).toHaveAttribute(
            'aria-pressed',
            'false',
        );

        // Fresh bond now draws without a wedge — peel back both bonds first
        // so we have endpoints to reconnect.
        await page.getByTestId('undo').click();
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.bonds).toHaveLength(0);

        await canvas.click({ position: { x: 140, y: 200 } });
        await canvas.click({ position: { x: 280, y: 200 } });
        rd = await snapshot(page);
        expect(rd.bonds).toHaveLength(1);
        expect(rd.bonds[0].dir).toBeUndefined();
    });

    test('interactively added O atom carries chemistry annotations', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await page.getByTestId('element-O').click();
        await canvas.click({ position: { x: 200, y: 200 } });

        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(1);
        expect(rd.atoms[0].el).toBe('O');
        // Property cache refresh in doMutation makes implicit Hs visible
        // without a separate sanitize call.
        expect(rd.atoms[0].nh).toBe(2);
        // Neutral atom: no charge field emitted.
        expect(rd.atoms[0].q).toBeUndefined();
        expect(rd.atoms[0].arom).toBeUndefined();

        // Bonding the O to a fresh C reduces O's H count from 2 to 1.
        await page.getByTestId('element-C').click();
        await canvas.click({ position: { x: 320, y: 200 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 200, y: 200 } });
        await canvas.click({ position: { x: 320, y: 200 } });

        const rd2 = await snapshot(page);
        const oxygen = rd2.atoms.find((a) => a.el === 'O');
        expect(oxygen.nh).toBe(1);
    });

    test('benzene ring tool drops a Kekulé hexagon on click', async ({ page }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await page.getByTestId('ring-benzene').click();
        await canvas.click({ position: { x: 260, y: 180 } });
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(6);
        expect(rd.bonds).toHaveLength(6);
        // Kekulé form: three double bonds and three single bonds.
        const doubles = rd.bonds.filter((b) => b.o === 2).length;
        expect(doubles).toBe(3);
        // Undo collapses the whole ring at once.
        await page.getByTestId('undo').click();
        const empty = await snapshot(page);
        expect(empty.atoms).toHaveLength(0);
    });

    test('cyclohexane ring tool drops all-single-bond hexagon', async ({ page }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await page.getByTestId('ring-cyclohexane').click();
        await canvas.click({ position: { x: 260, y: 180 } });
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(6);
        const doubles = rd.bonds.filter((b) => b.o === 2).length;
        expect(doubles).toBe(0);
    });

    test('atom-chain tool draws a free-standing zig-zag chain bonded in order', async ({
        page,
    }) => {
        // Qt DrawChainSceneTool: drag from empty area lays down N+1 carbons
        // (zig-zag, 30° angle-rounded) connected by N single bonds, one
        // undo step. We just check the structural outcome — N atoms, N-1
        // bonds, all carbons, all single, undo restores.
        const canvas = page.getByTestId('sketcher-canvas');
        await page.getByTestId('atom-chain').click();
        const box = await canvas.boundingBox();
        await page.mouse.move(box.x + 100, box.y + 200);
        await page.mouse.down();
        await page.mouse.move(box.x + 260, box.y + 200, { steps: 6 });
        await page.mouse.up();
        const rd = await snapshot(page);
        expect(rd.atoms.length).toBeGreaterThanOrEqual(3);
        expect(rd.bonds.length).toBe(rd.atoms.length - 1);
        expect(rd.atoms.every((a) => a.el === 'C')).toBe(true);
        expect(rd.bonds.every((b) => b.o === 1)).toBe(true);
        await page.getByTestId('undo').click();
        const empty = await snapshot(page);
        expect(empty.atoms).toHaveLength(0);
    });

    test('atom-chain tool extends an existing atom (first chain atom bonds to it)', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        // Place one atom, then chain-drag starting on it.
        await canvas.click({ position: { x: 120, y: 200 } });
        const before = await snapshot(page);
        expect(before.atoms).toHaveLength(1);

        await page.getByTestId('atom-chain').click();
        const box = await canvas.boundingBox();
        await page.mouse.move(box.x + 120, box.y + 200);
        await page.mouse.down();
        await page.mouse.move(box.x + 280, box.y + 200, { steps: 6 });
        await page.mouse.up();

        const rd = await snapshot(page);
        // Original atom + N new chain atoms, joined by N bonds.
        expect(rd.atoms.length).toBeGreaterThanOrEqual(3);
        expect(rd.bonds.length).toBe(rd.atoms.length - 1);
        // Atom 0 must participate in at least one bond (chain attached).
        const atom0Bonded = rd.bonds.some((b) => b.a === 0 || b.b === 0);
        expect(atom0Bonded).toBe(true);
        // Single undo step removes the chain but keeps the original atom.
        await page.getByTestId('undo').click();
        const after = await snapshot(page);
        expect(after.atoms).toHaveLength(1);
        expect(after.bonds).toHaveLength(0);
    });

    test('Import menu: Paste in Text modal loads SMILES and closes', async ({
        page,
    }) => {
        // Qt ImportMenu (menu/sketcher_top_bar_menus.cpp): the top-bar
        // Import button is a dropdown with "Import from File..." and
        // "Paste in Text..." items. Paste in Text opens a modal with a
        // textarea + Load / Cancel buttons.
        await page.getByTestId('import').click();
        await expect(page.getByTestId('import-menu')).toBeVisible();
        await expect(page.getByTestId('import-from-file')).toBeVisible();
        await page.getByTestId('import-paste-in-text').click();
        // Menu closes, modal opens.
        await expect(page.getByTestId('paste-text-modal')).toBeVisible();
        await expect(page.getByTestId('import-menu')).toHaveCount(0);
        await page.getByTestId('paste-text-input').fill('CCO');
        await page.getByTestId('paste-text-load').click();
        // Modal closes on successful load; mol picked up the SMILES.
        await expect(page.getByTestId('paste-text-modal')).toHaveCount(0);
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(3);
        expect(rd.bonds).toHaveLength(2);
    });

    test('Import menu: Paste in Text modal preserves sketch + leaves modal open on bad input', async ({
        page,
    }) => {
        // Seed a sketch so we can assert it stays put on a failed load.
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 150, y: 180 } });
        await page.getByTestId('import').click();
        await page.getByTestId('import-paste-in-text').click();
        await page.getByTestId('paste-text-input').fill('not a smiles!!!');
        await page.getByTestId('paste-text-load').click();
        // Modal stays open so the user can fix their input.
        await expect(page.getByTestId('paste-text-modal')).toBeVisible();
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/load failed/);
        // Original sketch untouched.
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(1);
        // Cancel closes without committing.
        await page.getByTestId('paste-text-cancel').click();
        await expect(page.getByTestId('paste-text-modal')).toHaveCount(0);
    });

    test('Import menu: Import from File reads a SMILES file and loads it', async ({
        page,
    }) => {
        // Qt's "Import from File..." opens QFileDialog and pipes the chosen
        // file's text through loadFromText with AUTO_DETECT. We use
        // Playwright's setInputFiles to drive the hidden <input type=file>
        // directly — no need to actually open the menu (the menu item just
        // .click()s the input, which we do here).
        await page.getByTestId('import-file-input').setInputFiles({
            name: 'sample.smi',
            mimeType: 'chemical/x-daylight-smiles',
            buffer: Buffer.from('c1ccccc1'),
        });
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(6);
        expect(rd.bonds).toHaveLength(6);
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/imported sample\.smi/);
    });

    test('Export menu: Export to File modal renders SMILES / V2000 / V3000 and copies', async ({
        page,
    }) => {
        // Seed benzene via the existing Paste-in-Text flow so we have
        // something to export.
        await page.getByTestId('import').click();
        await page.getByTestId('import-paste-in-text').click();
        await page.getByTestId('paste-text-input').fill('c1ccccc1');
        await page.getByTestId('paste-text-load').click();

        await page.getByTestId('export').click();
        await expect(page.getByTestId('export-menu')).toBeVisible();
        await page.getByTestId('export-to-file').click();
        await expect(page.getByTestId('export-modal')).toBeVisible();

        // Default format is SMILES.
        const text = page.getByTestId('export-text');
        await expect(text).toHaveValue(/c1ccccc1/);

        // Switch to V2000 — textarea content updates to a MOL block.
        await page.getByTestId('export-format-select').selectOption('mol-v2000');
        await expect(text).toHaveValue(/V2000/);
        await expect(text).not.toHaveValue(/V3000/);

        // Switch to V3000.
        await page.getByTestId('export-format-select').selectOption('mol-v3000');
        await expect(text).toHaveValue(/V3000/);

        // Copy button triggers status update (clipboard may or may not be
        // granted in the test env; both branches set a status).
        await page.getByTestId('export-copy').click();
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/MDL MOL V3000|copy manually/);

        await page.getByTestId('export-close').click();
        await expect(page.getByTestId('export-modal')).toHaveCount(0);
    });

    test('Export menu: Save Image opens dialog with Qt defaults + live status label', async ({
        page,
    }) => {
        await page.getByTestId('export').click();
        await page.getByTestId('export-save-image').click();
        const modal = page.getByTestId('save-image-modal');
        await expect(modal).toBeVisible();
        // Qt defaults: PNG, 400×400, White background.
        await expect(page.getByTestId('save-image-format-select'))
            .toHaveValue('png');
        await expect(page.getByTestId('save-image-width')).toHaveValue('400');
        await expect(page.getByTestId('save-image-height')).toHaveValue('400');
        await expect(page.getByTestId('save-image-transparent'))
            .not.toBeChecked();
        await expect(page.getByTestId('save-image-status'))
            .toHaveText('White background, 400 x 400 px');
        // Tweak width/height/transparent — status label updates to match
        // (Qt's FileSaveImageDialog refreshes the same line on every spin).
        await page.getByTestId('save-image-width').fill('600');
        await page.getByTestId('save-image-height').fill('300');
        await page.getByTestId('save-image-transparent').check();
        await expect(page.getByTestId('save-image-status'))
            .toHaveText('Transparent background, 600 x 300 px');
        // Cancel closes without saving.
        await page.getByTestId('save-image-cancel').click();
        await expect(page.getByTestId('save-image-modal')).toHaveCount(0);
    });

    test('Export menu: Save Image without a sketch surfaces a status, no download', async ({
        page,
    }) => {
        // Empty sketch — Save should bail with a friendly status, mirroring
        // Qt's "no atoms to draw" guard in get_image_bytes.
        await page.getByTestId('export').click();
        await page.getByTestId('export-save-image').click();
        await expect(page.getByTestId('save-image-modal')).toBeVisible();
        let downloaded = false;
        page.on('download', () => { downloaded = true; });
        await page.getByTestId('save-image-save').click();
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/nothing to save/);
        // Modal stays open so the user can dismiss intentionally.
        await expect(page.getByTestId('save-image-modal')).toBeVisible();
        expect(downloaded).toBe(false);
        await page.getByTestId('save-image-cancel').click();
    });

    test('Export menu: Save Image downloads a PNG of the current sketch', async ({
        page,
    }) => {
        // Seed benzene via Paste-in-Text so the render has something.
        await page.getByTestId('import').click();
        await page.getByTestId('import-paste-in-text').click();
        await page.getByTestId('paste-text-input').fill('c1ccccc1');
        await page.getByTestId('paste-text-load').click();

        await page.getByTestId('export').click();
        await page.getByTestId('export-save-image').click();
        // Use small dimensions so the offscreen render is cheap; assert the
        // status reflects what we asked for. Width/height inputs accept any
        // integer in [1, 9999]; pick 120 × 80 to confirm non-square works.
        await page.getByTestId('save-image-width').fill('120');
        await page.getByTestId('save-image-height').fill('80');

        const downloadPromise = page.waitForEvent('download');
        await page.getByTestId('save-image-save').click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toBe('sketch.png');
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/saved sketch\.png — White background, 120 x 80 px/);
        // Modal auto-closes after a successful save.
        await expect(page.getByTestId('save-image-modal')).toHaveCount(0);
    });

    test('Configure View dropdown: lists Qt-fidelity toggles in Qt order with Qt defaults', async ({
        page,
    }) => {
        // Qt's ConfigureViewMenu (menu/sketcher_top_bar_menus.cpp:109-128)
        // exposes 4 checkable actions in this order, then a separator,
        // then "Preferences..."; defaults from
        // model/sketcher_model.cpp:230-233 are true/true/true/false.
        await page.getByTestId('settings').click();
        const menu = page.getByTestId('configure-view-menu');
        await expect(menu).toBeVisible();
        // Default-checked toggles show "✓"; unchecked is empty.
        await expect(page.getByTestId('view-valence-errors'))
            .toHaveAttribute('aria-checked', 'true');
        await expect(page.getByTestId('view-color-heteroatoms'))
            .toHaveAttribute('aria-checked', 'true');
        await expect(page.getByTestId('view-stereo-labels'))
            .toHaveAttribute('aria-checked', 'true');
        await expect(page.getByTestId('view-implicit-hydrogens'))
            .toHaveAttribute('aria-checked', 'false');
        // Preferences is a plain action item (no aria-checked).
        await expect(page.getByTestId('view-preferences')).toBeVisible();
        // Clicking a toggle flips its state AND keeps the menu open so
        // the user can toggle multiple items (Qt's QMenu does the same
        // for non-exclusive checkable QActions).
        await page.getByTestId('view-color-heteroatoms').click();
        await expect(page.getByTestId('view-color-heteroatoms'))
            .toHaveAttribute('aria-checked', 'false');
        await expect(menu).toBeVisible();
        // Preferences closes the menu and surfaces the coming-soon status
        // (full RenderingSettingsDialog is its own batch).
        await page.getByTestId('view-preferences').click();
        await expect(page.getByTestId('configure-view-menu')).toHaveCount(0);
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/Preferences/);
    });

    test('Configure View: turning Heteroatom Colors off renders nitrogen in the carbon mono color', async ({
        page,
    }) => {
        // Seed a single nitrogen (pyrrole) so we have a heteroatom we can
        // sample. With Heteroatom Colors ON, the canvas pixel under the
        // atom should match the N color (#1f4faa); with it OFF, it
        // should match the C color (#222). Pixel-sample via canvas
        // .getImageData inside page.evaluate.
        await page.getByTestId('import').click();
        await page.getByTestId('import-paste-in-text').click();
        await page.getByTestId('paste-text-input').fill('N');
        await page.getByTestId('paste-text-load').click();
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(1);
        expect(rd.atoms[0].el).toBe('N');

        const sampleAtomColor = async () => {
            return await page.evaluate(() => {
                const c = document.querySelector(
                    '[data-testid="sketcher-canvas"]',
                );
                const ctx = c.getContext('2d');
                // Atom is centered (single-atom mol → bbox center = view
                // center) so sample at canvas center.
                const w = c.width;
                const h = c.height;
                // The element label is drawn at the atom position;
                // sampling a 5×5 window around center and picking the
                // most-non-white pixel gets us the label ink even with
                // sub-pixel AA.
                const data = ctx.getImageData(
                    Math.floor(w / 2) - 2,
                    Math.floor(h / 2) - 2,
                    5,
                    5,
                ).data;
                let best = [255, 255, 255];
                let bestDist = -1;
                for (let i = 0; i < data.length; i += 4) {
                    const r = data[i], g = data[i + 1], b = data[i + 2];
                    const d = (255 - r) + (255 - g) + (255 - b);
                    if (d > bestDist) {
                        bestDist = d;
                        best = [r, g, b];
                    }
                }
                return best;
            });
        };

        // With heteroatom colors ON (the default), the N label paints
        // with the nitrogen blue (#1f4faa) — blue channel > red channel.
        const [r1, , b1] = await sampleAtomColor();
        expect(b1).toBeGreaterThan(r1);

        // Turn the toggle off — N should now paint with the carbon
        // mono color (#222) where R, G, B are roughly equal.
        await page.getByTestId('settings').click();
        await page.getByTestId('view-color-heteroatoms').click();
        // Close the menu so subsequent canvas reads aren't covered by it.
        // The menu uses absolute positioning so it shouldn't, but close
        // it explicitly for clarity.
        await page.getByTestId('settings').click();
        const [r2, g2, b2] = await sampleAtomColor();
        expect(Math.abs(r2 - b2)).toBeLessThan(20);
        expect(Math.abs(r2 - g2)).toBeLessThan(20);
    });

    test('Help menu: dropdown shows three items in Qt order (Help / Getting Started / About)', async ({
        page,
    }) => {
        // Qt's HelpMenu (menu/sketcher_top_bar_menus.cpp:130-151) exposes
        // exactly three QActions in this order. We mirror them as plain
        // MoreItems (not toggles — these are one-shot actions).
        await page.getByTestId('help').click();
        const menu = page.getByTestId('help-menu');
        await expect(menu).toBeVisible();
        const items = menu.locator('[data-testid^="help-"]');
        await expect(items).toHaveCount(3);
        await expect(items.nth(0)).toHaveAttribute('data-testid', 'help-docs');
        await expect(items.nth(0)).toContainText('Help...');
        await expect(items.nth(1)).toHaveAttribute('data-testid', 'help-welcome');
        await expect(items.nth(1)).toContainText('Getting Started...');
        await expect(items.nth(2)).toHaveAttribute('data-testid', 'help-about');
        await expect(items.nth(2)).toContainText('About Sketcher...');
    });

    test('Help menu: Help... opens external docs in a new tab and closes the menu', async ({
        page,
    }) => {
        // Qt's onHelpClicked (widget/sketcher_top_bar.cpp) opens the
        // 2D Sketcher user manual URL. The web port uses window.open with
        // _blank + noopener,noreferrer. We assert the popup is requested
        // (new page event) and that the URL points at the right docs.
        await page.getByTestId('help').click();
        await expect(page.getByTestId('help-menu')).toBeVisible();
        const [popup] = await Promise.all([
            page.waitForEvent('popup'),
            page.getByTestId('help-docs').click(),
        ]);
        expect(popup.url()).toContain('schrodinger.com');
        expect(popup.url()).toContain('2d_sketcher');
        await popup.close();
        // Menu closes after picking an item.
        await expect(page.getByTestId('help-menu')).toHaveCount(0);
    });

    test('Help menu: Getting Started... opens the welcome modal with three tips, OK closes it', async ({
        page,
    }) => {
        // Qt's SketcherWelcomeDialog has three labeled tip blocks (Select
        // Mode, Chooser Buttons, Mouse Actions). The port mirrors the
        // tip text verbatim from ui/sketcher_welcome_dialog.ui.
        await page.getByTestId('help').click();
        await page.getByTestId('help-welcome').click();
        const modal = page.getByTestId('welcome-modal');
        await expect(modal).toBeVisible();
        await expect(modal).toContainText('Welcome to the Schrödinger Sketcher');
        await expect(modal).toContainText('Select Mode');
        await expect(modal).toContainText('Chooser Buttons');
        await expect(modal).toContainText('Mouse Actions');
        // Menu closes when we pick the item.
        await expect(page.getByTestId('help-menu')).toHaveCount(0);
        await page.getByTestId('welcome-ok').click();
        await expect(page.getByTestId('welcome-modal')).toHaveCount(0);
    });

    test('Help menu: About Sketcher... shows the version + EULA link, Close dismisses', async ({
        page,
    }) => {
        // Qt's About2DSketcher dialog shows release/version text, a
        // "Qt-free Port" line (added by the port to flag the build),
        // copyright, and a license-agreement hyperlink. The version
        // string is kept in lock-step with ../../version.json via the
        // SKETCHER_VERSION constant in Sketcher.tsx.
        await page.getByTestId('help').click();
        await page.getByTestId('help-about').click();
        const modal = page.getByTestId('about-modal');
        await expect(modal).toBeVisible();
        await expect(modal).toContainText('About Schrödinger 2D Sketcher');
        await expect(page.getByTestId('about-version'))
            .toContainText(/Release \d+\.\d+\.\d+/);
        await expect(modal).toContainText('Qt-free Port');
        await expect(modal).toContainText(/©.*Schrödinger/);
        const eula = page.getByTestId('about-eula');
        await expect(eula).toBeVisible();
        await expect(eula).toHaveAttribute('href', /schrodinger\.com/);
        await expect(eula).toHaveAttribute('target', '_blank');
        await expect(eula).toHaveAttribute('rel', /noopener/);
        await expect(page.getByTestId('help-menu')).toHaveCount(0);
        await page.getByTestId('about-close').click();
        await expect(page.getByTestId('about-modal')).toHaveCount(0);
    });

    test('SMILES Load parses input and Copy SMILES writes canonical form', async ({ page }) => {
        const input = page.getByTestId('smiles-input');
        await input.fill('c1ccccc1');
        await page.getByTestId('smiles-load').click();
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(6);
        expect(rd.bonds).toHaveLength(6);
        expect(rd.atoms.every((a) => a.arom === true)).toBe(true);

        // Copy SMILES populates the input with the canonical form even if
        // clipboard access is denied (headless Chromium does grant it, but
        // the input fallback is what the user sees in either case).
        await page.getByTestId('smiles-copy').click();
        await expect(input).toHaveValue('c1ccccc1');
    });

    test('SMILES Load accepts Cmd+Enter and supports undo', async ({ page }) => {
        const input = page.getByTestId('smiles-input');
        await input.fill('CCO');
        // Cmd+Enter triggers Load; plain Enter would insert a newline (textarea
        // semantics needed for multi-line MOL paste).
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await input.press(`${modifier}+Enter`);
        let rd = await snapshot(page);
        expect(rd.atoms.map((a) => a.el)).toEqual(['C', 'C', 'O']);
        // Single undo reverts the entire load.
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(0);
    });

    test('SMILES Load on garbage shows an error and leaves the sketch alone', async ({ page }) => {
        // Pre-populate with one atom so we can confirm the failed load
        // doesn't wipe existing work.
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 250, y: 180 } });
        const before = await snapshot(page);
        expect(before.atoms).toHaveLength(1);

        await page.getByTestId('smiles-input').fill('not a smiles!!!');
        await page.getByTestId('smiles-load').click();
        const status = await page.getByTestId('sketcher-status').textContent();
        expect(status).toMatch(/load failed/i);
        const after = await snapshot(page);
        expect(after.atoms).toHaveLength(1);
    });

    test('Copy MOL writes a V2000 block to the input field', async ({ page }) => {
        const input = page.getByTestId('smiles-input');
        await input.fill('CCO');
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await input.press(`${modifier}+Enter`);

        await page.getByTestId('mol-copy').click();
        const value = await input.inputValue();
        expect(value).toContain('V2000');
        // Counts line: 3 atoms, 2 bonds.
        expect(value).toContain('  3  2');
    });

    test('paste a MOL block then Load round-trips back to a sketch', async ({ page }) => {
        // Build a benzene mol block out-of-band, paste it, hit Load, and
        // verify the canvas now shows six aromatic atoms. MOL blocks start
        // with an empty title line (a leading "\n") — naive trimming on the
        // way in would corrupt the SDMolSupplier 3-header-line contract, so
        // this test also guards against that regression.
        const molBlock = await page.evaluate(() => {
            const m = new window.Module.MolModel();
            m.loadFromSmiles('c1ccccc1');
            const mb = m.toMolBlock(false);
            m.delete();
            return mb;
        });
        await page.getByTestId('clear').click();

        const input = page.getByTestId('smiles-input');
        await input.fill(molBlock);
        await page.getByTestId('smiles-load').click();

        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(6);
        expect(rd.bonds).toHaveLength(6);
        const status = await page.getByTestId('sketcher-status').textContent();
        expect(status).toMatch(/loaded MOL/);
    });

    test('charge +/- buttons adjust selected-atom formal charge', async ({ page }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await page.getByTestId('element-N').click();
        await canvas.click({ position: { x: 200, y: 200 } });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 200, y: 200 } });

        await page.getByTestId('charge-plus').click();
        let rd = await snapshot(page);
        expect(rd.atoms[0].q).toBe(1);
        // N+ tetravalent → 4 implicit Hs (NH4+ shape).
        expect(rd.atoms[0].nh).toBe(4);

        await page.getByTestId('charge-minus').click();
        await page.getByTestId('charge-minus').click();
        rd = await snapshot(page);
        expect(rd.atoms[0].q).toBe(-1);

        // Undo walks all three charge edits back to neutral.
        await page.getByTestId('undo').click();
        await page.getByTestId('undo').click();
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.atoms[0].q).toBeUndefined();
    });

    test('Add / Remove Explicit Hydrogens (via More menu) promote and strip explicit Hs', async ({ page }) => {
        // Qt's MoreActionsMenu → Modify All → "Add Explicit Hydrogens" / "Remove
        // Explicit Hydrogens" (sketcher_top_bar_menus.cpp:98-101). We mirror
        // both label and menu placement here.
        await page.getByTestId('smiles-input').fill('CO');
        await page.getByTestId('smiles-load').click();

        let rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(2);

        await page.getByTestId('more-actions-btn').click();
        await page.getByTestId('hydrogens-add').click();
        rd = await snapshot(page);
        // Methanol has 4 implicit Hs (3 on C + 1 on O) → 6 atoms total.
        expect(rd.atoms).toHaveLength(6);
        const explicitH = rd.atoms.filter((a) => a.el === 'H').length;
        expect(explicitH).toBe(4);

        await page.getByTestId('more-actions-btn').click();
        await page.getByTestId('hydrogens-remove').click();
        rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(2);

        // Undo restores explicit Hs (single undo step per toggle).
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(6);
    });

    test('Add Hs on an empty sketch is a no-op with a friendly status', async ({ page }) => {
        await page.getByTestId('clear').click();
        await page.getByTestId('more-actions-btn').click();
        await page.getByTestId('hydrogens-add').click();
        const status = await page.getByTestId('sketcher-status').textContent();
        expect(status).toMatch(/nothing to expand/);
    });

    test('Kekulize / Aromatize (via More menu) toggle benzene aromaticity end-to-end', async ({ page }) => {
        await page.getByTestId('smiles-input').fill('c1ccccc1');
        await page.getByTestId('smiles-load').click();

        let rd = await snapshot(page);
        expect(rd.bonds.every((b) => b.arom === true)).toBe(true);

        await page.getByTestId('more-actions-btn').click();
        await page.getByTestId('kekulize').click();
        rd = await snapshot(page);
        expect(rd.bonds.some((b) => b.arom === true)).toBe(false);
        expect(rd.bonds.filter((b) => b.o === 1)).toHaveLength(3);
        expect(rd.bonds.filter((b) => b.o === 2)).toHaveLength(3);

        await page.getByTestId('more-actions-btn').click();
        await page.getByTestId('aromatize').click();
        rd = await snapshot(page);
        expect(rd.bonds.every((b) => b.arom === true)).toBe(true);

        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.bonds.some((b) => b.arom === true)).toBe(false);
    });

    test('Fit re-centers the structure: bbox-centroid maps to canvas-center', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        // Place three atoms off in one corner of the canvas — they end up at
        // model coords near the top-left in model space (positive y, negative
        // x for the canvas-center origin).
        await canvas.click({ position: { x: 80, y: 80 } });
        await canvas.click({ position: { x: 150, y: 80 } });
        await canvas.click({ position: { x: 220, y: 80 } });

        // Default view: scale=40, offset=(0,0). The bbox centroid in model
        // space lands at the average of those click pixels, projected
        // through DEFAULT view — clearly off-center.
        const viewBefore = await page.evaluate(() => ({
            scale: window.SketcherView.current.scale,
            offsetX: window.SketcherView.current.offsetX,
            offsetY: window.SketcherView.current.offsetY,
        }));
        expect(viewBefore.scale).toBeCloseTo(40, 3);
        expect(viewBefore.offsetX).toBe(0);
        expect(viewBefore.offsetY).toBe(0);

        await page.getByTestId('fit-to-screen').click();

        // After Fit, the view transform must map the bbox centroid to the
        // canvas center. Verify by recomputing pixelFromModel on the centroid
        // and asserting it lands at (CANVAS_W/2, CANVAS_H/2) = (270, 180).
        const result = await page.evaluate(() => {
            const v = window.SketcherView.current;
            const desc = JSON.parse(window.SketcherModel.description());
            let cx = 0, cy = 0;
            const minX = Math.min(...desc.atoms.map((a) => a.x));
            const maxX = Math.max(...desc.atoms.map((a) => a.x));
            const minY = Math.min(...desc.atoms.map((a) => a.y));
            const maxY = Math.max(...desc.atoms.map((a) => a.y));
            cx = (minX + maxX) / 2;
            cy = (minY + maxY) / 2;
            const px = cx * v.scale + 540 / 2 + v.offsetX;
            const py = -cy * v.scale + 360 / 2 + v.offsetY;
            return { scale: v.scale, px, py };
        });
        // Scale changed away from the default — Fit picked a new scale.
        expect(result.scale).not.toBeCloseTo(40, 3);
        // bbox centroid now lands at canvas center.
        expect(result.px).toBeCloseTo(270, 3);
        expect(result.py).toBeCloseTo(180, 3);
    });

    test('Clean Up recomputes 2D coords and is a single undo step', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        // Build three atoms with a bond chain, then drag them all onto
        // nearly the same pixel so the layout is visibly degenerate.
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 400, y: 180 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 400, y: 180 } });

        // Select atom 1 then drag it onto atom 0 via the move-rotate tool
        // (drag-translate lives there per Qt's move_rotate_scene_tool).
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('tool-move-rotate').click();
        const box = await canvas.boundingBox();
        await page.mouse.move(box.x + 260, box.y + 180);
        await page.mouse.down();
        await page.mouse.move(box.x + 122, box.y + 182, { steps: 6 });
        await page.mouse.up();

        const before = await snapshot(page);
        const d01_before = Math.hypot(
            before.atoms[1].x - before.atoms[0].x,
            before.atoms[1].y - before.atoms[0].y,
        );
        expect(d01_before).toBeLessThan(0.5);

        await page.getByTestId('clean-up').click();
        const after = await snapshot(page);
        const d01_after = Math.hypot(
            after.atoms[1].x - after.atoms[0].x,
            after.atoms[1].y - after.atoms[0].y,
        );
        // Clean-up restored a sensible bond length (~1.5).
        expect(d01_after).toBeGreaterThan(1.0);

        // One undo walks back to the degenerate layout.
        await page.getByTestId('undo').click();
        const undone = await snapshot(page);
        expect(undone.atoms[1].x).toBeCloseTo(before.atoms[1].x, 3);
        expect(undone.atoms[1].y).toBeCloseTo(before.atoms[1].y, 3);
    });

    test('newly-wired elements P / S / F / Si place atoms via the icon-driven sidebar', async ({
        page,
    }) => {
        // The icon-driven SetAtomWidget (set_atom_widget.ui) ships 8 fixed
        // elements (C/H/N/O/P/S/F/Cl) and one "last picked from periodic
        // table" slot whose default is Si (Qt: last_picked_element_btn ->
        // setElement(Element::SI)). The first three fixed elements (C/H/N)
        // were exercised already; this guards the rest.
        const canvas = page.getByTestId('sketcher-canvas');
        const placements = [
            ['element-P', 'P', 120],
            ['element-S', 'S', 200],
            ['element-F', 'F', 280],
            // Si lives in the last-picked slot, not as element-Si.
            ['last-picked-element', 'Si', 360],
        ];
        for (const [testid, , x] of placements) {
            await page.getByTestId(testid).click();
            await expect(page.getByTestId(testid)).toHaveAttribute(
                'aria-pressed',
                'true',
            );
            await canvas.click({ position: { x, y: 200 } });
        }
        const rd = await snapshot(page);
        const els = rd.atoms.map((a) => a.el);
        expect(els).toEqual(['P', 'S', 'F', 'Si']);
    });

    test('newly-wired ring icons (cycloheptane / cyclopentadiene / cyclooctane / cyclobutane / cyclopropane) drop the right ring size', async ({
        page,
    }) => {
        // RingToolWidget (ring_tool_widget.ui) ships 8 ring presets. The
        // original 3-button sidebar only covered 3; this exercises the
        // 5 newly visible buttons.
        const canvas = page.getByTestId('sketcher-canvas');
        const cases = [
            ['cycloheptane', 7],
            ['cyclopentadiene', 5],
            ['cyclooctane', 8],
            ['cyclobutane', 4],
            ['cyclopropane', 3],
        ];
        for (const [label, size] of cases) {
            await page.getByTestId('clear').click();
            await page.getByTestId(`ring-${label}`).click();
            await canvas.click({ position: { x: 260, y: 180 } });
            const rd = await snapshot(page);
            expect(rd.atoms).toHaveLength(size);
        }
    });

    test('select-invert flips every atom and bond selection bit', async ({
        page,
    }) => {
        // The Invert text-link comes from select_options_widget.ui ("Invert"
        // in the second HBox). New in the icon-driven sidebar.
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 400, y: 180 } });

        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 120, y: 180 } }); // sel atom 0
        let rd = await snapshot(page);
        expect(rd.atoms.map((a) => !!a.sel)).toEqual([true, false, false]);

        await page.getByTestId('select-invert').click();
        rd = await snapshot(page);
        expect(rd.atoms.map((a) => !!a.sel)).toEqual([false, true, true]);
    });

    test('select-none clears the current selection', async ({ page }) => {
        // The None text-link is also new — it's the "deselect all" shortcut.
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });

        await page.getByTestId('select-all').click();
        let rd = await snapshot(page);
        expect(rd.atoms.every((a) => a.sel)).toBe(true);

        await page.getByTestId('select-none').click();
        rd = await snapshot(page);
        expect(rd.atoms.some((a) => a.sel)).toBe(false);
    });

    test('coming-soon stubs surface a friendly status message (no silent no-op)', async ({
        page,
    }) => {
        // Several Qt-side widgets are present for visual fidelity but the
        // underlying action isn't wired yet (atom_query needs RDKit query
        // atoms, bond_query needs the same, R-group, attachment
        // point, reaction, monomeric mode). Import/Export open real menus
        // (Batch 12); Save Image opens its own dialog (Batch 13);
        // Settings is the Configure View dropdown (Batch 14); Help is
        // its own dropdown (Batch 15) — all covered by their own tests.
        // The remaining stubs route through comingSoon() → setStatus(...)
        // so users can tell the button is intentional rather than
        // broken. (periodic-table opens a real popup in Batch 7; covered
        // by its own tests.)
        const status = page.getByTestId('sketcher-status');
        const stubs = [
            ['atom-query', /Atom query/],
            ['bond-query', /Bond query/],
            ['rgroup', /R-Group/],
            ['attachment-point', /Attachment point/],
            ['reaction', /Reaction/],
            ['mode-monomeric', /Monomeric/],
        ];
        for (const [testid, pattern] of stubs) {
            await page.getByTestId(testid).click();
            await expect(status).toContainText(pattern);
        }
    });

    test('Wheel zoom is view-center-anchored and capped at DEFAULT_SCALE', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        // Hover the canvas first so wheel events route correctly under PW.
        await canvas.hover({ position: { x: 400, y: 120 } });
        const box = await canvas.boundingBox();

        // First zoom OUT (positive deltaY) — at rest we're at DEFAULT_SCALE,
        // which is also the zoom-in cap. Qt's QGraphicsView wheel zoom (see
        // sketcher_view.cpp) uses factor = 2^(angleDelta.y / 2400) so a
        // negative deltaY of -100 → factor ~ 2^(100/2400) ≈ 1.030.
        await page.mouse.move(box.x + 400, box.y + 120);
        await page.mouse.wheel(0, 100); // zoom out
        await page.mouse.wheel(0, 100);
        const zoomedOut = await page.evaluate(() => ({
            scale: window.SketcherView.current.scale,
            offsetX: window.SketcherView.current.offsetX,
            offsetY: window.SketcherView.current.offsetY,
        }));
        // Scale dropped below DEFAULT_SCALE (=40).
        expect(zoomedOut.scale).toBeLessThan(40);
        // Center anchor: offsets stay at zero because we started from
        // (0, 0) offset — center-anchored zoom multiplies offset by ratio,
        // and 0 * ratio = 0.
        expect(zoomedOut.offsetX).toBeCloseTo(0, 3);
        expect(zoomedOut.offsetY).toBeCloseTo(0, 3);

        // Now zoom IN past the cap — sequence of wheel-ups should clamp at
        // DEFAULT_SCALE, never above. Qt enforces the same upper bound.
        for (let i = 0; i < 20; i++) {
            await page.mouse.wheel(0, -100);
        }
        const cap = await page.evaluate(() => window.SketcherView.current.scale);
        expect(cap).toBeCloseTo(40, 6); // exactly DEFAULT_SCALE
    });

    // ---- Keyboard shortcuts (Qt parity) -----------------------------------
    // Qt sources: menu/sketcher_top_bar_menus.cpp:65-88 (Ctrl combos),
    // sketcher_widget.cpp:1195-1310 (Space / Delete / 0-3 / D-T / +-= /
    // single-letter elements), molviewer/view.cpp:230-251 (arrow-key pan).

    test('Ctrl/Cmd+Z undoes; Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y redo', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        let rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(2);

        await page.keyboard.press('ControlOrMeta+z');
        rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(1);

        await page.keyboard.press('ControlOrMeta+Shift+z');
        rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(2);

        await page.keyboard.press('ControlOrMeta+z');
        await page.keyboard.press('ControlOrMeta+y');
        rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(2);
    });

    test('Ctrl/Cmd+A selects all, Ctrl/Cmd+D clears, Ctrl/Cmd+I inverts', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 400, y: 180 } });

        await page.keyboard.press('ControlOrMeta+a');
        let rd = await snapshot(page);
        expect(rd.atoms.every((a) => a.sel)).toBe(true);

        await page.keyboard.press('ControlOrMeta+d');
        rd = await snapshot(page);
        expect(rd.atoms.some((a) => a.sel)).toBe(false);

        // Select atom 0 manually then invert: 0 off, 1+2 on.
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await page.keyboard.press('ControlOrMeta+i');
        rd = await snapshot(page);
        expect(rd.atoms.map((a) => !!a.sel)).toEqual([false, true, true]);
    });

    test('Ctrl/Cmd+F fits the view (recenters offsets)', async ({ page }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });

        // Pan first so the offsets are non-zero, then Ctrl+F should reset.
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowDown');
        const panned = await page.evaluate(() => ({
            offsetX: window.SketcherView.current.offsetX,
            offsetY: window.SketcherView.current.offsetY,
        }));
        expect(panned.offsetX).not.toBe(0);
        expect(panned.offsetY).not.toBe(0);

        await page.keyboard.press('ControlOrMeta+f');
        const fitted = await page.evaluate(() => {
            const v = window.SketcherView.current;
            const desc = JSON.parse(window.SketcherModel.description());
            const xs = desc.atoms.map((a) => a.x);
            const ys = desc.atoms.map((a) => a.y);
            const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
            const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
            return { offsetX: v.offsetX, offsetY: v.offsetY, cx, cy };
        });
        // Fit puts the molecule centroid at the canvas center, i.e.
        //   offsetX = -cx * scale  and  offsetY = cy * scale  (Y-flipped).
        const scale = await page.evaluate(() => window.SketcherView.current.scale);
        expect(fitted.offsetX).toBeCloseTo(-fitted.cx * scale, 3);
        expect(fitted.offsetY).toBeCloseTo(fitted.cy * scale, 3);
    });

    test('arrow keys pan the view by half a bond length per press', async ({
        page,
    }) => {
        // Need atoms in the scene so the view isn't visually empty, but the
        // pan math is purely view-state and atom-independent.
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 200, y: 200 } });

        const before = await page.evaluate(() => ({
            scale: window.SketcherView.current.scale,
            offsetX: window.SketcherView.current.offsetX,
            offsetY: window.SketcherView.current.offsetY,
        }));
        // Qt: KEY_SCROLL_BOND_LENGTH_RATIO = 0.5 → step = 0.5 * scale px.
        const step = 0.5 * before.scale;

        await page.keyboard.press('ArrowRight');
        let v = await page.evaluate(() => window.SketcherView.current);
        expect(v.offsetX).toBeCloseTo(before.offsetX + step, 3);
        expect(v.offsetY).toBeCloseTo(before.offsetY, 3);

        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowLeft');
        v = await page.evaluate(() => window.SketcherView.current);
        expect(v.offsetX).toBeCloseTo(before.offsetX - step, 3);

        await page.keyboard.press('ArrowDown');
        v = await page.evaluate(() => window.SketcherView.current);
        expect(v.offsetY).toBeCloseTo(before.offsetY + step, 3);

        await page.keyboard.press('ArrowUp');
        await page.keyboard.press('ArrowUp');
        v = await page.evaluate(() => window.SketcherView.current);
        expect(v.offsetY).toBeCloseTo(before.offsetY - step, 3);
    });

    test('Space switches to Select tool when scene is non-empty', async ({
        page,
    }) => {
        const status = page.getByTestId('sketcher-status');
        const canvas = page.getByTestId('sketcher-canvas');

        // Empty scene: Space is a no-op (Qt sketcher_widget.cpp:1217 guards
        // on sceneIsEmpty).
        await page.keyboard.press('Space');
        await expect(status).not.toContainText('select mode');

        // Add an atom, then Space activates Select.
        await canvas.click({ position: { x: 200, y: 200 } });
        await page.keyboard.press('Space');
        await expect(status).toContainText('select mode');
        await expect(page.getByTestId('tool-select')).toHaveAttribute(
            'aria-pressed',
            'true',
        );
    });

    test('Delete/Backspace remove the current selection', async ({ page }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 400, y: 180 } });

        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.keyboard.press('Backspace');
        let rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(2);

        // Delete key works too.
        await canvas.click({ position: { x: 120, y: 180 } });
        await page.keyboard.press('Delete');
        rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(1);
    });

    test('1 / 2 set bond order (single / double) and switch to bond tool', async ({
        page,
    }) => {
        const status = page.getByTestId('sketcher-status');
        const canvas = page.getByTestId('sketcher-canvas');
        // Need to be on a non-input target.
        await canvas.click({ position: { x: 200, y: 200 } });

        await page.keyboard.press('1');
        await expect(status).toContainText(/bond mode: single/);
        await expect(page.getByTestId('bond-single')).toHaveAttribute(
            'aria-pressed',
            'true',
        );

        await page.keyboard.press('2');
        await expect(status).toContainText(/bond mode: double/);
        await expect(page.getByTestId('bond-double')).toHaveAttribute(
            'aria-pressed',
            'true',
        );
    });

    test('single-letter element shortcuts (c h n o p s f) switch atom + element', async ({
        page,
    }) => {
        const status = page.getByTestId('sketcher-status');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 200, y: 200 } }); // seed atom 0 = C

        // 'o' → atom tool with element O. Next canvas click places an O.
        await page.keyboard.press('o');
        await expect(status).toContainText('element: O');
        await canvas.click({ position: { x: 320, y: 200 } });
        let rd = await snapshot(page);
        expect(rd.atoms.map((a) => a.el)).toEqual(['C', 'O']);

        // Cycle through the rest of the single-char elements.
        for (const [k, el] of [
            ['n', 'N'],
            ['p', 'P'],
            ['s', 'S'],
            ['f', 'F'],
            ['h', 'H'],
            ['c', 'C'],
        ]) {
            await page.keyboard.press(k);
            await expect(status).toContainText(`element: ${el}`);
        }
    });

    test('+ / = / - adjust charge on the selection', async ({ page }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 200, y: 200 } });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 200, y: 200 } });

        await page.keyboard.press('+');
        let rd = await snapshot(page);
        expect(rd.atoms[0].q).toBe(1);

        await page.keyboard.press('=');
        rd = await snapshot(page);
        expect(rd.atoms[0].q).toBe(2);

        await page.keyboard.press('-');
        await page.keyboard.press('-');
        await page.keyboard.press('-');
        rd = await snapshot(page);
        expect(rd.atoms[0].q).toBe(-1);
    });

    test('stub shortcuts (Ctrl+X/C/V, 0 bond) surface a status; D/T without selection surfaces a friendly hint', async ({
        page,
    }) => {
        const status = page.getByTestId('sketcher-status');
        const canvas = page.getByTestId('sketcher-canvas');
        // Need atoms so the shortcuts route to model-aware branches.
        await canvas.click({ position: { x: 200, y: 200 } });

        // 3 (Triple bond) was a stub before batch 6 — now wired through the
        // bond-order popup primitive. D/T were stubs before batch 10 —
        // now wired through setSelectedAtomsToHydrogenIsotope, but with no
        // selection they surface a "select atoms first" status that still
        // mentions Deuterium / Tritium so users can tell what the shortcut
        // would do.
        const checks = [
            ['ControlOrMeta+x', /Cut/],
            ['ControlOrMeta+c', /Copy/],
            ['ControlOrMeta+v', /Paste/],
            ['d', /Deuterium.*select atoms first/],
            ['t', /Tritium.*select atoms first/],
            ['0', /Zero bond/],
        ];
        for (const [combo, pattern] of checks) {
            await page.keyboard.press(combo);
            await expect(status).toContainText(pattern);
        }
    });

    test('D mutates selected atoms to deuterium (H isotope=2); T to tritium (H isotope=3); undo restores both element and isotope', async ({
        page,
    }) => {
        // Qt sketcher_widget.cpp:1272-1283 — D / T replace selected atoms
        // with H + isotope 2 / 3. The new lean MolModel API
        // (setSelectedAtomsToHydrogenIsotope) backs both keys. Undo restores
        // the original element + isotope + charge + explicit-H count exactly.
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });

        // Select atom 0 only.
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 120, y: 180 } });

        const before = await snapshot(page);
        expect(before.atoms[0].el).toBe('C');
        expect(before.atoms[0].iso ?? 0).toBe(0);
        expect(before.atoms[1].el).toBe('C');

        // Press D.
        await page.keyboard.press('d');
        const afterD = await snapshot(page);
        expect(afterD.atoms[0].el).toBe('H');
        expect(afterD.atoms[0].iso).toBe(2);
        // Atom 1 (unselected) untouched.
        expect(afterD.atoms[1].el).toBe('C');
        expect(afterD.atoms[1].iso ?? 0).toBe(0);
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/Deuterium.*isotope 2/);

        // Press T — converts the now-deuterium atom 0 to tritium.
        await page.keyboard.press('t');
        const afterT = await snapshot(page);
        expect(afterT.atoms[0].el).toBe('H');
        expect(afterT.atoms[0].iso).toBe(3);
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/Tritium.*isotope 3/);

        // Undo (T → D), undo (D → C). Each step restores element + isotope.
        await page.keyboard.press('ControlOrMeta+z');
        const undo1 = await snapshot(page);
        expect(undo1.atoms[0].el).toBe('H');
        expect(undo1.atoms[0].iso).toBe(2);

        await page.keyboard.press('ControlOrMeta+z');
        const undo2 = await snapshot(page);
        expect(undo2.atoms[0].el).toBe('C');
        expect(undo2.atoms[0].iso ?? 0).toBe(0);

        // Redo replays D.
        await page.keyboard.press('ControlOrMeta+Shift+z');
        const redo = await snapshot(page);
        expect(redo.atoms[0].el).toBe('H');
        expect(redo.atoms[0].iso).toBe(2);
    });

    test('shortcuts are suppressed while typing in an input', async ({ page }) => {
        // SMILES Load input field is a normal <input>; pressing Backspace
        // there must edit the field, not delete the selection.
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 120, y: 180 } });

        const input = page.getByTestId('smiles-input');
        await input.click();
        await input.fill('CCO');
        await page.keyboard.press('Backspace');

        // Input now reads 'CC', and selection is intact (atoms unchanged).
        await expect(input).toHaveValue('CC');
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(2);
    });

    test('erase tool: click atom removes atom + incident bonds in one undo', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 400, y: 180 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 400, y: 180 } });

        let rd = await snapshot(page);
        expect([rd.atoms.length, rd.bonds.length]).toEqual([3, 2]);

        // Erase the middle atom: it and both incident bonds vanish.
        await page.getByTestId('tool-erase').click();
        await expect(page.getByTestId('tool-erase')).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await canvas.click({ position: { x: 260, y: 180 } });
        rd = await snapshot(page);
        expect([rd.atoms.length, rd.bonds.length]).toEqual([2, 0]);

        // Single undo restores the atom + both bonds.
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect([rd.atoms.length, rd.bonds.length]).toEqual([3, 2]);
    });

    test('erase tool: click double bond decrements to single before removing', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        // Two atoms, double bond between them.
        await canvas.click({ position: { x: 160, y: 200 } });
        await canvas.click({ position: { x: 320, y: 200 } });
        await page.getByTestId('bond-double').click();
        await canvas.click({ position: { x: 160, y: 200 } });
        await canvas.click({ position: { x: 320, y: 200 } });

        let rd = await snapshot(page);
        expect(rd.bonds[0]).toMatchObject({ a: 0, b: 1, o: 2 });

        await page.getByTestId('tool-erase').click();
        // First click: double → single (atoms intact).
        await canvas.click({ position: { x: 240, y: 200 } });
        rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(2);
        expect(rd.bonds[0]).toMatchObject({ a: 0, b: 1, o: 1 });

        // Second click on the (now single) bond removes it.
        await canvas.click({ position: { x: 240, y: 200 } });
        rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(2);
        expect(rd.bonds).toHaveLength(0);
    });

    test('erase tool: rubber-band region erases everything inside as one undo', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 400, y: 180 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 400, y: 180 } });

        let rd = await snapshot(page);
        expect([rd.atoms.length, rd.bonds.length]).toEqual([3, 2]);

        await page.getByTestId('tool-erase').click();
        // Drag a rectangle that encloses the first two atoms.
        const box = await canvas.boundingBox();
        await page.mouse.move(box.x + 60, box.y + 100);
        await page.mouse.down();
        await page.mouse.move(box.x + 200, box.y + 130, { steps: 4 });
        await page.mouse.move(box.x + 320, box.y + 260, { steps: 6 });
        await page.mouse.up();

        rd = await snapshot(page);
        // Atoms 0+1 and the bond between them go; atom 2 survives but its
        // incident bond is gone too (atom 1 removed).
        expect(rd.atoms).toHaveLength(1);
        expect(rd.bonds).toHaveLength(0);

        // Undo restores everything as a single step.
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect([rd.atoms.length, rd.bonds.length]).toEqual([3, 2]);
    });

    test('rotate handle: drag the handle rotates the whole molecule about its centroid', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        let rd = await snapshot(page);

        // Place two atoms symmetric about the canvas centre so the centroid
        // (and therefore the rotate pivot) lands exactly at canvas (270, 180)
        // — that's where the SketcherView resting offset puts the origin.
        // Canvas size is 540×360 and default scale is 40 px/Å, so atoms
        // placed at pixel (170, 180) and (370, 180) are at model (±2.5, 0).
        await canvas.click({ position: { x: 170, y: 180 } });
        await canvas.click({ position: { x: 370, y: 180 } });

        rd = await snapshot(page);
        const orig = rd.atoms.map((a) => ({ x: a.x, y: a.y }));
        // Sanity-check the symmetric placement before we depend on it.
        expect(Math.abs(orig[0].x + orig[1].x)).toBeLessThan(0.05);
        expect(Math.abs(orig[0].y - orig[1].y)).toBeLessThan(0.05);

        await page.getByTestId('tool-move-rotate').click();
        const box = await canvas.boundingBox();

        // Pivot is (270, 180) in canvas coords; handle 130 px to the right.
        const cx = 270;
        const cy = 180;
        const handleX = cx + 130;
        const handleY = cy;

        // Grab handle, drag 90° CCW (in pixel space) around pivot — handle
        // ends straight up. Pixel-CCW = model-CW, so an atom starting on
        // the +x side of the pivot (right) ends up below (model -y).
        await page.mouse.move(box.x + handleX, box.y + handleY);
        await page.mouse.down();
        await page.mouse.move(box.x + cx + 92, box.y + cy - 92, { steps: 4 });
        await page.mouse.move(box.x + cx, box.y + cy - 130, { steps: 4 });
        await page.mouse.up();

        rd = await snapshot(page);
        // Distance between atoms is preserved.
        const d0 = Math.hypot(
            orig[0].x - orig[1].x,
            orig[0].y - orig[1].y,
        );
        const d1 = Math.hypot(
            rd.atoms[0].x - rd.atoms[1].x,
            rd.atoms[0].y - rd.atoms[1].y,
        );
        expect(Math.abs(d1 - d0)).toBeLessThan(0.1);
        // Original pair was horizontal (|dy0| ≈ 0); rotated pair should be
        // close to vertical — i.e., the x-spread collapses to near zero.
        expect(Math.abs(rd.atoms[0].x - rd.atoms[1].x)).toBeLessThan(1.0);
        expect(Math.abs(rd.atoms[0].y - rd.atoms[1].y)).toBeGreaterThan(3.0);

        // Single undo restores the original positions.
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        for (let i = 0; i < orig.length; ++i) {
            expect(Math.abs(rd.atoms[i].x - orig[i].x)).toBeLessThan(1e-6);
            expect(Math.abs(rd.atoms[i].y - orig[i].y)).toBeLessThan(1e-6);
        }
    });

    test('rotate handle: hidden when fewer than 2 atoms qualify for rotation', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 270, y: 180 } });

        await page.getByTestId('tool-move-rotate').click();
        const box = await canvas.boundingBox();
        // With a single atom, no handle should be drawn. Pressing where the
        // handle would have been is empty canvas — Qt's "select atoms first"
        // status fires.
        const status = page.getByTestId('sketcher-status');
        await page.mouse.move(box.x + 270 + 130, box.y + 180);
        await page.mouse.down();
        await page.mouse.move(box.x + 200, box.y + 60, { steps: 4 });
        await page.mouse.up();
        await expect(status).toContainText(/select atoms first/);
    });

    test('erase tool: empty rubber-band preserves the prior selection', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 400, y: 180 } });

        // Seed a selection via the Select tool, then switch to Erase.
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        let rd = await snapshot(page);
        expect(rd.atoms[0].sel).toBe(true);

        await page.getByTestId('tool-erase').click();
        // Drag in an empty region — no atoms enclosed, nothing should change.
        const box = await canvas.boundingBox();
        await page.mouse.move(box.x + 500, box.y + 40);
        await page.mouse.down();
        await page.mouse.move(box.x + 560, box.y + 80, { steps: 4 });
        await page.mouse.up();

        rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(2);
        // Prior selection survives the empty erase-rect.
        expect(rd.atoms.map((a) => !!a.sel)).toEqual([true, false]);
    });

    // ---- Batch 6: popup primitive (Qt ModularToolButton + ModularPopup) ----

    test('bond-order popup: click-when-active opens popup; picking Triple swaps the slot icon AND switches bond mode', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        // Seed two atoms with the default atom tool (bond tool only works
        // on existing atoms — same pattern as the bond-single round-trip
        // test earlier in this file).
        await canvas.click({ position: { x: 120, y: 200 } });
        await canvas.click({ position: { x: 260, y: 200 } });

        // First click activates the bond-order slot (default = Double).
        await page.getByTestId('bond-double').click();
        await expect(page.getByTestId('bond-double')).toHaveAttribute('aria-pressed', 'true');
        // Popup should NOT be open yet — first click is just "activate".
        await expect(page.getByTestId('bond-double-popup')).toHaveCount(0);

        // Click-while-checked opens the popup (Qt onClicked at
        // tool_button_with_popup.h:113).
        await page.getByTestId('bond-double').click();
        await expect(page.getByTestId('bond-double-popup')).toBeVisible();
        await expect(page.getByTestId('order-popup-double')).toBeVisible();
        await expect(page.getByTestId('order-popup-triple')).toBeVisible();

        // Pick Triple. The popup closes, the slot becomes triple, and
        // subsequent canvas clicks draw triple bonds.
        await page.getByTestId('order-popup-triple').click();
        await expect(page.getByTestId('bond-double-popup')).toHaveCount(0);
        await expect(page.getByTestId('sketcher-status')).toContainText(/triple/i);

        await canvas.click({ position: { x: 120, y: 200 } });
        await canvas.click({ position: { x: 260, y: 200 } });
        const rd = await snapshot(page);
        expect(rd.bonds).toHaveLength(1);
        expect(rd.bonds[0].o).toBe(3); // TRIPLE
    });

    test('stereo popup: pick Wavy → next bond is a wavy single (BondDir::UNKNOWN, serialized dir=6)', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        // Seed two atoms with the default atom tool first.
        await canvas.click({ position: { x: 120, y: 200 } });
        await canvas.click({ position: { x: 260, y: 200 } });

        // Activate stereo1 slot, then click again to open popup.
        await page.getByTestId('bond-wedge').click();
        await page.getByTestId('bond-wedge').click();
        await expect(page.getByTestId('bond-wedge-popup')).toBeVisible();

        await page.getByTestId('stereo-popup-wavy').click();
        await expect(page.getByTestId('bond-wedge-popup')).toHaveCount(0);

        await canvas.click({ position: { x: 120, y: 200 } });
        await canvas.click({ position: { x: 260, y: 200 } });
        const rd = await snapshot(page);
        expect(rd.bonds).toHaveLength(1);
        expect(rd.bonds[0]).toMatchObject({ o: 1, dir: 6 }); // SINGLE + UNKNOWN
    });

    test('stereo popup: pick Crossed → next bond is a crossed double (BondDir::EITHERDOUBLE, serialized dir=5)', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        // Seed two atoms with the default atom tool first.
        await canvas.click({ position: { x: 120, y: 200 } });
        await canvas.click({ position: { x: 260, y: 200 } });

        await page.getByTestId('bond-dash').click();
        await page.getByTestId('bond-dash').click();
        await expect(page.getByTestId('bond-dash-popup')).toBeVisible();

        await page.getByTestId('stereo-popup-crossed').click();
        await expect(page.getByTestId('bond-dash-popup')).toHaveCount(0);

        await canvas.click({ position: { x: 120, y: 200 } });
        await canvas.click({ position: { x: 260, y: 200 } });
        const rd = await snapshot(page);
        expect(rd.bonds).toHaveLength(1);
        expect(rd.bonds[0]).toMatchObject({ o: 2, dir: 5 }); // DOUBLE + EITHERDOUBLE
    });

    test('popup closes on click outside (does not commit a choice)', async ({
        page,
    }) => {
        // Activate then open popup.
        await page.getByTestId('bond-double').click();
        await page.getByTestId('bond-double').click();
        await expect(page.getByTestId('bond-double-popup')).toBeVisible();

        // Click somewhere outside — the SMILES Load button is a stable
        // off-popup target that won't itself open a popup.
        await page.getByTestId('smiles-load').click();
        await expect(page.getByTestId('bond-double-popup')).toHaveCount(0);

        // Slot mode unchanged (still Double, since we never picked Triple).
        await expect(page.getByTestId('bond-double')).toHaveAttribute('aria-pressed', 'true');
    });

    test('long-press on stereo button opens popup without first activating the slot', async ({
        page,
    }) => {
        // Sanity: initial bond tool is not active. Long-press should open
        // the popup regardless. Use hover() + mouse.down + delay + mouse.up
        // so we cross the 250 ms POPUP_DELAY_MS threshold in Sketcher.tsx.
        // hover() is more reliable than mouse.move for getting the React
        // onMouseEnter / hit-test path right.
        const wedgeBtn = page.getByTestId('bond-wedge');
        await wedgeBtn.hover();
        await page.mouse.down();
        await page.waitForTimeout(350); // > POPUP_DELAY_MS (250)
        await expect(page.getByTestId('bond-wedge-popup')).toBeVisible();
        await page.mouse.up();
        // Popup stays visible after mouseup — Qt behavior; click outside or
        // pick to close.
        await expect(page.getByTestId('bond-wedge-popup')).toBeVisible();
    });

    test('keyboard 3 sets triple mode AND swaps the bond-order slot icon to Triple', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        // Seed two atoms with the default atom tool BEFORE pressing 3 —
        // once bond tool is active, empty-canvas clicks no longer add
        // atoms.
        await canvas.click({ position: { x: 200, y: 200 } });
        await canvas.click({ position: { x: 320, y: 200 } });

        await page.keyboard.press('3');
        await expect(page.getByTestId('sketcher-status')).toContainText(/triple/i);
        // Bond-order slot should now be the active button (since bondMode
        // = triple = bondOrderMode after the keypress).
        await expect(page.getByTestId('bond-double')).toHaveAttribute('aria-pressed', 'true');

        // Click both atoms to commit the bond; it should be triple.
        await canvas.click({ position: { x: 200, y: 200 } });
        await canvas.click({ position: { x: 320, y: 200 } });
        const rd = await snapshot(page);
        expect(rd.bonds).toHaveLength(1);
        expect(rd.bonds[0].o).toBe(3);
    });

    test('periodic-table: click opens popup → picking Fe activates atom tool with Fe AND parks Fe in the last-picked slot', async ({
        page,
    }) => {
        // Qt PeriodicTableWidget.onButtonClicked sets DRAW_TOOL=ATOM,
        // ATOM_TOOL=ELEMENT, ELEMENT=picked. SetAtomWidget watches ELEMENT
        // and routes anything outside the fixed bimap into
        // last_picked_element_btn. React port mirrors both.
        const canvas = page.getByTestId('sketcher-canvas');
        const last = page.getByTestId('last-picked-element');

        // Default state: last-picked is Si (Qt: last_picked_element_btn
        // ->setElement(Element::SI)).
        await expect(last).toHaveText('Si');

        // Click the PT button — popup should appear.
        await page.getByTestId('periodic-table').click();
        await expect(page.getByTestId('periodic-table-popup')).toBeVisible();

        // Pick Fe.
        await page.getByTestId('pt-Fe').click();
        // Popup closes.
        await expect(page.getByTestId('periodic-table-popup')).toHaveCount(0);

        // last-picked slot now shows Fe and is active.
        await expect(last).toHaveText('Fe');
        await expect(last).toHaveAttribute('aria-pressed', 'true');

        // Clicking the canvas places an Fe atom.
        await canvas.click({ position: { x: 240, y: 200 } });
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(1);
        expect(rd.atoms[0].el).toBe('Fe');
    });

    test('periodic-table: outside-click closes the popup without committing a pick', async ({
        page,
    }) => {
        const last = page.getByTestId('last-picked-element');
        await expect(last).toHaveText('Si');

        await page.getByTestId('periodic-table').click();
        await expect(page.getByTestId('periodic-table-popup')).toBeVisible();

        // Mouse down outside the popup (the canvas works); the popup
        // should close before the click resolves.
        await page.getByTestId('sketcher-canvas').click({ position: { x: 50, y: 50 } });
        await expect(page.getByTestId('periodic-table-popup')).toHaveCount(0);

        // Last-picked unchanged.
        await expect(last).toHaveText('Si');
    });

    test('periodic-table: fixed elements (C/H/N/O/P/S/F/Cl) bypass the last-picked slot when picked from the table', async ({
        page,
    }) => {
        // Qt SetAtomWidget::onModelValuePinged checks whether the new
        // element is in m_button_element_bimap before re-homing it on the
        // last-picked button. Fluorine is in the bimap → last-picked
        // stays on its previous element.
        const last = page.getByTestId('last-picked-element');
        await expect(last).toHaveText('Si');

        await page.getByTestId('periodic-table').click();
        await page.getByTestId('pt-F').click();
        await expect(page.getByTestId('periodic-table-popup')).toHaveCount(0);

        // Last-picked still says Si — F lives on its own fixed button.
        await expect(last).toHaveText('Si');
        // Active button is element-F, not last-picked.
        await expect(page.getByTestId('element-F')).toHaveAttribute('aria-pressed', 'true');
        await expect(last).toHaveAttribute('aria-pressed', 'false');
    });

    test('atom-query popup: long-press opens A/AH/Q/QH/M/MH/X/XH; pick still surfaces coming-soon (query atoms need RDKit support)', async ({
        page,
    }) => {
        // Qt AtomQueryPopup renders 8 choices in a 2×4 grid. The
        // underlying RDKit::QueryAtom plumbing isn't in the lean MolModel
        // yet, so picks should still route through comingSoon() rather
        // than silently no-op.
        const status = page.getByTestId('sketcher-status');
        const aQueryBtn = page.getByTestId('atom-query');

        // Long-press (>250 ms) opens the popup. Use hover()+mouse.down so
        // React's onMouseEnter path fires before mouseDown — see Batch 6.
        await aQueryBtn.hover();
        await page.mouse.down();
        await page.waitForTimeout(350);
        await expect(page.getByTestId('atom-query-popup')).toBeVisible();

        // All 8 choices present.
        for (const v of ['A', 'AH', 'Q', 'QH', 'M', 'MH', 'X', 'XH']) {
            await expect(page.getByTestId(`atom-query-popup-${v}`)).toBeVisible();
        }
        await page.mouse.up();

        // Pick "Q" — status should mention Q and coming-soon-ness.
        await page.getByTestId('atom-query-popup-Q').click();
        await expect(status).toContainText(/Q/);
        await expect(status).toContainText(/query atom/i);
        await expect(page.getByTestId('atom-query-popup')).toHaveCount(0);
    });

    test('bond-query popup: long-press exposes aromatic/Any/S-D/S-A/D-A; pick still surfaces coming-soon (query bonds need RDKit support)', async ({
        page,
    }) => {
        // Qt BondQueryPopup renders 5 choices in a horizontal row: aromatic
        // (icon) / Any / S/D / S/A / D/A. RDKit::QueryBond isn't in the lean
        // MolModel yet, so picks should route through comingSoon().
        const status = page.getByTestId('sketcher-status');
        const bondQueryBtn = page.getByTestId('bond-query');

        await bondQueryBtn.hover();
        await page.mouse.down();
        await page.waitForTimeout(350);
        await expect(page.getByTestId('bond-query-popup')).toBeVisible();

        // All 5 choices present.
        for (const v of ['aromatic', 'any', 'single-double', 'single-aromatic',
                         'double-aromatic']) {
            await expect(page.getByTestId(`bond-query-popup-${v}`)).toBeVisible();
        }
        await page.mouse.up();

        // Pick "S/D" — status surfaces the pick + coming-soon-ness.
        await page.getByTestId('bond-query-popup-single-double').click();
        await expect(status).toContainText(/single\/double/i);
        await expect(status).toContainText(/query bond/i);
        await expect(page.getByTestId('bond-query-popup')).toHaveCount(0);
    });

    test('select popup: long-press exposes rect/lasso/ellipse choices', async ({
        page,
    }) => {
        // Qt selection_tool_popup.ui: rect / lasso / ellipse — the same three
        // choices we surface in the port.
        const selectBtn = page.getByTestId('tool-select');
        await selectBtn.hover();
        await page.mouse.down();
        await page.waitForTimeout(350);
        await expect(page.getByTestId('tool-select-popup')).toBeVisible();
        for (const v of ['rect', 'lasso', 'ellipse']) {
            await expect(page.getByTestId(`select-popup-${v}`)).toBeVisible();
        }
        await page.mouse.up();
        // Outside-click closes without committing — select tool stays inactive.
        await page.mouse.click(10, 10);
        await expect(page.getByTestId('tool-select-popup')).toHaveCount(0);
    });

    test('select popup: pick lasso → select tool active with lasso icon; drag selects polygon-contained atoms', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        // Place 3 atoms across the canvas — we'll lasso just the middle one.
        await canvas.click({ position: { x: 100, y: 200 } });
        await canvas.click({ position: { x: 300, y: 200 } });
        await canvas.click({ position: { x: 500, y: 200 } });

        // Open the select popup and pick lasso.
        const selectBtn = page.getByTestId('tool-select');
        await selectBtn.hover();
        await page.mouse.down();
        await page.waitForTimeout(350);
        await page.mouse.up();
        await page.getByTestId('select-popup-lasso').click();

        // The button is now active (select tool) and its slot icon swapped.
        await expect(selectBtn).toHaveAttribute('aria-pressed', 'true');
        const slotIcon = selectBtn.locator('img').first();
        await expect(slotIcon).toHaveAttribute('src', '/icons/select_lasso.svg');

        // Drag a small loop around the middle atom (~x=300, y=200) only.
        const box = await canvas.boundingBox();
        const path = [
            [260, 170],
            [340, 170],
            [340, 230],
            [260, 230],
            [260, 175],
        ];
        await page.mouse.move(box.x + path[0][0], box.y + path[0][1]);
        await page.mouse.down();
        for (let i = 1; i < path.length; ++i) {
            await page.mouse.move(box.x + path[i][0], box.y + path[i][1],
                { steps: 4 });
        }
        await page.mouse.up();

        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(3);
        // Middle atom selected; left/right untouched.
        const sel = rd.atoms.filter((a) => a.sel).map((a) => a.i).sort();
        expect(sel).toEqual([1]);
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/lasso: 1 atom/);
    });

    test('select popup: pick ellipse → drag selects atoms inside ellipse but not in its corners', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        // Three collinear atoms.
        await canvas.click({ position: { x: 100, y: 200 } });
        await canvas.click({ position: { x: 300, y: 200 } });
        await canvas.click({ position: { x: 500, y: 200 } });

        // Switch to ellipse via the popup.
        const selectBtn = page.getByTestId('tool-select');
        await selectBtn.hover();
        await page.mouse.down();
        await page.waitForTimeout(350);
        await page.mouse.up();
        await page.getByTestId('select-popup-ellipse').click();
        await expect(selectBtn.locator('img').first())
            .toHaveAttribute('src', '/icons/select_ellipse.svg');

        // Drag a tall narrow ellipse around the middle atom. A bounding-rect
        // of the same span would include the left and right atoms too, but
        // the inscribed ellipse excludes them — that's the visual point of
        // the shape.
        const box = await canvas.boundingBox();
        await page.mouse.move(box.x + 240, box.y + 80);
        await page.mouse.down();
        await page.mouse.move(box.x + 360, box.y + 320, { steps: 8 });
        await page.mouse.up();

        const rd = await snapshot(page);
        const sel = rd.atoms.filter((a) => a.sel).map((a) => a.i).sort();
        expect(sel).toEqual([1]);
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/ellipse: 1 atom/);
    });

});
