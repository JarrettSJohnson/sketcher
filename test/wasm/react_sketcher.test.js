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

    test('rubber-band drag selects a bond when both endpoints fall inside', async ({
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
        // The icon-driven SetAtomWidget (set_atom_widget.ui) ships 9 elements
        // — C/H/N, O/P/S, F/Cl/Si. Coverage previously only exercised C/N/O.
        // This guards the four newly-wired buttons.
        const canvas = page.getByTestId('sketcher-canvas');
        const placements = [
            ['P', 120],
            ['S', 200],
            ['F', 280],
            ['Si', 360],
        ];
        for (const [el, x] of placements) {
            await page.getByTestId(`element-${el}`).click();
            await expect(page.getByTestId(`element-${el}`)).toHaveAttribute(
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
        // Several Qt-side widgets are present for visual fidelity but not yet
        // ported (atom_query popup, periodic_table, bond_query, atom_chain,
        // R-group, attachment point, reaction, monomeric mode,
        // import/export/settings/help). All of them route through
        // comingSoon() → setStatus(...) so users can tell the button is
        // intentional rather than broken. (Move/Rotate wired in Batch 3,
        // Erase wired in Batch 5.)
        const status = page.getByTestId('sketcher-status');
        const stubs = [
            ['atom-query', /Atom query/],
            ['periodic-table', /Periodic table/],
            ['bond-query', /Bond query/],
            ['atom-chain', /Atom chain/],
            ['rgroup', /R-Group/],
            ['attachment-point', /Attachment point/],
            ['reaction', /Reaction/],
            ['mode-monomeric', /Monomeric/],
            ['import', /Import/],
            ['export', /Export/],
            ['settings', /Settings/],
            ['help', /Help/],
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

    test('stub shortcuts (Ctrl+X/C/V, D/T isotope, 0/3 bond) surface a status', async ({
        page,
    }) => {
        const status = page.getByTestId('sketcher-status');
        const canvas = page.getByTestId('sketcher-canvas');
        // Need atoms so the shortcuts route to model-aware branches.
        await canvas.click({ position: { x: 200, y: 200 } });

        const checks = [
            ['ControlOrMeta+x', /Cut/],
            ['ControlOrMeta+c', /Copy/],
            ['ControlOrMeta+v', /Paste/],
            ['d', /Deuterium/],
            ['t', /Tritium/],
            ['0', /Zero bond/],
            ['3', /Triple bond/],
        ];
        for (const [combo, pattern] of checks) {
            await page.keyboard.press(combo);
            await expect(status).toContainText(pattern);
        }
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
});
