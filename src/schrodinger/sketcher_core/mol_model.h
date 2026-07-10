/* -------------------------------------------------------------------------
 * Qt-free skeleton of sketcher::MolModel — owns an RDKit RWMol and supports
 * undoable add/remove of atoms and bonds. Built on sketcher_core's
 * UndoableModel + Signal primitives.
 *
 * Scope: enough to validate the sketcher_core pattern against the real
 * domain. Selection, monomers, S-groups, reactions, query atoms/bonds, and
 * stereo edits are deliberately out of the Phase 0 skeleton.
 *
 * Copyright Schrodinger LLC, All Rights Reserved.
 --------------------------------------------------------------------------- */

#pragma once

#include <functional>
#include <optional>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

#include <GraphMol/Bond.h>
#include <GraphMol/RWMol.h>

#include "schrodinger/sketcher_core/observer.h"
#include "schrodinger/sketcher_core/undoable_model.h"

namespace schrodinger
{
namespace sketcher_core
{

// Private RDKit atom property holding a wildcard query atom's display label
// (A/Q/M/X + H variants). Set by MolModel::mutateAtomToWildcard and read by
// the render description so the UI can show the label without re-parsing the
// RDKit query. Underscore prefix keeps it out of molblock/SMILES output.
inline constexpr const char* WILDCARD_LABEL_PROP = "_sketcherWildcard";

// Private RDKit bond property holding a query bond's display label (Any / S/D
// / S/A / D/A). Set by MolModel::mutateBondToQuery and read by the render
// description — same "store the label, don't re-parse the query" approach as
// WILDCARD_LABEL_PROP. Mirrors Qt's get_bond_type_and_query_label output
// (rdkit/atoms_and_bonds.cpp:222).
inline constexpr const char* BOND_QUERY_LABEL_PROP = "_sketcherBondQuery";

// Private RDKit bond property holding a bond's ring-topology constraint:
// "ring" (in a ring) or "notring" (not in a ring). Absent = no constraint
// (BondTopology::EITHER). Set by MolModel::setBondTopologyForBond; the render
// description surfaces it so the UI can draw Qt's ⭔ / "Not ⭔" annotation
// (rdkit/atoms_and_bonds.cpp:204).
inline constexpr const char* BOND_TOPOLOGY_PROP = "_sketcherBondTopology";

class UndoStack;

class MolModel : public UndoableModel
{
  public:
    explicit MolModel(UndoStack* stack);

    const RDKit::RWMol& mol() const
    {
        return m_mol;
    }
    bool isEmpty() const
    {
        return m_mol.getNumAtoms() == 0 && !m_rxn_arrow.has_value() &&
               m_rxn_pluses.empty();
    }
    unsigned int numAtoms() const
    {
        return m_mol.getNumAtoms();
    }
    unsigned int numBonds() const
    {
        return m_mol.getNumBonds();
    }

    /** Append an atom by element symbol at the given 2D position. */
    void addAtom(const std::string& element, double x, double y);

    /**
     * Append an R-group atom (dummy atom carrying `_MolFileRLabel`) at the
     * given 2D position. When `bound_to_atom_idx` is a valid existing atom
     * index, the new R-group is single-bonded to it (extending the structure);
     * pass -1 for a free-standing R-group. Mirrors Qt's
     * `MolModel::addRGroup` (model/mol_model.cpp:643-648), which delegates to
     * `addRGroupChain({r_group_num}, {coords}, bound_to_atom)` →
     * `rdkit_extensions::make_new_r_group`. The dummy atom is decorated with
     * the RDKit conventions: atomLabel "_R<n>", dummyLabel "R<n>", isotope
     * == r_group_num, and `_MolFileRLabel` == r_group_num so MOL block export
     * round-trips correctly. Single undo step. Throws std::invalid_argument
     * for r_group_num == 0 (RDKit forbids R0).
     */
    void addRGroup(unsigned int r_group_num, double x, double y,
                   int bound_to_atom_idx = -1);

    /**
     * Append an attachment-point atom (dummy decorated with atomLabel
     * "_AP<n>") at the given 2D position, single-bonded to the atom at
     * `bound_to_atom_idx`. Unlike R-groups, attachment points are ALWAYS
     * bonded — `rdkit_extensions::is_attachment_point_dummy` requires
     * totalDegree == 1, so a stand-alone "AP" is meaningless. Mirrors Qt's
     * `MolModel::addAttachmentPoint` (model/mol_model.cpp:650-664) which
     * delegates to `sketcher::make_new_attachment_point` (rdkit/rgroup.cpp:52).
     * Visually the AP atom is rendered as a wavy squiggle perpendicular to
     * the bond (atom_item.cpp:302-304 — `label_is_visible=false`), not as
     * the dummy "*" or "AP<n>" text. Single undo step. Throws
     * std::invalid_argument when ap_num == 0 or bound_to_atom_idx is out
     * of range.
     */
    void addAttachmentPoint(unsigned int ap_num, double x, double y,
                            unsigned int bound_to_atom_idx);

