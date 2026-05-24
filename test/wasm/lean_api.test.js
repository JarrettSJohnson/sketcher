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

    test('SMILES with charge and implicit Hs emits q / nh annotations', async ({ page }) => {
        // Ammonium: one N atom, charge +1, four implicit hydrogens.
        const rd = await page.evaluate(() => {
            const json = window.Module.render_description_from_smiles('[NH4+]');
            return JSON.parse(json);
        });
        expect(rd.atoms).toHaveLength(1);
        expect(rd.atoms[0].el).toBe('N');
        expect(rd.atoms[0].q).toBe(1);
        expect(rd.atoms[0].nh).toBe(4);
    });

    test('chiral SMILES produces wedge/dash bond dirs via wedgeMolBonds', async ({ page }) => {
        // (R)-bromochlorofluoromethane — RDKit's wedgeMolBonds turns the
        // parsed CIP descriptor into at least one wedge or dash bond.
        const rd = await page.evaluate(() => {
            const json = window.Module.render_description_from_smiles(
                '[C@@H](F)(Cl)Br',
            );
            return JSON.parse(json);
        });
        const stereoBonds = rd.bonds.filter(
            (b) => typeof b.dir === 'number' && b.dir !== 0,
        );
        expect(stereoBonds.length).toBeGreaterThan(0);
        // dir values must be in the expected enum range (1=wedge, 2=dash,
        // up to 6=unknown).
        for (const b of stereoBonds) {
            expect(b.dir).toBeGreaterThanOrEqual(1);
            expect(b.dir).toBeLessThanOrEqual(6);
        }
    });

    test('aromatic SMILES sets arom flag on atoms and bonds', async ({ page }) => {
        const rd = await page.evaluate(() => {
            const json = window.Module.render_description_from_smiles('c1ccccc1');
            return JSON.parse(json);
        });
        expect(rd.atoms).toHaveLength(6);
        expect(rd.bonds).toHaveLength(6);
        // Every atom and every bond should be aromatic.
        expect(rd.atoms.every(a => a.arom === true)).toBe(true);
        expect(rd.bonds.every(b => b.arom === true)).toBe(true);
        // Aromatic carbons have one implicit H each.
        expect(rd.atoms.every(a => a.nh === 1)).toBe(true);
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

    test('selection: toggle, render-description flag, and deleteSelected', async ({ page }) => {
        const result = await page.evaluate(() => {
            const m = new window.Module.MolModel();
            m.addAtom('C', 0, 0);
            m.addAtom('C', 1.5, 0);
            m.addAtom('O', 3.0, 0);
            m.addBond(0, 1, 1);
            m.addBond(1, 2, 1);

            m.setAtomSelected(1, true);
            m.setBondSelected(0, true);
            const rd1 = JSON.parse(m.description());

            const hasSel = m.hasSelection();
            const atomSelFlags = rd1.atoms.map(a => !!a.sel);
            const bondSelFlags = rd1.bonds.map(b => !!b.sel);

            m.deleteSelected(); // removes atom 1 (and incident bonds) + bond 0
            const afterDelete = [m.numAtoms(), m.numBonds()];
            const selAfterDelete = m.hasSelection();

            m.undo(); // restores everything; selection stays cleared
            const afterUndo = [m.numAtoms(), m.numBonds()];
            const selAfterUndo = m.hasSelection();
            m.delete();
            return {
                hasSel, atomSelFlags, bondSelFlags,
                afterDelete, selAfterDelete,
                afterUndo, selAfterUndo,
            };
        });
        expect(result.hasSel).toBe(true);
        expect(result.atomSelFlags).toEqual([false, true, false]);
        expect(result.bondSelFlags).toEqual([true, false]);
        expect(result.afterDelete).toEqual([2, 0]);
        expect(result.selAfterDelete).toBe(false);
        expect(result.afterUndo).toEqual([3, 2]);
        expect(result.selAfterUndo).toBe(false);
    });

    test('drag-then-commit: setAtomPos previews, moveAtomUndoable round-trips', async ({ page }) => {
        const result = await page.evaluate(() => {
            const m = new window.Module.MolModel();
            m.addAtom('C', 0, 0);
            m.addAtom('O', 2, 0);
            m.setAtomSelected(1, true); // selection must survive the move

            let modelFires = 0;
            let selFires = 0;
            const h1 = window.Module.mol_model_subscribe(m, () => { ++modelFires; });
            const h2 = window.Module.mol_model_selection_subscribe(m, () => { ++selFires; });

            // Two preview steps + one undoable commit.
            m.setAtomPos(0, 1, 1);
            m.setAtomPos(0, 3, 2);
            m.moveAtomUndoable(0, 0, 0, 3, 2);
            const afterCommit = JSON.parse(m.description()).atoms.map(a => [a.x, a.y]);
            const selAfterCommit = m.isAtomSelected(1);

            m.undo();
            const afterUndo = JSON.parse(m.description()).atoms.map(a => [a.x, a.y]);
            const selAfterUndo = m.isAtomSelected(1);

            m.redo();
            const afterRedo = JSON.parse(m.description()).atoms.map(a => [a.x, a.y]);

            window.Module.mol_model_unsubscribe(h1);
            window.Module.mol_model_selection_unsubscribe(h2);
            m.delete();
            return { afterCommit, selAfterCommit, afterUndo, selAfterUndo,
                     afterRedo, modelFires, selFires };
        });
        expect(result.afterCommit).toEqual([[3, 2], [2, 0]]);
        expect(result.selAfterCommit).toBe(true);
        expect(result.afterUndo).toEqual([[0, 0], [2, 0]]);
        expect(result.selAfterUndo).toBe(true);
        expect(result.afterRedo).toEqual([[3, 2], [2, 0]]);
        // 2 previews + 1 commit + 1 undo + 1 redo = 5 modelChanged emissions.
        expect(result.modelFires).toBe(5);
        // No selection changes during the move.
        expect(result.selFires).toBe(0);
    });

    test('selectionChanged fires independently from modelChanged', async ({ page }) => {
        const result = await page.evaluate(() => {
            const m = new window.Module.MolModel();
            m.addAtom('C', 0, 0);
            m.addAtom('C', 1.5, 0);

            let modelFired = 0;
            let selFired = 0;
            const h1 = window.Module.mol_model_subscribe(m, () => { ++modelFired; });
            const h2 = window.Module.mol_model_selection_subscribe(m, () => { ++selFired; });

            m.setAtomSelected(0, true);   // sel++, model 0
            m.setAtomSelected(0, true);   // no-op
            m.setAtomSelected(1, true);   // sel++
            m.selectAll();                 // already complete, no-op
            m.clearSelection();           // sel++
            m.setAtomSelected(0, true);   // sel++
            m.addAtom('O', 3, 0);         // mutation: clears selection -> sel++; model++

            window.Module.mol_model_unsubscribe(h1);
            window.Module.mol_model_selection_unsubscribe(h2);
            m.delete();
            return { modelFired, selFired };
        });
        expect(result.modelFired).toBe(1);
        expect(result.selFired).toBe(5);
    });

    test('setBondDir round-trips through render description + undo', async ({ page }) => {
        const result = await page.evaluate(() => {
            const m = new window.Module.MolModel();
            m.addAtom('C', 0, 0);
            m.addAtom('C', 1.5, 0);
            m.addAtom('F', 3, 0);
            m.addBond(0, 1, 1);
            m.addBond(1, 2, 1);

            const before = JSON.parse(m.description()).bonds.map(b => b.dir);

            // Wedge bond 0; bond 1 should remain unset.
            m.setBondDirUndoable(0, 1, 1);
            const afterWedge = JSON.parse(m.description()).bonds.map(b => b.dir);

            // Apply dash to selected bonds (both) via the macro entry point.
            m.setBondSelected(0, true);
            m.setBondSelected(1, true);
            m.setBondDirForSelectedBonds(2);
            const afterDashAll = JSON.parse(m.description()).bonds.map(b => b.dir);

            // A single undo unwinds the macro.
            m.undo();
            const afterMacroUndo = JSON.parse(m.description()).bonds.map(b => b.dir);

            // Another undo unwinds the original setBondDirUndoable.
            m.undo();
            const afterFirstUndo = JSON.parse(m.description()).bonds.map(b => b.dir);

            m.delete();
            return { before, afterWedge, afterDashAll, afterMacroUndo, afterFirstUndo };
        });
        // dir field is omitted (undefined) when BondDir is NONE.
        expect(result.before).toEqual([undefined, undefined]);
        expect(result.afterWedge).toEqual([1, undefined]);
        expect(result.afterDashAll).toEqual([2, 2]);
        // Macro undo restores both bonds at once: wedge on 0, none on 1.
        expect(result.afterMacroUndo).toEqual([1, undefined]);
        expect(result.afterFirstUndo).toEqual([undefined, undefined]);
    });

    test('addRing(6, aromatic) inserts a Kekulé benzene as one undo step', async ({ page }) => {
        const result = await page.evaluate(() => {
            const m = new window.Module.MolModel();
            m.addRing(6, 0.0, 0.0, true);
            const desc = JSON.parse(m.description());
            const orders = desc.bonds.map((b) => b.o);
            // Bond orders alternate 1,2,1,2,1,2 because addRing emits Kekulé.
            const single = orders.filter((o) => o === 1).length;
            const double = orders.filter((o) => o === 2).length;
            // One undo collapses the whole ring.
            m.undo();
            const afterUndo = JSON.parse(m.description());
            m.delete();
            return {
                nAtoms: desc.atoms.length,
                nBonds: desc.bonds.length,
                single,
                double,
                undoAtoms: afterUndo.atoms.length,
                undoBonds: afterUndo.bonds.length,
            };
        });
        expect(result.nAtoms).toBe(6);
        expect(result.nBonds).toBe(6);
        expect(result.single).toBe(3);
        expect(result.double).toBe(3);
        expect(result.undoAtoms).toBe(0);
        expect(result.undoBonds).toBe(0);
    });

    test('loadFromSmiles replaces mol with parsed structure and is undoable', async ({ page }) => {
        const result = await page.evaluate(() => {
            const m = new window.Module.MolModel();
            m.addAtom('F', 0, 0); // pre-existing atom we expect to be replaced
            m.loadFromSmiles('c1ccccc1');
            const desc = JSON.parse(m.description());
            const before = {
                nAtoms: desc.atoms.length,
                nBonds: desc.bonds.length,
                aromatic: desc.atoms.every((a) => a.arom === true),
            };
            m.undo(); // restores the stray fluorine
            const afterUndo = JSON.parse(m.description());
            m.delete();
            return {
                ...before,
                undoNAtoms: afterUndo.atoms.length,
                undoFirstElement: afterUndo.atoms[0]?.el,
            };
        });
        expect(result.nAtoms).toBe(6);
        expect(result.nBonds).toBe(6);
        expect(result.aromatic).toBe(true);
        expect(result.undoNAtoms).toBe(1);
        expect(result.undoFirstElement).toBe('F');
    });

    test('loadFromSmiles throws on garbage input', async ({ page }) => {
        const threw = await page.evaluate(() => {
            const m = new window.Module.MolModel();
            let caught = false;
            try {
                m.loadFromSmiles('this is not a smiles');
            } catch {
                caught = true;
            }
            const n = m.numAtoms();
            m.delete();
            return { caught, n };
        });
        expect(threw.caught).toBe(true);
        expect(threw.n).toBe(0); // model untouched by the failed load
    });

    test('toSmiles round-trips canonical SMILES', async ({ page }) => {
        const out = await page.evaluate(() => {
            const m = new window.Module.MolModel();
            const empty = m.toSmiles();
            m.loadFromSmiles('OCC');
            const after = m.toSmiles();
            m.delete();
            return { empty, after };
        });
        expect(out.empty).toBe('');
        // Canonical form of ethanol — RDKit normalizes regardless of input order.
        expect(out.after).toBe('CCO');
    });

    test('adjustChargeOnSelectedAtoms updates q and nh in render description', async ({ page }) => {
        const result = await page.evaluate(() => {
            const m = new window.Module.MolModel();
            m.addAtom('N', 0, 0);
            m.addAtom('O', 1, 0);
            m.setAtomSelected(0, true);
            m.adjustChargeOnSelectedAtoms(+1);
            const desc = JSON.parse(m.description());
            // Selection survives so the user can keep stacking charge edits.
            const stillSelected = m.isAtomSelected(0);
            m.undo();
            const undoDesc = JSON.parse(m.description());
            m.delete();
            return {
                qN: desc.atoms[0].q,
                nhN: desc.atoms[0].nh,
                qO: desc.atoms[1].q,
                stillSelected,
                undoQ: undoDesc.atoms[0].q,
                undoNh: undoDesc.atoms[0].nh,
            };
        });
        expect(result.qN).toBe(1);
        // [NH3+] has 4 implicit Hs in RDKit's valence model (N+ is tetravalent).
        expect(result.nhN).toBe(4);
        // Unselected O carries no charge annotation (undefined when 0).
        expect(result.qO).toBeUndefined();
        expect(result.stillSelected).toBe(true);
        // Undo restores neutral N (q field omitted) with 3 implicit Hs.
        expect(result.undoQ).toBeUndefined();
        expect(result.undoNh).toBe(3);
    });
});
