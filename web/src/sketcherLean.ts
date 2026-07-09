// Loader for the lean Emscripten bundle.
//
// SketcherLean.js is *not* an ES module — it's the classic Emscripten output
// that defines a global `sketcher_lean_entry` factory. We therefore inject it
// via a <script> tag, wait for the global to appear, and then call the
// factory. Both the .js loader and the .wasm payload are served from / by
// the vite middleware in vite.config.ts (dev) or copied to dist/ (prod).

export interface MolModelInstance {
    addAtom(element: string, x: number, y: number): void;
    /**
     * Append an R-group atom (dummy carrying `_MolFileRLabel`) at (x, y).
     * Pass `boundToAtomIdx=-1` for a free-standing R-group, or a valid atom
     * index to single-bond the new R to it. Throws if `rGroupNum == 0`
     * (RDKit forbids R0).
     */
    addRGroup(rGroupNum: number, x: number, y: number,
              boundToAtomIdx: number): void;
    /**
     * Append an attachment-point dummy at (x, y), single-bonded to the atom
     * at `boundToAtomIdx`. Unlike R-groups, attachment points are ALWAYS
     * bonded — there is no -1 fallback (RDKit's is_attachment_point_dummy
     * requires totalDegree == 1). The renderer paints a wavy squiggle
     * perpendicular to the bond instead of an atom dot/label. Throws if
     * `apNum == 0` or `boundToAtomIdx` is out of range.
     */
    addAttachmentPoint(apNum: number, x: number, y: number,
                       boundToAtomIdx: number): void;
    /**
     * Place the reaction arrow at (x, y). At most one arrow per model —
     * throws "Only one arrow allowed" if one already exists (Qt:
     * MolModel::addNonMolecularObject in model/mol_model.cpp). Single undo
     * step.
     */
    addRxnArrow(x: number, y: number): void;
    /**
     * Append a reaction plus sign at (x, y). Pluses are unlimited; each
     * click drops another. Single undo step.
     */
    addRxnPlus(x: number, y: number): void;
    addBond(begin: number, end: number, bondType: number): void;
    /**
     * addBond + setBondDirUndoable inside a single undo macro. Pass dir=0
     * (NONE) to behave identically to addBond.
     */
    addBondWithDir(
        begin: number,
        end: number,
        bondType: number,
        dir: number,
    ): void;
    removeAtom(idx: number): void;
    removeBond(begin: number, end: number): void;
    clear(): void;
    setAtomPos(idx: number, x: number, y: number): void;
    moveAtomUndoable(
        idx: number,
        fromX: number,
        fromY: number,
        toX: number,
        toY: number,
    ): void;
    /**
     * Batched moveAtomUndoable — every (idx, from, to) row commits inside
     * a single undo macro so the whole gesture collapses to one undo.
     */
    moveAtomsUndoable(
        indices: number[],
        fromXs: number[],
        fromYs: number[],
        toXs: number[],
        toYs: number[],
    ): void;
    /** dir is RDKit::Bond::BondDir as int: 0=NONE, 1=BEGINWEDGE, 2=BEGINDASH. */
    setBondDirUndoable(begin: number, end: number, dir: number): void;
    setBondDirForSelectedBonds(dir: number): void;
    /**
     * Change bond order on an existing bond. `type` is RDKit::Bond::BondType
     * as int (1=SINGLE, 2=DOUBLE, 3=TRIPLE, 12=AROMATIC). Used by Erase to
     * decrement triple→double→single. Preserves selection. No-op if the
     * bond doesn't exist or the type already matches.
     */
    setBondTypeUndoable(begin: number, end: number, type: number): void;
    /**
     * Selection-wide equivalent of setBondTypeUndoable. Changes the bond
     * order of every selected bond to `type` in a single undo step. Mirrors
     * Qt's ModifyBondsMenu (bond_context_menu.cpp:17) when invoked from the
     * SelectionContextMenu. `type` is RDKit::Bond::BondType (1=SINGLE,
     * 2=DOUBLE, 3=TRIPLE, 12=AROMATIC). Bonds whose type already matches
     * are skipped. Preserves the selection. No-op when no bonds are selected.
     */
    setBondTypeForSelectedBonds(type: number): void;
    /**
     * Combined `setBondTypeUndoable(type)` + `setBondDirUndoable(dir)` as one
     * undo step. Mirrors Qt's `MolModel::mutateBonds` (model/mol_model.cpp:
     * 2288), used by the ModifyBondsMenu "Other Type" submenu (Coordinate /
     * Zero Order / Single Up/Down (wavy) / Double Cis/Trans (crossed)) so the
     * type+dir swap survives Ctrl+Z together. `type` is RDKit::Bond::BondType
     * (1=SINGLE, 2=DOUBLE, 17=DATIVE/Coordinate, 21=ZERO). `dir` is
     * RDKit::Bond::BondDir (0=NONE, 5=EITHERDOUBLE/crossed, 6=UNKNOWN/wavy).
     * No-op when the bond is missing.
     */
    setBondTypeAndDirUndoable(begin: number, end: number,
                              type: number, dir: number): void;
    /**
     * Selection-wide equivalent of `setBondTypeAndDirUndoable` — every
     * selected bond gets both type and dir replaced inside one undo macro.
     * Backs the SelectionContextMenu's Modify Bonds → Other Type items.
     * No-op when no bonds are selected.
     */
    setBondTypeAndDirForSelectedBonds(type: number, dir: number): void;
    addRing(size: number, cx: number, cy: number, aromatic: boolean): void;
    /**
     * Add a single-bonded carbon chain at the given 2D positions. Pass
     * boundToAtomIdx=-1 for a free-standing chain; otherwise the first new
     * atom is single-bonded to the existing atom at that index (extending
     * the chain off existing structure). Single undo step.
     */
    addAtomChain(xs: number[], ys: number[], boundToAtomIdx: number): void;
    /**
     * Rotate selected atoms (or all atoms when nothing is selected) by
     * angle_rad counterclockwise around their centroid. Single undo step.
     */
    rotateSelectedAtoms(angleRad: number): void;
    /**
     * Flip selected atoms (or all atoms when nothing is selected) across a
     * horizontal axis (left↔right when horizontal=true) or vertical axis
     * (top↔bottom when horizontal=false) through the centroid. Single undo
     * step.
     */
    flipSelectedAtoms(horizontal: boolean): void;
    /**
     * Flip the smaller substituent hanging off the begin—end bond across the
     * bond axis (Qt's `MolModel::flipSubstituent`, model/mol_model.cpp:1793).
     * Backs the bond context menu's "Flip Substituent". Single undo step.
     * No-op when the bond is missing or in a ring (removing it wouldn't split
     * the mol into two substituents).
     */
    flipSubstituentAroundBond(begin: number, end: number): void;
    adjustChargeOnSelectedAtoms(delta: number): void;
    /**
     * Replace every selected atom with a hydrogen of the given mass-number
     * isotope (Deuterium = 2, Tritium = 3, ordinary H = 1, "no specific
     * isotope" = 0). Mirrors Qt's D/T keyboard shortcuts. Resets formal
     * charge + explicit-H count so the implicit-H cache reflects the new
     * H valence. Preserves selection. Single undo step. No-op on empty
     * selection.
     */
    setSelectedAtomsToHydrogenIsotope(isotope: number): void;
    /**
     * Replace the element of a single atom by RDKit atomic number. Used by
     * the atom context menu's "Set Element" submenu. Resets formal charge +
     * explicit-H count to the new element's defaults so implicit-H valence
     * re-perceives. Preserves selection. Single undo step. Throws if `idx`
     * is out of range; no-op if the atom already has that atomic number.
     */
    setAtomElement(idx: number, atomicNum: number): void;
    /**
     * Selection-wide equivalent of setAtomElement. Replaces the element of
     * every selected atom with `atomicNum` in a single undo step. Mirrors
     * Qt's ModifyAtomsMenu "Set Element" submenu when invoked from the
     * selection context menu. Resets formal charge + explicit-H count to the
     * new element's defaults on each atom. Preserves the selection. No-op
     * when nothing is selected.
     */
    setElementForSelectedAtoms(atomicNum: number): void;
    /**
     * Replace the atom at `idx` in place with an R-group dummy carrying the
     * given R-group number, preserving bonds + position. Backs the atom
     * context menu's "Replace with > R-Group" (Qt's mutateRGroups). Single
     * undo step. Throws when rGroupNum is 0; no-op when idx is out of range.
     */
    mutateAtomToRGroup(idx: number, rGroupNum: number): void;
    /**
     * Replace the atom at `idx` in place with a wildcard query atom. `label`
     * is one of A/Q/M/X/AH/QH/MH/XH — mapped to the matching RDKit query maker
     * (Qt's ATOM_TOOL_QUERY_MAP). Backs the atom context menu's "Replace with
     * > Wildcard". Single undo step. No-op when idx is out of range or the
     * label is unrecognized.
     */
    mutateAtomToWildcard(idx: number, label: string): void;
    /** Replace mol with parsed SMILES. Throws if SMILES is malformed. */
    loadFromSmiles(smiles: string): void;
    /** Replace mol with parsed text (auto-detects SMILES, MOL, etc.). Throws on failure. */
    loadFromText(text: string): void;
    /**
     * Append parsed text to the current mol. The new structure is placed to
     * the right of the existing mol (or centered at the origin if the mol is
     * empty). Auto-detects format like loadFromText; throws on parse failure.
     * Single undo step.
     */
    addMolFromText(text: string): void;
    /** Canonical SMILES for the current mol; empty string if mol is empty. */
    toSmiles(): string;
    /** MDL MOL block (V3000 if `v3000` else V2000); empty for empty mol. */
    toMolBlock(v3000: boolean): string;
    /**
     * MDL MOL block of just the current selection. Auto-extends selection so
     * every selected bond keeps both endpoints. Returns "" when nothing is
     * selected. Used by Ctrl+X (Cut) and Copy when a selection is present.
     */
    toMolBlockForSelection(v3000: boolean): string;
    /**
     * Generic exporter; format names mirror Qt's get_standard_export_formats()
     * entries (lowercased + no spaces): "smiles", "extended_smiles", "smarts",
     * "extended_smarts", "inchi", "inchikey", "pdb", "xyz", "mrv", "maestro",
     * "mdl_molv3000", "mdl_molv2000". `selectionOnly=true` exports only the
     * current selection (auto-extending to bond endpoints); returns "" if no
     * selection. Returns "" on empty mol, unknown format, or writer failure.
     */
    toFormatString(formatName: string, selectionOnly: boolean): string;
    /** Promote every implicit hydrogen to an explicit atom. Single undo step. */
    addHydrogens(): void;
    /** Strip explicit hydrogens back to implicit. Single undo step. */
    removeHydrogens(): void;
    /**
     * Promote implicit Hs to explicit on the given atom indices only.
     * Empty array means "all atoms" (matches rdkit_extensions::addHs). Used by
     * the per-atom + selection "Add Explicit Hydrogens" context-menu actions.
     * Single undo step. No-op on empty mol.
     */
    addExplicitHsToAtoms(atomIndices: number[]): void;
    /**
     * Counterpart to addExplicitHsToAtoms — strip explicit Hs attached to (or
     * directly named by) the given atom indices. Empty input is a no-op
     * (unlike the whole-mol removeHydrogens). Single undo step.
     */
    removeExplicitHsFromAtoms(atomIndices: number[]): void;
    /**
     * Add `delta` to the unpaired-electron (radical) count on each atom in
     * `atomIndices` (single undo step). Per-atom count is clamped to [0, 4]
     * to match Qt's MIN_UNPAIRED_E/MAX_UNPAIRED_E
     * (molviewer/constants.h:41-42). Atoms already at the clamp boundary
     * are skipped silently. No-op on empty input, delta=0, or empty mol.
     */
    adjustRadicalElectronsOnAtoms(atomIndices: number[], delta: number): void;
    /** Perceive aromaticity — sets arom flag on atoms/bonds. Single undo step. */
    aromatize(): void;
    /** Kekulize aromatic bonds back to explicit SINGLE/DOUBLE alternation. Single undo step. */
    kekulize(): void;
    /** Recompute 2D coords via the RDKit native depictor. Single undo step. */
    cleanUp(): void;
    undo(): void;
    redo(): void;
    numAtoms(): number;
    numBonds(): number;
    setAtomSelected(idx: number, selected: boolean): void;
    setBondSelected(idx: number, selected: boolean): void;
    isAtomSelected(idx: number): boolean;
    isBondSelected(idx: number): boolean;
    hasSelection(): boolean;
    selectAll(): void;
    clearSelection(): void;
    deleteSelected(): void;
    description(): string;
    delete(): void;
}