    /** 2D position of the atom at `idx` (z is always 0). */
    void atomPos(unsigned int idx, double& x, double& y) const;

    /** Add a bond between two existing atom indices. */
    void addBond(unsigned int begin_idx, unsigned int end_idx,
                 RDKit::Bond::BondType type = RDKit::Bond::BondType::SINGLE);

    /**
     * Add a bond and immediately set its BondDir, both inside one undo
     * macro. Convenient when the bond tool runs with an active stereo mode
     * (wedge/dash) so the new bond appears wedged on creation rather than
     * requiring a separate Wedge click. Falls through to addBond when dir
     * is BondDir::NONE.
     */
    void addBondWithDir(unsigned int begin_idx, unsigned int end_idx,
                        RDKit::Bond::BondType type,
                        RDKit::Bond::BondDir dir);

    /** Remove an atom (and its incident bonds) by index. */
    void removeAtom(unsigned int idx);

    /** Remove the bond between two atom indices. */
    void removeBond(unsigned int begin_idx, unsigned int end_idx);

    /** Reset to an empty molecule. */
    void clear();

    /**
     * Set the 2D position of an existing atom *without* pushing an undo
     * command. Used as the live-preview step of a drag; the caller is
     * responsible for calling moveAtomUndoable on commit. Fires
     * modelChanged so observers can repaint. No-op if `idx` is out of range.
     */
    void setAtomPos(unsigned int idx, double x, double y);

    /**
     * Push an undoable atom move from `(from_x, from_y)` to `(to_x, to_y)`.
     * Unlike addAtom/removeAtom this does NOT clear the selection — moving
     * an atom doesn't reindex anything, so existing selection indices stay
     * valid. Backed by a custom command (not a whole-RWMol snapshot) so a
     * single drag commits one tiny command instead of two RWMol copies.
     */
    void moveAtomUndoable(unsigned int idx, double from_x, double from_y,
                          double to_x, double to_y);

    /**
     * Batched moveAtomUndoable: every (idx, from, to) row is committed
     * inside a single undo macro so the whole gesture (e.g. drag-moving
     * a multi-atom selection) collapses to one undo step. All four
     * vectors must have the same length; no-op when `indices` is empty.
     * Preserves selection like the single-atom variant.
     */
    void moveAtomsUndoable(const std::vector<unsigned int>& indices,
                           const std::vector<double>& from_xs,
                           const std::vector<double>& from_ys,
                           const std::vector<double>& to_xs,
                           const std::vector<double>& to_ys);

    /**
     * Set the BondDir on the bond between `begin_idx` and `end_idx` to
     * `dir` (RDKit::Bond::BondDir cast to int). Undoable; preserves the
     * current selection (setting stereo doesn't reindex anything). No-op
     * if the bond does not exist.
     */
    void setBondDirUndoable(unsigned int begin_idx, unsigned int end_idx,
                            RDKit::Bond::BondDir dir);

    /**
     * Apply `setBondDirUndoable` to every selected bond in a single undo
     * macro. Convenient for UI actions like "wedge selected bonds". No-op
     * if no bonds are selected.
     */
    void setBondDirForSelectedBonds(RDKit::Bond::BondDir dir);

    /**
     * Change the bond order of the bond between `begin_idx` and `end_idx`
     * to `type`. Used by the Erase tool to decrement triple→double→single
     * before deleting (Qt `EraseSceneTool::onLeftButtonClick`). Preserves
     * selection (no reindexing). Refreshes the implicit-H cache so labels
     * update with the new valence. No-op if the bond is missing or the
     * type already matches.
     */
    void setBondTypeUndoable(unsigned int begin_idx, unsigned int end_idx,
                             RDKit::Bond::BondType type);

    /**
     * Selection-wide equivalent of setBondTypeUndoable — change every
     * selected bond's order to `type` inside a single undo macro. Mirrors
     * Qt's ModifyBondsMenu (menu/bond_context_menu.cpp:17) when invoked from
     * the SelectionContextMenu. `type` accepts any RDKit::Bond::BondType
     * (1=SINGLE, 2=DOUBLE, 3=TRIPLE, 12=AROMATIC). Bonds whose current type
     * already matches are skipped (matches setBondTypeUndoable's no-op).
     * Preserves the selection. No-op when no bonds are selected.
     */
    void setBondTypeForSelectedBonds(RDKit::Bond::BondType type);

