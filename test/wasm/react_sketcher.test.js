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
        // Place two carbons (the bbox math needs atoms — Save Image's
        // empty-mol guard short-circuits when numAtoms == 0, so a pure
        // non-mol scheme can't be exported in this skeleton yet), then
        // an arrow + plus. The exported SVG must include at least two
        // <path stroke=...> elements (one for the chevron arrow, one for
        // the crossed plus) on top of the C-C bond path.
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
        // (sketcher_side_bar.cpp:55-188). Monomer draw tools are a
        // placeholder for now; we only verify the page swap, the active
        // button reflects the current mode, and SELECT survives the swap.
        await expect(page.getByTestId('mode-atomistic'))
            .toHaveAttribute('aria-pressed', 'true');
        await expect(page.getByTestId('mode-monomeric'))
            .toHaveAttribute('aria-pressed', 'false');
        // Atomistic page renders the element grid; monomeric placeholder
        // hasn't rendered yet.
        await expect(page.getByTestId('element-C')).toBeVisible();
        await expect(page.getByTestId('monomeric-page')).toHaveCount(0);
        // SELECT block is present in atomistic mode.
        await expect(page.getByTestId('tool-select')).toBeVisible();

        await page.getByTestId('mode-monomeric').click();
        await expect(page.getByTestId('mode-atomistic'))
            .toHaveAttribute('aria-pressed', 'false');
        await expect(page.getByTestId('mode-monomeric'))
            .toHaveAttribute('aria-pressed', 'true');
        // Atomistic page unmounts; monomeric placeholder mounts.
        await expect(page.getByTestId('element-C')).toHaveCount(0);
        await expect(page.getByTestId('monomeric-page')).toBeVisible();
        await expect(page.getByTestId('monomer-amino')).toBeVisible();
        await expect(page.getByTestId('monomer-nucleic')).toBeVisible();
        // SELECT block survives the page swap (Qt: lives outside the stack).
        await expect(page.getByTestId('tool-select')).toBeVisible();

        // Flip back.
        await page.getByTestId('mode-atomistic').click();
        await expect(page.getByTestId('element-C')).toBeVisible();
        await expect(page.getByTestId('monomeric-page')).toHaveCount(0);
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
        // underlying action isn't wired yet (atom_query needs RDKit query
        // atoms, bond_query needs the same).
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
        // Atomistic-page stubs.
        for (const [testid, pattern] of [
            ['atom-query', /Atom query/],
            ['bond-query', /Bond query/],
        ]) {
            await page.getByTestId(testid).click();
            await expect(status).toContainText(pattern);
        }
        // Flip to monomeric page; AMINO/NUCLEIC buttons live there.
        await page.getByTestId('mode-monomeric').click();
        for (const [testid, pattern] of [
            ['monomer-amino', /Amino acid/],
            ['monomer-nucleic', /Nucleic acid/],
        ]) {
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

    test('stub shortcuts (0 bond) surface a status; D/T without selection surfaces a friendly hint', async ({
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
        // would do. Ctrl+C was a stub before batch 16 (now copies as MOL
        // V3000); Ctrl+V was a stub before batch 17 (now pastes via
        // clipboard-read + AUTO_DETECT); Ctrl+X was a stub before batch 18
        // (now cuts via toMolBlockForSelection + deleteSelected).
        const checks = [
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
