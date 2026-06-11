import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  File,
  FileCog,
  Folder,
  FolderPlus,
  Pencil,
  Plus,
  Save,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useFileStore } from "../stores/fileStore";
import { useTranslation } from "../hooks/useTranslation";
import type { WorkspaceNode } from "../services/fileSystemService";
import type { ReferenceListData } from "../services/fileSystemService";
import { buildWorkspaceIndexes, collectFolderPaths, filterWorkspaceNodes } from "../utils/workspaceTree";
import "./AssetsPanel.css";

type CreateDialogState =
  | { type: "file"; targetNodePath: string | null }
  | { type: "folder"; targetNodePath: string | null }
  | null;

type CreateFileExtension = ".docx" | ".txt" | ".md";

const CREATE_FILE_EXTENSIONS: CreateFileExtension[] = [".docx", ".txt", ".md"];
const CHARACTER_REFERENCE_BODY_TEMPLATE = `{basic}
[name]:
[age]:
[identity]:

{appearance}
  [hair]:
  [eyes]:

{personality}
  [surface]:
  {core_belief}:
  [desire]:
  [fear]:

{history}
  [events]:

{behavior}
  [danger]:
  [pressure]:
  [conflict]:

{relationships}

{arc}
  [start]:
  [end]:`;

const createDraftList = (): ReferenceListData => ({
  id: `list-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
  name: "New List",
  items: [{ key: "", value: "", body: "" }],
});

const AssetsPanel: React.FC = () => {
  const { t } = useTranslation();
  const {
    files,
    rootPath,
    activeFile,
    referenceLists,
    selectedListId,
    ensureFolderLoaded,
    openFile,
    createFile,
    createFolder,
    deleteFile,
    renameFile,
    duplicateFile,
    moveFile,
    loadReferenceLists,
    saveReferenceList,
    deleteReferenceList,
    setSelectedListId,
  } = useFileStore();
  const [selectedNodePath, setSelectedNodePath] = useState<string | null>(null);
  const [contextPos, setContextPos] = useState<{ x: number; y: number } | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [renamingNodePath, setRenamingNodePath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [draggedNodePath, setDraggedNodePath] = useState<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [createDialog, setCreateDialog] = useState<CreateDialogState>(null);
  const [createValue, setCreateValue] = useState("");
  const [createExtension, setCreateExtension] = useState<CreateFileExtension>(".docx");
  const [deleteConfirmPath, setDeleteConfirmPath] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [referenceDialogOpen, setReferenceDialogOpen] = useState(false);
  const [referenceListDraft, setReferenceListDraft] = useState<ReferenceListData | null>(null);
  const [referenceSearchQuery, setReferenceSearchQuery] = useState("");
  const [referenceError, setReferenceError] = useState("");
  const [referenceSaveStatus, setReferenceSaveStatus] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const createInputRef = useRef<HTMLInputElement | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);

  const workspaceIndexes = useMemo(() => buildWorkspaceIndexes(files), [files]);

  const getTargetFolderPath = (nodePath: string | null): string | undefined => {
    if (!nodePath) return rootPath ?? undefined;

    const selectedNode = workspaceIndexes.nodeIndex[nodePath] ?? null;
    if (selectedNode?.type === "folder") {
      return selectedNode.path;
    }

    return workspaceIndexes.parentIndex[nodePath] ?? rootPath ?? undefined;
  };

  const selectedNode = useMemo(
    () => (selectedNodePath ? workspaceIndexes.nodeIndex[selectedNodePath] ?? null : null),
    [workspaceIndexes, selectedNodePath]
  );
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();

  const visibleFiles = useMemo(() => {
    if (!normalizedSearchQuery) return files;
    return filterWorkspaceNodes(files, normalizedSearchQuery);
  }, [files, normalizedSearchQuery]);

  const visibleExpandedFolders = useMemo(() => {
    if (!normalizedSearchQuery) return expandedFolders;
    return collectFolderPaths(visibleFiles);
  }, [expandedFolders, normalizedSearchQuery, visibleFiles]);

  const filteredReferenceLists = useMemo(() => {
    if (!referenceSearchQuery.trim()) return referenceLists;
    const query = referenceSearchQuery.trim().toLowerCase();
    return referenceLists.filter(list => list.name.toLowerCase().includes(query));
  }, [referenceLists, referenceSearchQuery]);

  const selectedList = useMemo(
    () => referenceLists.find(l => l.id === selectedListId) ?? null,
    [referenceLists, selectedListId]
  );

  const toggleFolder = async (folderPath: string) => {
    const node = workspaceIndexes.nodeIndex[folderPath] ?? null;
    if (node?.type === "folder" && !node.isLoaded) {
      await ensureFolderLoaded(folderPath);
    }

    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      return next;
    });
  };

  const beginRename = (nodePath: string) => {
    const node = workspaceIndexes.nodeIndex[nodePath] ?? null;
    if (!node || node.path === rootPath) return;
    setSelectedNodePath(nodePath);
    setRenamingNodePath(nodePath);
    setRenameValue(node.name);
    setContextPos(null);
  };

  const commitRename = async () => {
    if (!renamingNodePath) return;
    const trimmed = renameValue.trim();
    if (trimmed) {
      await renameFile(renamingNodePath, trimmed);
      setSelectedNodePath((current) => (current === renamingNodePath ? null : current));
    }
    setRenamingNodePath(null);
    setRenameValue("");
  };

  const cancelRename = () => {
    setRenamingNodePath(null);
    setRenameValue("");
  };

  const openCreateDialog = (type: "file" | "folder", targetNodePath: string | null = selectedNodePath) => {
    setCreateDialog({ type, targetNodePath });
    setCreateValue("");
    setCreateExtension(".docx");
    setContextPos(null);
  };

  const closeCreateDialog = () => {
    setCreateDialog(null);
    setCreateValue("");
    setCreateExtension(".docx");
  };

  const openReferenceDialog = () => {
    setReferenceDialogOpen(true);
    setReferenceError("");
    setReferenceSaveStatus("");
    setReferenceSearchQuery("");
    if (selectedList) {
      setReferenceListDraft({ ...selectedList, items: [...selectedList.items] });
    } else {
      const newList = createDraftList();
      setReferenceListDraft(newList);
      setSelectedListId(newList.id);
    }
    setContextPos(null);
  };

  const closeReferenceDialog = () => {
    setReferenceDialogOpen(false);
    setReferenceListDraft(null);
    setReferenceError("");
    setReferenceSaveStatus("");
  };

  const handleCreateConfigFile = async () => {
    if (!referenceListDraft) return;

    const name = referenceListDraft.name.trim();
    if (!name) {
      setReferenceError(t("reference.nameRequired"));
      return;
    }

    // 过滤空行
    const validItems = referenceListDraft.items.filter(item => item.key.trim());
    const listToSave = { ...referenceListDraft, items: validItems };

    try {
      await saveReferenceList(listToSave);
      setReferenceSaveStatus(t("reference.saveSuccess"));
      setReferenceError("");
    } catch (error) {
      setReferenceError(error instanceof Error ? error.message : t("reference.saveFailed"));
    }
  };

  const handleDeleteList = async () => {
    if (!selectedListId) return;
    if (window.confirm(t("reference.deleteConfirm"))) {
      await deleteReferenceList(selectedListId);
      setReferenceListDraft(null);
    }
  };

  const handleAddRow = () => {
    if (!referenceListDraft) return;
    setReferenceListDraft({
      ...referenceListDraft,
      items: [...referenceListDraft.items, { key: "", value: "", body: "" }],
    });
  };

  const handleRemoveRow = (index: number) => {
    if (!referenceListDraft) return;
    const newItems = referenceListDraft.items.filter((_, i) => i !== index);
    setReferenceListDraft({
      ...referenceListDraft,
      items: newItems.length > 0 ? newItems : [{ key: "", value: "", body: "" }],
    });
  };

  const handleUpdateRow = (index: number, field: "key" | "value" | "body", value: string) => {
    if (!referenceListDraft) return;
    const newItems = [...referenceListDraft.items];
    newItems[index] = { ...newItems[index], [field]: value };
    setReferenceListDraft({
      ...referenceListDraft,
      items: newItems,
    });
  };

  const handleUseCharacterTemplate = (index: number) => {
    if (!referenceListDraft) return;
    const item = referenceListDraft.items[index];
    if (!item) return;
    const nextBody = item.body?.trim() ? `${item.body.trim()}\n\n${CHARACTER_REFERENCE_BODY_TEMPLATE}` : CHARACTER_REFERENCE_BODY_TEMPLATE;
    handleUpdateRow(index, "body", nextBody);
  };

  const handleImportTxt = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".txt";
    input.multiple = true;
    
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files) return;

      for (const file of files) {
        const content = await file.text();
        const items = content
          .split(/(?=^\{\{.+?\}\})/m)
          .map(block => block.trim())
          .filter(Boolean)
          .map(block => {
            const [head = "", ...bodyLines] = block.split(/\r?\n/);
            const match = head.match(/^\{\{(.+?)\}\}(?:\s+(.+))?$/);
            if (!match) return null;
            return {
              key: match[1].trim(),
              value: (match[2] ?? "").trim().replace(/^["“]|["”]$/g, ""),
              body: bodyLines.join("\n").trim(),
            };
          })
          .filter((item): item is { key: string; value: string; body: string } => item !== null);

        // 去重
        const uniqueItems = items.filter((item, index, self) =>
          index === self.findIndex(t => t.key === item.key)
        );

        const newList: ReferenceListData = {
          id: `list-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          name: file.name.replace(/\.txt$/, ""),
          items: uniqueItems,
        };

        try {
          await saveReferenceList(newList);
        } catch (error) {
          console.error("Failed to import list:", error);
        }
      }

      await loadReferenceLists();
      setReferenceSaveStatus(t("reference.importSuccess"));
    };

    input.click();
  };

  const handleExportTxt = () => {
    if (!referenceListDraft) return;

    const content = referenceListDraft.items
      .filter(item => item.key.trim())
      .map(item => {
        const head = `{{${item.key}}}${item.value ? ` "${item.value}"` : ""}`;
        return item.body?.trim() ? `${head}\n${item.body.trim()}` : head;
      })
      .join("\n");

    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${referenceListDraft.name}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    setReferenceSaveStatus(t("reference.exportSuccess"));
  };

  const handleSelectList = (listId: string) => {
    setSelectedListId(listId);
    const list = referenceLists.find(l => l.id === listId);
    if (list) {
      setReferenceListDraft({ ...list, items: [...list.items] });
    }
    setReferenceError("");
    setReferenceSaveStatus("");
  };

  const handleNewList = () => {
    const newList = createDraftList();
    setReferenceListDraft(newList);
    setSelectedListId(newList.id);
    setReferenceError("");
    setReferenceSaveStatus("");
  };

  const normalizeCreateFileName = (rawName: string) => {
    const matchedExtension = CREATE_FILE_EXTENSIONS.find((extension) =>
      rawName.toLowerCase().endsWith(extension)
    );
    const extension = matchedExtension ?? createExtension;
    const nameWithoutExtension = matchedExtension
      ? rawName.slice(0, -matchedExtension.length)
      : rawName.replace(/\.[^./\\]+$/, "");
    return `${nameWithoutExtension || "untitled"}${extension}`;
  };

  const submitCreateDialog = async () => {
    if (!createDialog) return;

    const name = createValue.trim();
    if (!name) return;

    const targetFolderPath = getTargetFolderPath(createDialog.targetNodePath);
    if (createDialog.type === "file") {
      await createFile(normalizeCreateFileName(name), targetFolderPath);
    } else {
      await createFolder(name, targetFolderPath);
    }

    closeCreateDialog();
  };

  const handleDelete = async () => {
    if (!selectedNodePath || selectedNodePath === rootPath) return;
    setDeleteConfirmPath(selectedNodePath);
    setContextPos(null);
  };

  const confirmDelete = async () => {
    if (!deleteConfirmPath) return;

    await deleteFile(deleteConfirmPath);
    setSelectedNodePath((current) => (current === deleteConfirmPath ? null : current));
    setDeleteConfirmPath(null);
  };

  const handleDuplicate = async () => {
    if (!selectedNode || selectedNode.type !== "file") return;
    await duplicateFile(selectedNode.path);
    setContextPos(null);
  };

  const handleDropOnFolder = async (destinationFolderPath: string) => {
    if (!draggedNodePath || draggedNodePath === destinationFolderPath) return;
    if (destinationFolderPath.startsWith(draggedNodePath)) return;

    await moveFile(draggedNodePath, destinationFolderPath);
    setDraggedNodePath(null);
    setDropTargetPath(null);
  };

  const renderFileTree = (nodes: WorkspaceNode[], level = 0): React.ReactNode =>
    nodes.map((node) => {
      const isFolder = node.type === "folder";
      const isExpanded = visibleExpandedFolders.has(node.path);

      return (
        <div key={node.path} style={{ marginLeft: `${level * 16}px` }}>
          <div
            draggable={node.path !== rootPath}
            className={[
              "file-tree-item",
              activeFile?.path === node.path ? "active" : "",
              selectedNodePath === node.path ? "selected" : "",
              dropTargetPath === node.path ? "drop-target" : "",
            ].join(" ")}
            onClick={(e) => {
              e.stopPropagation();
              setSelectedNodePath(node.path);
              if (isFolder) {
                void toggleFolder(node.path);
              }
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (!isFolder) {
                void openFile(node.path);
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setSelectedNodePath(node.path);
              setContextPos({ x: e.clientX, y: e.clientY });
            }}
            onDragStart={(e) => {
              e.stopPropagation();
              setDraggedNodePath(node.path);
              e.dataTransfer.effectAllowed = "copyMove";
              e.dataTransfer.setData("text/plain", node.path);
              e.dataTransfer.setData("application/x-novel-node-type", node.type);
              if (!isFolder) {
                e.dataTransfer.setData("application/x-novel-file-path", node.path);
              }
            }}
            onDragOver={(e) => {
              if (!isFolder || draggedNodePath === node.path) return;
              e.preventDefault();
              setDropTargetPath(node.path);
            }}
            onDragLeave={() => {
              if (dropTargetPath === node.path) {
                setDropTargetPath(null);
              }
            }}
            onDrop={async (e) => {
              if (!isFolder) return;
              e.preventDefault();
              e.stopPropagation();
              await handleDropOnFolder(node.path);
            }}
            onDragEnd={() => {
              setDraggedNodePath(null);
              setDropTargetPath(null);
            }}
          >
            {isFolder ? (
              <>
                {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Folder size={16} className="folder-icon" />
                {renamingNodePath === node.path ? (
                  <input
                    ref={renameInputRef}
                    className="rename-input"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => void commitRename()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename();
                      if (e.key === "Escape") cancelRename();
                    }}
                  />
                ) : (
                  <span className="file-name">{node.name}</span>
                )}
              </>
            ) : (
              <>
                <span className="spacer"></span>
                <File size={16} className="file-icon" />
                {renamingNodePath === node.path ? (
                  <input
                    ref={renameInputRef}
                    className="rename-input"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => void commitRename()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename();
                      if (e.key === "Escape") cancelRename();
                    }}
                  />
                ) : (
                  <span className="file-name">{node.name}</span>
                )}
              </>
            )}
          </div>
          {isFolder && isExpanded && node.children && renderFileTree(node.children, level + 1)}
        </div>
      );
    });

  useEffect(() => {
    if (rootPath) {
      setExpandedFolders(new Set([rootPath]));
      void ensureFolderLoaded(rootPath);
    }
  }, [ensureFolderLoaded, rootPath]);

  useEffect(() => {
    const handleClick = () => setContextPos(null);
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  useEffect(() => {
    if (renamingNodePath) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingNodePath]);

  useEffect(() => {
    if (createDialog) {
      createInputRef.current?.focus();
      createInputRef.current?.select();
    }
  }, [createDialog]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTypingTarget =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.getAttribute("contenteditable") === "true";

      if (isTypingTarget) return;
      if (!selectedNodePath) return;

      if (e.key === "F2") {
        e.preventDefault();
        beginRename(selectedNodePath);
      }

      if (e.key === "Delete" && selectedNodePath !== rootPath) {
        e.preventDefault();
        void handleDelete();
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        if (selectedNode?.type === "file") {
          e.preventDefault();
          void handleDuplicate();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [rootPath, selectedNode, selectedNodePath]);

  return (
    <div className="assets-panel">
      <div className="panel-header">
        <h2>Explorer</h2>
        <div className="panel-actions">
          <button onClick={() => openCreateDialog("file")} title="New File" disabled={!rootPath}>
            <Plus size={16} />
          </button>
          <button onClick={() => openCreateDialog("folder")} title="New Folder" disabled={!rootPath}>
            <FolderPlus size={16} />
          </button>
          <button onClick={openReferenceDialog} title={t("reference.title")} disabled={!rootPath}>
            <FileCog size={16} />
          </button>
        </div>
      </div>
      <div className="explorer-search">
        <div className="search-input-wrap">
          <Search size={14} className="search-icon" />
          <input
            className="search-input"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search files and folders"
            aria-label="Search files and folders"
          />
          {searchQuery && (
            <button
              type="button"
              className="clear-search-button"
              onClick={() => setSearchQuery("")}
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      <div
        ref={treeRef}
        className="file-tree"
        onClick={() => setSelectedNodePath(null)}
        onContextMenu={(e) => {
          if (e.target === treeRef.current && rootPath) {
            e.preventDefault();
            setSelectedNodePath(null);
            setContextPos({ x: e.clientX, y: e.clientY });
          }
        }}
      >
        {rootPath ? (
          visibleFiles.length > 0 ? (
            renderFileTree(visibleFiles)
          ) : (
            <div className="explorer-empty">
              <p>No files or folders match "{searchQuery.trim()}".</p>
            </div>
          )
        ) : (
          <div className="explorer-empty">
            <p>Open a workspace folder to start editing real files.</p>
          </div>
        )}
      </div>
      {contextPos && (
        <div
          className="context-menu"
          style={{ position: "fixed", left: contextPos.x, top: contextPos.y, zIndex: 1000 }}
        >
          <button onClick={() => openCreateDialog("file")}>
            <Plus size={14} />
            <span>New File</span>
          </button>
          <button onClick={() => openCreateDialog("folder")}>
            <FolderPlus size={14} />
            <span>New Folder</span>
          </button>
          {selectedNode?.type === "folder" && (
            <button onClick={() => void toggleFolder(selectedNode.path)}>
              {expandedFolders.has(selectedNode.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span>{expandedFolders.has(selectedNode.path) ? "Collapse Folder" : "Expand Folder"}</span>
            </button>
          )}
          {selectedNode && selectedNode.path !== rootPath && (
            <button onClick={() => beginRename(selectedNode.path)}>
              <Pencil size={14} />
              <span>Rename</span>
            </button>
          )}
          {selectedNode?.type === "file" && (
            <button onClick={() => void handleDuplicate()}>
              <Copy size={14} />
              <span>Duplicate</span>
            </button>
          )}
          {selectedNode && selectedNode.path !== rootPath && (
            <button className="danger" onClick={() => void handleDelete()}>
              <Trash2 size={14} />
              <span>Delete</span>
            </button>
          )}
        </div>
      )}
      {createDialog && (
        <div className="dialog-backdrop" onClick={closeCreateDialog}>
          <div
            className="dialog-card"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeCreateDialog();
              if (event.key === "Enter") void submitCreateDialog();
            }}
          >
            <h3>{createDialog.type === "file" ? "Create New File" : "Create New Folder"}</h3>
            <p>
              {createDialog.type === "file"
                ? "Enter a file name and choose a file type."
                : "Enter a folder name."}
            </p>
            {createDialog.type === "file" ? (
              <div className="create-file-row">
                <input
                  ref={createInputRef}
                  className="dialog-input create-file-name-input"
                  value={createValue}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    setCreateValue(nextValue);
                    const matchedExtension = CREATE_FILE_EXTENSIONS.find((extension) =>
                      nextValue.toLowerCase().endsWith(extension)
                    );
                    if (matchedExtension) setCreateExtension(matchedExtension);
                  }}
                  placeholder="chapter-01"
                />
                <select
                  className="dialog-input create-extension-select"
                  value={createExtension}
                  onChange={(event) => setCreateExtension(event.target.value as CreateFileExtension)}
                >
                  {CREATE_FILE_EXTENSIONS.map((extension) => (
                    <option key={extension} value={extension}>
                      {extension}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <input
                ref={createInputRef}
                className="dialog-input"
                value={createValue}
                onChange={(event) => setCreateValue(event.target.value)}
                placeholder="notes"
              />
            )}
            <div className="dialog-actions">
              <button type="button" className="secondary" onClick={closeCreateDialog}>
                Cancel
              </button>
              <button type="button" onClick={() => void submitCreateDialog()} disabled={!createValue.trim()}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}
      {referenceDialogOpen && (
        <div className="dialog-backdrop reference-dialog-backdrop" onClick={closeReferenceDialog}>
          <div className="reference-dialog-modal" onClick={(event) => event.stopPropagation()}>
            <div className="reference-dialog-header">
              <div className="reference-dialog-title">
                <h2>{t("reference.title")}</h2>
              </div>
              <button className="icon-button" onClick={closeReferenceDialog} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <div className="reference-dialog-layout">
              <aside className="reference-dialog-sidebar">
                <div className="reference-dialog-sidebar-header">
                  <h3>{t("reference.lists")}</h3>
                  <div className="reference-dialog-sidebar-actions">
                    <button onClick={handleNewList} className="workspace-button compact-button" type="button">
                      <Plus size={14} />
                    </button>
                    <button onClick={() => void handleImportTxt()} className="workspace-button compact-button" type="button" title={t("reference.import")}>
                      <Upload size={14} />
                    </button>
                  </div>
                </div>
                <div className="explorer-search" style={{ padding: 0 }}>
                  <div className="search-input-wrap">
                    <Search size={14} className="search-icon" />
                    <input
                      className="search-input"
                      value={referenceSearchQuery}
                      onChange={(event) => setReferenceSearchQuery(event.target.value)}
                      placeholder={t("reference.searchLists")}
                    />
                    {referenceSearchQuery && (
                      <button
                        type="button"
                        className="clear-search-button"
                        onClick={() => setReferenceSearchQuery("")}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="reference-dialog-list">
                  {filteredReferenceLists.map((list) => (
                    <button
                      key={list.id}
                      type="button"
                      className={`reference-dialog-list-item ${selectedListId === list.id ? "active" : ""}`}
                      onClick={() => handleSelectList(list.id)}
                    >
                      <strong>{list.name}</strong>
                      <span>{list.items.length} items</span>
                    </button>
                  ))}
                  {filteredReferenceLists.length === 0 && (
                    <div className="reference-dialog-empty">{t("reference.noLists")}</div>
                  )}
                </div>
              </aside>
              <div className="reference-dialog-content">
                {referenceListDraft ? (
                  <>
                    <div className="reference-dialog-section">
                      <label>
                        <span>{t("reference.listName")}</span>
                        <input
                          type="text"
                          value={referenceListDraft.name}
                          onChange={(event) => setReferenceListDraft({ ...referenceListDraft, name: event.target.value })}
                          autoComplete="off"
                        />
                      </label>
                    </div>
                    <div className="reference-dialog-section reference-dialog-table-section">
                      <div className="reference-table-body">
                        {referenceListDraft.items.map((item, index) => (
                          <div key={index} className="reference-entry-card">
                            <div className="reference-entry-head">
                              <label className="reference-entry-key">
                                <span>{"{{Key}}"}</span>
                                <input
                                  className="reference-table-key"
                                  value={item.key}
                                  onChange={(event) => handleUpdateRow(index, "key", event.target.value)}
                                  placeholder={t("reference.keyPlaceholder")}
                                />
                              </label>
                              <label className="reference-entry-note">
                                <span>注释</span>
                                <input
                                  className="reference-table-value"
                                  value={item.value}
                                  onChange={(event) => handleUpdateRow(index, "value", event.target.value)}
                                  placeholder={t("reference.valuePlaceholder")}
                                />
                              </label>
                              <button
                                className="reference-table-delete"
                                onClick={() => handleRemoveRow(index)}
                                type="button"
                              >
                                <X size={14} />
                              </button>
                            </div>
                            <label className="reference-entry-body">
                              <span>结构正文</span>
                              <textarea
                                className="reference-table-body-field"
                                value={item.body ?? ""}
                                onChange={(event) => handleUpdateRow(index, "body", event.target.value)}
                                placeholder={"{basic}\n  [name]:\n  [age]:\n{personality}\n  [surface]:\n  [desire]:"}
                                spellCheck={false}
                              />
                            </label>
                            <div className="reference-entry-card-actions">
                              <button
                                className="reference-table-template"
                                onClick={() => handleUseCharacterTemplate(index)}
                                type="button"
                              >
                                插入模板
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                      <button className="workspace-button compact-button" onClick={handleAddRow} type="button">
                        <Plus size={14} />
                        <span>{t("reference.addRow")}</span>
                      </button>
                    </div>
                    <div className="reference-dialog-actions">
                      <button className="workspace-button" onClick={() => void handleCreateConfigFile()} type="button">
                        <Save size={14} />
                        <span>{t("reference.save")}</span>
                      </button>
                      <button className="workspace-button" onClick={handleExportTxt} type="button">
                        <Download size={14} />
                        <span>{t("reference.export")}</span>
                      </button>
                      <button
                        className="workspace-button danger-button"
                        onClick={() => void handleDeleteList()}
                        type="button"
                      >
                        <Trash2 size={14} />
                        <span>{t("reference.deleteList")}</span>
                      </button>
                    </div>
                    {referenceSaveStatus && <div className="reference-dialog-status">{referenceSaveStatus}</div>}
                    {referenceError && <div className="reference-dialog-status error">{referenceError}</div>}
                  </>
                ) : (
                  <div className="reference-dialog-empty">{t("reference.createList")}</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {deleteConfirmPath && (
        <div className="dialog-backdrop" onClick={() => setDeleteConfirmPath(null)}>
          <div className="dialog-card" onClick={(event) => event.stopPropagation()}>
            <h3>{t("assets.deleteItem")}</h3>
            <p>{t("assets.deleteItemConfirm")}</p>
            <div className="dialog-actions">
              <button type="button" className="secondary" onClick={() => setDeleteConfirmPath(null)}>
                {t("assets.cancel")}
              </button>
              <button type="button" className="danger-action" onClick={() => void confirmDelete()}>
                {t("assets.deleteItem")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AssetsPanel;