    /**
     * Apply both `setBondTypeUndoable(type)` and `setBondDirUndoable(dir)` as
     * one undo step. Mirrors Qt's `MolModel::mutateBonds` (model/mol_model.cpp:
     * 2288) — the "Other Type" submenu in ModifyBondsMenu (Coordinate / Zero
     * Order / Single Up/Down (wavy) / Double Cis/Trans (crossed)) replaces
     * both type and dir as a unit so Ctrl+Z restores the bond in one step.
     * No-op when the bond is missing.
     */
    void setBondTypeAndDirUndoable(unsigned int begin_idx,
                                   unsigned int end_idx,
                                   RDKit::Bond::BondType type,
                                   RDKit::Bond::BondDir dir);

    /**
     * Selection-wide equivalent of `setBondTypeAndDirUndoable` — every
     * selected bond gets both type and dir replaced inside one undo macro.
     * Used by the SelectionContextMenu's Modify Bonds → Other Type items
     * (Coordinate / Zero / Wavy / Crossed). No-op when no bonds are selected.
     */
    void setBondTypeAndDirForSelectedBonds(RDKit::Bond::BondType type,
                                           RDKit::Bond::BondDir dir);

    /**
     * Replace the bond between `begin_idx` and `end_idx` in place with a query
     * bond. `label` is one of "Any" / "S/D" / "S/A" / "D/A" — mapped to the
     * matching RDKit query maker (makeBondNullQuery / makeSingleOrDoubleBond
     * Query / …) exactly as Qt's BOND_TOOL_QUERY_MAP (rdkit/atoms_and_bonds.h:
     * 74). Sets the base bond type Qt draws it as (SINGLE for Any/S/D/S/A,
     * DOUBLE for D/A) and stores the display label in BOND_QUERY_LABEL_PROP for
     * the render description. Backs the ModifyBondsMenu "Query" submenu.
     * Single undo step. No-op when the bond is missing or `label` unrecognized.
     */
    void mutateBondToQuery(unsigned int begin_idx, unsigned int end_idx,
                           const std::string& label);

    /**
     * Selection-wide equivalent of `mutateBondToQuery` — every selected bond
     * becomes the given query bond inside one undo macro. No-op when no bonds
     * are selected or `label` is unrecognized.
     */
    void mutateSelectedBondsToQuery(const std::string& label);

    /**
     * Ensure a bond exists between `begin_idx` and `end_idx`, then stamp it
     * with the given query (or aromatic type) as one undo step. Backs the
     * bond-query (B▾) draw tool completing a two-atom gesture. `label` is
     * "aromatic" (a real BondType) or one of "Any"/"S/D"/"S/A"/"D/A". No-op
     * for the same atom, out-of-range indices, or an unrecognized label.
     */
    void addQueryBondBetweenAtoms(unsigned int begin_idx, unsigned int end_idx,
                                  const std::string& label);

    /**
     * Set the ring-topology constraint on the bond between `begin_idx` and
     * `end_idx`. `topology` is "ring" (in a ring), "notring" (not in a ring),
     * or "either" (clear the constraint). Mirrors Qt's ModifyBondsMenu
     * Topology submenu → MolModel::setBondTopology (model/mol_model.cpp:2356).
     * The bond is rebuilt from its base type + any query label, then a
     * BondInRing query is added (negated for "notring") or dropped ("either").
     * Single undo step. No-op when the bond is missing or `topology` is
     * unrecognized.
     */
    void setBondTopologyForBond(unsigned int begin_idx, unsigned int end_idx,
                                const std::string& topology);

    /**
     * Selection-wide equivalent of `setBondTopologyForBond` — every selected
     * bond gets the topology constraint inside one undo macro. No-op when no
     * bonds are selected or `topology` is unrecognized.
     */
    void setSelectedBondsTopology(const std::string& topology);

    /**
     * Insert a planar regular polygon of `size` carbon atoms centered at
     * (cx, cy). When `aromatic` is true (and `size` is even), bonds alternate
     * SINGLE / DOUBLE in Kekulé form so benzene renders the classic three-
     * double-bond pattern. Otherwise all bonds are SINGLE (cyclohexane etc.).
     * No-op if `size < 3`. Single undo step.
     */
    void addRing(unsigned int size, double cx, double cy, bool aromatic);

    /**
     * Add a chain of carbon atoms at the given 2D positions, single-bonded in
     * order. When `bound_to_atom_idx` is a valid existing atom index, the
     * first new atom is single-bonded to it (extending the chain off an
     * existing structure). Pass -1 for a free-standing chain. Mirrors Qt's
     * `DrawChainSceneTool::onLeftButtonDragRelease` (`tool/draw_chain_scene_tool.cpp:74-89`),
     * which calls `MolModel::addAtomChain(Element::C, coords, start_atom)`.
     * Single undo step. No-op when `xs` is empty or xs/ys lengths mismatch.
     */
    void addAtomChain(const std::vector<double>& xs,
                      const std::vector<double>& ys, int bound_to_atom_idx);