interface MolModelConstructor {
    new (): MolModelInstance;
}

export interface SketcherLeanModule {
    render_description_from_smiles(smiles: string): string;
    MolModel: MolModelConstructor;
    mol_model_subscribe(m: MolModelInstance, cb: () => void): number;
    mol_model_unsubscribe(handle: number): void;
    mol_model_selection_subscribe(m: MolModelInstance, cb: () => void): number;
    mol_model_selection_unsubscribe(handle: number): void;
    getExceptionMessage?: (ptr: number) => string[];
    [key: string]: unknown;
}

type SketcherLeanFactory = (opts?: {
    locateFile?: (path: string) => string;
    getExceptionMessage?: unknown;
}) => Promise<SketcherLeanModule>;

declare global {
    interface Window {
        sketcher_lean_entry?: SketcherLeanFactory;
    }
}

const SCRIPT_URL = '/SketcherLean.js';
const WASM_URL = '/SketcherLean.wasm';

let factoryPromise: Promise<SketcherLeanFactory> | null = null;
let modulePromise: Promise<SketcherLeanModule> | null = null;

function loadFactory(): Promise<SketcherLeanFactory> {
    if (factoryPromise) return factoryPromise;
    factoryPromise = new Promise<SketcherLeanFactory>((resolve, reject) => {
        if (window.sketcher_lean_entry) {
            resolve(window.sketcher_lean_entry);
            return;
        }
        const existing = document.querySelector<HTMLScriptElement>(
            `script[data-sketcher-lean='true']`,
        );
        const script = existing ?? document.createElement('script');
        if (!existing) {
            script.src = SCRIPT_URL;
            script.async = true;
            script.dataset.sketcherLean = 'true';
        }
        script.addEventListener('load', () => {
            if (window.sketcher_lean_entry) {
                resolve(window.sketcher_lean_entry);
            } else {
                reject(
                    new Error(
                        'SketcherLean.js loaded but sketcher_lean_entry not defined',
                    ),
                );
            }
        });
        script.addEventListener('error', () =>
            reject(new Error(`failed to load ${SCRIPT_URL}`)),
        );
        if (!existing) document.head.appendChild(script);
    });
    return factoryPromise;
}

export function loadSketcherLean(): Promise<SketcherLeanModule> {
    if (modulePromise) return modulePromise;
    modulePromise = loadFactory().then((factory) =>
        factory({
            // Tell Emscripten where to fetch the .wasm binary. Without this
            // it tries to resolve relative to SketcherLean.js, which works
            // here but is brittle if the script ever moves.
            locateFile: (path: string) =>
                path.endsWith('.wasm') ? WASM_URL : path,
        }),
    );
    return modulePromise;
}
