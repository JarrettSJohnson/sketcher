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

    test('drag-to-move atom: live preview + undoable commit', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        // Place two atoms.
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });

        // Capture original coords of atom 0.
        const before = await snapshot(page);
        const a0Before = before.atoms[0];

        // Select atom 1 first — moving atom 0 must NOT clear that selection.
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 260, y: 180 } });
        expect(
            await page.evaluate(() => window.SketcherModel.isAtomSelected(1)),
        ).toBe(true);

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
        // Atom 1's selection survives the move.
        expect(
            await page.evaluate(() => window.SketcherModel.isAtomSelected(1)),
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

        // Grab atom 0 (selected) and drag it — atom 1 should follow by the
        // same delta; atom 2 must stay put.
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

        // Drag atom 1 onto atom 0 to collapse the layout.
        await page.getByTestId('tool-select').click();
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
});
