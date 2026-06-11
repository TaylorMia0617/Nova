import { useEffect, useState } from "react";
import { GitBranch, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { useBlueprintStore } from "../stores/blueprintStore";
import { useFileStore } from "../stores/fileStore";
import { useTranslation } from "../hooks/useTranslation";
import "./BlueprintPanel.css";

export default function BlueprintPanel() {
  const { t } = useTranslation();
  const { blueprints, isLoading, errorMessage, loadBlueprints, createBlueprint, deleteBlueprint, renameBlueprint } = useBlueprintStore();
  const { rootPath, openBlueprintTab, closeBlueprintTabs, renameBlueprintTabs } = useFileStore();
  const [newName, setNewName] = useState("");
  const [selectedBlueprintId, setSelectedBlueprintId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  useEffect(() => {
    setSelectedBlueprintId(null);
    setRenamingId(null);
    setRenameValue("");
    setNewName("");
    if (rootPath) void loadBlueprints();
  }, [rootPath, loadBlueprints]);

  const handleCreate = async () => {
    const blueprint = await createBlueprint(newName.trim() || t("blueprint.defaultName"));
    setNewName("");
    openBlueprintTab(blueprint.id, blueprint.name);
  };

  const handleRename = async (id: string) => {
    const name = renameValue.trim();
    if (!name) return;
    await renameBlueprint(id, name);
    renameBlueprintTabs(id, name);
    setRenamingId(null);
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm(t("blueprint.deleteConfirm"))) return;
    setSelectedBlueprintId((current) => (current === id ? null : current));
    setRenamingId((current) => (current === id ? null : current));
    setRenameValue("");
    closeBlueprintTabs(id);
    try {
      await deleteBlueprint(id);
    } catch {
      await loadBlueprints();
    }
  };

  return (
    <section className="blueprint-panel">
      <header className="blueprint-panel-header">
        <div>
          <h2>{t("blueprint.title")}</h2>
          <p>{t("blueprint.subtitle")}</p>
        </div>
      </header>
      <div className="blueprint-create-row">
        <input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder={t("blueprint.namePlaceholder")}
          disabled={!rootPath || isLoading}
          onKeyDown={(event) => { if (event.key === "Enter") void handleCreate(); }}
        />
        <button type="button" onClick={() => void handleCreate()} disabled={!rootPath || isLoading} title={t("blueprint.create")}>
          <Plus size={15} />
        </button>
      </div>
      {isLoading && (
        <div className="blueprint-loading" role="status" aria-live="polite">
          <LoaderCircle size={20} />
          <span>{t("blueprint.loading")}</span>
        </div>
      )}
      {!isLoading && blueprints.length === 0 && (
        <div className="blueprint-empty">{t("blueprint.empty")}</div>
      )}
      {errorMessage && <div className="blueprint-error">{errorMessage}</div>}
      {!isLoading && (
        <div className="blueprint-list">
          {blueprints.map((blueprint) => (
          <article key={blueprint.id} className={`blueprint-list-item ${selectedBlueprintId === blueprint.id ? "selected" : ""}`}>
            {renamingId === blueprint.id ? (
              <input
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onBlur={() => void handleRename(blueprint.id)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") void handleRename(blueprint.id);
                  if (event.key === "Escape") setRenamingId(null);
                }}
                autoFocus
              />
            ) : (
              <button
                type="button"
                className="blueprint-open-button"
                onClick={() => setSelectedBlueprintId(blueprint.id)}
                onDoubleClick={() => openBlueprintTab(blueprint.id, blueprint.name)}
                title={t("blueprint.doubleClickOpen")}
              >
                <GitBranch size={15} />
                <span>{blueprint.name}</span>
                <small>{blueprint.nodes.length} {t("blueprint.nodes")}</small>
              </button>
            )}
            <div className="blueprint-item-actions">
              <button
                type="button"
                onClick={() => {
                  setSelectedBlueprintId(blueprint.id);
                  setRenamingId(blueprint.id);
                  setRenameValue(blueprint.name);
                }}
              >
                {t("blueprint.rename")}
              </button>
              <button type="button" onClick={() => { setSelectedBlueprintId(blueprint.id); void handleDelete(blueprint.id); }} title={t("blueprint.delete")}>
                <Trash2 size={14} />
              </button>
            </div>
          </article>
          ))}
        </div>
      )}
    </section>
  );
}