    // -- Monomers (coarse-grained peptide/nucleic-acid mode) ---------------
    // A monomer is a single dummy RDKit::Atom carrying residue metadata (via
    // rdkit_extensions::makeMonomer), a connection is a single RDKit::Bond, and
    // the mol is flagged `HELM_MODEL` (isMonomeric). Mirrors Qt's MolModel
    // monomer methods (model/mol_model.cpp), which sit on the same rdkit_
    // extensions coarse-grain API. Atomistic and monomeric content don't mix.

    /**
     * Place a new free-standing monomer at (x, y), starting a fresh chain.
     * `res_name` is the monomer symbol (e.g. "A" for Alanine); `chain_type` is
     * an int matching rdkit_extensions::ChainType (0=PEPTIDE, 1=RNA, 2=DNA,
     * 3=CHEM). Flags the mol monomeric. Backs the monomer draw tool clicking
     * empty canvas (Qt's MolModel::addMonomer). Single undo step.
     */
    void addMonomer(const std::string& res_name, int chain_type, double x,
                    double y);

    /**
     * Add a monomer at (x, y) bonded to the existing monomer `bound_to_idx`,
     * continuing that monomer's chain (residue number = neighbor + 1). The
     * attachment-point linkage is resolved from the two monomers' kinds
     * (mirrors Qt's get_attachment_point_for_new_monomer): peptide↔peptide and
     * sugar↔phosphate use a backbone (R2-R1) connection; sugar↔base uses a
     * branch (R3-R1) connection. Backs the monomer draw tool clicking on an
     * existing monomer (Qt's MolModel::addBoundMonomer). Single undo step.
     * No-op when `bound_to_idx` is out of range.
     */
    void addBoundMonomer(const std::string& res_name, int chain_type, double x,
                         double y, unsigned int bound_to_idx);

    /**
     * Place a full nucleotide — sugar (rect) + base (diamond, branched off the
     * sugar's 1' via R3-R1) + phosphate (ellipse, backbone off the sugar's 3'
     * via R2-R1) — starting a fresh RNA chain. The sugar sits at (x, y); the
     * phosphate is one MONOMER_BOND_LENGTH to the +x side and the base one
     * MONOMER_BOND_LENGTH to the -y side. `sugar`/`base`/`phos` are the monomer
     * symbols (e.g. "R"/"U"/"P" for RNA, "dR"/"T"/"P" for DNA). Mirrors Qt's
     * RNA/DNA nucleotide tool (draw_monomer_fragment_scene_tool, HELM
     * "RNA1{R(U)P}"). All three monomers + two connections land in one undo
     * step.
     */
    void addNucleotide(const std::string& sugar, const std::string& base,
                       const std::string& phos, double x, double y);

    /**
     * Add a nucleotide (see addNucleotide) chained onto the existing monomer
     * `bound_to_idx` — the new sugar's 5' (R1) connects to `bound_to_idx` via a
     * backbone (R2-R1) connection, continuing that monomer's chain. Intended
     * for clicking the 3' phosphate at the end of a strand. The new sugar sits
     * at (x, y). Single undo step. No-op when `bound_to_idx` is out of range.
     */
    void addBoundNucleotide(const std::string& sugar, const std::string& base,
                            const std::string& phos, double x, double y,
                            unsigned int bound_to_idx);

    /**
     * Mutate the monomer at `idx` in place to residue `res_name`, keeping its
     * position, chain, residue number, and connections (only the residue
     * symbol/label change). Backs the monomer draw tool clicking directly on an
     * existing monomer of the same kind but a different residue (Qt's
     * MolModel::mutateMonomers → rdkit_extensions::mutateMonomer). Single undo
     * step. No-op when `idx` is out of range or not a monomer.
     */
    void mutateMonomer(unsigned int idx, const std::string& res_name);

    /**
     * Add a monomer at (x, y) bonded to the existing monomer `bound_to_idx`
     * through a SPECIFIC attachment point on that monomer (`existing_ap`, a
     * model name like "R2"). The new monomer's attachment point is resolved from
     * the two monomers' kinds + the chosen existing AP (Qt's
     * get_attachment_point_for_new_monomer), and the connection carries the
     * explicit `existing_ap-new_ap` linkage. Backs clicking an unbound
     * attachment-point stub — the way to chain a *different* residue (a plain
     * body-click mutates instead). Single undo step. No-op when `bound_to_idx`
     * is out of range or the new AP can't be resolved.
     */
    void addBoundMonomerViaAP(const std::string& res_name, int chain_type,
                              double x, double y, unsigned int bound_to_idx,
                              const std::string& existing_ap);

    /**
     * Add `delta` to the formal charge of every selected atom in a single
     * undoable command. Preserves the selection (charge edits don't reindex).
     * Refreshes the implicit-H cache so render description picks up the new
     * H counts. No-op if no atoms are selected.
     */
    void adjustChargeOnSelectedAtoms(int delta);

