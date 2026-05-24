/* -------------------------------------------------------------------------
 * Lean Qt-free WASM entry point for the sketcher.
 *
 * Spike for the "Sketcher Qt removal" plan: exposes a minimal embind surface
 * over rdkit_extensions to prove a Qt-free WASM bundle is viable.
 *
 * Copyright Schrodinger LLC, All Rights Reserved.
 --------------------------------------------------------------------------- */

#include <sstream>
#include <string>

#include <emscripten/bind.h>

#include <GraphMol/Atom.h>
#include <GraphMol/Bond.h>
#include <GraphMol/Conformer.h>
#include <GraphMol/RWMol.h>

#include "schrodinger/rdkit_extensions/convert.h"
#include "schrodinger/rdkit_extensions/coord_utils.h"
#include "schrodinger/rdkit_extensions/file_format.h"

namespace
{

using schrodinger::rdkit_extensions::compute2DCoords;
using schrodinger::rdkit_extensions::Format;
using schrodinger::rdkit_extensions::to_rdkit;

std::string render_description_from_text(const std::string& text,
                                         const Format format)
{
    auto mol = to_rdkit(text, format);
    if (!mol || mol->getNumAtoms() == 0) {
        return R"({"atoms":[],"bonds":[]})";
    }
    compute2DCoords(*mol);
    const auto& conf = mol->getConformer();

    std::ostringstream os;
    os.precision(4);
    os << std::fixed;

    os << "{\"atoms\":[";
    for (unsigned int i = 0; i < mol->getNumAtoms(); ++i) {
        const auto& p = conf.getAtomPos(i);
        if (i > 0) {
            os << ',';
        }
        os << "{\"i\":" << i << ",\"el\":\""
           << mol->getAtomWithIdx(i)->getSymbol() << "\",\"x\":" << p.x
           << ",\"y\":" << p.y << '}';
    }
    os << "],\"bonds\":[";
    for (unsigned int i = 0; i < mol->getNumBonds(); ++i) {
        const auto* b = mol->getBondWithIdx(i);
        if (i > 0) {
            os << ',';
        }
        os << "{\"a\":" << b->getBeginAtomIdx()
           << ",\"b\":" << b->getEndAtomIdx()
           << ",\"o\":" << b->getBondTypeAsDouble() << '}';
    }
    os << "]}";
    return os.str();
}

std::string render_description_from_smiles(const std::string& smiles)
{
    return render_description_from_text(smiles, Format::SMILES);
}

} // namespace

EMSCRIPTEN_BINDINGS(sketcher_lean)
{
    emscripten::enum_<Format>("Format")
        .value("AUTO_DETECT", Format::AUTO_DETECT)
        .value("SMILES", Format::SMILES)
        .value("EXTENDED_SMILES", Format::EXTENDED_SMILES)
        .value("MDL_MOLV2000", Format::MDL_MOLV2000)
        .value("MDL_MOLV3000", Format::MDL_MOLV3000)
        .value("INCHI", Format::INCHI)
        .value("HELM", Format::HELM)
        .value("FASTA_PEPTIDE", Format::FASTA_PEPTIDE);

    emscripten::function("render_description_from_smiles",
                         &render_description_from_smiles);
    emscripten::function("render_description_from_text",
                         &render_description_from_text);
}

int main()
{
    return 0;
}
