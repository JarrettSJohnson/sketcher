#define BOOST_TEST_MODULE Test_Sketcher
#include <boost/test/unit_test.hpp>

#include "../test_common.h"
#include "schrodinger/sketcher/dialog/file_import_export.h"
#include "schrodinger/sketcher/menu/cut_copy_action_manager.h"
#include "schrodinger/sketcher/model/mol_model.h"
#include "schrodinger/sketcher/model/sketcher_model.h"

BOOST_GLOBAL_FIXTURE(QApplicationRequiredFixture);

namespace schrodinger
{
namespace sketcher
{

/**
 * Verify that cut and copy actions are enabled as expected
 */
BOOST_AUTO_TEST_CASE(test_updateActions)
{
    TestSketcherWidget sk;
    auto mol_model = sk.m_mol_model;
    CutCopyActionManager mgr(nullptr);
    mgr.setModel(sk.m_sketcher_model);
    // empty
    BOOST_TEST(!mgr.m_cut_action->isEnabled());
    BOOST_TEST(!mgr.m_copy_action->isEnabled());
    BOOST_TEST(!mgr.m_copy_as_menu->isEnabled());

    sk.addFromString("CC");
    BOOST_TEST(!mgr.m_cut_action->isEnabled());
    BOOST_TEST(mgr.m_copy_action->isEnabled());
    BOOST_TEST(mgr.m_copy_as_menu->isEnabled());
    BOOST_TEST(mgr.m_copy_action->text().toStdString() == "Copy All");
    BOOST_TEST(mgr.m_copy_as_menu->title().toStdString() == "Copy All As");

    mol_model->selectAll();
    BOOST_TEST(mgr.m_cut_action->isEnabled());
    BOOST_TEST(mgr.m_copy_action->isEnabled());
    BOOST_TEST(mgr.m_copy_as_menu->isEnabled());
    BOOST_TEST(mgr.m_copy_action->text().toStdString() == "Copy");
    BOOST_TEST(mgr.m_copy_as_menu->title().toStdString() == "Copy As");

    // All formats are present as actions, we just show/hide based on the
    // active scene contents (mol vs reaction vs monomer)
    BOOST_TEST(mgr.m_copy_as_menu->actions().size() ==
               get_standard_export_formats().size() +
                   get_reaction_export_formats().size() +
                   get_monomeric_export_formats().size() +
                   2); // + (separator + image)

    // Confirm copy as menu only shows actions tagged with the expected
    // category. The image action and its separator follow a separate rule
    // (only visible during "Copy All As").
    auto category_actions_visible = [&mgr](CopyFormatCategory expected_cat) {
        for (auto act : mgr.m_copy_as_menu->actions()) {
            bool expected;
            if (act->isSeparator() || act->text() == "Image") {
                expected =
                    mgr.m_copy_as_menu->title().toStdString() == "Copy All As";
            } else {
                auto act_cat =
                    static_cast<CopyFormatCategory>(act->data().toInt());
                expected = (act_cat == expected_cat);
            }
            if (act->isVisible() != expected) {
                return false;
            }
        }
        return true;
    };

    auto select_one_atom = [mol_model]() {
        auto atom = mol_model->getMol()->getAtomWithIdx(0);
        mol_model->select({atom}, {}, {}, {}, {}, SelectMode::SELECT_ONLY);
    };

    BOOST_TEST(category_actions_visible(CopyFormatCategory::ATOMISTIC));
    mol_model->clear();
    BOOST_TEST(category_actions_visible(CopyFormatCategory::ATOMISTIC));
    sk.addFromString("CC>>CC");
    BOOST_TEST(category_actions_visible(CopyFormatCategory::REACTION));
    select_one_atom();
    BOOST_TEST(category_actions_visible(CopyFormatCategory::ATOMISTIC));
    mol_model->selectAll();
    BOOST_TEST(category_actions_visible(CopyFormatCategory::REACTION));
    mol_model->clear();
    BOOST_TEST(category_actions_visible(CopyFormatCategory::ATOMISTIC));
    sk.addFromString("CC");
    BOOST_TEST(category_actions_visible(CopyFormatCategory::ATOMISTIC));

    // monomeric content swaps to the monomeric category
    mol_model->clear();
    sk.addFromString("PEPTIDE1{A.G.L}$$$$V2.0");
    BOOST_TEST(category_actions_visible(CopyFormatCategory::MONOMERIC));
    mol_model->clear();
    BOOST_TEST(category_actions_visible(CopyFormatCategory::ATOMISTIC));

    // background context menu always "Copy All"
    mgr.setAlwaysCopyAll(true);

    sk.addFromString("CC");
    BOOST_TEST(category_actions_visible(CopyFormatCategory::ATOMISTIC));
    mol_model->clear();
    BOOST_TEST(category_actions_visible(CopyFormatCategory::ATOMISTIC));
    sk.addFromString("CC>>CC");
    BOOST_TEST(category_actions_visible(CopyFormatCategory::REACTION));
    select_one_atom();
    BOOST_TEST(
        category_actions_visible(CopyFormatCategory::REACTION)); // ignores sel
    mol_model->selectAll();
    BOOST_TEST(
        category_actions_visible(CopyFormatCategory::REACTION)); // ignores sel
    mol_model->clear();
    BOOST_TEST(category_actions_visible(CopyFormatCategory::ATOMISTIC));
    sk.addFromString("CC");
    BOOST_TEST(category_actions_visible(CopyFormatCategory::ATOMISTIC));
    mol_model->clear();
    sk.addFromString("PEPTIDE1{A.G.L}$$$$V2.0");
    BOOST_TEST(category_actions_visible(CopyFormatCategory::MONOMERIC));
}

} // namespace sketcher
} // namespace schrodinger