    /**
     * Add `delta` to the unpaired-electron (radical) count of every atom in
     * `atom_indices` in a single undoable command. Mirrors Qt's
     * `MolModel::adjustRadicalElectronsOnAtoms` (model/mol_model.cpp:2414).
     * Per-atom result is clamped to [MIN_UNPAIRED_E=0, MAX_UNPAIRED_E=4] to
     * match Qt's `MIN_UNPAIRED_E`/`MAX_UNPAIRED_E` clamping
     * (molviewer/constants.h:41-42). Atoms whose post-clamp count equals the
     * current value are still recorded so undo replays cleanly. Preserves the
     * selection. Empty `atom_indices`, `delta == 0`, or empty mol → no-op.
     */
    void adjustRadicalElectronsOnAtoms(
        const std::vector<unsigned int>& atom_indices, int delta);

    /**
     * Set the reaction atom-map number of every atom in `atom_indices` to
     * `mapping_num` in a single undoable command (0 clears the mapping).
     * Mirrors Qt's `MolModel::setAtomMapping` (used by the reaction-popup
     * Map Atoms / Remove Mapping tools, tool/atom_mapping_scene_tool.cpp).
     * Atom mapping is a per-atom property with no reindexing, so this uses
     * doCommand (not doMutation) and preserves the selection. Atoms already at
     * `mapping_num` are skipped; empty `atom_indices` or empty mol → no-op.
     */
    void setAtomMapping(const std::vector<unsigned int>& atom_indices,
                        int mapping_num);

    /**
     * Replace the element of a single atom (by index) with the element whose
     * RDKit atomic number is `atomic_num`. Used by the atom context menu's
     * "Set Element" submenu (Qt: ModifyAtomsMenu::createElementMenu →
     * SetAtomMenuWidget). Resets formal charge and explicit-H count to the
     * new element's defaults so the implicit-H cache reflects the swap, just
     * like Qt's mutateAtoms with a fresh RDKit::Atom(element). Preserves the
     * selection. Single undo step. Throws std::out_of_range if `idx` is past
     * the atom count; no-op if the atom already has that atomic number.
     */
    void setAtomElement(unsigned int idx, unsigned int atomic_num);

    /**
     * Set element (by symbol) + formal charge + isotope + unpaired-electron
     * count on a single atom in one undo step. Backs the Edit Atom Properties
     * dialog's Atom page (Qt EditAtomPropertiesDialog). No-op if `idx` is out of
     * range or `element` is not a known chemical symbol. Preserves bonds +
     * position (mutates the existing atom in place, not replaceAtom).
     */
    void setAtomProperties(unsigned int idx, const std::string& element,
                           int charge, unsigned int isotope,
                           unsigned int radicals);

    /**
     * Replace a single atom (by index) in place with an R-group dummy carrying
     * `_MolFileRLabel = r_group_num`, preserving its bonds and 2D position.
     * Backs the atom context menu's "Replace with > R-Group" (Qt's
     * ModifyAtomsMenu → ReplaceAtomsWithMenu → MolModel::mutateRGroups,
     * model/mol_model.cpp:2245). Single undo step. Throws when `r_group_num`
     * is 0; no-op when `idx` is past the atom count.
     */
    void mutateAtomToRGroup(unsigned int idx, unsigned int r_group_num);

    /**
     * Replace a single atom (by index) in place with a wildcard query atom.
     * `label` is one of A/Q/M/X/AH/QH/MH/XH — mapped to the matching RDKit
     * query maker (makeAAtomQuery, etc.) exactly as Qt's ATOM_TOOL_QUERY_MAP
     * (rdkit/atoms_and_bonds.h:61). Backs the atom context menu's "Replace
     * with > Wildcard". The display label is stored in WILDCARD_LABEL_PROP for
     * the render description. Bonds + position preserved. Single undo step.
     * No-op when `idx` is out of range or `label` is unrecognized.
     */
    void mutateAtomToWildcard(unsigned int idx, const std::string& label);

    /**
     * Replace a single atom (by index) in place with an allowed-list (or
     * not-allowed-list) query atom that matches any of `atomic_nums` (or none of
     * them when `negate`). Ports the ALLOWED_LIST / NOT_ALLOWED_LIST query build
     * from Qt's atom_properties.cpp (OR of AtomNum queries, or AND of negated
     * ones). `label` (e.g. "[C,N,O]" / "[!C,N,O]") is stored in
     * WILDCARD_LABEL_PROP for the render description. Bonds + position preserved.
     * Single undo step. No-op when `idx` is out of range or `atomic_nums` empty.
     */
    void setAtomAllowedList(unsigned int idx,
                            const std::vector<int>& atomic_nums, bool negate,
                            const std::string& label);

