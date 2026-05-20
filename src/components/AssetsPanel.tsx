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
  Trash2,
} from "lucide-react";
import { useFileStore } from "../stores/fileStore";
import type { WorkspaceNode } from "../services/fileSystemService";
import "./AssetsPanel.css";

const AssetsPanel: React.FC = () => {
  const {
    files,
    rootPath,
    activeFile,
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
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);

  const findNodeByPath = (nodes: WorkspaceNode[], path: string): WorkspaceNode | null => {
    for (const node of nodes) {
      if (node.path === path) return node;
      if (node.children) {
        const found = findNodeByPath(node.children, path);
        if (found) return found;
      }
    }
    return null;
  };

  const findParentPath = (nodes: WorkspaceNode[], childPath: string, parentPath?: string): string | null => {
    for (const node of nodes) {
      if (node.path === childPath) return parentPath || null;
      if (node.children) {
        const found = findParentPath(node.children, childPath, node.path);
        if (found) return found;
      }
    }
    return null;
  };

  const getTargetFolderPath = (nodePath: string | null): string | undefined => {
    if (!nodePath) return rootPath ?? undefined;

    const selectedNode = findNodeByPath(files, nodePath);
    if (selectedNode?.type === "folder") {
      return selectedNode.path;
    }

    return findParentPath(files, nodePath) ?? rootPath ?? undefined;
  };

  const selectedNode = useMemo(
    () => (selectedNodePath ? findNodeByPath(files, selectedNodePath) : null),
    [files, selectedNodePath]
  );

  const toggleFolder = (folderPath: string) => {
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
    const node = findNodeByPath(files, nodePath);
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

  const handleCreateFile = async (targetNodePath: string | null = selectedNodePath) => {
    const name = prompt("Enter file name (include .md or .txt if desired):");
    if (name) {
      await createFile(name, getTargetFolderPath(targetNodePath));
      setContextPos(null);
    }
  };

  const handleCreateFolder = async (targetNodePath: string | null = selectedNodePath) => {
    const name = prompt("Enter folder name:");
    if (name) {
      await createFolder(name, getTargetFolderPath(targetNodePath));
      setContextPos(null);
    }
  };

  const handleDelete = async () => {
    if (!selectedNodePath || selectedNodePath === rootPath) return;
    const ok = confirm("Delete selected item? This cannot be undone.");
    if (ok) {
      await deleteFile(selectedNodePath);
      setSelectedNodePath(null);
    }
    setContextPos(null);
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
      const isExpanded = expandedFolders.has(node.path);

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
                toggleFolder(node.path);
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
    }
  }, [rootPath]);

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
          <button onClick={() => void handleCreateFile()} title="New File" disabled={!rootPath}>
            <Plus size={16} />
          </button>
          <button onClick={() => void handleCreateFolder()} title="New Folder" disabled={!rootPath}>
            <FolderPlus size={16} />
          </button>
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
          renderFileTree(files)
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
          <button onClick={() => void handleCreateFile()}>
            <Plus size={14} />
            <span>New File</span>
          </button>
          <button onClick={() => void handleCreateFolder()}>
            <FolderPlus size={14} />
            <span>New Folder</span>
          </button>
          {selectedNode?.type === "folder" && (
            <button onClick={() => toggleFolder(selectedNode.path)}>
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
    </div>
  );
};

export default AssetsPanel;
