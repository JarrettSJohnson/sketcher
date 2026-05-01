#pragma once

#include <QAction>
#include <QMenu>

#include "schrodinger/rdkit_extensions/convert.h"
#include "schrodinger/sketcher/definitions.h"

namespace schrodinger
{
namespace sketcher
{

class SketcherModel;
enum class SceneSubset;

/**
 * Categories used to tag Copy As menu actions so the menu can be filtered to
 * the formats relevant to the current scene contents.
 */
enum class CopyFormatCategory : int { ATOMISTIC, REACTION, MONOMERIC };

class SKETCHER_API CutCopyActionManager : public QWidget
{
    Q_OBJECT
  public:
    CutCopyActionManager(QWidget* parent);
    void setModel(SketcherModel* model);

    /**
     * @param whether copy actions should dynamically change based on selection
     */
    void setAlwaysCopyAll(bool always_copy_all);

    QAction* m_cut_action = nullptr;
    QAction* m_copy_action = nullptr;
    QMenu* m_copy_as_menu = nullptr;

  signals:
    void cutRequested(schrodinger::rdkit_extensions::Format format);
    void copyRequested(schrodinger::rdkit_extensions::Format format,
                       SceneSubset subset);
    void copyAsImageRequested();

  private:
    /**
     * Updates action labels based on what subset is emitted on cut/copy
     */
    void updateActions();

    /**
     * @return subset to emit on cut/copy requests
     */
    SceneSubset getSubset();

    /**
     * Initializes the Copy As menu with atomistic, reaction, and monomeric
     * formats. Visibility is filtered by updateActions() based on the
     * current scene contents.
     */
    void initCopyAsMenu();

    SketcherModel* m_sketcher_model = nullptr;
    bool m_always_copy_all = false;
    QVector<QAction*> m_hide_for_selections;
};

} // namespace sketcher
} // namespace schrodinger