    /**
     * Place a new free-standing wildcard query atom (A/Q/M/X + H variants) at
     * (x, y). Click-to-place counterpart of mutateAtomToWildcard — backs the
     * atom-query (A▾) draw tool on empty canvas. Single undo step. No-op when
     * `label` is unrecognized.
     */
    void addWildcardAtom(const std::string& label, double x, double y);

    /**
     * Selection-wide equivalent of setAtomElement — replaces the element of
     * every selected atom with `atomic_num` in a single undo step. Mirrors
     * Qt's ModifyAtomsMenu::requestElementChange routed through
     * mutateAtoms(atoms, Element). Resets formal charge + explicit-H count
     * on each mutated atom to the new element's defaults (matches the fresh
     * RDKit::Atom(element) construction Qt does). Preserves the selection.
     * No-op when nothing is selected. Atoms past `numAtoms()` (defensive
     * against stale selection sets) are skipped.
     */
    void setElementForSelectedAtoms(unsigned int atomic_num);

    /**
     * Replace every selected atom with a hydrogen of the given mass-number
     * isotope (Deuterium = 2, Tritium = 3, ordinary H = 1, "no specific
     * isotope" = 0). Mirrors Qt's D/T keyboard shortcuts
     * (sketcher_widget.cpp:1272-1283), which call mutateAtoms with a fresh
     * RDKit::Atom("H").setIsotope(N). Resets formal charge + explicit-H
     * count on the mutated atoms to the H defaults so the implicit-H cache
     * reflects the new valence. Preserves the selection. Single undo step.
     * No-op if no atoms are selected.
     */
    void setSelectedAtomsToHydrogenIsotope(unsigned int isotope);

    /**
     * Replace the entire mol with the parsed SMILES, computing 2D coords +
     * wedge bonds so the new structure is renderable. Single undo step
     * (snapshot-based); throws std::invalid_argument if the SMILES is
     * unparseable (caller decides whether to surface that to the user).
     */
    void loadFromSmiles(const std::string& smiles);

    /**
     * Replace the mol with the parsed text, auto-detecting the format
     * (SMILES, MOL V2000/V3000, SMARTS, InChI, etc. — whatever to_rdkit's
     * AUTO_DETECT supports). Computes 2D coords + wedges. For inputs that
     * already carry coords (MOL blocks), coords are preserved as-is.
     * Throws std::invalid_argument on unparseable input.
     */
    void loadFromText(const std::string& text);

    /**
     * Append the parsed text to the current mol (auto-detects format). The
     * existing structure is preserved; the new mol is placed to the right
     * of the existing mol with IMPORT_SPACING (2 * RDDepict::BOND_LEN = 3.0
     * RDKit units) of horizontal gap, vertically centered against the
     * existing mol. When the current mol is empty, the new mol is centered
     * at the origin instead. Mirrors Qt `MolModel::addMol` with
     * reposition_mol=true (model/mol_model.cpp:1195). Single undo step.
     * Throws std::invalid_argument on unparseable input; no-op when the
     * parse succeeds but yields zero atoms.
     */
    void addMolFromText(const std::string& text);

    /**
     * Serialize the current mol as a SMILES string. Returns an empty string
     * for an empty mol. RDKit writes non-Kekulé canonical SMILES by default;
     * stereo is preserved.
     */
    std::string toSmiles() const;

    /**
     * Serialize the current mol as an MDL MOL block. `v3000` selects the
     * V3000 spec (no atom-count limit, richer query support); false picks
     * V2000 for compatibility with older tools. Returns "" for an empty
     * mol or on writer failure.
     */
    std::string toMolBlock(bool v3000) const;

    /**
     * Serialize just the current selection as an MDL MOL block. Auto-extends
     * the selection so any selected bond has both endpoints in the kept set
     * (mirrors Qt `MolModel::getSelectedMolForExport`,
     * model/mol_model.cpp:240-271). Returns "" when nothing is selected or
     * the writer fails. The live selection is not mutated — extension only
     * runs against a local copy. Bonds whose both endpoints land in the
     * selection survive even if the bond itself wasn't selected (matches
     * RDKit's `removeAtom`-keeps-incident-bonds-where-both-survive policy
     * that Qt relies on).
     */
    std::string toMolBlockForSelection(bool v3000) const;

    /**
     * Generic exporter — routes through `rdkit_extensions::to_string` for
     * the format named by `format_name`. Supported names mirror Qt's
     * `get_standard_export_formats()` list (file_import_export.cpp:75):
     *   "smiles", "extended_smiles", "smarts", "extended_smarts",
     *   "inchi", "inchikey", "pdb", "xyz", "mrv", "maestro",
     *   "mdl_molv3000", "mdl_molv2000", "helm", "fasta"
     * The sequence formats ("helm"/"fasta") are always offered — to_string
     * converts atomistic↔monomeric on the fly and surfaces failures as "".
     * `selection_only=true` extracts the current selection first (using the
     * same auto-extend-to-bond-endpoints logic as `toMolBlockForSelection`)
     * — returns "" when nothing is selected. `false` exports the whole mol.
     * Returns "" on empty mol, unknown format name, or writer failure.
     */
    std::string toFormatString(const std::string& format_name,
                               bool selection_only) const;

