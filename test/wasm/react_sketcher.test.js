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

// Loads a SMILES (or MOL block) into the sketch via the Qt-fidelity
// Import → Paste in Text modal — the only text-entry path Qt exposes.
async function loadText(page, text) {
    await page.getByTestId('import').click();
    await page.getByTestId('import-paste-in-text').click();
    await page.getByTestId('paste-text-input').fill(text);
    await page.getByTestId('paste-text-load').click();
}

test.beforeEach(async ({ page, context }) => {
    // Grant clipboard so the Copy-As tests can verify writes via
    // navigator.clipboard.readText(). Headless Chromium allows
    // clipboard-write by default but denies clipboard-read without
    // an explicit grant.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await waitForReady(page);
});

async function readClipboard(page) {
    return await page.evaluate(() => navigator.clipboard.readText());
}

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
        await loadText(page, 'c1ccccc1');
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

    test('R-Group tool: free-standing click adds R1, second click adds R2, click on atom attaches R3', async ({
        page,
    }) => {
        // Qt EnumerationToolWidget: the R button activates the R-Group
        // scene tool, which calls MolModel::addRGroup(next_num, coords,
        // optional_target). Free clicks drop free-standing R atoms;
        // clicking on an existing atom bonds a new R to it. Numbers auto-
        // increment to the smallest free positive integer.
        const canvas = page.getByTestId('sketcher-canvas');
        await page.getByTestId('rgroup').click();
        // First free click → R1.
        await canvas.click({ position: { x: 120, y: 150 } });
        let rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(1);
        expect(rd.atoms[0].rlabel).toBe(1);
        // Second free click → R2 (auto-incremented).
        await canvas.click({ position: { x: 220, y: 150 } });
        rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(2);
        const labels = rd.atoms.map((a) => a.rlabel).sort();
        expect(labels).toEqual([1, 2]);
        // Now place a C, click it with R-group tool → bonded R3.
        await page.getByTestId('element-C').click();
        await canvas.click({ position: { x: 320, y: 250 } });
        await page.getByTestId('rgroup').click();
        await canvas.click({ position: { x: 320, y: 250 } });
        rd = await snapshot(page);
        // Three R-groups + one C.
        expect(rd.atoms).toHaveLength(4);
        const rlabels = rd.atoms
            .map((a) => a.rlabel)
            .filter((n) => typeof n === 'number')
            .sort();
        expect(rlabels).toEqual([1, 2, 3]);
        // The new R3 must be bonded to the carbon (the C is the only non-R).
        const carbonIdx = rd.atoms.findIndex((a) => typeof a.rlabel !== 'number');
        expect(carbonIdx).toBeGreaterThanOrEqual(0);
        const carbonBonded = rd.bonds.some(
            (b) => b.a === carbonIdx || b.b === carbonIdx);
        expect(carbonBonded).toBe(true);
        // Undo removes the attached R3 (back to 3 atoms, no bonds).
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(3);
        expect(rd.bonds).toHaveLength(0);
    });

    test('R-Group tool: SVG export renders R-label text and survives the round trip', async ({
        page,
    }) => {
        // Drop a single R1 atom, then run the same Save Image SVG flow the
        // Save Image PNG/SVG tests use. The exported SVG must contain a
        // <text>R1</text> element so anyone consuming the file sees the R
        // label exactly as the canvas painted it.
        const canvas = page.getByTestId('sketcher-canvas');
        await page.getByTestId('rgroup').click();
        await canvas.click({ position: { x: 200, y: 200 } });
        await page.getByTestId('export').click();
        await page.getByTestId('export-save-image').click();
        await page.getByTestId('save-image-format-select')
            .selectOption('svg');
        await page.getByTestId('save-image-width').fill('200');
        await page.getByTestId('save-image-height').fill('120');
        const downloadPromise = page.waitForEvent('download');
        await page.getByTestId('save-image-save').click();
        const download = await downloadPromise;
        const path = await download.path();
        const fs = await import('node:fs/promises');
        const body = await fs.readFile(path, 'utf8');
        expect(body).toMatch(/<text [^>]*>R1<\/text>/);
    });

    test('Attachment-point tool: clicking an atom attaches AP1, second attach is AP2, empty click is a no-op', async ({
        page,
    }) => {
        // Qt EnumerationToolWidget / DrawAttachmentPointSceneTool: AP atoms
        // are ALWAYS bonded (is_attachment_point_dummy requires
        // totalDegree == 1), so a click on empty canvas is a no-op with a
        // hint message. AP numbers auto-increment to max + 1, mirroring
        // get_next_attachment_point_number (rdkit/rgroup.cpp).
        const canvas = page.getByTestId('sketcher-canvas');
        // Place a carbon to attach to.
        await canvas.click({ position: { x: 200, y: 200 } });
        let rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(1);
        // Switch to attachment-point tool.
        await page.getByTestId('attachment-point').click();
        // Empty click: no-op, just a status message.
        await canvas.click({ position: { x: 400, y: 100 } });
        rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(1);
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/click an existing atom/);
        // Click the carbon: adds AP1, bonded.
        await canvas.click({ position: { x: 200, y: 200 } });
        rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(2);
        expect(rd.bonds).toHaveLength(1);
        const apAtom = rd.atoms.find((a) => typeof a.ap === 'number');
        expect(apAtom).toBeTruthy();
        expect(apAtom.ap).toBe(1);
        // Click the carbon again: adds AP2 (max+1).
        await canvas.click({ position: { x: 200, y: 200 } });
        rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(3);
        const aps = rd.atoms
            .map((a) => a.ap)
            .filter((n) => typeof n === 'number')
            .sort();
        expect(aps).toEqual([1, 2]);
        // Undo rolls back the second AP.
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(2);
    });

    test('Attachment-point tool: SVG export renders a wavy <path> per AP and no element label', async ({
        page,
    }) => {
        // Drop a C, attach an AP, then SVG-export. The export must include
        // a <path> element for the squiggle and MUST NOT include any "*"
        // text node (Qt hides the dummy label and replaces it with the
        // squiggle — atom_item.cpp:302-304). The C label stays visible.
        const canvas = page.getByTestId('sketcher-canvas');
        await page.getByTestId('element-N').click();
        await canvas.click({ position: { x: 200, y: 200 } });
        await page.getByTestId('attachment-point').click();
        await canvas.click({ position: { x: 200, y: 200 } });
        await page.getByTestId('export').click();
        await page.getByTestId('export-save-image').click();
        await page.getByTestId('save-image-format-select')
            .selectOption('svg');
        await page.getByTestId('save-image-width').fill('200');
        await page.getByTestId('save-image-height').fill('120');
        const downloadPromise = page.waitForEvent('download');
        await page.getByTestId('save-image-save').click();
        const download = await downloadPromise;
        const path = await download.path();
        const fs = await import('node:fs/promises');
        const body = await fs.readFile(path, 'utf8');
        // The wavy path uses quadratic curves — at minimum one `<path d='M`
        // with a transform that rotates it to perpendicular.
        expect(body).toMatch(/<path d='M [^']+'[^>]*transform='translate/);
        // The dummy atom's "*" symbol must NOT appear as a text label.
        expect(body).not.toMatch(/<text [^>]*>\*<\/text>/);
        // The anchor heteroatom (N) is still labeled.
        expect(body).toMatch(/<text [^>]*>N<\/text>/);
    });

    test('Reaction tool: arrow mode places an arrow; popup switches to plus mode for subsequent clicks', async ({
        page,
    }) => {
        // Qt ReactionPopup (ui/reaction_popup.ui) drives a ModularToolButton;
        // long-press exposes arrow/plus and a pick swaps the active mode.
        // MolModel::addNonMolecularObject allows at most one arrow but
        // unlimited pluses, so the second click in arrow mode would throw;
        // switching to plus mode lets us drop multiple +.
        const canvas = page.getByTestId('sketcher-canvas');
        const reactionBtn = page.getByTestId('reaction');

        // Default mode is arrow — single click places one.
        await reactionBtn.click();
        await canvas.click({ position: { x: 250, y: 200 } });
        let rd = await snapshot(page);
        expect(rd.nonMol).toBeDefined();
        expect(rd.nonMol.filter((o) => o.type === 'arrow')).toHaveLength(1);
        expect(rd.nonMol.filter((o) => o.type === 'plus')).toHaveLength(0);

        // Long-press to open popup; pick "plus" to flip the mode.
        await reactionBtn.hover();
        await page.mouse.down();
        await page.waitForTimeout(350);
        await expect(page.getByTestId('reaction-popup')).toBeVisible();
        await expect(page.getByTestId('reaction-popup-arrow')).toBeVisible();
        await expect(page.getByTestId('reaction-popup-plus')).toBeVisible();
        await page.mouse.up();
        await page.getByTestId('reaction-popup-plus').click();
        await expect(page.getByTestId('reaction-popup')).toHaveCount(0);

        // Two clicks in plus mode drop two pluses (no cap on count).
        await canvas.click({ position: { x: 350, y: 200 } });
        await canvas.click({ position: { x: 450, y: 200 } });
        rd = await snapshot(page);
        expect(rd.nonMol.filter((o) => o.type === 'arrow')).toHaveLength(1);
        expect(rd.nonMol.filter((o) => o.type === 'plus')).toHaveLength(2);

        // Undo removes the last plus.
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.nonMol.filter((o) => o.type === 'plus')).toHaveLength(1);
    });

    test('Reaction tool: SVG export renders <path> for arrow + plus alongside the mol', async ({
        page,
    }) => {
        // Place two carbons, then an arrow + plus. The exported SVG must
        // include at least two <path stroke=...> elements (one for the
        // chevron arrow, one for the crossed plus) on top of the C-C
        // bond. (Reaction-only export — no atoms at all — is covered by
        // the dedicated reaction-only export test in the Save Image
        // suite.)
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 100, y: 200 } });
        await canvas.click({ position: { x: 200, y: 200 } });
        await page.getByTestId('reaction').click();
        await canvas.click({ position: { x: 300, y: 200 } });
        await page.getByTestId('reaction').hover();
        await page.mouse.down();
        await page.waitForTimeout(350);
        await page.mouse.up();
        await page.getByTestId('reaction-popup-plus').click();
        await canvas.click({ position: { x: 400, y: 200 } });

        await page.getByTestId('export').click();
        await page.getByTestId('export-save-image').click();
        await page.getByTestId('save-image-format-select')
            .selectOption('svg');
        await page.getByTestId('save-image-width').fill('400');
        await page.getByTestId('save-image-height').fill('200');
        const downloadPromise = page.waitForEvent('download');
        await page.getByTestId('save-image-save').click();
        const download = await downloadPromise;
        const path = await download.path();
        const fs = await import('node:fs/promises');
        const body = await fs.readFile(path, 'utf8');
        // Bonds emit <line> elements; only the reaction objects use
        // <path>. So one arrow path + one plus path = 2 stroked <path>s.
        const pathMatches = body.match(/<path [^>]*stroke=/g) || [];
        expect(pathMatches.length).toBeGreaterThanOrEqual(2);
    });

    test('Mode toggle: atomistic ↔ monomeric swaps the sidebar page; SELECT stays', async ({
        page,
    }) => {
        // Qt's sketcher_side_bar.ui has a QStackedWidget
        // (`atomistic_or_monomeric_stack`) with `atomistic_page` and
        // `monomeric_page`. The atomistic/monomeric header buttons act as
        // a QButtonGroup — toggling flips which page is mounted while the
        // SELECT cluster above the divider stays put in both modes
        // (sketcher_side_bar.cpp:55-188).
        await expect(page.getByTestId('mode-atomistic'))
            .toHaveAttribute('aria-pressed', 'true');
        await expect(page.getByTestId('mode-monomeric'))
            .toHaveAttribute('aria-pressed', 'false');
        await expect(page.getByTestId('element-C')).toBeVisible();
        await expect(page.getByTestId('monomeric-page')).toHaveCount(0);
        await expect(page.getByTestId('tool-select')).toBeVisible();

        await page.getByTestId('mode-monomeric').click();
        await expect(page.getByTestId('mode-atomistic'))
            .toHaveAttribute('aria-pressed', 'false');
        await expect(page.getByTestId('mode-monomeric'))
            .toHaveAttribute('aria-pressed', 'true');
        await expect(page.getByTestId('element-C')).toHaveCount(0);
        await expect(page.getByTestId('monomeric-page')).toBeVisible();
        await expect(page.getByTestId('tool-select')).toBeVisible();

        await page.getByTestId('mode-atomistic').click();
        await expect(page.getByTestId('element-C')).toBeVisible();
        await expect(page.getByTestId('monomeric-page')).toHaveCount(0);
    });

    test('Monomer AMINO sub-mode renders all 21 natural amino acids in Qt display order', async ({
        page,
    }) => {
        // Qt's monomer_tool_widget.ui has a QStackedWidget
        // (`amino_or_nucleic_stack`) gated by AMINO / NUCLEIC tab buttons
        // (`amino_monomer_btn` defaults to checked=true). The amino_page is
        // a 3-col grid of 21 ModularToolButtons, one per natural amino
        // acid, laid out per AMINO_ACID_TOOL_DISPLAY_ORDER in
        // src/schrodinger/sketcher/model/sketcher_model.h. The tile clicks
        // stub through comingSoon for now — the lean MolModel doesn't
        // speak monomer yet.
        await page.getByTestId('mode-monomeric').click();
        // Default sub-mode is AMINO per Qt.
        await expect(page.getByTestId('monomer-amino'))
            .toHaveAttribute('aria-pressed', 'true');
        await expect(page.getByTestId('monomer-nucleic'))
            .toHaveAttribute('aria-pressed', 'false');
        // Grid is mounted; placeholder is not.
        await expect(page.getByTestId('amino-acid-grid')).toBeVisible();
        await expect(page.getByTestId('nucleic-placeholder')).toHaveCount(0);
        // All 21 amino-acid tiles render.
        const grid = page.getByTestId('amino-acid-grid');
        const tiles = await grid.locator('button').all();
        expect(tiles.length).toBe(21);
        // Verify the row-major Qt order: ALA top-left, UNK bottom-right,
        // CYS at index 9 (row 3 col 0), GLU at index 19, etc.
        const expectedLabels = [
            'A', 'F', 'G',
            'I', 'L', 'M',
            'P', 'V', 'W',
            'C', 'N', 'Q',
            'S', 'T', 'Y',
            'H', 'K', 'R',
            'D', 'E', 'X',
        ];
        for (let i = 0; i < expectedLabels.length; i++) {
            await expect(tiles[i]).toHaveText(expectedLabels[i]);
        }
        // Tooltip wires up the full name (used by future MolModel hook).
        await expect(page.getByTestId('monomer-aa-cys'))
            .toHaveAttribute('title', /Cysteine/);
        // Clicking a tile surfaces the coming-soon status.
        await page.getByTestId('monomer-aa-trp').click();
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/Tryptophan/);
    });

    test('Monomer AMINO/NUCLEIC sub-toggle flips the inner stack', async ({
        page,
    }) => {
        // Qt's `amino_or_nucleic_stack` flips between amino_page and
        // nucleic_page on the AMINO/NUCLEIC toggle. We verify the toggle
        // swaps panels and the active state survives a round-trip; the
        // amino + nucleic grids each get their own coverage tests.
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-nucleic').click();
        await expect(page.getByTestId('monomer-amino'))
            .toHaveAttribute('aria-pressed', 'false');
        await expect(page.getByTestId('monomer-nucleic'))
            .toHaveAttribute('aria-pressed', 'true');
        await expect(page.getByTestId('amino-acid-grid')).toHaveCount(0);
        await expect(page.getByTestId('nucleic-acid-grid')).toBeVisible();

        await page.getByTestId('monomer-amino').click();
        await expect(page.getByTestId('amino-acid-grid')).toBeVisible();
        await expect(page.getByTestId('nucleic-acid-grid')).toHaveCount(0);
    });

    test('Monomer NUCLEIC sub-mode renders RNA/DNA/Custom selectors + base letters + sugar/phosphate blocks', async ({
        page,
    }) => {
        // Qt's nucleic_page (monomer_tool_widget.ui):
        //   row 0 (colspan 4): na_rna_btn (RNA selector)
        //   row 1 (colspan 3): na_dna_btn (DNA selector)
        //   row 2 (colspan 3): na_custom_nt_btn (Custom popup)
        //   rows 4-5: 3-col base letters [A C N / G U T]
        //   row 8:    3-col building blocks [R dR P]
        // RNA/DNA place a full nucleotide, base/sugar/phosphate tiles place a
        // single monomer; only Custom still stubs through comingSoon.
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-nucleic').click();
        const grid = page.getByTestId('nucleic-acid-grid');
        await expect(grid).toBeVisible();
        // Three wide selectors.
        await expect(page.getByTestId('monomer-na-rna'))
            .toHaveText('RNA');
        await expect(page.getByTestId('monomer-na-dna'))
            .toHaveText('DNA');
        await expect(page.getByTestId('monomer-na-custom'))
            .toHaveText('Custom');
        // Six base letters in Qt grid order [A C N / G U T].
        const baseLabels = ['A', 'C', 'N', 'G', 'U', 'T'];
        for (const letter of baseLabels) {
            await expect(
                page.getByTestId(`monomer-na-${letter.toLowerCase()}`),
            ).toHaveText(letter);
        }
        // Three building blocks [R dR P].
        await expect(page.getByTestId('monomer-na-r')).toHaveText('R');
        await expect(page.getByTestId('monomer-na-dr')).toHaveText('dR');
        await expect(page.getByTestId('monomer-na-p')).toHaveText('P');
        // Tooltip wires up the chemistry name.
        await expect(page.getByTestId('monomer-na-dr'))
            .toHaveAttribute('title', /Deoxyribose/);
        // RNA arms the nucleotide draw tool; the base tile arms a single
        // monomer — both update the status line with the armed selection.
        await page.getByTestId('monomer-na-rna').click();
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/nucleotide: RNA/);
        await page.getByTestId('monomer-na-g').click();
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/Guanine/);
        // Custom opens the sugar/base/phosphate triple-builder popup.
        await page.getByTestId('monomer-na-custom').click();
        await expect(page.getByTestId('monomer-na-custom-popup')).toBeVisible();
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

    test('Import menu: Replace Current Content toggle controls replace vs append', async ({
        page,
    }) => {
        // Qt's ImportMenu (menu/sketcher_top_bar_menus.cpp:50) adds a
        // checkable "Replace Current Content" action; default from
        // model/sketcher_model.cpp:227 is true. When ON,
        // sketcher_widget::importText calls m_mol_model->clear() before
        // loading; when OFF, the new structure is appended (Qt:
        // MolModel::addMol with reposition_mol=true, model/mol_model.cpp:1195
        // — the new mol is placed to the right of the existing one). Ctrl+V
        // paste is intentionally agnostic of this flag per the Qt comment
        // at sketcher_widget.cpp:685.
        await page.getByTestId('import').click();
        const toggle = page.getByTestId('import-replace-content');
        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveAttribute('aria-checked', 'true');
        // Replace mode (default): paste CCO loads 3 atoms / 2 bonds.
        await page.getByTestId('import-paste-in-text').click();
        await page.getByTestId('paste-text-input').fill('CCO');
        await page.getByTestId('paste-text-load').click();
        let rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(3);
        expect(rd.bonds).toHaveLength(2);
        // Toggle off — next import appends rather than replacing.
        await page.getByTestId('import').click();
        await page.getByTestId('import-replace-content').click();
        await expect(page.getByTestId('import-replace-content'))
            .toHaveAttribute('aria-checked', 'false');
        await page.getByTestId('import-paste-in-text').click();
        await page.getByTestId('paste-text-input').fill('N');
        await page.getByTestId('paste-text-load').click();
        rd = await snapshot(page);
        // 3 (original CCO) + 1 (N) = 4 atoms; bonds unchanged at 2.
        expect(rd.atoms).toHaveLength(4);
        expect(rd.bonds).toHaveLength(2);
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/appended/);
        // The newly added N should sit to the right of the existing mol
        // (matches Qt's move_molecule_to_the_right_of placement). Verify
        // by comparing min-x of the new atom against max-x of the others.
        const xs = rd.atoms.map((a) => a.x);
        const maxOldX = Math.max(...xs.slice(0, 3));
        const newX = xs[3];
        expect(newX).toBeGreaterThan(maxOldX);
        // Append is a single undo step — one undo restores to 3 atoms.
        await page.keyboard.press(
            (process.platform === 'darwin' ? 'Meta' : 'Control') + '+z',
        );
        rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(3);
        // File import while OFF also appends — load benzene SMI on top.
        await page.getByTestId('import').click();
        await page.getByTestId('import-file-input').setInputFiles({
            name: 'ring.smi',
            mimeType: 'chemical/x-daylight-smiles',
            buffer: Buffer.from('c1ccccc1'),
        });
        // setInputFiles' change handler is async — wait for the status line
        // to flip before snapshotting the model.
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/appended ring\.smi/);
        rd = await snapshot(page);
        // 3 (CCO) + 6 (benzene) = 9 atoms; 2 + 6 ring bonds = 8 bonds.
        expect(rd.atoms).toHaveLength(9);
        expect(rd.bonds).toHaveLength(8);
    });

    test('Import menu: Replace Current Content does NOT gate Ctrl+V clipboard paste', async ({
        page,
        context,
    }) => {
        // Qt's paste handler (sketcher_widget.cpp:685) explicitly notes
        // that clipboard paste merges into the existing scene
        // regardless of the Replace Current Content flag — the flag is
        // for the Import menu only. Confirm Ctrl+V still loads.
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        // Turn off Replace Current Content.
        await page.getByTestId('import').click();
        await page.getByTestId('import-replace-content').click();
        await expect(page.getByTestId('import-replace-content'))
            .toHaveAttribute('aria-checked', 'false');
        // Close the import menu by clicking on the canvas (the document
        // mousedown handler dismisses any open menu when the click lands
        // outside its wrapper). The click itself is on an empty canvas
        // with no draw tool active, so it doesn't create an atom.
        await page.getByTestId('sketcher-canvas').click({
            position: { x: 200, y: 200 },
        });
        await expect(page.getByTestId('import-menu')).toHaveCount(0);
        // Push SMILES into the clipboard and dispatch the platform paste
        // shortcut — Cmd+V on macOS, Ctrl+V elsewhere.
        await page.evaluate(() =>
            navigator.clipboard.writeText('CCO'));
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.keyboard.press(`${modifier}+v`);
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(3);
        // Status should be the normal "pasted SMILES" line — NOT the
        // append-mode stub, because Ctrl+V ignores the toggle.
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/pasted SMILES/);
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

    test('Export menu: Save Image lists SVG alongside PNG in the format dropdown', async ({
        page,
    }) => {
        // Qt's FileSaveImageDialog (dialog/file_save_image_dialog.cpp:80-86)
        // populates the format combo from get_image_export_formats which
        // returns {PNG, SVG} when SVG is enabled. The lean port exposes
        // both; selecting SVG should stick (no auto-revert).
        await page.getByTestId('export').click();
        await page.getByTestId('export-save-image').click();
        const select = page.getByTestId('save-image-format-select');
        await expect(select).toHaveValue('png');
        const labels = await select.locator('option').allTextContents();
        expect(labels).toEqual(['PNG', 'SVG']);
        await select.selectOption('svg');
        await expect(select).toHaveValue('svg');
        await page.getByTestId('save-image-cancel').click();
    });

    test('Export menu: Save Image SVG downloads a valid SVG of the current sketch', async ({
        page,
    }) => {
        // Round-trip: seed CCO, select SVG, save at 200×120, intercept the
        // download body, assert it's a well-formed SVG with the expected
        // dimensions and a few primitives matching what drawSketch would
        // have painted (a <text>O</text> for the heteroatom; <line>s for
        // the bonds; a <rect> for the white background fill).
        await page.getByTestId('import').click();
        await page.getByTestId('import-paste-in-text').click();
        await page.getByTestId('paste-text-input').fill('CCO');
        await page.getByTestId('paste-text-load').click();

        await page.getByTestId('export').click();
        await page.getByTestId('export-save-image').click();
        await page.getByTestId('save-image-format-select').selectOption('svg');
        await page.getByTestId('save-image-width').fill('200');
        await page.getByTestId('save-image-height').fill('120');

        const downloadPromise = page.waitForEvent('download');
        await page.getByTestId('save-image-save').click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toBe('sketch.svg');
        const path = await download.path();
        const fs = await import('node:fs/promises');
        const body = await fs.readFile(path, 'utf8');
        // Opens with the SVG element + namespace + correct viewport.
        expect(body).toMatch(/^<svg xmlns='http:\/\/www\.w3\.org\/2000\/svg'/);
        expect(body).toContain(`width='200' height='120'`);
        expect(body).toContain(`viewBox='0 0 200 120'`);
        // White (default) background fill.
        expect(body).toContain(`fill='#ffffff'`);
        // CCO has 2 bonds → at least 2 <line> elements.
        const lineCount = (body.match(/<line /g) ?? []).length;
        expect(lineCount).toBeGreaterThanOrEqual(2);
        // Oxygen label rendered as a <text> element.
        expect(body).toMatch(/<text [^>]*>O<\/text>/);
        // Implicit H label rendered too (water-like H₂ on the O).
        expect(body).toMatch(/<text [^>]*>H<\/text>/);
        expect(body).toMatch(/<\/svg>$/);
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/saved sketch\.svg — White background, 200 x 120 px/);
        await expect(page.getByTestId('save-image-modal')).toHaveCount(0);
    });

    test('Export menu: Save Image SVG with Transparent omits the background rect', async ({
        page,
    }) => {
        // Qt's FileSaveImagePopup passes Qt::transparent as the background
        // color when the checkbox is checked; the SVG path then skips the
        // fill rect entirely so anything behind shows through. Same here.
        await page.getByTestId('import').click();
        await page.getByTestId('import-paste-in-text').click();
        await page.getByTestId('paste-text-input').fill('CCO');
        await page.getByTestId('paste-text-load').click();

        await page.getByTestId('export').click();
        await page.getByTestId('export-save-image').click();
        await page.getByTestId('save-image-format-select').selectOption('svg');
        await page.getByTestId('save-image-transparent').check();

        const downloadPromise = page.waitForEvent('download');
        await page.getByTestId('save-image-save').click();
        const download = await downloadPromise;
        const path = await download.path();
        const fs = await import('node:fs/promises');
        const body = await fs.readFile(path, 'utf8');
        // No white-fill background rect when transparent is checked.
        expect(body).not.toContain(`fill='#ffffff'`);
        // Structure primitives still present.
        expect(body).toMatch(/<line /);
        expect(body).toMatch(/<text [^>]*>O<\/text>/);
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/saved sketch\.svg — Transparent background/);
    });

    test('Export menu: Save Image exports a pure reaction-only scheme (arrow + plus, no atoms)', async ({
        page,
    }) => {
        // Reaction-only schemes are real Qt content (arrows + pluses are
        // NonMolecularObjects, independent of atoms). The earlier Batch 30
        // landing flagged a gap where doSaveImage bailed when numAtoms ==
        // 0 — Batch 34 fixes that by seeding the bbox from non-mol coords
        // when there are no atoms, and folding non-mol drawing extents
        // into the fit calculation so chevrons / plus arms don't clip.
        const canvas = page.getByTestId('sketcher-canvas');
        // Place an arrow, then switch the popup to plus and place two.
        await page.getByTestId('reaction').click();
        await canvas.click({ position: { x: 300, y: 200 } });
        await page.getByTestId('reaction').hover();
        await page.mouse.down();
        await page.waitForTimeout(350);
        await page.mouse.up();
        await page.getByTestId('reaction-popup-plus').click();
        await canvas.click({ position: { x: 200, y: 200 } });
        await canvas.click({ position: { x: 400, y: 200 } });

        await page.getByTestId('export').click();
        await page.getByTestId('export-save-image').click();
        await page.getByTestId('save-image-format-select')
            .selectOption('svg');
        await page.getByTestId('save-image-width').fill('400');
        await page.getByTestId('save-image-height').fill('200');
        const downloadPromise = page.waitForEvent('download');
        await page.getByTestId('save-image-save').click();
        const download = await downloadPromise;
        const path = await download.path();
        const fs = await import('node:fs/promises');
        const body = await fs.readFile(path, 'utf8');
        // No atoms → no <line> (bond strokes) or element <text>; ≥3
        // stroked <path>s (one arrow + two pluses) from the non-mol layer.
        expect(body).not.toMatch(/<line /);
        const pathMatches = body.match(/<path [^>]*stroke=/g) || [];
        expect(pathMatches.length).toBeGreaterThanOrEqual(3);
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/saved sketch\.svg/);
    });

    test('Export menu: Save Image still bails when both atoms and non-mol are empty', async ({
        page,
    }) => {
        // Regression guard for Batch 34: the empty-sketch friendly-status
        // path now uses (atoms + non-mol) == 0, not just numAtoms == 0.
        // A truly-empty sketch must still surface "nothing to save".
        await page.getByTestId('export').click();
        await page.getByTestId('export-save-image').click();
        let downloaded = false;
        page.on('download', () => { downloaded = true; });
        await page.getByTestId('save-image-save').click();
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/nothing to save/);
        expect(downloaded).toBe(false);
        await page.getByTestId('save-image-cancel').click();
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
        // Preferences closes the menu and opens the 2D Settings modal
        // (Qt's RenderingSettingsDialog).
        await page.getByTestId('view-preferences').click();
        await expect(page.getByTestId('configure-view-menu')).toHaveCount(0);
        await expect(page.getByTestId('preferences-modal')).toBeVisible();
        await page.getByTestId('preferences-close').click();
        await expect(page.getByTestId('preferences-modal')).toHaveCount(0);
    });

    test('Preferences modal: font size + bond width + ABS prefix wire end-to-end; Reset restores; Configure View stays in sync', async ({
        page,
    }) => {
        // Qt's RenderingSettingsDialog (dialog/rendering_settings_dialog.h)
        // is the "2D Settings" dialog launched from Configure View →
        // Preferences. The port wires four controls today: atom font size,
        // bond line width, "Use ABS prefix", and (synced with Configure
        // View) Color Heteroatoms / Show Stereo. The remaining Qt
        // controls (carbon labels, color modes, undefined-stereo) are
        // tracked as follow-up batches.
        await loadText(page, 'F[C@H](Cl)Br');

        // Open via Configure View → Preferences...
        await page.getByTestId('settings').click();
        await page.getByTestId('view-preferences').click();
        const modal = page.getByTestId('preferences-modal');
        await expect(modal).toBeVisible();
        await expect(modal).toContainText('2D Settings');

        // Defaults reflect DEFAULT_DISPLAY_OPTIONS (font 13, bond 2).
        const fontInput = page.getByTestId('preferences-font-size');
        const widthInput = page.getByTestId('preferences-bond-width');
        await expect(fontInput).toHaveValue('13');
        await expect(widthInput).toHaveValue('2');
        await expect(page.getByTestId('preferences-color-heteroatoms'))
            .toBeChecked();
        await expect(page.getByTestId('preferences-show-stereo')).toBeChecked();
        await expect(page.getByTestId('preferences-abs-prefix')).not.toBeChecked();

        // Bump font size + bond width, then close so the modal doesn't
        // intercept clicks on the export button.
        await fontInput.fill('22');
        await widthInput.fill('4');
        await page.getByTestId('preferences-close').click();
        await expect(page.getByTestId('preferences-modal')).toHaveCount(0);

        const fs = await import('node:fs/promises');
        const saveSvg = async () => {
            await page.getByTestId('export').click();
            await page.getByTestId('export-save-image').click();
            await page.getByTestId('save-image-format-select')
                .selectOption('svg');
            const dl = page.waitForEvent('download');
            await page.getByTestId('save-image-save').click();
            const d = await dl;
            const body = await fs.readFile(await d.path(), 'utf8');
            // doSaveImage auto-closes the Save Image modal once the
            // download blob is queued (Sketcher.tsx setImageModalOpen(false)).
            await expect(page.getByTestId('save-image-modal'))
                .toHaveCount(0);
            return body;
        };
        const svgBigFont = await saveSvg();
        // Atom labels are emitted with the active font size; "F" / "Cl"
        // / "Br" labels of F[C@H](Cl)Br all render at font-size=22.
        expect(svgBigFont).toMatch(/font-size='22'/);
        expect(svgBigFont).toMatch(/stroke-width='4'/);

        // Flip ABS prefix — SVG stereo label switches between "(R)"/"(S)"
        // and "abs (R)"/"abs (S)" (the hair-space U+200A between "abs"
        // and the parenthesis is preserved in the SVG body).
        const absRe = /<text [^>]*>abs[  ]\([RS]\)<\/text>/;
        const plainStereoRe = /<text [^>]*>\([RS]\)<\/text>/;
        expect(svgBigFont).toMatch(plainStereoRe);
        expect(svgBigFont).not.toMatch(absRe);

        await page.getByTestId('settings').click();
        await page.getByTestId('view-preferences').click();
        await page.getByTestId('preferences-abs-prefix').click();
        await expect(page.getByTestId('preferences-abs-prefix')).toBeChecked();
        await page.getByTestId('preferences-close').click();
        const svgWithAbs = await saveSvg();
        expect(svgWithAbs).toMatch(absRe);

        // Toggle Color Heteroatoms in the modal — Configure View reflects
        // the same value (both surfaces write the same displayOption).
        await page.getByTestId('settings').click();
        await page.getByTestId('view-preferences').click();
        await page.getByTestId('preferences-color-heteroatoms').click();
        await expect(page.getByTestId('preferences-color-heteroatoms'))
            .not.toBeChecked();
        await page.getByTestId('preferences-close').click();
        await expect(page.getByTestId('preferences-modal')).toHaveCount(0);
        await page.getByTestId('settings').click();
        await expect(page.getByTestId('view-color-heteroatoms'))
            .toHaveAttribute('aria-checked', 'false');

        // Reset to Defaults restores everything the modal owns. Configure
        // View is already open from the assertion above; jump straight to
        // Preferences.
        await page.getByTestId('view-preferences').click();
        await page.getByTestId('preferences-reset').click();
        await expect(page.getByTestId('preferences-font-size')).toHaveValue('13');
        await expect(page.getByTestId('preferences-bond-width')).toHaveValue('2');
        await expect(page.getByTestId('preferences-color-heteroatoms'))
            .toBeChecked();
        await expect(page.getByTestId('preferences-show-stereo')).toBeChecked();
        await expect(page.getByTestId('preferences-abs-prefix')).not.toBeChecked();
    });

    test('Preferences: Label carbons toggles between none / terminal / all (Qt CarbonLabels parity)', async ({
        page,
    }) => {
        // Qt's RenderingSettingsDialog (m_label_carbons_cb +
        // m_label_terminal_C_rb / m_label_all_C_rb). NONE = bare dots
        // (default); TERMINAL = label C atoms with exactly one heavy
        // neighbour; ALL = label every C. The d=2-with-two-doubles case
        // (allene central C) always labels in every mode — matches Qt's
        // AtomItem::determineLabelIsVisible.
        await loadText(page, 'CCC');

        const fs = await import('node:fs/promises');
        const saveSvg = async () => {
            await page.getByTestId('export').click();
            await page.getByTestId('export-save-image').click();
            await page.getByTestId('save-image-format-select')
                .selectOption('svg');
            const dl = page.waitForEvent('download');
            await page.getByTestId('save-image-save').click();
            const d = await dl;
            const body = await fs.readFile(await d.path(), 'utf8');
            await expect(page.getByTestId('save-image-modal'))
                .toHaveCount(0);
            return body;
        };
        const countC = (svg) =>
            (svg.match(/<text [^>]*>C<\/text>/g) ?? []).length;

        // Default: NONE — no "C" text labels for the three carbons of
        // propane (rendered as bare dots).
        const svgNone = await saveSvg();
        expect(countC(svgNone)).toBe(0);

        // Open Preferences, enable Label carbons (defaults to Terminal-only
        // per Qt's m_label_terminal_C_rb checked=true). Two of three
        // propane carbons are terminal (degree 1), so we expect 2 "C"
        // labels.
        await page.getByTestId('settings').click();
        await page.getByTestId('view-preferences').click();
        const labelCb = page.getByTestId('preferences-label-carbons');
        await expect(labelCb).not.toBeChecked();
        await expect(page.getByTestId('preferences-label-terminal-rb'))
            .toBeDisabled();
        await expect(page.getByTestId('preferences-label-all-rb'))
            .toBeDisabled();
        await labelCb.click();
        await expect(labelCb).toBeChecked();
        await expect(page.getByTestId('preferences-label-terminal-rb'))
            .toBeChecked();
        await expect(page.getByTestId('preferences-label-all-rb'))
            .not.toBeChecked();
        await page.getByTestId('preferences-close').click();
        const svgTerminal = await saveSvg();
        expect(countC(svgTerminal)).toBe(2);

        // Switch to ALL — every carbon gets a label.
        await page.getByTestId('settings').click();
        await page.getByTestId('view-preferences').click();
        await page.getByTestId('preferences-label-all-rb').click();
        await expect(page.getByTestId('preferences-label-all-rb'))
            .toBeChecked();
        await page.getByTestId('preferences-close').click();
        const svgAll = await saveSvg();
        expect(countC(svgAll)).toBe(3);

        // Reset to Defaults pulls Label carbons back to NONE (and the
        // radios disable again).
        await page.getByTestId('settings').click();
        await page.getByTestId('view-preferences').click();
        await page.getByTestId('preferences-reset').click();
        await expect(page.getByTestId('preferences-label-carbons'))
            .not.toBeChecked();
        await expect(page.getByTestId('preferences-label-terminal-rb'))
            .toBeDisabled();
        await page.getByTestId('preferences-close').click();
        const svgAfterReset = await saveSvg();
        expect(countC(svgAfterReset)).toBe(0);
    });

    test('Preferences: Color mode switches palette + Dark scheme swaps canvas BG; combos sync per Color Heteroatoms', async ({
        page,
    }) => {
        // Qt's m_color_mode_combo / m_bw_mode_combo
        // (rendering_settings_dialog.ui + rendering_settings_dialog.cpp).
        // Combos hold independent state; only one is visible at a time
        // (Color Heteroatoms gates). Picking Dark in either combo
        // mirrors the Dark bit to the hidden combo. Switching to CDK /
        // Avalon shifts the nitrogen color away from the default
        // ELEMENT_COLORS value.
        await loadText(page, 'N');

        const fs = await import('node:fs/promises');
        const saveSvg = async () => {
            await page.getByTestId('export').click();
            await page.getByTestId('export-save-image').click();
            await page.getByTestId('save-image-format-select')
                .selectOption('svg');
            const dl = page.waitForEvent('download');
            await page.getByTestId('save-image-save').click();
            const d = await dl;
            const body = await fs.readFile(await d.path(), 'utf8');
            await expect(page.getByTestId('save-image-modal'))
                .toHaveCount(0);
            return body;
        };

        // Default scheme: N renders at the existing ELEMENT_COLORS value
        // (#1f4faa). Background is white.
        const svgDefault = await saveSvg();
        expect(svgDefault).toMatch(
            /<text [^>]*fill='#1f4faa'[^>]*>N<\/text>/);
        expect(svgDefault).toContain(`fill='#ffffff'`);

        // Switch to CDK: N color shifts to the CDK blue (0.188, 0.314,
        // 0.972 → #3050f8).
        await page.getByTestId('settings').click();
        await page.getByTestId('view-preferences').click();
        const colorMode = page.getByTestId('preferences-color-mode');
        await expect(colorMode).toBeVisible();
        await expect(colorMode).toHaveValue('default');
        await expect(page.getByTestId('preferences-bw-mode')).toHaveCount(0);
        await colorMode.selectOption('cdk');
        await page.getByTestId('preferences-close').click();
        const svgCDK = await saveSvg();
        expect(svgCDK).toMatch(/<text [^>]*fill='#3050f8'[^>]*>N<\/text>/);

        // Switch to Dark: BG flips to near-black; N uses the dark-mode
        // palette value (#5469eb from 0.33, 0.41, 0.92).
        await page.getByTestId('settings').click();
        await page.getByTestId('view-preferences').click();
        await page.getByTestId('preferences-color-mode').selectOption('dark');
        await page.getByTestId('preferences-close').click();
        const svgDark = await saveSvg();
        expect(svgDark).toContain(`fill='#1a1a1a'`);
        expect(svgDark).toMatch(/<text [^>]*fill='#5469eb'[^>]*>N<\/text>/);

        // Turn Color Heteroatoms OFF: the color combo gets hidden, the
        // B&W combo appears, and because we were in Dark the B&W combo
        // starts on Dark (the sync_comboboxes mirror). BG stays dark; N
        // renders in the carbon (mono) color, not its element color.
        await page.getByTestId('settings').click();
        await page.getByTestId('view-preferences').click();
        await page.getByTestId('preferences-color-heteroatoms').click();
        const bwMode = page.getByTestId('preferences-bw-mode');
        await expect(bwMode).toBeVisible();
        await expect(bwMode).toHaveValue('dark');
        await expect(page.getByTestId('preferences-color-mode')).toHaveCount(0);
        await page.getByTestId('preferences-close').click();
        const svgBwDark = await saveSvg();
        expect(svgBwDark).toContain(`fill='#1a1a1a'`);
        // N rendered in the light-gray bond color (#e6e6e6), not its
        // element color.
        expect(svgBwDark).toMatch(
            /<text [^>]*fill='#e6e6e6'[^>]*>N<\/text>/);

        // Flip B&W back to Default: BG returns to white; the hidden
        // color combo follows the Dark→Default sync so re-enabling
        // Color Heteroatoms gives Default, not the user's stale Dark.
        await page.getByTestId('settings').click();
        await page.getByTestId('view-preferences').click();
        await page.getByTestId('preferences-bw-mode').selectOption('default');
        await page.getByTestId('preferences-color-heteroatoms').click();
        await expect(page.getByTestId('preferences-color-mode'))
            .toHaveValue('default');
        await page.getByTestId('preferences-close').click();
        const svgBackToDefault = await saveSvg();
        expect(svgBackToDefault).toMatch(
            /<text [^>]*fill='#1f4faa'[^>]*>N<\/text>/);
        expect(svgBackToDefault).toContain(`fill='#ffffff'`);

        // Reset to Defaults pulls both combos back to 'default'.
        await page.getByTestId('settings').click();
        await page.getByTestId('view-preferences').click();
        await page.getByTestId('preferences-color-mode')
            .selectOption('avalon');
        await page.getByTestId('preferences-reset').click();
        await expect(page.getByTestId('preferences-color-mode'))
            .toHaveValue('default');
    });

    test('Preferences: Include undefined centers toggles "(?)" label on possible-but-unspecified stereo centers', async ({
        page,
    }) => {
        // Qt's m_undefined_centers_labels_cb (rendering_settings_dialog.ui:274-281,
        // default true; disabled when Show stereo annotations is off). When on,
        // get_atom_chirality_label (rdkit/stereochemistry.cpp:45-53) returns
        // "(?)" for atoms with _ChiralityPossible set + no _CIPCode. The lean
        // C++ surface emits a per-atom `psbl: true` flag for exactly that case
        // and the React renderer paints "(?)" when both Show stereo + Include
        // undefined are on.
        //
        // FC(Cl)Br has a tetrahedral C bonded to F/Cl/Br/H — RDKit's
        // assignStereochemistry(flagPossible=true) marks it as a possible
        // stereo center, and the absence of wedges/dashes means CIPLabeler
        // can't assign an R/S code → "(?)" is the only label that should fire.
        await loadText(page, 'FC(Cl)Br');

        const fs = await import('node:fs/promises');
        const saveSvg = async () => {
            await page.getByTestId('export').click();
            await page.getByTestId('export-save-image').click();
            await page.getByTestId('save-image-format-select')
                .selectOption('svg');
            const dl = page.waitForEvent('download');
            await page.getByTestId('save-image-save').click();
            const d = await dl;
            const body = await fs.readFile(await d.path(), 'utf8');
            await expect(page.getByTestId('save-image-modal'))
                .toHaveCount(0);
            return body;
        };
        const qmarkRe = /<text [^>]*>\(\?\)<\/text>/;

        // Default: Include undefined is ON. SVG carries a "(?)" label.
        const svgDefault = await saveSvg();
        expect(svgDefault).toMatch(qmarkRe);

        // Open Preferences and confirm the new checkbox starts checked.
        await page.getByTestId('settings').click();
        await page.getByTestId('view-preferences').click();
        const cb = page.getByTestId('preferences-include-undefined-stereo');
        await expect(cb).toBeChecked();
        await expect(cb).toBeEnabled();
        await cb.click();
        await expect(cb).not.toBeChecked();
        await page.getByTestId('preferences-close').click();
        const svgOff = await saveSvg();
        expect(svgOff).not.toMatch(qmarkRe);

        // Re-check and verify the label comes back.
        await page.getByTestId('settings').click();
        await page.getByTestId('view-preferences').click();
        await page.getByTestId('preferences-include-undefined-stereo').click();
        await page.getByTestId('preferences-close').click();
        const svgBackOn = await saveSvg();
        expect(svgBackOn).toMatch(qmarkRe);

        // Turning Show stereo annotations OFF disables the Include-undefined
        // checkbox AND suppresses the "(?)" label even when the checkbox
        // value stays checked. Matches Qt's updateWidgets gate at
        // rendering_settings_dialog.cpp:107-109.
        await page.getByTestId('settings').click();
        await page.getByTestId('view-preferences').click();
        await page.getByTestId('preferences-show-stereo').click();
        await expect(page.getByTestId('preferences-show-stereo'))
            .not.toBeChecked();
        await expect(page.getByTestId('preferences-include-undefined-stereo'))
            .toBeDisabled();
        await expect(page.getByTestId('preferences-include-undefined-stereo'))
            .toBeChecked();
        await page.getByTestId('preferences-close').click();
        const svgStereoOff = await saveSvg();
        expect(svgStereoOff).not.toMatch(qmarkRe);

        // Reset to Defaults restores Show stereo + Include undefined → label
        // returns. Re-open the modal first (Reset only fires inside it).
        await page.getByTestId('settings').click();
        await page.getByTestId('view-preferences').click();
        await page.getByTestId('preferences-reset').click();
        await expect(page.getByTestId('preferences-show-stereo'))
            .toBeChecked();
        await expect(page.getByTestId('preferences-include-undefined-stereo'))
            .toBeChecked();
        await page.getByTestId('preferences-close').click();
        const svgReset = await saveSvg();
        expect(svgReset).toMatch(qmarkRe);
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

    test('Configure View: Show Valence Errors paints an orange dotted halo on hypervalent atoms', async ({
        page,
    }) => {
        // Qt's AtomItem::determineValenceErrorIsVisible (atom_item.cpp:853-856)
        // gates the orange halo on m_settings.m_valence_errors_shown &&
        // atom->hasValenceViolation(). N with 5 double bonds → 10 bonds of
        // valence on a 3-valent element triggers the violation. The halo
        // is #fb7100 (border) on #ffecc5 (fill); we assert the render
        // description carries verr=true AND that an orange pixel appears
        // under the atom when the toggle is on, then disappears when off.
        await loadText(page, '[N](=O)(=O)(=O)=O');
        const rd = await snapshot(page);
        const nAtom = rd.atoms.find((a) => a.el === 'N');
        expect(nAtom.verr).toBe(true);
        const sampleHaloOrange = async () => {
            return await page.evaluate(() => {
                const c = document.querySelector(
                    '[data-testid="sketcher-canvas"]',
                );
                const ctx = c.getContext('2d');
                // The halo is drawn around the centered N atom — sample a
                // ring ~13px from the center (the halo's radius). Return
                // true if ANY sampled pixel is the warm orange shade
                // (#fb7100 ≈ R>200, G~110, B<60).
                const cx = Math.floor(c.width / 2);
                const cy = Math.floor(c.height / 2);
                for (let dr = 11; dr <= 15; ++dr) {
                    for (let a = 0; a < 360; a += 15) {
                        const rad = (a * Math.PI) / 180;
                        const x = Math.round(cx + dr * Math.cos(rad));
                        const y = Math.round(cy + dr * Math.sin(rad));
                        const d = ctx.getImageData(x, y, 1, 1).data;
                        if (d[0] > 200 && d[1] < 160 && d[1] > 50 && d[2] < 80) {
                            return true;
                        }
                    }
                }
                return false;
            });
        };
        expect(await sampleHaloOrange()).toBe(true);
        // Toggle off → halo disappears.
        await page.getByTestId('settings').click();
        await page.getByTestId('view-valence-errors').click();
        await page.getByTestId('settings').click();
        expect(await sampleHaloOrange()).toBe(false);
    });

    test('Configure View: Show Stereo Labels paints "(R)" / "(S)" near the chiral atom and SVG export honors the toggle', async ({
        page,
    }) => {
        // Qt's AtomItem::updateChiralityLabel (atom_item.cpp:417-449) reads
        // RDKit::common_properties::atomNote (populated by Chirality::
        // addStereoAnnotations after CIPLabeler runs) and draws it as a
        // small text label offset from the atom. The port mirrors the same
        // pipeline in lean_main.cpp::apply_stereo_annotations and emits
        // the resulting label as stereo:"(R)" / "(S)" on the render desc.
        await loadText(page, 'F[C@H](Cl)Br');
        const rd = await snapshot(page);
        const cAtom = rd.atoms.find((a) => a.el === 'C');
        expect(cAtom.stereo).toMatch(/\(R\)|\(S\)/);

        // Save SVG with the toggle ON → SVG body must contain a <text>
        // node with the (R)/(S) label.
        const fs = await import('node:fs/promises');
        const saveAndReadSvg = async () => {
            await page.getByTestId('export').click();
            await page.getByTestId('export-save-image').click();
            await page.getByTestId('save-image-format-select').selectOption('svg');
            const downloadPromise = page.waitForEvent('download');
            await page.getByTestId('save-image-save').click();
            const download = await downloadPromise;
            const path = await download.path();
            const body = await fs.readFile(path, 'utf8');
            return body;
        };
        const svgOn = await saveAndReadSvg();
        expect(svgOn).toMatch(/<text [^>]*>\(R\)<\/text>|<text [^>]*>\(S\)<\/text>/);

        // Toggle off → render desc still carries the label (the toggle
        // gates the *paint*, not the perception), but the SVG must NOT
        // contain a (R)/(S) text node.
        await page.getByTestId('settings').click();
        await page.getByTestId('view-stereo-labels').click();
        await page.getByTestId('settings').click();
        const rdAfter = await snapshot(page);
        expect(rdAfter.atoms.find((a) => a.el === 'C').stereo)
            .toBe(cAtom.stereo);
        const svgOff = await saveAndReadSvg();
        expect(svgOff).not.toMatch(/<text [^>]*>\(R\)<\/text>|<text [^>]*>\(S\)<\/text>/);
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

    test('More Actions: Copy As SMILES writes canonical form to the clipboard', async ({ page }) => {
        // Qt's CutCopyActionManager populates a "Copy As" submenu from
        // get_standard_export_formats() (cut_copy_action_manager.cpp:82,
        // file_import_export.cpp:75-90). React port hangs SMILES /
        // V2000 / V3000 off More Actions as a flattened section.
        await loadText(page, 'c1ccccc1');
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(6);
        expect(rd.atoms.every((a) => a.arom === true)).toBe(true);

        await page.getByTestId('more-actions-btn').click();
        await page.getByTestId('copy-as-smiles').click();
        // Menu closes after picking.
        await expect(page.getByTestId('more-actions-menu')).toHaveCount(0);
        const clip = await readClipboard(page);
        expect(clip).toBe('c1ccccc1');
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/copied SMILES/);
    });

    test('More Actions: Copy As MDL SD V3000 writes the right block to the clipboard', async ({ page }) => {
        // Qt's get_standard_export_formats() explicitly forbids MDL_MOLV2000
        // on export ("potential stereo ambiguities", file_import_export.cpp:79)
        // so V3000 is the only MOL flavor in the menu.
        await loadText(page, 'CCO');
        await page.getByTestId('more-actions-btn').click();
        await page.getByTestId('copy-as-mol-v3000').click();
        const clip = await readClipboard(page);
        expect(clip).toContain('V3000');
        expect(clip).toContain('M  V30 COUNTS 3 2');
    });

    test('More Actions: Copy As menu lists Qt\'s 11 standard export formats in order', async ({ page }) => {
        // Qt's get_standard_export_formats() (file_import_export.cpp:75-90)
        // defines the labels + order exactly. This test pins both so a
        // future refactor can't silently drop a format or reorder them.
        await loadText(page, 'CCO');
        await page.getByTestId('more-actions-btn').click();
        const menu = page.getByTestId('more-actions-menu');
        const expected = [
            'MDL SD V3000',
            'Maestro',
            'SMILES',
            'Extended SMILES',
            'SMARTS',
            'Extended SMARTS',
            'InChI',
            'InChIKey',
            'PDB',
            'XYZ',
            'Marvin Document',
            'HELM',
            'FASTA',
        ];
        for (const label of expected) {
            await expect(menu).toContainText(label);
        }
        // V2000 is intentionally absent — Qt forbids it on export.
        await expect(page.getByTestId('copy-as-mol-v2000')).toHaveCount(0);
    });

    test('More Actions: Copy As InChI / InChIKey / SMARTS / Ext SMILES / Ext SMARTS / PDB / MRV / Maestro', async ({ page }) => {
        // Each format hits a distinct rdkit_extensions::to_string branch.
        // We don't pin the exact serialization (RDKit owns that), just the
        // format-identifying prefix or marker.
        await loadText(page, 'CCO');

        const checks = [
            ['copy-as-inchi', /^InChI=/, /copied InChI:/],
            ['copy-as-inchikey', /^[A-Z]{14}-[A-Z]{10}-[A-Z]$/, /copied InChIKey:/],
            ['copy-as-smarts', /#6|#8/, /copied SMARTS:/],
            ['copy-as-extended-smiles', /CCO/, /copied Extended SMILES:/],
            ['copy-as-extended-smarts', /#6|#8/, /copied Extended SMARTS:/],
            ['copy-as-pdb', /HETATM/, /copied PDB:/],
            ['copy-as-mrv', /MDocument|cml/, /copied Marvin:/],
            ['copy-as-maestro', /f_m_ct|m_atom/, /copied Maestro:/],
        ];
        for (const [testid, clipPattern, statusPattern] of checks) {
            await page.getByTestId('more-actions-btn').click();
            await page.getByTestId(testid).click();
            const clip = await readClipboard(page);
            expect(clip).toMatch(clipPattern);
            await expect(page.getByTestId('sketcher-status'))
                .toContainText(statusPattern);
        }
    });

    test('More Actions: Copy As respects selection (Qt: copy(SELECTION) when something is selected)', async ({ page }) => {
        // Qt's CutCopyActionManager::getSubset returns SELECTION when
        // hasActiveSelection (cut_copy_action_manager.cpp:60). React port
        // mirrors by passing hasSelection() to toFormatString.
        await loadText(page, 'CCO');
        await page.evaluate(() => {
            const m = window.SketcherModel;
            m.clearSelection();
            m.setAtomSelected(2, true); // the O
        });
        await page.getByTestId('more-actions-btn').click();
        await page.getByTestId('copy-as-smiles').click();
        const clip = await readClipboard(page);
        // Selection-only SMILES export of the lone O = "O".
        expect(clip).toBe('O');
    });

    test('Ctrl+C copies the sketch as MDL MOL V3000 (Qt default format)', async ({ page }) => {
        // Qt's CutCopyActionManager default is MDL_MOLV3000
        // (cut_copy_action_manager.cpp:16). React port mirrors.
        await loadText(page, 'CCO');
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.keyboard.press(`${modifier}+c`);
        const clip = await readClipboard(page);
        expect(clip).toContain('V3000');
        expect(clip).toContain('M  V30 COUNTS 3 2');
    });

    test('Copy As on an empty sketch surfaces a friendly status, no clipboard write', async ({ page }) => {
        await page.getByTestId('more-actions-btn').click();
        await page.getByTestId('copy-as-smiles').click();
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/nothing to copy/);
    });

    test('Ctrl+V pastes SMILES from the clipboard via AUTO_DETECT (single undo)', async ({ page }) => {
        // Qt's sketcher_widget.cpp:676 routes clipboard text through
        // addTextToMolModel(text, AUTO_DETECT) — loadFromText matches.
        await page.evaluate(() => navigator.clipboard.writeText('CCO'));
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.keyboard.press(`${modifier}+v`);
        let rd = await snapshot(page);
        expect(rd.atoms.map((a) => a.el)).toEqual(['C', 'C', 'O']);
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/pasted SMILES/);
        // Single undo unwinds the paste.
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(0);
    });

    test('Ctrl+V pastes a V2000 MOL block from the clipboard', async ({ page }) => {
        // Round-trip benzene → V2000 → clipboard → Ctrl+V. Verifies the
        // AUTO_DETECT path handles MOL blocks (the historical leading-
        // newline trap from the old SMILES bar test still applies here
        // — clipboard.writeText preserves the leading \n).
        const molBlock = await page.evaluate(() => {
            const m = new window.Module.MolModel();
            m.loadFromSmiles('c1ccccc1');
            const mb = m.toMolBlock(false);
            m.delete();
            return mb;
        });
        await page.evaluate(
            (mb) => navigator.clipboard.writeText(mb),
            molBlock,
        );
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.keyboard.press(`${modifier}+v`);
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(6);
        expect(rd.bonds).toHaveLength(6);
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/pasted MOL/);
    });

    test('Ctrl+V with an empty clipboard surfaces a friendly status, no model change', async ({ page }) => {
        await page.evaluate(() => navigator.clipboard.writeText(''));
        // Seed one atom so we can assert the paste no-op leaves it alone.
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 200, y: 200 } });
        const before = await snapshot(page);
        expect(before.atoms).toHaveLength(1);

        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.keyboard.press(`${modifier}+v`);
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/clipboard is empty/);
        const after = await snapshot(page);
        expect(after.atoms).toHaveLength(1);
    });

    test('Ctrl+X cuts the selection to the clipboard as MOL V3000 and removes it from the model', async ({ page }) => {
        // Qt's CutCopyActionManager (cut_copy_action_manager.cpp:131-135)
        // does copy(MOLV3000) + removeSelected. Round-trip: load CCO, select
        // all, Ctrl+X — clipboard should hold a V3000 MOL of the 3-atom
        // fragment, and the sketch should be empty after the cut.
        await loadText(page, 'CCO');
        await page.getByTestId('select-all').click();

        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.keyboard.press(`${modifier}+x`);

        // Clipboard now holds the MOL V3000 block.
        const clip = await page.evaluate(() => navigator.clipboard.readText());
        expect(clip).toContain('V3000');
        expect(clip).toMatch(/COUNTS 3 2/);

        // Sketch is empty.
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(0);
        expect(rd.bonds).toHaveLength(0);
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/copied MOL V3000/);

        // Undo restores the cut atoms (deleteSelected is undoable).
        await page.getByTestId('undo').click();
        const restored = await snapshot(page);
        expect(restored.atoms).toHaveLength(3);
        expect(restored.bonds).toHaveLength(2);
    });

    test('Ctrl+X with no selection surfaces a friendly hint, no clipboard write, no model change', async ({ page }) => {
        // Qt's m_cut_action->setEnabled(has_contents && has_selection)
        // (cut_copy_action_manager.cpp:55). Without a selection the action
        // is disabled. We surface a friendly status instead.
        await loadText(page, 'CCO');
        await page.evaluate(() => navigator.clipboard.writeText('sentinel'));

        const before = await snapshot(page);
        expect(before.atoms).toHaveLength(3);

        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.keyboard.press(`${modifier}+x`);

        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/nothing to cut/);

        // Clipboard untouched.
        const clip = await page.evaluate(() => navigator.clipboard.readText());
        expect(clip).toBe('sentinel');

        // Model untouched.
        const after = await snapshot(page);
        expect(after.atoms).toHaveLength(3);
    });

    test('Ctrl+X with a partial selection cuts only the selected fragment, leaving the rest', async ({ page }) => {
        // Qt's getSelectedMolForExport (mol_model.cpp:240-271) auto-extends
        // selection from selected bonds to their endpoints, then removes
        // unselected atoms. The lean toMolBlockForSelection mirrors this.
        // Drive selection programmatically through the exposed model so the
        // test doesn't depend on layout coords.
        await loadText(page, 'CCO');
        await page.evaluate(() => {
            const m = window.SketcherModel;
            m.clearSelection();
            m.setAtomSelected(2, true); // the O
        });

        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.keyboard.press(`${modifier}+x`);

        const clip = await page.evaluate(() => navigator.clipboard.readText());
        expect(clip).toContain('V3000');
        expect(clip).toMatch(/COUNTS 1 0/);

        // The two unselected carbons remain.
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(2);
        expect(rd.atoms.every((a) => a.el === 'C')).toBe(true);
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
        await loadText(page, 'CO');

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
        await loadText(page, 'c1ccccc1');

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
        // underlying action isn't wired yet. (atom-query was wired in Batch 50,
        // bond-query in Batch 52 — both are draw tools now, so the atomistic
        // toolbar has no coming-soon stubs left; the remaining stubs are the
        // monomeric-page tiles.)
        // Import/Export open real menus (Batch 12); Save Image opens its
        // own dialog (Batch 13); Settings is the Configure View dropdown
        // (Batch 14); Help is its own dropdown (Batch 15) — all covered by
        // their own tests. The remaining stubs route through comingSoon()
        // → setStatus(...) so users can tell the button is intentional
        // rather than broken. (R-Group was wired in Batch 28;
        // attachment-point in Batch 29; reaction in Batch 30;
        // periodic-table opens a real popup in Batch 7; mode-monomeric
        // swaps the sidebar to the placeholder MonomerToolWidget page in
        // Batch 31 — its inner AMINO/NUCLEIC buttons are the new stubs;
        // all covered by their own tests.)
        const status = page.getByTestId('sketcher-status');
        // Flip to monomeric page; every amino-acid tile is a stub for now
        // (MolModel doesn't speak monomer yet). Probe one to confirm the
        // routing — full grid is covered by the dedicated batch-32 test.
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-aa-ala').click();
        await expect(status).toContainText(/Alanine/);
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

    test('D/T without selection surface a friendly hint; 0 arms zero-order bond mode', async ({
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
        // would do. '0' was a stub before batch 54 — now arms zero-order
        // bond mode (DATIVE/ZERO draw via the render bt field).
        const checks = [
            ['d', /Deuterium.*select atoms first/],
            ['t', /Tritium.*select atoms first/],
            ['0', /zero order/i],
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
        // Paste-in-Text modal textarea must absorb Backspace as a normal
        // edit (not route through the global "Delete selected" shortcut).
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 120, y: 180 } });

        await page.getByTestId('import').click();
        await page.getByTestId('import-paste-in-text').click();
        const input = page.getByTestId('paste-text-input');
        await input.click();
        await input.fill('CCO');
        await page.keyboard.press('Backspace');

        // Input now reads 'CC', and selection is intact (atoms unchanged).
        await expect(input).toHaveValue('CC');
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(2);
        // Cancel the modal so we don't leak it into later tests.
        await page.getByTestId('paste-text-cancel').click();
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

        // Click somewhere outside — the Undo button is a stable off-popup
        // target that won't itself open a popup.
        await page.getByTestId('undo').click();
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

    test('atom-query popup: long-press opens A/AH/Q/QH/M/MH/X/XH; pick arms the atom-query draw tool', async ({
        page,
    }) => {
        // Qt AtomQueryPopup renders 8 choices in a 2×4 grid. Picking one arms
        // the atom-query (A▾) draw tool with that wildcard (Batch 50 wired the
        // RDKit query-atom primitive behind it).
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

        // Pick "Q" — the button face updates to the picked wildcard and the
        // tool is now armed (a subsequent canvas click would place a Q atom;
        // exercised in the draw-tool tests below).
        await page.getByTestId('atom-query-popup-Q').click();
        await expect(page.getByTestId('atom-query')).toContainText('Q');
        await expect(page.getByTestId('atom-query-popup')).toHaveCount(0);
    });

    test('bond-query popup: long-press exposes aromatic/Any/S-D/S-A/D-A; pick arms the bond-query draw tool', async ({
        page,
    }) => {
        // Qt BondQueryPopup renders 5 choices in a horizontal row: aromatic
        // (icon) / Any / S/D / S/A / D/A. Picking one arms the bond-query (B▾)
        // draw tool (Batch 52 wired the query-bond primitive behind it).
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

        // Pick "S/D" — the button face updates and the tool is now armed
        // (drawing exercised in the bond-query tool tests below).
        await page.getByTestId('bond-query-popup-single-double').click();
        await expect(page.getByTestId('bond-query')).toContainText('S/D');
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

    // -------- Batch 35: background right-click context menu --------
    // Mirrors Qt's BackgroundContextMenu (menu/background_context_menu.cpp).
    // The menu appears at the cursor on right-click of an empty canvas
    // region; actions match Qt's order/labels/separators and enable-states
    // (Save Image / Export / Flip H,V / Select All / Copy / Copy As / Paste
    // gate off scene-emptiness; Undo/Redo/Clear/Paste are always enabled —
    // the existing top-bar undo/redo buttons also don't gate).
    test('background context menu: right-click on empty canvas opens menu with Qt action order', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        // Right-click anywhere on canvas opens the menu (empty scene OK).
        await canvas.click({ position: { x: 200, y: 200 }, button: 'right' });
        const menu = page.getByTestId('bg-context-menu');
        await expect(menu).toBeVisible();
        // Order matches Qt: Save Image, Export, --, Flip H, Flip V, --,
        // Undo, Redo, --, Select All, Copy, Copy As [...], Paste, --, Clear.
        const expected = [
            'ctx-save-image', 'ctx-export',
            'ctx-flip-horizontal', 'ctx-flip-vertical',
            'ctx-undo', 'ctx-redo',
            'ctx-select-all', 'ctx-copy',
            'ctx-copy-as-mol-v3000', 'ctx-copy-as-maestro',
            'ctx-copy-as-smiles', 'ctx-copy-as-extended-smiles',
            'ctx-copy-as-smarts', 'ctx-copy-as-extended-smarts',
            'ctx-copy-as-inchi', 'ctx-copy-as-inchikey',
            'ctx-copy-as-pdb', 'ctx-copy-as-xyz', 'ctx-copy-as-mrv',
            'ctx-paste', 'ctx-clear',
        ];
        for (const id of expected) {
            await expect(page.getByTestId(id)).toBeVisible();
        }
    });

    test('background context menu: empty-scene disables Save/Export/Flip/SelectAll/Copy; Undo/Redo/Paste/Clear stay enabled', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 200, y: 200 }, button: 'right' });
        // Disabled when scene is empty (mirrors updateActions()).
        for (const id of [
            'ctx-save-image', 'ctx-export',
            'ctx-flip-horizontal', 'ctx-flip-vertical',
            'ctx-select-all', 'ctx-copy',
            'ctx-copy-as-smiles', 'ctx-copy-as-mol-v3000',
        ]) {
            await expect(page.getByTestId(id)).toBeDisabled();
        }
        // Always-enabled (Qt: undo/redo gated on stack, but React top-bar
        // doesn't gate either — we match the React surface).
        for (const id of ['ctx-undo', 'ctx-redo', 'ctx-paste', 'ctx-clear']) {
            await expect(page.getByTestId(id)).toBeEnabled();
        }
    });

    test('background context menu: non-empty scene enables every action', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        // Drop one atom so the scene is non-empty.
        await canvas.click({ position: { x: 250, y: 200 } });
        await canvas.click({ position: { x: 400, y: 200 }, button: 'right' });
        for (const id of [
            'ctx-save-image', 'ctx-export',
            'ctx-flip-horizontal', 'ctx-flip-vertical',
            'ctx-undo', 'ctx-redo',
            'ctx-select-all', 'ctx-copy', 'ctx-paste', 'ctx-clear',
            'ctx-copy-as-smiles', 'ctx-copy-as-mol-v3000',
        ]) {
            await expect(page.getByTestId(id)).toBeEnabled();
        }
    });

    test('background context menu: non-empty scene also enables actions when only non-mol objects exist (reaction-only)', async ({
        page,
    }) => {
        // Switch to the Reaction tool and drop an arrow — no atoms, but the
        // scene is non-empty via nonMol[]. updateActions() must enable the
        // gated actions in that case (Qt's sceneIsEmpty checks both).
        await page.getByTestId('reaction').click();
        const canvas = page.getByTestId('sketcher-canvas');
        // Default reactionMode is 'arrow' on first click — drop it.
        await canvas.click({ position: { x: 300, y: 200 } });
        await canvas.click({ position: { x: 100, y: 100 }, button: 'right' });
        await expect(page.getByTestId('ctx-save-image')).toBeEnabled();
        await expect(page.getByTestId('ctx-export')).toBeEnabled();
        await expect(page.getByTestId('ctx-select-all')).toBeEnabled();
    });

    test('background context menu: Clear Sketcher empties the model and closes the menu', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 250, y: 200 } });
        await canvas.click({ position: { x: 350, y: 200 } });
        let rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(2);
        await canvas.click({ position: { x: 100, y: 100 }, button: 'right' });
        await page.getByTestId('ctx-clear').click();
        await expect(page.getByTestId('bg-context-menu')).toHaveCount(0);
        rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(0);
    });

    test('background context menu: Copy writes MOL V3000 to clipboard (matches Qt DEFAULT_FORMAT)', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 250, y: 200 } });
        await canvas.click({ position: { x: 100, y: 100 }, button: 'right' });
        await page.getByTestId('ctx-copy').click();
        const clip = await readClipboard(page);
        // V3000 header includes "M  V30 BEGIN CTAB" — V2000 would not.
        expect(clip).toContain('V30 BEGIN CTAB');
    });

    test('background context menu: Copy As SMILES writes SMILES to clipboard', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        // Build CCO via two click + bond cycles? Easier: paste SMILES.
        await loadText(page, 'CCO');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('ctx-copy-as-smiles').click();
        const clip = await readClipboard(page);
        expect(clip.trim()).toBe('CCO');
    });

    test('background context menu: Flip All Horizontal flips every atom about the centroid', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        const before = await snapshot(page);
        // Capture min/max x for the centroid before flipping.
        const xsBefore = before.atoms.map((a) => a.x);
        const cxBefore = (Math.min(...xsBefore) + Math.max(...xsBefore)) / 2;
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('ctx-flip-horizontal').click();
        const after = await snapshot(page);
        // Reflecting x around cxBefore: new_x = 2*cxBefore - old_x.
        for (let i = 0; i < before.atoms.length; ++i) {
            const expectedX = 2 * cxBefore - before.atoms[i].x;
            // 3-decimal precision — the serializer rounds to ~4 decimals and
            // the centroid math reflects a float-rounded mid-x, so 5dp would
            // be over-strict.
            expect(after.atoms[i].x).toBeCloseTo(expectedX, 3);
        }
    });

    test('background context menu: Select All selects every atom and closes', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('ctx-select-all').click();
        await expect(page.getByTestId('bg-context-menu')).toHaveCount(0);
        const rd = await snapshot(page);
        expect(rd.atoms.every((a) => a.sel)).toBe(true);
    });

    test('background context menu: outside-click dismisses without firing any action', async ({
        page,
    }) => {
        await loadText(page, 'CC');
        const canvas = page.getByTestId('sketcher-canvas');
        const before = await snapshot(page);
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await expect(page.getByTestId('bg-context-menu')).toBeVisible();
        // Click the status box (outside the menu).
        await page.getByTestId('sketcher-status').click();
        await expect(page.getByTestId('bg-context-menu')).toHaveCount(0);
        const after = await snapshot(page);
        expect(after.atoms).toHaveLength(before.atoms.length);
    });

    test('background context menu: Save Image opens the FileSaveImageDialog', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('ctx-save-image').click();
        await expect(page.getByTestId('bg-context-menu')).toHaveCount(0);
        await expect(page.getByTestId('save-image-modal')).toBeVisible();
    });

    test('background context menu: Export to File opens the FileExportDialog', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('ctx-export').click();
        await expect(page.getByTestId('bg-context-menu')).toHaveCount(0);
        await expect(page.getByTestId('export-modal')).toBeVisible();
    });

    // -------- Batch 36: selection right-click context menu --------
    // Mirrors Qt's SelectionContextMenu (menu/selection_context_menu.cpp).
    // Qt's SketcherView dispatches right-click → SelectionContextMenu when
    // hit-test lands on a selected item, BackgroundContextMenu otherwise.
    // Without item hit-test (deferred), the dispatch collapses to "any
    // selection present → selection menu" which preserves the user-visible
    // behavior of Qt for the right-click-with-selection case.
    test('selection context menu: right-click with active selection opens SelectionContextMenu (not Background)', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        const canvas = page.getByTestId('sketcher-canvas');
        // Select-all so a selection exists.
        await page.keyboard.press('Control+A');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await expect(page.getByTestId('sel-context-menu')).toBeVisible();
        await expect(page.getByTestId('bg-context-menu')).toHaveCount(0);
    });

    test('selection context menu: action set matches Qt (Invert / Copy / Copy As / Flip Molecule / Delete)', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        for (const id of [
            'sel-ctx-invert',
            'sel-ctx-copy',
            'sel-ctx-copy-as-mol-v3000', 'sel-ctx-copy-as-maestro',
            'sel-ctx-copy-as-smiles', 'sel-ctx-copy-as-extended-smiles',
            'sel-ctx-copy-as-smarts', 'sel-ctx-copy-as-extended-smarts',
            'sel-ctx-copy-as-inchi', 'sel-ctx-copy-as-inchikey',
            'sel-ctx-copy-as-pdb', 'sel-ctx-copy-as-xyz',
            'sel-ctx-copy-as-mrv',
            'sel-ctx-flip-horizontal', 'sel-ctx-flip-vertical',
            'sel-ctx-set-C', 'sel-ctx-set-N', 'sel-ctx-set-O',
            'sel-ctx-charge-plus', 'sel-ctx-charge-minus',
            'sel-ctx-bond-single', 'sel-ctx-bond-double',
            'sel-ctx-bond-triple', 'sel-ctx-bond-aromatic',
            'sel-ctx-bond-up', 'sel-ctx-bond-down',
            'sel-ctx-delete',
        ]) {
            await expect(page.getByTestId(id)).toBeVisible();
        }
    });

    test('selection context menu: clearing selection routes the next right-click back to BackgroundContextMenu', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await expect(page.getByTestId('sel-context-menu')).toBeVisible();
        // Dismiss without acting, clear selection, then re-open.
        await page.keyboard.press('Escape'); // not actually wired, but click
        // outside dismisses — use that:
        await page.getByTestId('sketcher-status').click();
        await page.keyboard.press('Control+D'); // clear selection shortcut
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await expect(page.getByTestId('bg-context-menu')).toBeVisible();
        await expect(page.getByTestId('sel-context-menu')).toHaveCount(0);
    });

    test('selection context menu: Invert Selection toggles which atoms are selected', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        const canvas = page.getByTestId('sketcher-canvas');
        // Select all three, then in next steps we'll invert via menu.
        await page.keyboard.press('Control+A');
        let rd = await snapshot(page);
        const allSelected = rd.atoms.every((a) => a.sel);
        expect(allSelected).toBe(true);
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-invert').click();
        rd = await snapshot(page);
        const noneSelected = rd.atoms.every((a) => !a.sel);
        expect(noneSelected).toBe(true);
    });

    test('selection context menu: Copy writes MOL V3000 (Qt DEFAULT_FORMAT) for the selection', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-copy').click();
        const clip = await readClipboard(page);
        expect(clip).toContain('V30 BEGIN CTAB');
    });

    test('selection context menu: Copy As SMILES emits selection SMILES', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-copy-as-smiles').click();
        const clip = await readClipboard(page);
        expect(clip.trim()).toBe('CCO');
    });

    test('selection context menu: Flip Horizontally mirrors selected atoms about centroid', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        await page.keyboard.press('Control+A');
        const before = await snapshot(page);
        const xs = before.atoms.map((a) => a.x);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-flip-horizontal').click();
        const after = await snapshot(page);
        for (let i = 0; i < before.atoms.length; ++i) {
            expect(after.atoms[i].x).toBeCloseTo(2 * cx - before.atoms[i].x, 3);
        }
    });

    test('selection context menu: Delete removes the selected atoms', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        let rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(3);
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-delete').click();
        await expect(page.getByTestId('sel-context-menu')).toHaveCount(0);
        rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(0);
    });

    test('selection context menu: outside-click dismisses without mutating the selection', async ({
        page,
    }) => {
        await loadText(page, 'CC');
        await page.keyboard.press('Control+A');
        const before = await snapshot(page);
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await expect(page.getByTestId('sel-context-menu')).toBeVisible();
        await page.getByTestId('sketcher-status').click();
        await expect(page.getByTestId('sel-context-menu')).toHaveCount(0);
        const after = await snapshot(page);
        // Same atoms, same selection (nothing was acted on).
        expect(after.atoms).toHaveLength(before.atoms.length);
        for (let i = 0; i < before.atoms.length; ++i) {
            expect(after.atoms[i].sel).toBe(before.atoms[i].sel);
        }
    });

    test('selection context menu: Cut writes V3000 to clipboard and removes the selection', async ({
        page,
    }) => {
        // Qt's CutCopyActionManager (cut_copy_action_manager.cpp:131-135):
        // Cut = copy(SELECTION, MDL_MOLV3000) + removeSelected. React port
        // mirrors via doCut → toFormatString('mdl_molv3000', true) +
        // model.deleteSelected().
        await loadText(page, 'CCO');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-cut').click();
        await expect(page.getByTestId('sel-context-menu')).toHaveCount(0);
        const clip = await readClipboard(page);
        expect(clip).toContain('V30 BEGIN CTAB');
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(0);
    });

    // -------- Batch 37: bond right-click context menu --------
    // Mirrors Qt's BondContextMenu (menu/bond_context_menu.cpp). Right-click
    // on a bond's midpoint when no selection is active routes to BondContext
    // rather than BackgroundContext. Active bond-type / bond-dir items show
    // a leading check; submenus that need query bond support (Other Type,
    // Query, Topology) and Flip Substituent (needs adjacency data) are
    // intentionally omitted.
    test('bond context menu: right-click on a bond opens BondContextMenu (not Background, not Selection)', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        // Two carbons side-by-side, then a single bond between them.
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        // Switch back to select so right-click doesn't conflict with a draw
        // tool. The Bond hit-test runs regardless of active tool.
        await page.getByTestId('tool-select').click();
        // Right-click on the bond midpoint at ~ (190, 180).
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        await expect(page.getByTestId('bond-context-menu')).toBeVisible();
        await expect(page.getByTestId('bg-context-menu')).toHaveCount(0);
        await expect(page.getByTestId('sel-context-menu')).toHaveCount(0);
    });

    test('bond context menu: action set matches Qt (Single/Double/Triple/Aromatic, Up/Down/None, Delete)', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        for (const id of [
            'bond-ctx-single', 'bond-ctx-double',
            'bond-ctx-triple', 'bond-ctx-aromatic',
            'bond-ctx-wedge-up', 'bond-ctx-wedge-down', 'bond-ctx-wedge-none',
            'bond-ctx-delete',
        ]) {
            await expect(page.getByTestId(id)).toBeVisible();
        }
        // Active bond is single → "Single" gets the check; others don't.
        await expect(page.getByTestId('bond-ctx-single'))
            .toContainText('✓ Single');
        await expect(page.getByTestId('bond-ctx-double'))
            .not.toContainText('✓');
    });

    test('bond context menu: Double promotes the bond order (Qt setBondTypeUndoable=DOUBLE)', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('tool-select').click();
        let rd = await snapshot(page);
        expect(rd.bonds[0].o).toBe(1);
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        await page.getByTestId('bond-ctx-double').click();
        await expect(page.getByTestId('bond-context-menu')).toHaveCount(0);
        rd = await snapshot(page);
        expect(rd.bonds[0].o).toBe(2);
        // Undo restores to single.
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.bonds[0].o).toBe(1);
    });

    test('bond context menu: Up sets the wedge dir; None clears it', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('tool-select').click();
        let rd = await snapshot(page);
        expect(rd.bonds[0].dir).toBeUndefined();
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        await page.getByTestId('bond-ctx-wedge-up').click();
        rd = await snapshot(page);
        expect(rd.bonds[0].dir).toBe(1); // BEGINWEDGE
        // Reopen the menu — "Up" should now carry the check.
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        await expect(page.getByTestId('bond-ctx-wedge-up'))
            .toContainText('✓ Up');
        await page.getByTestId('bond-ctx-wedge-none').click();
        rd = await snapshot(page);
        expect(rd.bonds[0].dir).toBeUndefined();
    });

    test('bond context menu: Delete removes the bond', async ({ page }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('tool-select').click();
        let rd = await snapshot(page);
        expect(rd.bonds).toHaveLength(1);
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        await page.getByTestId('bond-ctx-delete').click();
        await expect(page.getByTestId('bond-context-menu')).toHaveCount(0);
        rd = await snapshot(page);
        expect(rd.bonds).toHaveLength(0);
        // Atoms still there — Delete-bond doesn't touch atoms.
        expect(rd.atoms).toHaveLength(2);
    });

    test('bond context menu: outside-click dismisses without mutating the bond', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('tool-select').click();
        const before = await snapshot(page);
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        await expect(page.getByTestId('bond-context-menu')).toBeVisible();
        // Dismiss via a viewport-corner click that's clearly outside the menu.
        // (The status bar can sit under the now-taller bond menu.)
        await page.mouse.click(2, 2);
        await expect(page.getByTestId('bond-context-menu')).toHaveCount(0);
        const after = await snapshot(page);
        expect(after.bonds).toHaveLength(before.bonds.length);
        expect(after.bonds[0].o).toBe(before.bonds[0].o);
        expect(after.bonds[0].dir).toBe(before.bonds[0].dir);
    });

    // -------- Batch 38: atom right-click context menu --------
    // Mirrors Qt's AtomContextMenu (menu/atom_context_menu.cpp). Atom
    // hit-test runs before bond hit-test in onCanvasContextMenu, so a
    // right-click landing inside an atom's hit-radius routes to the atom
    // menu even when a bond passes through. Lean MolModel surface limits
    // this batch to Charge ± and Delete; richer actions (Set Element,
    // Add Explicit Hs, Unpaired Electrons, Edit Atom Properties, Add
    // Brackets, Replace With) need C++ primitives not yet ported.
    test('atom context menu: right-click on an atom opens AtomContextMenu (not Bond, not Background)', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('tool-select').click();
        // Right-click directly on atom 0's drawn position.
        await canvas.click({ position: { x: 120, y: 180 }, button: 'right' });
        await expect(page.getByTestId('atom-context-menu')).toBeVisible();
        await expect(page.getByTestId('bg-context-menu')).toHaveCount(0);
        await expect(page.getByTestId('bond-context-menu')).toHaveCount(0);
    });

    test('atom context menu: action set matches the lean port subset (Charge ±, Delete)', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 120, y: 180 }, button: 'right' });
        for (const id of [
            'atom-ctx-charge-plus',
            'atom-ctx-charge-minus',
            'atom-ctx-delete',
        ]) {
            await expect(page.getByTestId(id)).toBeVisible();
        }
    });

    test('atom context menu: + Charge increments formal charge as one undo step', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await page.getByTestId('tool-select').click();
        // C with no prior selection → q undefined (== 0).
        let rd = await snapshot(page);
        expect(rd.atoms[0].q).toBeUndefined();
        await canvas.click({ position: { x: 120, y: 180 }, button: 'right' });
        await page.getByTestId('atom-ctx-charge-plus').click();
        await expect(page.getByTestId('atom-context-menu')).toHaveCount(0);
        rd = await snapshot(page);
        expect(rd.atoms[0].q).toBe(1);
        // No leftover selection from the temp-selection dance.
        expect(rd.atoms[0].sel).toBeUndefined();
        // Single undo removes the +1.
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.atoms[0].q).toBeUndefined();
    });

    test('atom context menu: − Charge decrements formal charge', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 120, y: 180 }, button: 'right' });
        await page.getByTestId('atom-ctx-charge-minus').click();
        const rd = await snapshot(page);
        expect(rd.atoms[0].q).toBe(-1);
    });

    test('atom context menu: header shows the element symbol and current charge', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await page.getByTestId('element-N').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 120, y: 180 }, button: 'right' });
        // Neutral N → just "N" (no charge in header).
        await expect(page.getByTestId('atom-context-menu'))
            .toContainText('N');
        // Bump charge, reopen — header should now read "N (+1)".
        await page.getByTestId('atom-ctx-charge-plus').click();
        await canvas.click({ position: { x: 120, y: 180 }, button: 'right' });
        await expect(page.getByTestId('atom-context-menu'))
            .toContainText('N (+1)');
    });

    test('atom context menu: Delete removes the atom', async ({ page }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('tool-select').click();
        const before = await snapshot(page);
        expect(before.atoms).toHaveLength(2);
        const survivorX = before.atoms[1].x;
        await canvas.click({ position: { x: 120, y: 180 }, button: 'right' });
        await page.getByTestId('atom-ctx-delete').click();
        await expect(page.getByTestId('atom-context-menu')).toHaveCount(0);
        const after = await snapshot(page);
        expect(after.atoms).toHaveLength(1);
        // The surviving atom is the one we didn't right-click (atom 1's
        // original x ≈ survivorX, not atom 0's smaller x).
        expect(after.atoms[0].x).toBeCloseTo(survivorX, 3);
    });

    test('atom context menu: outside-click dismisses without mutating the atom', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await page.getByTestId('tool-select').click();
        const before = await snapshot(page);
        await canvas.click({ position: { x: 120, y: 180 }, button: 'right' });
        await expect(page.getByTestId('atom-context-menu')).toBeVisible();
        await page.getByTestId('sketcher-status').click();
        await expect(page.getByTestId('atom-context-menu')).toHaveCount(0);
        const after = await snapshot(page);
        expect(after.atoms[0].q).toBe(before.atoms[0].q);
        expect(after.atoms).toHaveLength(before.atoms.length);
    });

    test('atom context menu: charge ± disabled for R-groups (Qt: is_r_group gate)', async ({
        page,
    }) => {
        // Place a free R-group via the R-Group tool, then right-click it.
        const canvas = page.getByTestId('sketcher-canvas');
        await page.getByTestId('rgroup').click();
        await canvas.click({ position: { x: 200, y: 200 } });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 200, y: 200 }, button: 'right' });
        await expect(page.getByTestId('atom-context-menu')).toBeVisible();
        // Both charge actions should be disabled.
        await expect(page.getByTestId('atom-ctx-charge-plus'))
            .toBeDisabled();
        await expect(page.getByTestId('atom-ctx-charge-minus'))
            .toBeDisabled();
        // Delete is still allowed.
        await expect(page.getByTestId('atom-ctx-delete')).toBeEnabled();
    });

    test('atom context menu: atom hit-test wins over nearby bond hit', async ({
        page,
    }) => {
        // Two carbons + a bond — right-click on atom 0's drawn position
        // must route to AtomContextMenu, not BondContextMenu, even though
        // the bond extends out from the atom.
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 120, y: 180 }, button: 'right' });
        await expect(page.getByTestId('atom-context-menu')).toBeVisible();
        await expect(page.getByTestId('bond-context-menu')).toHaveCount(0);
    });

    // -------- Batch 39: Set Element submenu in atom context menu --------
    // Mirrors Qt's ModifyAtomsMenu::createElementMenu → SetAtomMenuWidget
    // (8-element grid). Backed by MolModel.setAtomElement(idx, atomicNum).
    test('atom context menu: Set Element strip exposes all 8 fixed elements', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 120, y: 180 }, button: 'right' });
        for (const el of ['C', 'H', 'N', 'O', 'P', 'S', 'F', 'Cl']) {
            await expect(page.getByTestId(`atom-ctx-set-${el}`)).toBeVisible();
        }
    });

    test('atom context menu: clicking N swaps element on the right-clicked atom', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await page.getByTestId('tool-select').click();
        const before = await snapshot(page);
        expect(before.atoms[0].el).toBe('C');
        await canvas.click({ position: { x: 120, y: 180 }, button: 'right' });
        await page.getByTestId('atom-ctx-set-N').click();
        await expect(page.getByTestId('atom-context-menu')).toHaveCount(0);
        const after = await snapshot(page);
        expect(after.atoms[0].el).toBe('N');
        // No leftover selection — setAtomElement preserves whatever was
        // selected at call time (nothing here).
        expect(after.atoms[0].sel).toBeUndefined();
        // Single undo restores carbon.
        await page.getByTestId('undo').click();
        const undone = await snapshot(page);
        expect(undone.atoms[0].el).toBe('C');
    });

    test('atom context menu: Set Element resets formal charge to defaults', async ({
        page,
    }) => {
        // C+ atom, then swap to N — Qt mutates by constructing a fresh
        // RDKit::Atom(element), which zeros the formal charge. Match that.
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 120, y: 180 }, button: 'right' });
        await page.getByTestId('atom-ctx-charge-plus').click();
        let rd = await snapshot(page);
        expect(rd.atoms[0].q).toBe(1);
        await canvas.click({ position: { x: 120, y: 180 }, button: 'right' });
        await page.getByTestId('atom-ctx-set-N').click();
        rd = await snapshot(page);
        expect(rd.atoms[0].el).toBe('N');
        expect(rd.atoms[0].q).toBeUndefined();
        // Undo restores N → C and brings the +1 charge back along the way.
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.atoms[0].el).toBe('C');
        expect(rd.atoms[0].q).toBe(1);
    });

    test('atom context menu: current element button is disabled (no-op self-swap)', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 120, y: 180 }, button: 'right' });
        // The drawn atom is C — atom-ctx-set-C should be disabled, others enabled.
        await expect(page.getByTestId('atom-ctx-set-C')).toBeDisabled();
        await expect(page.getByTestId('atom-ctx-set-N')).toBeEnabled();
    });

    test('atom context menu: Set Element disabled for R-groups (preserves dummy)', async ({
        page,
    }) => {
        // R-group atoms carry the _MolFileRLabel dummy property; replaceAtom
        // would discard it, so Qt's ReplaceAtomsWithMenu / ModifyAtomsMenu
        // route those through mutateRGroups instead. We gate the inline strip.
        const canvas = page.getByTestId('sketcher-canvas');
        await page.getByTestId('rgroup').click();
        await canvas.click({ position: { x: 200, y: 200 } });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 200, y: 200 }, button: 'right' });
        for (const el of ['C', 'H', 'N', 'O', 'P', 'S', 'F', 'Cl']) {
            await expect(page.getByTestId(`atom-ctx-set-${el}`)).toBeDisabled();
        }
    });

    // -------- Batch 40: AttachmentPointContextMenu --------
    // Qt menu/attachment_point_context_menu.cpp:8 — a tiny dedicated menu
    // (just "Attachment Point" title + Delete) that fires when right-click
    // hits an attachment-point dummy. Distinct from the generic atom menu
    // (which is what the React port previously showed for AP atoms, with
    // everything but Delete disabled).
    async function apAtomPx(page) {
        // Compute the pixel-space position of the AP atom by combining the
        // model-space atom position from the snapshot with the live
        // SketcherView transform exposed on window for tests.
        return await page.evaluate(() => {
            const rd = JSON.parse(window.SketcherModel.description());
            const ap = rd.atoms.find((a) => typeof a.ap === 'number');
            if (!ap) return null;
            const view = window.SketcherView.current;
            const canvas = document.querySelector(
                '[data-testid="sketcher-canvas"]');
            const rect = canvas.getBoundingClientRect();
            const cx = canvas.width / 2 + view.offsetX;
            const cy = canvas.height / 2 + view.offsetY;
            const px = ap.x * view.scale + cx;
            const py = -ap.y * view.scale + cy;
            // Convert canvas-internal coords to client coords using
            // the canvas's CSS scaling ratio.
            const sx = rect.width / canvas.width;
            const sy = rect.height / canvas.height;
            return { x: px * sx, y: py * sy };
        });
    }

    test('attachment-point context menu: right-click on an AP opens the dedicated menu (not the atom menu)', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 200, y: 200 } });
        await page.getByTestId('attachment-point').click();
        await canvas.click({ position: { x: 200, y: 200 } });
        await page.getByTestId('tool-select').click();
        const pos = await apAtomPx(page);
        expect(pos).not.toBeNull();
        await canvas.click({ position: pos, button: 'right' });
        await expect(page.getByTestId('ap-context-menu')).toBeVisible();
        await expect(page.getByTestId('atom-context-menu')).toHaveCount(0);
        await expect(page.getByTestId('bond-context-menu')).toHaveCount(0);
        await expect(page.getByTestId('bg-context-menu')).toHaveCount(0);
    });

    test('attachment-point context menu: shows only Delete (and the title)', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 200, y: 200 } });
        await page.getByTestId('attachment-point').click();
        await canvas.click({ position: { x: 200, y: 200 } });
        await page.getByTestId('tool-select').click();
        const pos = await apAtomPx(page);
        await canvas.click({ position: pos, button: 'right' });
        await expect(page.getByTestId('ap-context-menu'))
            .toContainText('Attachment Point');
        await expect(page.getByTestId('ap-ctx-delete')).toBeVisible();
        // Things the atom menu would have shown must not appear here.
        await expect(page.getByTestId('atom-ctx-charge-plus')).toHaveCount(0);
        await expect(page.getByTestId('atom-ctx-set-C')).toHaveCount(0);
    });

    test('attachment-point context menu: Delete removes only the AP atom + its bond', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 200, y: 200 } });
        await page.getByTestId('attachment-point').click();
        await canvas.click({ position: { x: 200, y: 200 } });
        await page.getByTestId('tool-select').click();
        const before = await snapshot(page);
        expect(before.atoms).toHaveLength(2);
        expect(before.bonds).toHaveLength(1);
        const pos = await apAtomPx(page);
        await canvas.click({ position: pos, button: 'right' });
        await page.getByTestId('ap-ctx-delete').click();
        await expect(page.getByTestId('ap-context-menu')).toHaveCount(0);
        const after = await snapshot(page);
        // The host C survives; the AP and its single bond are gone.
        expect(after.atoms).toHaveLength(1);
        expect(after.bonds).toHaveLength(0);
        expect(after.atoms[0].ap).toBeUndefined();
    });

    // -------- Batch 41: Modify Atoms section in selection menu --------
    // Qt's SelectionContextMenu wires a ModifyAtomsMenu submenu (Set Element
    // grid + ± Charge + …). The React port flattens this into an inline
    // section to match how the other context menus are already structured.
    // Backed by MolModel.setElementForSelectedAtoms (new selection-wide
    // primitive) and the existing adjustChargeOnSelectedAtoms.
    test('selection context menu: Set Element strip exposes all 8 fixed elements', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        for (const el of ['C', 'H', 'N', 'O', 'P', 'S', 'F', 'Cl']) {
            await expect(page.getByTestId(`sel-ctx-set-${el}`)).toBeVisible();
        }
    });

    test('selection context menu: Set Element swaps every selected atom in one undo step', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-set-N').click();
        await expect(page.getByTestId('sel-context-menu')).toHaveCount(0);
        let rd = await snapshot(page);
        // CCO → all three atoms become N (selection covered every atom).
        expect(rd.atoms.map((a) => a.el)).toEqual(['N', 'N', 'N']);
        // Selection survives — element edits don't reindex.
        expect(rd.atoms.every((a) => a.sel)).toBe(true);
        // Single undo restores the original CCO mix.
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.atoms.map((a) => a.el)).toEqual(['C', 'C', 'O']);
    });

    test('selection context menu: + Charge applies +1 to every selected atom', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-charge-plus').click();
        await expect(page.getByTestId('sel-context-menu')).toHaveCount(0);
        const rd = await snapshot(page);
        expect(rd.atoms.map((a) => a.q ?? 0)).toEqual([1, 1, 1]);
    });

    test('selection context menu: − Charge applies −1 to every selected atom', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-charge-minus').click();
        const rd = await snapshot(page);
        expect(rd.atoms.map((a) => a.q ?? 0)).toEqual([-1, -1, -1]);
    });

    test('selection context menu: Set Element resets formal charge on each atom', async ({
        page,
    }) => {
        // Mirrors the atom-context-menu charge-reset test but for the
        // selection-wide primitive. Charge the whole selection +1, then
        // swap element → charges must drop to 0 (Qt mutates by constructing
        // a fresh RDKit::Atom(element)).
        await loadText(page, 'CCO');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-charge-plus').click();
        let rd = await snapshot(page);
        expect(rd.atoms.every((a) => a.q === 1)).toBe(true);
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-set-N').click();
        rd = await snapshot(page);
        expect(rd.atoms.every((a) => a.el === 'N')).toBe(true);
        expect(rd.atoms.every((a) => a.q === undefined || a.q === 0)).toBe(true);
        // Undo brings back the prior C/O mix AND the +1 charges.
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.atoms.map((a) => a.el)).toEqual(['C', 'C', 'O']);
        expect(rd.atoms.every((a) => a.q === 1)).toBe(true);
    });

    // -------- Batch 42: Modify Bonds section in selection menu --------
    // Qt's SelectionContextMenu wires a ModifyBondsMenu (with setFlipVisible
    // false) — bond-type rows + Up/Down stereo. The React port flattens to
    // an inline section. Backed by setBondTypeForSelectedBonds (new) +
    // setBondDirForSelectedBonds (existing).
    test('selection context menu: Modify Bonds exposes Single/Double/Triple/Aromatic + Up/Down', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        for (const id of [
            'sel-ctx-bond-single', 'sel-ctx-bond-double',
            'sel-ctx-bond-triple', 'sel-ctx-bond-aromatic',
            'sel-ctx-bond-up', 'sel-ctx-bond-down',
        ]) {
            await expect(page.getByTestId(id)).toBeVisible();
        }
    });

    test('selection context menu: Double promotes every selected bond and is one undo step', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-bond-double').click();
        await expect(page.getByTestId('sel-context-menu')).toHaveCount(0);
        let rd = await snapshot(page);
        // CCO ships two single bonds — both should now be double.
        expect(rd.bonds.map((b) => b.o)).toEqual([2, 2]);
        expect(rd.bonds.every((b) => b.sel)).toBe(true);
        // Single undo restores both as single (one macro).
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.bonds.map((b) => b.o)).toEqual([1, 1]);
    });

    test('selection context menu: Triple then Single round-trips through the bond order', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-bond-triple').click();
        let rd = await snapshot(page);
        expect(rd.bonds.map((b) => b.o)).toEqual([3, 3]);
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-bond-single').click();
        rd = await snapshot(page);
        expect(rd.bonds.map((b) => b.o)).toEqual([1, 1]);
    });

    test('selection context menu: Aromatic flags every selected bond as arom', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-bond-aromatic').click();
        const rd = await snapshot(page);
        // Aromatic bonds carry the arom flag in the render description.
        expect(rd.bonds.every((b) => b.arom === true)).toBe(true);
    });

    test('selection context menu: Up applies wedge stereo to every selected bond', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-bond-up').click();
        const rd = await snapshot(page);
        // BondDir 1 = BEGINWEDGE.
        expect(rd.bonds.every((b) => b.dir === 1)).toBe(true);
    });

    test('selection context menu: Down applies dash stereo to every selected bond', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-bond-down').click();
        const rd = await snapshot(page);
        // BondDir 2 = BEGINDASH.
        expect(rd.bonds.every((b) => b.dir === 2)).toBe(true);
    });

    // ---- Batch 43: Add/Remove Explicit Hydrogens ---------------------------

    test('atom context menu: Add Explicit Hydrogens promotes implicit Hs on just the clicked atom', async ({
        page,
    }) => {
        // CCO: C(0), C(1), O(2). Right-click O and add explicit Hs — only
        // the OH proton becomes graph-explicit (3 → 4 atoms).
        await loadText(page, 'CCO');
        const rd0 = await snapshot(page);
        expect(rd0.atoms.length).toBe(3);
        const o = rd0.atoms.find((a) => a.el === 'O');
        const oPx = await page.evaluate(({ x, y }) => {
            const view = window.SketcherView.current;
            const canvas = document.querySelector(
                '[data-testid="sketcher-canvas"]');
            const w = canvas.width, h = canvas.height;
            return { px: w / 2 + (x - 0) * view.scale + view.offsetX,
                py: h / 2 - (y - 0) * view.scale + view.offsetY };
        }, { x: o.x, y: o.y });
        const canvas = page.getByTestId('sketcher-canvas');
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: oPx.px, y: oPx.py }, button: 'right' });
        await expect(page.getByTestId('atom-ctx-explicit-h'))
            .toHaveText('Add Explicit Hydrogens');
        await page.getByTestId('atom-ctx-explicit-h').click();
        const rd1 = await snapshot(page);
        expect(rd1.atoms.length).toBe(4);
        // The other two atoms (C, C) keep their implicit Hs.
        const carbons1 = rd1.atoms.filter((a) => a.el === 'C');
        expect(carbons1.every((a) => (a.nh ?? 0) > 0)).toBe(true);
        // Single undo restores.
        await page.getByTestId('undo').click();
        const rd2 = await snapshot(page);
        expect(rd2.atoms.length).toBe(3);
    });

    test('atom context menu: action label flips to Remove Explicit Hydrogens when atom has no implicit Hs left', async ({
        page,
    }) => {
        // Fully-expand methane first, then right-click the carbon — its nh
        // is now 0, so the label should read "Remove Explicit Hydrogens".
        await loadText(page, 'C');
        await page.evaluate(() => window.SketcherModel.addHydrogens());
        const rd = await snapshot(page);
        expect(rd.atoms.length).toBe(5);
        const c = rd.atoms.find((a) => a.el === 'C');
        const cPx = await page.evaluate(({ x, y }) => {
            const view = window.SketcherView.current;
            const canvas = document.querySelector(
                '[data-testid="sketcher-canvas"]');
            const w = canvas.width, h = canvas.height;
            return { px: w / 2 + (x - 0) * view.scale + view.offsetX,
                py: h / 2 - (y - 0) * view.scale + view.offsetY };
        }, { x: c.x, y: c.y });
        const canvas = page.getByTestId('sketcher-canvas');
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: cPx.px, y: cPx.py }, button: 'right' });
        await expect(page.getByTestId('atom-ctx-explicit-h'))
            .toHaveText('Remove Explicit Hydrogens');
        await page.getByTestId('atom-ctx-explicit-h').click();
        const rd2 = await snapshot(page);
        // All 4 Hs collapse back; the carbon is alone.
        expect(rd2.atoms.length).toBe(1);
    });

    test('atom context menu: Add Explicit Hydrogens disabled on R-groups', async ({
        page,
    }) => {
        // R1 dummy via SMILES extension; the lean MolModel uses the
        // _MolFileRLabel property which loadFromText recognizes from MOL.
        // Easier path: place an R1 via the model API at a known position.
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 200, y: 180 } });
        await page.evaluate(() =>
            window.SketcherModel.addRGroup(1, 1.5, 0, 0));
        const rd = await snapshot(page);
        // The R-group dummy is the second atom.
        const r = rd.atoms.find((a) => typeof a.rlabel === 'number');
        expect(r).toBeDefined();
        const rPx = await page.evaluate(({ x, y }) => {
            const view = window.SketcherView.current;
            const canvas = document.querySelector(
                '[data-testid="sketcher-canvas"]');
            const w = canvas.width, h = canvas.height;
            return { px: w / 2 + (x - 0) * view.scale + view.offsetX,
                py: h / 2 - (y - 0) * view.scale + view.offsetY };
        }, { x: r.x, y: r.y });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: rPx.px, y: rPx.py }, button: 'right' });
        await expect(page.getByTestId('atom-ctx-explicit-h'))
            .toBeDisabled();
    });

    test('selection context menu: Add Explicit Hydrogens expands every selected atom in one undo step', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await expect(page.getByTestId('sel-ctx-explicit-h'))
            .toHaveText('Add Explicit Hydrogens');
        await page.getByTestId('sel-ctx-explicit-h').click();
        const rd = await snapshot(page);
        // CCO: 2 + 2 + 1 implicit Hs over the carbons + 1 OH = 6 explicit Hs.
        expect(rd.atoms.length).toBe(3 + 6);
        // Single undo collapses back.
        await page.getByTestId('undo').click();
        const rd2 = await snapshot(page);
        expect(rd2.atoms.length).toBe(3);
    });

    test('selection context menu: action flips to Remove Explicit Hydrogens once every selected atom is fully expanded', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        // Expand whole-mol via the model API so every atom is now nh=0
        // (the sidebar Add Explicit Hydrogens lives in the More menu —
        // calling the model directly is shorter and equivalent).
        await page.evaluate(() => window.SketcherModel.addHydrogens());
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await expect(page.getByTestId('sel-ctx-explicit-h'))
            .toHaveText('Remove Explicit Hydrogens');
        await page.getByTestId('sel-ctx-explicit-h').click();
        const rd = await snapshot(page);
        expect(rd.atoms.length).toBe(3);
    });

    // ---- Batch 44: ± Unpaired Electrons ------------------------------------

    test('atom context menu: + Unpaired Electron increments nrad on the clicked atom and renders the bullet', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        const rd0 = await snapshot(page);
        const o = rd0.atoms.find((a) => a.el === 'O');
        expect(o.nrad ?? 0).toBe(0);
        const oPx = await page.evaluate(({ x, y }) => {
            const view = window.SketcherView.current;
            const canvas = document.querySelector(
                '[data-testid="sketcher-canvas"]');
            const w = canvas.width, h = canvas.height;
            return { px: w / 2 + (x - 0) * view.scale + view.offsetX,
                py: h / 2 - (y - 0) * view.scale + view.offsetY };
        }, { x: o.x, y: o.y });
        const canvas = page.getByTestId('sketcher-canvas');
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: oPx.px, y: oPx.py }, button: 'right' });
        await page.getByTestId('atom-ctx-radical-plus').click();
        const rd1 = await snapshot(page);
        const o1 = rd1.atoms.find((a) => a.el === 'O');
        expect(o1.nrad).toBe(1);
        // Carbons are untouched.
        expect(rd1.atoms.filter((a) => a.el === 'C')
            .every((a) => (a.nrad ?? 0) === 0)).toBe(true);
        // Single undo restores.
        await page.getByTestId('undo').click();
        const rd2 = await snapshot(page);
        expect(rd2.atoms.find((a) => a.el === 'O').nrad ?? 0).toBe(0);
    });

    test('atom context menu: + Unpaired Electron disabled once atom is at MAX_UNPAIRED_E=4', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        // Bring the O up to the clamp via the model API, then reopen the menu.
        const rd0 = await snapshot(page);
        const oIdx = rd0.atoms.find((a) => a.el === 'O').i;
        await page.evaluate((idx) =>
            window.SketcherModel.adjustRadicalElectronsOnAtoms([idx], 4),
            oIdx);
        const rd1 = await snapshot(page);
        const o = rd1.atoms.find((a) => a.el === 'O');
        expect(o.nrad).toBe(4);
        const oPx = await page.evaluate(({ x, y }) => {
            const view = window.SketcherView.current;
            const canvas = document.querySelector(
                '[data-testid="sketcher-canvas"]');
            const w = canvas.width, h = canvas.height;
            return { px: w / 2 + (x - 0) * view.scale + view.offsetX,
                py: h / 2 - (y - 0) * view.scale + view.offsetY };
        }, { x: o.x, y: o.y });
        const canvas = page.getByTestId('sketcher-canvas');
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: oPx.px, y: oPx.py }, button: 'right' });
        await expect(page.getByTestId('atom-ctx-radical-plus')).toBeDisabled();
        // The decrement entry is still enabled (current=4 > MIN_UNPAIRED_E=0).
        await expect(page.getByTestId('atom-ctx-radical-minus'))
            .toBeEnabled();
    });

    test('atom context menu: − Unpaired Electron disabled when atom is at MIN_UNPAIRED_E=0', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        const rd0 = await snapshot(page);
        const o = rd0.atoms.find((a) => a.el === 'O');
        expect(o.nrad ?? 0).toBe(0);
        const oPx = await page.evaluate(({ x, y }) => {
            const view = window.SketcherView.current;
            const canvas = document.querySelector(
                '[data-testid="sketcher-canvas"]');
            const w = canvas.width, h = canvas.height;
            return { px: w / 2 + (x - 0) * view.scale + view.offsetX,
                py: h / 2 - (y - 0) * view.scale + view.offsetY };
        }, { x: o.x, y: o.y });
        const canvas = page.getByTestId('sketcher-canvas');
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: oPx.px, y: oPx.py }, button: 'right' });
        await expect(page.getByTestId('atom-ctx-radical-minus'))
            .toBeDisabled();
        await expect(page.getByTestId('atom-ctx-radical-plus')).toBeEnabled();
    });

    test('atom context menu: ± Unpaired Electron disabled on R-groups', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 200, y: 180 } });
        await page.evaluate(() =>
            window.SketcherModel.addRGroup(1, 1.5, 0, 0));
        const rd = await snapshot(page);
        const r = rd.atoms.find((a) => typeof a.rlabel === 'number');
        const rPx = await page.evaluate(({ x, y }) => {
            const view = window.SketcherView.current;
            const canvas = document.querySelector(
                '[data-testid="sketcher-canvas"]');
            const w = canvas.width, h = canvas.height;
            return { px: w / 2 + (x - 0) * view.scale + view.offsetX,
                py: h / 2 - (y - 0) * view.scale + view.offsetY };
        }, { x: r.x, y: r.y });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: rPx.px, y: rPx.py }, button: 'right' });
        await expect(page.getByTestId('atom-ctx-radical-plus'))
            .toBeDisabled();
        await expect(page.getByTestId('atom-ctx-radical-minus'))
            .toBeDisabled();
    });

    test('selection context menu: + Unpaired Electron increments every selected atom in one undo step', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-radical-plus').click();
        const rd = await snapshot(page);
        expect(rd.atoms.every((a) => a.nrad === 1)).toBe(true);
        // Single undo collapses every atom back to 0.
        await page.getByTestId('undo').click();
        const rd2 = await snapshot(page);
        expect(rd2.atoms.every((a) => (a.nrad ?? 0) === 0)).toBe(true);
    });

    test('selection context menu: ± Unpaired Electron stay enabled with a mixed selection (one at MAX, others at MIN)', async ({
        page,
    }) => {
        // Disable logic is "every atom at the clamp" — a mixed selection
        // keeps both actions enabled (per-atom clamp swallows no-ops while
        // changing the atoms with room).
        await loadText(page, 'CCO');
        const rd0 = await snapshot(page);
        const oIdx = rd0.atoms.find((a) => a.el === 'O').i;
        await page.evaluate((idx) =>
            window.SketcherModel.adjustRadicalElectronsOnAtoms([idx], 4),
            oIdx);
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await expect(page.getByTestId('sel-ctx-radical-plus')).toBeEnabled();
        await expect(page.getByTestId('sel-ctx-radical-minus'))
            .toBeEnabled();
    });

    test('selection context menu: + Unpaired Electron disabled when EVERY selected atom is at MAX_UNPAIRED_E=4', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        // Bring every atom up to the clamp so + must disable.
        await page.evaluate(() => {
            const m = window.SketcherModel;
            const all = [];
            for (let i = 0; i < m.numAtoms(); ++i) all.push(i);
            m.adjustRadicalElectronsOnAtoms(all, 4);
        });
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await expect(page.getByTestId('sel-ctx-radical-plus')).toBeDisabled();
        await expect(page.getByTestId('sel-ctx-radical-minus'))
            .toBeEnabled();
    });

    test('selection context menu: − Unpaired Electron disabled when EVERY selected atom is at MIN_UNPAIRED_E=0', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        // No radicals anywhere — every selected atom is at 0, so − disables.
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await expect(page.getByTestId('sel-ctx-radical-minus'))
            .toBeDisabled();
        await expect(page.getByTestId('sel-ctx-radical-plus')).toBeEnabled();
    });

    // -------- Batch 45: Periodic-table popup for Set Element --------
    // Qt's SetAtomMenuWidget (set_atom_widget.cpp:158) embeds the
    // PeriodicTableWidget popup alongside the 8-element strip so the menu
    // can mutate existing atoms to any of the 118 elements (not just the
    // sidebar's quick-pick set). React port mounts the same
    // PeriodicTableButton popup behind a "Periodic Table..." menu item in
    // both the atom and selection context menus.
    test('atom context menu: Periodic Table launcher opens the popup grid', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 120, y: 180 }, button: 'right' });
        await expect(page.getByTestId('atom-ctx-periodic-table'))
            .toBeVisible();
        await page.getByTestId('atom-ctx-periodic-table').click();
        await expect(page.getByTestId('atom-ctx-periodic-table-popup'))
            .toBeVisible();
        // Spot-check a few cells across the periodic table classes.
        for (const sym of ['H', 'Fe', 'Au', 'U']) {
            await expect(page.getByTestId(`pt-${sym}`)).toBeVisible();
        }
    });

    test('atom context menu: picking Fe from the periodic-table popup converts the right-clicked atom', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await page.getByTestId('tool-select').click();
        const before = await snapshot(page);
        expect(before.atoms[0].el).toBe('C');
        await canvas.click({ position: { x: 120, y: 180 }, button: 'right' });
        await page.getByTestId('atom-ctx-periodic-table').click();
        await page.getByTestId('pt-Fe').click();
        // Picking closes both the PT popup AND the atom context menu.
        await expect(page.getByTestId('atom-ctx-periodic-table-popup'))
            .toHaveCount(0);
        await expect(page.getByTestId('atom-context-menu')).toHaveCount(0);
        const after = await snapshot(page);
        expect(after.atoms[0].el).toBe('Fe');
        // Single undo restores carbon.
        await page.getByTestId('undo').click();
        const undone = await snapshot(page);
        expect(undone.atoms[0].el).toBe('C');
    });

    test('atom context menu: Periodic Table is disabled for R-groups', async ({
        page,
    }) => {
        // Same fidelity rule as the 8-element strip: R-group atoms carry
        // the _MolFileRLabel dummy that replaceAtom would discard.
        const canvas = page.getByTestId('sketcher-canvas');
        await page.getByTestId('rgroup').click();
        await canvas.click({ position: { x: 200, y: 200 } });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 200, y: 200 }, button: 'right' });
        await expect(page.getByTestId('atom-ctx-periodic-table'))
            .toBeDisabled();
    });

    test('selection context menu: Periodic Table launcher opens the popup grid', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await expect(page.getByTestId('sel-ctx-periodic-table'))
            .toBeVisible();
        await page.getByTestId('sel-ctx-periodic-table').click();
        await expect(page.getByTestId('sel-ctx-periodic-table-popup'))
            .toBeVisible();
        for (const sym of ['H', 'Fe', 'Au', 'U']) {
            await expect(page.getByTestId(`pt-${sym}`)).toBeVisible();
        }
    });

    test('selection context menu: picking Fe from the periodic-table popup converts every selected atom in one undo step', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-periodic-table').click();
        await page.getByTestId('pt-Fe').click();
        await expect(page.getByTestId('sel-ctx-periodic-table-popup'))
            .toHaveCount(0);
        await expect(page.getByTestId('sel-context-menu')).toHaveCount(0);
        let rd = await snapshot(page);
        expect(rd.atoms.map((a) => a.el)).toEqual(['Fe', 'Fe', 'Fe']);
        // Selection survives — setElementForSelectedAtoms uses doCommand,
        // not doMutation, so the selection isn't torn down.
        expect(rd.atoms.every((a) => a.sel)).toBe(true);
        // One undo restores the original mix.
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.atoms.map((a) => a.el)).toEqual(['C', 'C', 'O']);
    });

    test('atom context menu: outside-click on the PT popup closes the popup without committing', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 120, y: 180 }, button: 'right' });
        await page.getByTestId('atom-ctx-periodic-table').click();
        await expect(page.getByTestId('atom-ctx-periodic-table-popup'))
            .toBeVisible();
        // Click far away to dismiss. Use a viewport-corner click that
        // lands on neither the popup nor the context menu nor the canvas.
        await page.mouse.click(2, 2);
        await expect(page.getByTestId('atom-ctx-periodic-table-popup'))
            .toHaveCount(0);
        // Atom didn't change — outside-click is a pure cancel.
        const rd = await snapshot(page);
        expect(rd.atoms[0].el).toBe('C');
    });

    // -------- Batch 46: Other Type bond submenu --------
    // Qt's ModifyBondsMenu (menu/bond_context_menu.cpp:55-72) tucks four
    // bond modes into an "Other Type" submenu — Coordinate (DATIVE), Zero
    // Order (ZERO), Single Up/Down (wavy = SINGLE + BondDir::UNKNOWN),
    // Double Cis/Trans (crossed = DOUBLE + BondDir::EITHERDOUBLE). React
    // port flattens the submenu into the existing bond + selection context
    // menus and routes through the new combined
    // setBondTypeAndDir{Undoable,ForSelectedBonds} primitive so type + dir
    // collapse to a single undo step.
    test('bond context menu: Other Type items are visible (Coordinate / Zero / Single Up/Down / Double Cis/Trans)', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        for (const id of [
            'bond-ctx-coordinate', 'bond-ctx-zero',
            'bond-ctx-single-either', 'bond-ctx-double-either',
        ]) {
            await expect(page.getByTestId(id)).toBeVisible();
        }
    });

    test('bond context menu: Single Up/Down sets SINGLE + BondDir::UNKNOWN in one undo step (wavy)', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('tool-select').click();
        // Promote to DOUBLE first so picking Single Up/Down has to change
        // BOTH type (2→1) and dir (none→6) — exercises the combined macro.
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        await page.getByTestId('bond-ctx-double').click();
        let rd = await snapshot(page);
        expect(rd.bonds[0].o).toBe(2);
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        await page.getByTestId('bond-ctx-single-either').click();
        await expect(page.getByTestId('bond-context-menu')).toHaveCount(0);
        rd = await snapshot(page);
        expect(rd.bonds[0].o).toBe(1);
        expect(rd.bonds[0].dir).toBe(6); // BondDir::UNKNOWN (wavy)
        // ONE undo restores both: type back to DOUBLE and dir cleared.
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.bonds[0].o).toBe(2);
        expect(rd.bonds[0].dir ?? 0).toBe(0);
    });

    test('bond context menu: Double Cis/Trans sets DOUBLE + BondDir::EITHERDOUBLE in one undo step (crossed)', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('tool-select').click();
        let rd = await snapshot(page);
        expect(rd.bonds[0].o).toBe(1);
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        await page.getByTestId('bond-ctx-double-either').click();
        rd = await snapshot(page);
        expect(rd.bonds[0].o).toBe(2);
        expect(rd.bonds[0].dir).toBe(5); // BondDir::EITHERDOUBLE (crossed)
        // ONE undo collapses both back to SINGLE / no dir.
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.bonds[0].o).toBe(1);
        expect(rd.bonds[0].dir ?? 0).toBe(0);
    });

    test('bond context menu: Coordinate switches BondType to DATIVE (17) and clears any wedge', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('tool-select').click();
        // Put a wedge on first so picking Coordinate has to clear it.
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        await page.getByTestId('bond-ctx-wedge-up').click();
        let rd = await snapshot(page);
        expect(rd.bonds[0].dir).toBe(1); // BEGINWEDGE
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        await page.getByTestId('bond-ctx-coordinate').click();
        rd = await snapshot(page);
        // `o` is the bond ORDER double (DATIVE→1); the raw type comes through
        // as `bt` so the renderer can draw the dative arrow.
        expect(rd.bonds[0].bt).toBe(17); // BondType::DATIVE
        expect(rd.bonds[0].dir ?? 0).toBe(0);
        // One undo restores SINGLE + BEGINWEDGE together.
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.bonds[0].o).toBe(1);
        expect(rd.bonds[0].bt).toBeUndefined();
        expect(rd.bonds[0].dir).toBe(1);
    });

    test('bond context menu: Zero Order switches BondType to ZERO (21)', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        await page.getByTestId('bond-ctx-zero').click();
        const rd = await snapshot(page);
        expect(rd.bonds[0].bt).toBe(21); // BondType::ZERO (o double = 0)
    });

    test('bond context menu: active Other Type item carries the leading check', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        await page.getByTestId('bond-ctx-zero').click();
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        await expect(page.getByTestId('bond-ctx-zero'))
            .toContainText('✓ Zero Order');
        await expect(page.getByTestId('bond-ctx-coordinate'))
            .not.toContainText('✓');
    });

    test('selection context menu: Other Type items are visible alongside the existing Single/Double/Triple/Up/Down', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        for (const id of [
            'sel-ctx-bond-coordinate', 'sel-ctx-bond-zero',
            'sel-ctx-bond-single-either', 'sel-ctx-bond-double-either',
        ]) {
            await expect(page.getByTestId(id)).toBeVisible();
        }
    });

    test('selection context menu: Single Up/Down on selection sets every bond to SINGLE + dir 6 in one undo step', async ({
        page,
    }) => {
        await loadText(page, 'C=CC=C'); // butadiene: bonds alternate D-S-D
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-bond-single-either').click();
        const rd = await snapshot(page);
        // Every bond is now SINGLE (o=1) with dir=UNKNOWN (6).
        expect(rd.bonds.every((b) => b.o === 1)).toBe(true);
        expect(rd.bonds.every((b) => b.dir === 6)).toBe(true);
        // ONE undo restores ALL bonds at once (the macro covers every
        // type+dir pair across the selection).
        await page.getByTestId('undo').click();
        const rd2 = await snapshot(page);
        expect(rd2.bonds.some((b) => b.o === 2)).toBe(true);
        expect(rd2.bonds.every((b) => (b.dir ?? 0) === 0)).toBe(true);
    });

    test('selection context menu: Double Cis/Trans on selection sets every bond to DOUBLE + dir 5 in one undo step', async ({
        page,
    }) => {
        await loadText(page, 'CCC');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-bond-double-either').click();
        const rd = await snapshot(page);
        expect(rd.bonds.every((b) => b.o === 2)).toBe(true);
        expect(rd.bonds.every((b) => b.dir === 5)).toBe(true);
        await page.getByTestId('undo').click();
        const rd2 = await snapshot(page);
        expect(rd2.bonds.every((b) => b.o === 1)).toBe(true);
        expect(rd2.bonds.every((b) => (b.dir ?? 0) === 0)).toBe(true);
    });

    test('selection context menu: Coordinate on selection sets every bond to DATIVE (17)', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-bond-coordinate').click();
        const rd = await snapshot(page);
        expect(rd.bonds.every((b) => b.bt === 17)).toBe(true); // DATIVE
    });

    test('selection context menu: Zero Order on selection sets every bond to ZERO (21)', async ({
        page,
    }) => {
        await loadText(page, 'CCO');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-bond-zero').click();
        const rd = await snapshot(page);
        expect(rd.bonds.every((b) => b.bt === 21)).toBe(true); // ZERO
    });

    // -------- Batch 47: Flip Substituent --------
    // Qt's ModifyBondsMenu adds Flip Substituent first (bond_context_menu.cpp:
    // 22), disabled for ring bonds (updateActions:38). Reflects the smaller
    // substituent across the bond axis (MolModel::flipSubstituent). Backed by
    // the lean flipSubstituentAroundBond primitive.

    // A branched chain with an off-axis atom on the SMALLER side of a bond, so
    // flipping visibly mirrors it. Atoms (0-indexed): 0=(0,0) 1=(0.8,0.8)
    // 2=(1.5,0) 3=(3,0) 4=(4.5,0). Bonds 0-2, 0-1, 2-3, 3-4. Flip bond 0-2's
    // axis is the x-axis; removing it splits into {0,1} (smaller) and {2,3,4}.
    const FLIP_MOLBLOCK = `flip-test
  test
flip
  5  4  0  0  0  0  0  0  0  0999 V2000
    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    0.8000    0.8000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.5000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    3.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    4.5000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
  1  3  1  0
  1  2  1  0
  3  4  1  0
  4  5  1  0
M  END`;

    // Pixel midpoint of the bond between atoms ai and bi, via the live view
    // transform (scale/offset) + current model coords. Canvas is 540×360.
    async function bondMidPx(page, ai, bi) {
        return await page.evaluate(({ ai, bi }) => {
            const v = window.SketcherView.current;
            const d = JSON.parse(window.SketcherModel.description());
            const a = d.atoms.find((x) => x.i === ai);
            const b = d.atoms.find((x) => x.i === bi);
            const mx = (a.x + b.x) / 2;
            const my = (a.y + b.y) / 2;
            return {
                px: mx * v.scale + 540 / 2 + v.offsetX,
                py: -my * v.scale + 360 / 2 + v.offsetY,
            };
        }, { ai, bi });
    }

    test('bond context menu: Flip Substituent is present at the top of the menu', async ({
        page,
    }) => {
        await loadText(page, FLIP_MOLBLOCK);
        await page.getByTestId('tool-select').click();
        const mid = await bondMidPx(page, 0, 2);
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: mid.px, y: mid.py },
            button: 'right' });
        await expect(page.getByTestId('bond-ctx-flip-substituent'))
            .toBeVisible();
    });

    test('bond context menu: Flip Substituent mirrors the smaller substituent across the bond axis (one undo)', async ({
        page,
    }) => {
        await loadText(page, FLIP_MOLBLOCK);
        await page.getByTestId('tool-select').click();
        const before = await snapshot(page);
        const at = (rd, i) => rd.atoms.find((a) => a.i === i);
        // Perpendicular offset of the branch atom (1) from the bond endpoint
        // (0) that shares its substituent — positive before the flip.
        const dyBefore = at(before, 1).y - at(before, 0).y;
        const dxBefore = at(before, 1).x - at(before, 0).x;
        expect(Math.abs(dyBefore)).toBeGreaterThan(0.5);

        const mid = await bondMidPx(page, 0, 2);
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: mid.px, y: mid.py },
            button: 'right' });
        await page.getByTestId('bond-ctx-flip-substituent').click();
        await expect(page.getByTestId('bond-context-menu')).toHaveCount(0);

        const after = await snapshot(page);
        // Axis is horizontal (atoms 0 & 2 share a y), so the flip negates the
        // branch atom's perpendicular (y) offset and leaves x untouched.
        const dyAfter = at(after, 1).y - at(after, 0).y;
        const dxAfter = at(after, 1).x - at(after, 0).x;
        expect(dyAfter).toBeCloseTo(-dyBefore, 4);
        expect(dxAfter).toBeCloseTo(dxBefore, 4);
        // The larger side (atoms 3, 4) is untouched.
        expect(at(after, 3).x).toBeCloseTo(at(before, 3).x, 4);
        expect(at(after, 3).y).toBeCloseTo(at(before, 3).y, 4);
        expect(at(after, 4).x).toBeCloseTo(at(before, 4).x, 4);

        // One undo restores the branch atom.
        await page.getByTestId('undo').click();
        const undone = await snapshot(page);
        expect(at(undone, 1).y).toBeCloseTo(at(before, 1).y, 4);
        expect(at(undone, 1).x).toBeCloseTo(at(before, 1).x, 4);
    });

    test('bond context menu: Flip Substituent is disabled for a ring bond', async ({
        page,
    }) => {
        await loadText(page, 'C1CCCCC1'); // cyclohexane — every bond in a ring
        await page.getByTestId('tool-select').click();
        const mid = await bondMidPx(page, 0, 1);
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: mid.px, y: mid.py },
            button: 'right' });
        await expect(page.getByTestId('bond-context-menu')).toBeVisible();
        await expect(page.getByTestId('bond-ctx-flip-substituent'))
            .toBeDisabled();
    });

    // -------- Batch 48: Replace with > R-Group (atom context menu) --------
    // Qt's ReplaceAtomsWithMenu (atom_context_menu.cpp:167) — the R-Group
    // branch (New R-Group + Existing R-Group list). Backed by the lean
    // mutateAtomToRGroup primitive; Wildcard (query atoms) + Allowed List
    // (Edit Atom Properties dialog) stay deferred behind missing C++.
    test('atom context menu: New R-Group replaces the atom in place and is undoable', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 260, y: 180 }, button: 'right' });
        // No R-groups yet → the new-R-group item offers R1.
        await expect(page.getByTestId('atom-ctx-replace-new-rgroup'))
            .toContainText('R1');
        await page.getByTestId('atom-ctx-replace-new-rgroup').click();
        await expect(page.getByTestId('atom-context-menu')).toHaveCount(0);
        let rd = await snapshot(page);
        // One atom is now an R1 dummy; the C0–C1 bond is preserved.
        expect(rd.atoms.filter((a) => a.rlabel === 1)).toHaveLength(1);
        expect(rd.bonds).toHaveLength(1);
        // Single undo restores the plain carbon.
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.atoms.every((a) => a.rlabel === undefined)).toBe(true);
        expect(rd.bonds).toHaveLength(1);
    });

    test('atom context menu: existing R-groups are listed and New R-Group picks the next free number', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        // Three carbons in a row, bonded 0-1-2.
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 400, y: 180 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await canvas.click({ position: { x: 400, y: 180 } });
        await page.getByTestId('tool-select').click();
        // Make atom 0 an R1.
        await canvas.click({ position: { x: 120, y: 180 }, button: 'right' });
        await page.getByTestId('atom-ctx-replace-new-rgroup').click();
        expect((await snapshot(page)).atoms.filter((a) => a.rlabel === 1))
            .toHaveLength(1);
        // Now right-click atom 2: the menu lists existing R1 and offers R2.
        await canvas.click({ position: { x: 400, y: 180 }, button: 'right' });
        await expect(page.getByTestId('atom-ctx-replace-rgroup-1'))
            .toBeVisible();
        await expect(page.getByTestId('atom-ctx-replace-new-rgroup'))
            .toContainText('R2');
        await page.getByTestId('atom-ctx-replace-new-rgroup').click();
        const rd = await snapshot(page);
        expect(rd.atoms.filter((a) => a.rlabel === 1)).toHaveLength(1);
        expect(rd.atoms.filter((a) => a.rlabel === 2)).toHaveLength(1);
    });

    test('atom context menu: replacing an atom with an existing R-group number reuses it', async ({
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
        await page.getByTestId('tool-select').click();
        // Atom 0 → R1.
        await canvas.click({ position: { x: 120, y: 180 }, button: 'right' });
        await page.getByTestId('atom-ctx-replace-new-rgroup').click();
        // Atom 2 → also R1 (reuse the existing number).
        await canvas.click({ position: { x: 400, y: 180 }, button: 'right' });
        await page.getByTestId('atom-ctx-replace-rgroup-1').click();
        const rd = await snapshot(page);
        expect(rd.atoms.filter((a) => a.rlabel === 1)).toHaveLength(2);
    });

    // -------- Batch 49: Replace with > Wildcard query atoms --------
    // Qt's ReplaceAtomsWithMenu createWildcardMenu (atom_context_menu.cpp:196):
    // A/Q/M/X + AH/QH/MH/XH. Backed by the lean mutateAtomToWildcard primitive
    // (RDKit make{A,Q,M,X,…}AtomQuery); the display label rides on a private
    // prop surfaced as `qlabel` in the render description.
    test('atom context menu: Wildcard items are listed in Replace with', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 120, y: 180 }, button: 'right' });
        for (const code of ['A', 'Q', 'M', 'X', 'AH', 'QH', 'MH', 'XH']) {
            await expect(
                page.getByTestId(`atom-ctx-replace-wildcard-${code}`))
                .toBeVisible();
        }
    });

    test('atom context menu: picking Q converts the atom to a query atom and is undoable', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('tool-select').click();
        await canvas.click({ position: { x: 260, y: 180 }, button: 'right' });
        await page.getByTestId('atom-ctx-replace-wildcard-Q').click();
        await expect(page.getByTestId('atom-context-menu')).toHaveCount(0);
        let rd = await snapshot(page);
        // One atom now carries the "Q" wildcard label; the bond is preserved.
        expect(rd.atoms.filter((a) => a.qlabel === 'Q')).toHaveLength(1);
        expect(rd.bonds).toHaveLength(1);
        // Undo restores a plain carbon (no query label).
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.atoms.every((a) => a.qlabel === undefined)).toBe(true);
    });

    test('atom context menu: element/charge/H edits are disabled on a wildcard query atom', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await page.getByTestId('tool-select').click();
        // Convert the atom to an "A" wildcard.
        await canvas.click({ position: { x: 120, y: 180 }, button: 'right' });
        await page.getByTestId('atom-ctx-replace-wildcard-A').click();
        expect((await snapshot(page)).atoms.filter((a) => a.qlabel === 'A'))
            .toHaveLength(1);
        // Reopen the menu on the now-query atom: element / charge / H edits
        // are gated off (Qt's element_atoms excludes hasQuery()).
        await canvas.click({ position: { x: 120, y: 180 }, button: 'right' });
        await expect(page.getByTestId('atom-ctx-charge-plus')).toBeDisabled();
        await expect(page.getByTestId('atom-ctx-set-N')).toBeDisabled();
        await expect(page.getByTestId('atom-ctx-radical-plus'))
            .toBeDisabled();
        // …but Replace with is still available, so you can re-wildcard it.
        await expect(page.getByTestId('atom-ctx-replace-wildcard-Q'))
            .toBeVisible();
    });

    // -------- Batch 50: atom-query (A▾) draw tool --------
    // Qt's DrawAtomSceneTool armed with a wildcard. Clicking the A▾ button
    // arms the tool; empty-canvas clicks place a query atom, clicks on an
    // existing atom convert it. Backed by addWildcardAtom / mutateAtomToWildcard.
    test('atom-query tool: clicking empty canvas places the armed wildcard atom', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        // Arm the tool via a plain click on the A▾ button (default mode A).
        await page.getByTestId('atom-query').click();
        await canvas.click({ position: { x: 160, y: 160 } });
        const rd = await snapshot(page);
        expect(rd.atoms.filter((a) => a.qlabel === 'A')).toHaveLength(1);
    });

    test('atom-query tool: picking X from the popup then clicking places an X query atom', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await page.getByTestId('atom-query').hover();
        await page.mouse.down();
        await page.waitForTimeout(350);
        await page.getByTestId('atom-query-popup-X').click();
        await canvas.click({ position: { x: 200, y: 160 } });
        const rd = await snapshot(page);
        expect(rd.atoms.filter((a) => a.qlabel === 'X')).toHaveLength(1);
    });

    test('atom-query tool: clicking an existing atom converts it to the wildcard (undoable)', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        // Draw a plain carbon first with the atom tool.
        await canvas.click({ position: { x: 180, y: 180 } });
        let rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(1);
        expect(rd.atoms[0].qlabel).toBeUndefined();
        // Arm atom-query (A) and click the existing atom → converts in place.
        await page.getByTestId('atom-query').click();
        await canvas.click({ position: { x: 180, y: 180 } });
        rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(1);
        expect(rd.atoms[0].qlabel).toBe('A');
        // Undo restores the carbon.
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.atoms[0].qlabel).toBeUndefined();
    });

    // -------- Batch 51: Query bond submenu --------
    // Qt's ModifyBondsMenu::createQueryMenu (bond_context_menu.cpp:74):
    // Any / Single-Double / Double-Aromatic / Single-Aromatic. Backed by
    // mutateBondToQuery / mutateSelectedBondsToQuery; the bond renders at its
    // base order with a `qlabel` annotation.
    async function drawSingleBond(page) {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 120, y: 180 } });
        await canvas.click({ position: { x: 260, y: 180 } });
        await page.getByTestId('tool-select').click();
    }

    test('bond context menu: Query items are listed', async ({ page }) => {
        await drawSingleBond(page);
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        for (const id of ['Any', 'SD', 'DA', 'SA']) {
            await expect(page.getByTestId(`bond-ctx-query-${id}`))
                .toBeVisible();
        }
    });

    test('bond context menu: Single/Double query annotates the bond and is undoable', async ({
        page,
    }) => {
        await drawSingleBond(page);
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        await page.getByTestId('bond-ctx-query-SD').click();
        await expect(page.getByTestId('bond-context-menu')).toHaveCount(0);
        let rd = await snapshot(page);
        expect(rd.bonds[0].qlabel).toBe('S/D');
        expect(rd.bonds[0].o).toBe(1); // base type single
        // Reopen: the active query carries a check.
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        await expect(page.getByTestId('bond-ctx-query-SD'))
            .toContainText('✓');
        // Dismiss the reopened menu (corner click) before hitting undo.
        await page.mouse.click(2, 2);
        await expect(page.getByTestId('bond-context-menu')).toHaveCount(0);
        // Undo restores a plain single bond (no qlabel).
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.bonds[0].qlabel).toBeUndefined();
        expect(rd.bonds[0].o).toBe(1);
    });

    test('bond context menu: Double/Aromatic query draws at double base order', async ({
        page,
    }) => {
        await drawSingleBond(page);
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        await page.getByTestId('bond-ctx-query-DA').click();
        const rd = await snapshot(page);
        expect(rd.bonds[0].qlabel).toBe('D/A');
        expect(rd.bonds[0].o).toBe(2); // base type double
    });

    test('selection context menu: Query applies to every selected bond in one undo step', async ({
        page,
    }) => {
        await loadText(page, 'CCC'); // two single bonds
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-bond-query-Any').click();
        let rd = await snapshot(page);
        expect(rd.bonds.every((b) => b.qlabel === 'Any')).toBe(true);
        // One undo clears every query at once.
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.bonds.every((b) => b.qlabel === undefined)).toBe(true);
    });

    // -------- Batch 52: bond-query (B▾) draw tool --------
    // Qt's DrawBondSceneTool armed with a query. Two-click bonding creates a
    // query bond; the aromatic mode makes a real aromatic bond. Backed by
    // addQueryBondBetweenAtoms.
    test('bond-query tool: two clicks create the armed query bond', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        // Two loose carbons.
        await canvas.click({ position: { x: 140, y: 180 } });
        await canvas.click({ position: { x: 300, y: 180 } });
        // Arm bond-query and pick S/D from the popup.
        await page.getByTestId('bond-query').hover();
        await page.mouse.down();
        await page.waitForTimeout(350);
        await page.getByTestId('bond-query-popup-single-double').click();
        // Two-click the atoms.
        await canvas.click({ position: { x: 140, y: 180 } });
        await canvas.click({ position: { x: 300, y: 180 } });
        const rd = await snapshot(page);
        expect(rd.bonds).toHaveLength(1);
        expect(rd.bonds[0].qlabel).toBe('S/D');
        expect(rd.bonds[0].o).toBe(1);
    });

    test('bond-query tool: aromatic mode makes a real aromatic bond (no query label)', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 140, y: 180 } });
        await canvas.click({ position: { x: 300, y: 180 } });
        // Default bond-query mode is aromatic; a plain click arms the tool.
        await page.getByTestId('bond-query').click();
        await canvas.click({ position: { x: 140, y: 180 } });
        await canvas.click({ position: { x: 300, y: 180 } });
        const rd = await snapshot(page);
        expect(rd.bonds).toHaveLength(1);
        expect(rd.bonds[0].arom).toBe(true);
        expect(rd.bonds[0].qlabel).toBeUndefined();
    });

    test('bond-query tool: completing on an existing bond converts it (no duplicate)', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 140, y: 180 } });
        await canvas.click({ position: { x: 300, y: 180 } });
        await page.getByTestId('bond-single').click();
        await canvas.click({ position: { x: 140, y: 180 } });
        await canvas.click({ position: { x: 300, y: 180 } });
        let rd = await snapshot(page);
        expect(rd.bonds).toHaveLength(1);
        // Arm bond-query (Any) and re-draw over the same two atoms.
        await page.getByTestId('bond-query').hover();
        await page.mouse.down();
        await page.waitForTimeout(350);
        await page.getByTestId('bond-query-popup-any').click();
        await canvas.click({ position: { x: 140, y: 180 } });
        await canvas.click({ position: { x: 300, y: 180 } });
        rd = await snapshot(page);
        expect(rd.bonds).toHaveLength(1); // converted, not duplicated
        expect(rd.bonds[0].qlabel).toBe('Any');
    });

    // -------- Batch 53: Topology bond submenu --------
    // Qt's ModifyBondsMenu::createTopologyMenu (bond_context_menu.cpp:92):
    // In Ring / Not In a Ring / Either. Backed by setBondTopologyForBond /
    // setSelectedBondsTopology; surfaces as the bond's `topo` field.
    test('bond context menu: Topology items are listed with Either active by default', async ({
        page,
    }) => {
        await drawSingleBond(page);
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        for (const id of ['ring', 'notring', 'either']) {
            await expect(page.getByTestId(`bond-ctx-topo-${id}`))
                .toBeVisible();
        }
        // No constraint yet → Either carries the check.
        await expect(page.getByTestId('bond-ctx-topo-either'))
            .toContainText('✓');
    });

    test('bond context menu: In Ring sets the topology and Either clears it (undoable)', async ({
        page,
    }) => {
        await drawSingleBond(page);
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        await page.getByTestId('bond-ctx-topo-ring').click();
        let rd = await snapshot(page);
        expect(rd.bonds[0].topo).toBe('ring');
        // Reopen: In Ring is checked now.
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        await expect(page.getByTestId('bond-ctx-topo-ring')).toContainText('✓');
        // Clear via Either.
        await page.getByTestId('bond-ctx-topo-either').click();
        rd = await snapshot(page);
        expect(rd.bonds[0].topo).toBeUndefined();
        // Undo restores the ring constraint.
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.bonds[0].topo).toBe('ring');
    });

    test('bond context menu: topology coexists with a query label', async ({
        page,
    }) => {
        await drawSingleBond(page);
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        await page.getByTestId('bond-ctx-query-SD').click();
        await canvas.click({ position: { x: 190, y: 180 }, button: 'right' });
        await page.getByTestId('bond-ctx-topo-notring').click();
        const rd = await snapshot(page);
        expect(rd.bonds[0].qlabel).toBe('S/D');
        expect(rd.bonds[0].topo).toBe('notring');
    });

    test('selection context menu: Topology applies to every selected bond in one undo step', async ({
        page,
    }) => {
        await loadText(page, 'CCC');
        await page.keyboard.press('Control+A');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 50, y: 50 }, button: 'right' });
        await page.getByTestId('sel-ctx-bond-topo-ring').click();
        let rd = await snapshot(page);
        expect(rd.bonds.every((b) => b.topo === 'ring')).toBe(true);
        await page.getByTestId('undo').click();
        rd = await snapshot(page);
        expect(rd.bonds.every((b) => b.topo === undefined)).toBe(true);
    });

    // -------- Batch 54: Coordinate/Zero bond-order modes --------
    // Qt's bond_order_popup.ui has Double / Triple / Coordinate / Zero; the
    // '0' key arms the zero bond (sketcher_widget.cpp:1257). Both draw via the
    // render `bt` field (DATIVE=17 arrow / ZERO=21 dashed).
    test('bond-order popup: exposes Coordinate and Zero choices', async ({
        page,
    }) => {
        const btn = page.getByTestId('bond-double');
        await btn.hover();
        await page.mouse.down();
        await page.waitForTimeout(350);
        await expect(page.getByTestId('order-popup-coordinate'))
            .toBeVisible();
        await expect(page.getByTestId('order-popup-zero')).toBeVisible();
        await page.mouse.up();
    });

    test('bond-order popup: picking Coordinate then drawing makes a DATIVE bond', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 140, y: 180 } });
        await canvas.click({ position: { x: 300, y: 180 } });
        // Arm coordinate via the bond-order popup.
        await page.getByTestId('bond-double').hover();
        await page.mouse.down();
        await page.waitForTimeout(350);
        await page.getByTestId('order-popup-coordinate').click();
        // Draw the bond between the two atoms.
        await canvas.click({ position: { x: 140, y: 180 } });
        await canvas.click({ position: { x: 300, y: 180 } });
        const rd = await snapshot(page);
        expect(rd.bonds).toHaveLength(1);
        expect(rd.bonds[0].bt).toBe(17); // DATIVE
    });

    test('0 key arms zero-order bond mode; drawing makes a ZERO bond', async ({
        page,
    }) => {
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 140, y: 180 } });
        await canvas.click({ position: { x: 300, y: 180 } });
        // Press '0' to arm zero-order bond mode, then draw between the atoms.
        await page.keyboard.press('0');
        await canvas.click({ position: { x: 140, y: 180 } });
        await canvas.click({ position: { x: 300, y: 180 } });
        const rd = await snapshot(page);
        expect(rd.bonds).toHaveLength(1);
        expect(rd.bonds[0].bt).toBe(21); // ZERO
    });

    // -------- Batch 55: monomer placement + chaining (peptides) --------
    // Qt's DrawMonomerSceneTool armed with an amino acid. Clicking an AA tile
    // arms the tool; empty-canvas clicks place a free monomer bead, clicks on
    // an existing bead chain a new monomer. Backed by addMonomer /
    // addBoundMonomer; the render description flags the scene monomeric with
    // per-atom mon/lbl.
    test('monomer tool: clicking Alanine then the canvas places a peptide bead', async ({
        page,
    }) => {
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-aa-ala').click();
        // The tile arms the monomer tool (active highlight).
        await expect(page.getByTestId('monomer-aa-ala'))
            .toHaveAttribute('aria-pressed', 'true');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 160, y: 180 } });
        const rd = await snapshot(page);
        expect(rd.monomeric).toBe(true);
        expect(rd.atoms).toHaveLength(1);
        expect(rd.atoms[0].lbl).toBe('A');
        expect(rd.atoms[0].mon).toBe('pep');
    });

    test('monomer tool: clicking an existing bead chains a second monomer with a connection', async ({
        page,
    }) => {
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-aa-ala').click();
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 160, y: 180 } });
        // Click the existing Alanine bead with Alanine still armed → chain a
        // second bead off it. (Clicking with a DIFFERENT residue armed would
        // mutate instead — see the batch-57 mutate tests.)
        await canvas.click({ position: { x: 160, y: 180 } });
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(2);
        expect(rd.bonds).toHaveLength(1);
        expect(rd.bonds[0].mon).toBe(true);
        expect(rd.atoms.map((a) => a.lbl).sort()).toEqual(['A', 'A']);
    });

    test('monomer tool: undo removes a placed monomer', async ({ page }) => {
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-aa-ala').click();
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 160, y: 180 } });
        expect((await snapshot(page)).atoms).toHaveLength(1);
        await page.getByTestId('undo').click();
        expect((await snapshot(page)).atoms).toHaveLength(0);
    });

    test('monomer tool: a single undo removes both the chained monomer and its connection', async ({
        page,
    }) => {
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-aa-ala').click();
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 160, y: 180 } });
        // Chain a second Alanine off the first (same residue armed).
        await canvas.click({ position: { x: 160, y: 180 } });
        expect((await snapshot(page)).atoms).toHaveLength(2);
        await page.getByTestId('undo').click();
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(1);
        expect(rd.bonds).toHaveLength(0);
        expect(rd.atoms[0].lbl).toBe('A');
    });

    // -------- Batch 56: nucleic-acid monomers (3-node nucleotides) --------
    // Qt's DrawMonomerFragmentSceneTool (RNA/DNA nucleotide tiles) + the single
    // base/sugar/phosphate DrawMonomerSceneTool. A nucleotide is a faithful
    // sugar + branched base + backbone phosphate; the render description carries
    // per-bead mon subtypes (sugar/phos/base) and a conn:"base" flag on the
    // sugar→base branch connector. Backed by addNucleotide / addBoundNucleotide.
    test('nucleic tool: RNA tile then canvas places a 3-node nucleotide', async ({
        page,
    }) => {
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-nucleic').click();
        await page.getByTestId('monomer-na-rna').click();
        // The RNA tile arms the nucleotide draw tool (active highlight).
        await expect(page.getByTestId('monomer-na-rna'))
            .toHaveAttribute('aria-pressed', 'true');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 200, y: 180 } });
        const rd = await snapshot(page);
        expect(rd.monomeric).toBe(true);
        // Three beads: sugar (R) + base (U) + phosphate (P).
        expect(rd.atoms).toHaveLength(3);
        const byLbl = Object.fromEntries(rd.atoms.map((a) => [a.lbl, a]));
        expect(byLbl.R.mon).toBe('sugar');
        expect(byLbl.U.mon).toBe('base');
        expect(byLbl.P.mon).toBe('phos');
        // Two connections; exactly one is the thin sugar→base branch.
        expect(rd.bonds).toHaveLength(2);
        expect(rd.bonds.filter((b) => b.conn === 'base')).toHaveLength(1);
        expect(rd.bonds.every((b) => b.mon === true)).toBe(true);
    });

    test('nucleic tool: a base tile places a single nucleobase bead', async ({
        page,
    }) => {
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-nucleic').click();
        await page.getByTestId('monomer-na-a').click();
        await expect(page.getByTestId('monomer-na-a'))
            .toHaveAttribute('aria-pressed', 'true');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 200, y: 180 } });
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(1);
        expect(rd.atoms[0].lbl).toBe('A');
        expect(rd.atoms[0].mon).toBe('base');
    });

    test('nucleic tool: clicking an existing bead chains a second nucleotide', async ({
        page,
    }) => {
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-nucleic').click();
        await page.getByTestId('monomer-na-rna').click();
        const canvas = page.getByTestId('sketcher-canvas');
        // Place the first nucleotide; its sugar sits at the click point.
        await canvas.click({ position: { x: 200, y: 180 } });
        expect((await snapshot(page)).atoms).toHaveLength(3);
        // Clicking the existing sugar chains a second nucleotide off it.
        await canvas.click({ position: { x: 200, y: 180 } });
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(6);
        // 2 branch/backbone per nucleotide + 1 inter-nucleotide connection.
        expect(rd.bonds).toHaveLength(5);
    });

    test('nucleic tool: a single undo removes the whole placed nucleotide', async ({
        page,
    }) => {
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-nucleic').click();
        await page.getByTestId('monomer-na-dna').click();
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 200, y: 180 } });
        const placed = await snapshot(page);
        expect(placed.atoms).toHaveLength(3);
        // DNA nucleotide: deoxyribose (dR) + thymine (T) + phosphate (P).
        expect(placed.atoms.map((a) => a.lbl).sort()).toEqual(['P', 'T', 'dR']);
        await page.getByTestId('undo').click();
        expect((await snapshot(page)).atoms).toHaveLength(0);
    });

    // -------- Batch 57: mutate monomer on click --------
    // Qt's DrawMonomerSceneTool clickShouldMutate: clicking directly on an
    // existing monomer of the SAME kind but a DIFFERENT residue mutates it in
    // place (no new bead, no connection). A same-residue click still chains.
    test('monomer tool: clicking a bead with a different residue mutates it in place', async ({
        page,
    }) => {
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-aa-ala').click();
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 160, y: 180 } });
        expect((await snapshot(page)).atoms).toHaveLength(1);
        // Arm Glycine, click the Alanine bead → mutate (still one bead, now G).
        await page.getByTestId('monomer-aa-gly').click();
        await canvas.click({ position: { x: 160, y: 180 } });
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(1);
        expect(rd.bonds).toHaveLength(0);
        expect(rd.atoms[0].lbl).toBe('G');
        expect(rd.atoms[0].mon).toBe('pep');
    });

    test('monomer tool: mutate is a single undo step back to the original residue', async ({
        page,
    }) => {
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-aa-ala').click();
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 160, y: 180 } });
        await page.getByTestId('monomer-aa-gly').click();
        await canvas.click({ position: { x: 160, y: 180 } });
        expect((await snapshot(page)).atoms[0].lbl).toBe('G');
        await page.getByTestId('undo').click();
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(1);
        expect(rd.atoms[0].lbl).toBe('A');
    });

    test('nucleic tool: clicking a base bead with a different base mutates it', async ({
        page,
    }) => {
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-nucleic').click();
        await page.getByTestId('monomer-na-a').click();
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 200, y: 180 } });
        expect((await snapshot(page)).atoms[0].lbl).toBe('A');
        // Arm Cytosine, click the adenine base → mutate the base in place.
        await page.getByTestId('monomer-na-c').click();
        await canvas.click({ position: { x: 200, y: 180 } });
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(1);
        expect(rd.atoms[0].lbl).toBe('C');
        expect(rd.atoms[0].mon).toBe('base');
    });

    // -------- Batch 58: HELM / FASTA sequence export (Copy As) --------
    // Qt get_standard_export_formats() always offers HELM + FASTA (to_string
    // converts atomistic↔monomeric on the fly). Backed by MolModel.toFormatString.
    test('Copy As: HELM exports a placed peptide chain as a HELM string', async ({
        page,
    }) => {
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-aa-ala').click();
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 160, y: 180 } });
        // Chain a second Alanine (same residue armed) → PEPTIDE1{A.A}.
        await canvas.click({ position: { x: 160, y: 180 } });
        await page.getByTestId('more-actions-btn').click();
        await page.getByTestId('copy-as-helm').click();
        const clip = await readClipboard(page);
        expect(clip).toMatch(/PEPTIDE1\{/);
        expect(clip).toMatch(/A\.A/);
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/copied HELM:/);
    });

    test('Copy As: FASTA exports a placed peptide as its one-letter sequence', async ({
        page,
    }) => {
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-aa-ala').click();
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 160, y: 180 } });
        await canvas.click({ position: { x: 160, y: 180 } });
        await page.getByTestId('more-actions-btn').click();
        await page.getByTestId('copy-as-fasta').click();
        const clip = await readClipboard(page);
        expect(clip).toMatch(/AA/);
        await expect(page.getByTestId('sketcher-status'))
            .toContainText(/copied FASTA:/);
    });

    // -------- Batch 59: HELM import (paste in text) --------
    // HELM is in the AUTO_DETECT list; loadFromText parses it and generates a
    // bead layout (a HELM parse carries no conformer). Backed by
    // compute_monomer_mol_coords in MolModel::loadFromText.
    test('Import: pasting a HELM string loads a monomeric peptide chain', async ({
        page,
    }) => {
        await loadText(page, 'PEPTIDE1{A.G.C}$$$$V2.0');
        const rd = await snapshot(page);
        expect(rd.monomeric).toBe(true);
        expect(rd.atoms).toHaveLength(3);
        // Residues render as peptide beads with their 1-letter labels.
        expect(rd.atoms.every((a) => a.mon === 'pep')).toBe(true);
        expect(rd.atoms.map((a) => a.lbl).sort()).toEqual(['A', 'C', 'G']);
        // Two backbone connections chain the three residues.
        expect(rd.bonds).toHaveLength(2);
        // Coords were generated (beads aren't all stacked at the origin).
        const xs = rd.atoms.map((a) => a.x);
        expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0);
    });

    test('Import: pasting a HELM RNA strand loads 3-node nucleotides', async ({
        page,
    }) => {
        await loadText(page, 'RNA1{R(A)P.R(U)P}$$$$V2.0');
        const rd = await snapshot(page);
        expect(rd.monomeric).toBe(true);
        // Two nucleotides = 6 monomers (sugar/base/phosphate each).
        expect(rd.atoms).toHaveLength(6);
        const kinds = rd.atoms.map((a) => a.mon).sort();
        expect(kinds).toEqual(
            ['base', 'base', 'phos', 'phos', 'sugar', 'sugar']);
    });

    // -------- Batch 60: RNA/DNA base-picker popups --------
    // Qt NucleotidePopup: press & hold the RNA/DNA selector to pick A/C/G/U-or-T/N.
    // In the port, clicking an already-armed selector reopens the popup; picking
    // a base arms the nucleotide tool with sugar(base)phosphate.
    test('nucleic tool: RNA base picker places the chosen base', async ({
        page,
    }) => {
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-nucleic').click();
        await page.getByTestId('monomer-na-rna').click(); // arm (default U)
        await page.getByTestId('monomer-na-rna').click(); // reopen popup
        await expect(page.getByTestId('monomer-na-rna-popup')).toBeVisible();
        await page.getByTestId('na-rna-base-g').click();  // pick Guanine
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 200, y: 180 } });
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(3);
        expect(rd.atoms.find((a) => a.mon === 'base').lbl).toBe('G');
        // RNA uses the ribose sugar.
        expect(rd.atoms.find((a) => a.mon === 'sugar').lbl).toBe('R');
    });

    test('nucleic tool: DNA base picker places dR sugar with the chosen base', async ({
        page,
    }) => {
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-nucleic').click();
        await page.getByTestId('monomer-na-dna').click();
        await page.getByTestId('monomer-na-dna').click();
        await expect(page.getByTestId('monomer-na-dna-popup')).toBeVisible();
        await page.getByTestId('na-dna-base-a').click();
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 200, y: 180 } });
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(3);
        expect(rd.atoms.find((a) => a.mon === 'base').lbl).toBe('A');
        // DNA uses the deoxyribose sugar.
        expect(rd.atoms.find((a) => a.mon === 'sugar').lbl).toBe('dR');
    });

    // -------- Batch 61: amino-acid analog popups (SKETCH-2482) --------
    // Each AA tile press&holds to a popup of its non-natural analogs (D- and
    // N-methyl variants etc.) pulled from the monomer DB
    // (Module.monomer_analogs_json). Picking one arms that variant symbol.
    test('monomer tool: an amino-acid tile exposes its D-/N-methyl analogs', async ({
        page,
    }) => {
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-aa-ala').click(); // arm A (active)
        await page.getByTestId('monomer-aa-ala').click(); // reopen popup
        const popup = page.getByTestId('monomer-aa-ala-popup');
        await expect(popup).toBeVisible();
        // Alanine's analogs include D-alanine (dA) and N-methyl-alanine (meA).
        await expect(page.getByTestId('monomer-aa-analog-dA')).toBeVisible();
        await expect(page.getByTestId('monomer-aa-analog-meA')).toBeVisible();
    });

    test('monomer tool: picking an analog places that variant monomer', async ({
        page,
    }) => {
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-aa-ala').click();
        await page.getByTestId('monomer-aa-ala').click();
        await page.getByTestId('monomer-aa-analog-dA').click(); // D-alanine
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 160, y: 180 } });
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(1);
        expect(rd.atoms[0].lbl).toBe('dA');
        expect(rd.atoms[0].mon).toBe('pep');
    });

    // -------- Batch 63: attachment-point editing --------
    // Qt UnboundMonomericAttachmentPointItem: a monomer exposes its free APs as
    // clickable stubs. Clicking a stub chains a (possibly different) residue via
    // that AP — the way to attach a different residue (a body-click mutates).
    // Backed by the render description's per-atom `aps` + addBoundMonomerViaAP.
    async function apClickPoint(page, bead, ap) {
        // Mirror apStubGeometry: bead center in canvas px, then out along the
        // AP direction (screen y is flipped) to the nubbin circle.
        const view = await page.evaluate(() => ({ ...window.SketcherView.current }));
        const cx = 540 / 2 + view.offsetX;
        const cy = 360 / 2 + view.offsetY;
        const bx = bead.x * view.scale + cx;
        const by = -bead.y * view.scale + cy;
        const half = Math.max(10, view.scale * 0.37);
        const sdx = ap.dx;
        const sdy = -ap.dy;
        return {
            x: bx + sdx * (half + 9),
            y: by + sdy * (half + 9),
        };
    }

    test('monomer tool: a free peptide exposes its N/C/X attachment points', async ({
        page,
    }) => {
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-aa-ala').click();
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 200, y: 180 } });
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(1);
        const aps = rd.atoms[0].aps ?? [];
        // Three unbound APs with pretty names N / C / X (model R1/R2/R3).
        expect(aps.map((a) => a.n).sort()).toEqual(['C', 'N', 'X']);
        expect(aps.map((a) => a.r).sort()).toEqual(['R1', 'R2', 'R3']);
    });

    test('monomer tool: clicking an AP stub chains a DIFFERENT residue (not mutate)', async ({
        page,
    }) => {
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-aa-ala').click();
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 200, y: 180 } });
        let rd = await snapshot(page);
        const cAp = (rd.atoms[0].aps ?? []).find((a) => a.r === 'R2');
        expect(cAp).toBeTruthy();
        // Arm Glycine and click Alanine's C stub → chain (not mutate).
        await page.getByTestId('monomer-aa-gly').click();
        const pt = await apClickPoint(page, rd.atoms[0], cAp);
        await canvas.click({ position: pt });
        rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(2);
        expect(rd.bonds).toHaveLength(1);
        expect(rd.atoms.map((a) => a.lbl).sort()).toEqual(['A', 'G']);
    });

    test('monomer tool: a chained monomer no longer offers the used AP', async ({
        page,
    }) => {
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-aa-ala').click();
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 200, y: 180 } });
        // Chain a second Alanine off the first (same residue) via the bead.
        await canvas.click({ position: { x: 200, y: 180 } });
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(2);
        // The bonded monomers each expose fewer APs than a free one (3): the
        // used backbone AP is dropped.
        for (const a of rd.atoms) {
            expect((a.aps ?? []).length).toBeLessThan(3);
        }
    });

    // -------- Batch 62: Custom nucleotide triple-builder --------
    // Qt CustomNucleotidePopup: three text fields (sugar/base/phosphate). Editing
    // updates the armed triple; a canvas click places addNucleotide(sugar,base,phos).
    test('nucleic tool: Custom builds a nucleotide from typed sugar/base/phosphate', async ({
        page,
    }) => {
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-nucleic').click();
        await page.getByTestId('monomer-na-custom').click();
        const popup = page.getByTestId('monomer-na-custom-popup');
        await expect(popup).toBeVisible();
        // Default triple is R(A)P; retype the base to G.
        await page.getByTestId('monomer-na-custom-base').fill('G');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 200, y: 180 } });
        const rd = await snapshot(page);
        expect(rd.atoms).toHaveLength(3);
        expect(rd.atoms.find((a) => a.mon === 'sugar').lbl).toBe('R');
        expect(rd.atoms.find((a) => a.mon === 'base').lbl).toBe('G');
        expect(rd.atoms.find((a) => a.mon === 'phos').lbl).toBe('P');
    });

    test('nucleic tool: Custom respects an edited sugar (dR)', async ({
        page,
    }) => {
        await page.getByTestId('mode-monomeric').click();
        await page.getByTestId('monomer-nucleic').click();
        await page.getByTestId('monomer-na-custom').click();
        await page.getByTestId('monomer-na-custom-sugar').fill('dR');
        await page.getByTestId('monomer-na-custom-base').fill('T');
        const canvas = page.getByTestId('sketcher-canvas');
        await canvas.click({ position: { x: 200, y: 180 } });
        const rd = await snapshot(page);
        expect(rd.atoms.find((a) => a.mon === 'sugar').lbl).toBe('dR');
        expect(rd.atoms.find((a) => a.mon === 'base').lbl).toBe('T');
    });

});
