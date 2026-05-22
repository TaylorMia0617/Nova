import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  File,
  Folder,
  FolderPlus,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useFileStore } from "../stores/fileStore";
import type { WorkspaceNode } from "../services/fileSystemService";
import { buildWorkspaceIndexes, collectFolderPaths, filterWorkspaceNodes } from "../utils/workspaceTree";
import "./AssetsPanel.css";

type CreateDialogState =
  | { type: "file"; targetNodePath: string | null }
  | { type: "folder"; targetNodePath: string | null }
  | null;

const AssetsPanel: React.FC = () => {
  const {
    files,
    rootPath,
    activeFile,
    ensureFolderLoaded,
    loadFullWorkspaceTree,
    openFile,
    createFile,
    createFolder,
    deleteFile,
    renameFile,
    duplicateFile,
    moveFile,
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
  const [deleteConfirmPath, setDeleteConfirmPath] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
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
    setContextPos(null);
  };

  const closeCreateDialog = () => {
    setCreateDialog(null);
    setCreateValue("");
  };

  const submitCreateDialog = async () => {
    if (!createDialog) return;

    const name = createValue.trim();
    if (!name) return;

    const targetFolderPath = getTargetFolderPath(createDialog.targetNodePath);
    if (createDialog.type === "file") {
      await createFile(name, targetFolderPath);
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
            onClick={async (e) => {
              e.stopPropagation();
              setSelectedNodePath(node.path);
              if (isFolder) {
                await toggleFolder(node.path);
              } else {
                await openFile(node.path);
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
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", node.path);
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
    if (!normalizedSearchQuery || !rootPath) return;
    void loadFullWorkspaceTree();
  }, [loadFullWorkspaceTree, normalizedSearchQuery, rootPath]);

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
                ? "Enter a file name. If you omit the extension, the app creates a Markdown file (.md)."
                : "Enter a folder name."}
            </p>
            <input
              ref={createInputRef}
              className="dialog-input"
              value={createValue}
              onChange={(event) => setCreateValue(event.target.value)}
              placeholder={createDialog.type === "file" ? "chapter-01" : "notes"}
            />
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
      {deleteConfirmPath && (
        <div className="dialog-backdrop" onClick={() => setDeleteConfirmPath(null)}>
          <div className="dialog-card" onClick={(event) => event.stopPropagation()}>
            <h3>Delete Item</h3>
            <p>This will permanently delete the selected file or folder.</p>
            <div className="dialog-actions">
              <button type="button" className="secondary" onClick={() => setDeleteConfirmPath(null)}>
                Cancel
              </button>
              <button type="button" className="danger-action" onClick={() => void confirmDelete()}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AssetsPanel;