    /**
     * Promote every implicit hydrogen to an explicit atom with a generated
     * 2D position. Single undo step. No-op when the mol is empty; safe to
     * call repeatedly (a fully-explicit mol just stays that way).
     */
    void addHydrogens();

    /**
     * Strip explicit hydrogens back to implicit. Counterpart to addHydrogens.
     * Hs that carry isotopes / charges / unusual valence are preserved (per
     * rdkit_extensions::removeHs's "common standard"). Single undo step.
     */
    void removeHydrogens();

    /**
     * Promote implicit hydrogens to explicit on the given atoms only.
     * `atom_indices` empty means "all atoms" (matches
     * rdkit_extensions::addHs). Single undo step. No-op when the mol is
     * empty. Mirrors Qt's MolModel::addExplicitHs(atoms) in
     * model/mol_model.cpp.
     */
    void
    addExplicitHsToAtoms(const std::vector<unsigned int>& atom_indices);

    /**
     * Counterpart to addExplicitHsToAtoms: strip explicit hydrogens that are
     * attached to (or whose own index is in) `atom_indices`. Empty input is
     * a no-op (unlike rdkit_extensions::removeHs's "no args = all" overload —
     * the per-atom action would never be invoked with an empty list, so we
     * treat empty as "nothing to do" to keep the API unambiguous). Single
     * undo step. Hs carrying isotopes / charges / unusual valence are
     * preserved.
     */
    void removeExplicitHsFromAtoms(
        const std::vector<unsigned int>& atom_indices);

    /**
     * Perceive aromaticity on the current mol — sets the aromatic flag on
     * atoms and bonds wherever RDKit's default aromaticity model fires
     * (Daylight-ish). Single undo step. No-op when the mol is empty. Swallow
     * RDKit perception failures so a stray odd valence doesn't kill the edit.
     */
    void aromatize();

    /**
     * Kekulize the current mol — replaces aromatic bonds with explicit
     * SINGLE/DOUBLE alternation and clears the aromatic flag. Counterpart to
     * aromatize. Single undo step. Silent no-op if kekulization fails for
     * the current structure (e.g. unkekulizable aromatic system).
     */
    void kekulize();

    /**
     * Recompute 2D coordinates for the entire mol via
     * rdkit_extensions::compute2DCoords + wedgeMolBonds. Useful as a
     * "clean up" action after the user has dragged atoms into a mess, or
     * after a load path that left coords stale. Single undo step. No-op
     * when the mol is empty.
     */
    void cleanUp();

    /**
     * Rotate every selected atom by `angle_rad` (counterclockwise, since the
     * model-space Y axis points up) around the centroid of the selection.
     * When no atoms are selected, rotates the whole mol around its centroid.
     * Single undo step. No-op on empty mol. Preserves selection.
     */
    void rotateSelectedAtoms(double angle_rad);

    /**
     * Flip every selected atom across a horizontal (when `horizontal` is true:
     * mirror left↔right, i.e. negate X about the centroid X) or vertical
     * (mirror top↔bottom: negate Y about the centroid Y) axis through the
     * selection centroid. When no atoms are selected, flips the whole mol.
     * Single undo step. No-op on empty mol. Preserves selection.
     */
    void flipSelectedAtoms(bool horizontal);

    /**
     * Flip the smaller of the two substituents hanging off `begin_idx`—
     * `end_idx` across the bond axis. Mirrors Qt's `MolModel::flipSubstituent`
     * (model/mol_model.cpp:1793) — backs the bond context menu's "Flip
     * Substituent". Removes the bond internally to split the mol into two
     * fragments, reflects the smaller fragment's atoms across the line through
     * the two bond endpoints, and applies it as one undo step. No-op when the
     * bond is missing or lies in a ring (removal wouldn't disconnect the mol,
     * so there aren't two clean substituents).
     */
    void flipSubstituentAroundBond(unsigned int begin_idx,
                                   unsigned int end_idx);

    // -- Selection --------------------------------------------------------
    // Selection is transient UI state, not undoable. Any mutation that may
    // reindex atoms/bonds clears it (matching the simplest correct policy
    // for index-based selection). For a stable-across-edits selection we'd
    // need the original sketcher's tag system; deliberately scoped out.

    void setAtomSelected(unsigned int atom_idx, bool selected);
    void setBondSelected(unsigned int bond_idx, bool selected);
    bool isAtomSelected(unsigned int atom_idx) const;
    bool isBondSelected(unsigned int bond_idx) const;
    bool hasSelection() const;
    void selectAll();
    void clearSelection();

    const std::unordered_set<unsigned int>& selectedAtoms() const
    {
        return m_selected_atoms;
    }
    const std::unordered_set<unsigned int>& selectedBonds() const
    {
        return m_selected_bonds;
    }

    /** Undoably remove every selected atom and bond (and incident bonds of
     *  selected atoms). No-op if the selection is empty. */
    void deleteSelected();

    // -- Non-molecular objects (reaction arrow + pluses) ------------------
    // Reaction schemes live outside the RWMol — Qt stores a single optional
    // arrow plus a vector of pluses (model/mol_model.cpp:185-186). The
    // sketcher_core port mirrors that shape: at most one arrow, any number
    // of pluses. Both are persistent state and round-trip through doMutation
    // snapshots so undo of any operation restores them faithfully.

    /**
     * Place the reaction arrow at (x, y). Throws std::runtime_error when an
     * arrow already exists — Qt's MolModel::addNonMolecularObject enforces the
     * same "Only one arrow allowed" rule (model/mol_model.cpp:1116-1118).
     * Single undo step.
     */
    void addRxnArrow(double x, double y);

    /**
     * Append a reaction plus sign at (x, y). Pluses are unlimited (unlike the
     * arrow); each click drops another. Single undo step.
     */
    void addRxnPlus(double x, double y);

    bool hasRxnArrow() const
    {
        return m_rxn_arrow.has_value();
    }
    /** Coordinates of the arrow center; undefined behavior if !hasRxnArrow(). */
    std::pair<double, double> rxnArrow() const
    {
        return m_rxn_arrow.value();
    }
    const std::vector<std::pair<double, double>>& rxnPluses() const
    {
        return m_rxn_pluses;
    }

    // -- Substance groups (bracket subgroups: SRU / copolymer) ------------
    // S-groups live inside the RWMol as RDKit::SubstanceGroups, so they
    // round-trip through doMutation snapshots automatically (RWMol copy
    // preserves them). Mirrors Qt MolModel::addSGroup (model/mol_model.cpp:2439)
    // + rdkit/sgroup.cpp helpers.

    /**
     * True iff `atom_indices` can form a valid bracket subgroup: non-empty,
     * all atoms connected, and exactly two bonds crossing between the group and
     * the rest of the molecule. Ported from `can_atoms_form_sgroup`
     * (rdkit/sgroup.cpp:149). Backs the "Add Brackets" enable gate.
     */
    bool canAtomsFormSGroup(const std::vector<unsigned int>& atom_indices) const;

    /**
     * Add a bracket substance group over `atom_indices`. `type_str` is the
     * RDKit TYPE ("SRU"/"COP"/"GEN"), `connect_str` the CONNECT repeat pattern
     * ("HT"/"HH"/"EU", empty for none), `label` the polymer/numeric label.
     * No-op if the atoms can't form a valid S-group (see canAtomsFormSGroup).
     * Single undo step. Mirrors Qt MolModel::addSGroup.
     */
    void addSGroup(const std::vector<unsigned int>& atom_indices,
                   const std::string& type_str, const std::string& connect_str,
                   const std::string& label);

    /** Number of substance groups on the molecule. */
    unsigned int numSGroups() const;

    /**
     * Remove the substance group at `index` (position in getSubstanceGroups).
     * Uses RDKit's rebuild-without-it workaround (rdkit/sgroup.cpp:56). No-op if
     * `index` is out of range. Single undo step. Backs "Remove Brackets".
     */
    void removeSGroup(unsigned int index);

    /**
     * Update the TYPE / CONNECT / LABEL of the substance group at `index` in
     * place (atoms + bonds unchanged). No-op if `index` is out of range. Single
     * undo step. Backs the bracket "Modify Notation…" flow.
     */
    void modifySGroup(unsigned int index, const std::string& type_str,
                      const std::string& connect_str, const std::string& label);

    /** Fired once per applied/undone/redone mutation. */
    Signal<> modelChanged;

    /** Fired when the selection set changes (independent of modelChanged). */
    Signal<> selectionChanged;

  private:
    /**
     * Run a mutation under snapshot-based undo: capture an RWMol copy before
     * and after, then push a command whose redo/undo restore those copies.
     * Also clears any current selection (selection is reset by any edit).
     */
    void doMutation(const std::function<void()>& mutate,
                    std::string description);

    RDKit::RWMol m_mol;
    std::unordered_set<unsigned int> m_selected_atoms;
    std::unordered_set<unsigned int> m_selected_bonds;
    std::optional<std::pair<double, double>> m_rxn_arrow;
    std::vector<std::pair<double, double>> m_rxn_pluses;
};

} // namespace sketcher_core
} // namespace schrodinger
