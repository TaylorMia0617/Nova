import { create } from "zustand";
import {
  createFile as createFileOnDisk,
  createFolder as createFolderOnDisk,
  deletePath,
  duplicateFile as duplicateFileOnDisk,
  loadWorkspaceTree,
  loadWorkspace,
  movePath,
  pickWorkspace,
  readDirectory,
  readFile,
  readFileBinary,
  renamePath,
  type WorkspaceNode,
  writeFile,
  writeFileBinary,
  getReferenceLists as getReferenceListsFromDisk,
  getReferenceList as getReferenceListFromDisk,
  saveReferenceList as saveReferenceListToDisk,
  deleteReferenceList as deleteReferenceListFromDisk,
  type ReferenceListData,
} from "../services/fileSystemService";
import {
  createDocxBase64FromPlainText,
  isInvalidDocxZipLike,
  parseDocxBase64,
  serializeDocxBase64,
  type DocxPackageState,
} from "../services/docxOoxmlService";
import {
  VERSION_HISTORY_IDLE_MS,
  VERSION_HISTORY_SIZE_TRIGGER_BYTES,
  estimateContentBytes,
  recordSnapshot,
  restoreSnapshot,
  updateSnapshotPaths,
} from "../services/versionHistoryService";
import type { FileChange } from "../types/ai";
import type { VersionSnapshot, VersionSnapshotReason } from "../types/versionHistory";

export type FileMode = "txt" | "markdown" | "docx" | "blueprint" | "image" | "unsupported";
export type HistoryViewMode = "browse" | "compare";
export type HistoryDiffPart = { type: "same" | "added" | "removed"; text: string };

export interface OpenFileTab {
  path: string;
  name: string;
  content: string;
  savedContent: string;
  fileMode: FileMode;
  docxPackageState?: DocxPackageState;
  blueprintId?: string;
  blueprintFocusedNodeId?: string | null;
  isReadOnly?: boolean;
  historySnapshotId?: string;
  historySourcePath?: string;
  historyViewMode?: HistoryViewMode;
  isDirty: boolean;
}

export interface ReferenceEntry {
  name: string;
  description?: string;
  sourceList?: string;
}

export interface EditorGroup {
  id: string;
  tabs: OpenFileTab[];
  activeTabPath: string | null;
}

const RECENT_WORKSPACES_KEY = "novel-assistance-recent-workspaces";
const MAX_RECENT_WORKSPACES = 5;
export const MAX_EDITOR_GROUPS = 3;
let refreshWorkspaceRequestId = 0;
const historyIdleTimers = new Map<string, number>();
const historyBaselineKeys = new Set<string>();
const historyLastSnapshotContent = new Map<string, string>();

function loadRecentWorkspaces(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_WORKSPACES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENT_WORKSPACES) : [];
  } catch {
    return [];
  }
}

function persistRecentWorkspaces(paths: string[]) {
  localStorage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(paths));
}

function clearHistoryIdleTimer(path: string) {
  const timer = historyIdleTimers.get(path);
  if (timer) {
    window.clearTimeout(timer);
    historyIdleTimers.delete(path);
  }
}

function rememberSnapshotContent(path: string, content: string) {
  historyLastSnapshotContent.set(path, content);
}

async function recordTextSnapshot(
  rootPath: string | null,
  path: string,
  content: string,
  reason: VersionSnapshotReason
) {
  await recordSnapshot({
    rootPath,
    path,
    reason,
    encoding: "utf8",
    content,
  });
  rememberSnapshotContent(path, content);
}

async function recordBinarySnapshot(
  rootPath: string | null,
  path: string,
  base64Content: string,
  reason: VersionSnapshotReason
) {
  await recordSnapshot({
    rootPath,
    path,
    reason,
    encoding: "base64",
    content: base64Content,
  });
}

interface FileState {
  rootPath: string | null;
  rootName: string | null;
  files: WorkspaceNode[];
  activeFile: OpenFileTab | null;
  editorGroups: EditorGroup[];
  activeGroupId: string;
  referenceEntries: ReferenceEntry[];
  referenceLists: ReferenceListData[];
  selectedListId: string | null;
  isLoadingWorkspace: boolean;
  errorMessage: string | null;
  fileChanges: Map<string, FileChange[]>;
  recentWorkspaces: string[];
  getOpenTabs: () => OpenFileTab[];
  setErrorMessage: (message: string | null) => void;
  openWorkspace: () => Promise<void>;
  openRecentWorkspace: (path: string) => Promise<void>;
  saveRecentWorkspace: (path: string) => void;
  clearRecentWorkspaces: () => void;
  removeRecentWorkspace: (path: string) => void;
  refreshWorkspace: () => Promise<void>;
  refreshLoadedWorkspace: (changedPath?: string | null) => Promise<void>;
  refreshFolder: (folderPath: string) => Promise<void>;
  ensureFolderLoaded: (path: string) => Promise<void>;
  loadFullWorkspaceTree: () => Promise<void>;
  openFile: (path: string, groupId?: string) => Promise<void>;
  openBlueprintTab: (blueprintId: string, name: string, focusedNodeId?: string | null, groupId?: string) => void;
  closeBlueprintTabs: (blueprintId: string) => void;
  renameBlueprintTabs: (blueprintId: string, name: string) => void;
  setActiveFile: (path: string | null) => void;
  closeTab: (path: string) => void;
  updateFileContent: (path: string, content: string) => void;
  saveFile: (path?: string, reason?: VersionSnapshotReason) => Promise<void>;
  saveAllFiles: () => Promise<void>;
  createFile: (name: string, parentPath?: string) => Promise<void>;
  createFolder: (name: string, parentPath?: string) => Promise<void>;
  renameFile: (path: string, newName: string) => Promise<void>;
  duplicateFile: (path: string) => Promise<void>;
  deleteFile: (path: string) => Promise<void>;
  moveFile: (sourcePath: string, destinationFolderPath: string) => Promise<void>;
  loadReferenceLists: () => Promise<void>;
  saveReferenceList: (list: ReferenceListData) => Promise<void>;
  deleteReferenceList: (listId: string) => Promise<void>;
  setSelectedListId: (listId: string | null) => void;
  trackFileChange: (path: string, oldContent: string, newContent: string) => void;
  getFileChanges: (path: string) => FileChange[];
  clearFileChanges: (path: string) => void;
  restoreVersionSnapshot: (snapshot: VersionSnapshot) => Promise<void>;
  openHistorySnapshotPreview: (snapshot: VersionSnapshot) => Promise<void>;
  openHistorySnapshotCompare: (snapshot: VersionSnapshot) => Promise<void>;
  splitEditor: (direction: "horizontal" | "vertical") => void;
  openFileInNewGroup: (path: string) => Promise<void>;
  closeGroup: (groupId: string) => void;
  setActiveGroup: (groupId: string) => void;
  moveTabToGroup: (tabPath: string, targetGroupId: string) => void;
  moveTabToNewGroup: (tabPath: string) => void;
}

function getNodeByPath(nodes: WorkspaceNode[], path: string): WorkspaceNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = getNodeByPath(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

function joinPath(basePath: string, name: string): string {
  const separator = basePath.includes("\\") ? "\\" : "/";
  return `${basePath}${separator}${name}`;
}

function replaceNodeChildren(nodes: WorkspaceNode[], path: string, children: WorkspaceNode[]): WorkspaceNode[] {
  return nodes.map((node) => {
    if (node.path === path && node.type === "folder") {
      return {
        ...node,
        hasChildren: children.length > 0,
        isLoaded: true,
        children,
      };
    }

    if (!node.children) {
      return node;
    }

    return {
      ...node,
      children: replaceNodeChildren(node.children, path, children),
    };
  });
}

function mergeLoadedChildren(previous: WorkspaceNode[] | undefined, fresh: WorkspaceNode[]): WorkspaceNode[] {
  const previousByPath = new Map((previous ?? []).map((node) => [node.path, node]));
  return fresh.map((node) => {
    const previousNode = previousByPath.get(node.path);
    if (node.type === "folder" && previousNode?.type === "folder" && previousNode.isLoaded) {
      return {
        ...node,
        isLoaded: true,
        children: previousNode.children,
      };
    }
    return node;
  });
}

function hydrateFolderChain(nodes: WorkspaceNode[], targetPath: string): WorkspaceNode[] {
  return nodes.map((node) => {
    if (node.type !== "folder") {
      return node;
    }

    if (targetPath === node.path || isSameOrDescendantPath(targetPath, node.path)) {
      return {
        ...node,
        hasChildren: true,
        children: node.children ?? [],
      };
    }

    if (!node.children) {
      return node;
    }

    return {
      ...node,
      children: hydrateFolderChain(node.children, targetPath),
    };
  });
}

function getPathPrefix(targetPath: string): string {
  const separator = targetPath.includes("\\") ? "\\" : "/";
  return `${targetPath.replace(/[\\/]+$/, "")}${separator}`;
}

function isSameOrDescendantPath(candidatePath: string, targetPath: string): boolean {
  return candidatePath === targetPath || candidatePath.startsWith(getPathPrefix(targetPath));
}

function assertValidNewEntryName(name: string): string {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("Name cannot be empty.");
  }

  if (trimmedName === "." || trimmedName === "..") {
    throw new Error("Name cannot be . or ..");
  }

  if (/[\\/]/.test(trimmedName)) {
    throw new Error("Name cannot contain path separators.");
  }

  return trimmedName;
}

function getFileExtension(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  return dotIndex === -1 ? "" : name.slice(dotIndex).toLowerCase();
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const TEXT_EXTENSIONS = new Set(["", ".txt"]);

function getImageMimeType(extension: string) {
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".svg") return "image/svg+xml";
  return `image/${extension.slice(1)}`;
}

export function getFileMode(name: string): FileMode {
  const extension = getFileExtension(name);
  if (extension === ".docx") return "docx";
  if (extension === ".md" || extension === ".markdown") return "markdown";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (TEXT_EXTENSIONS.has(extension)) return "txt";
  return "unsupported";
}

async function readDocxForOpen(path: string, name: string) {
  try {
    return parseDocxBase64(await readFileBinary(path));
  } catch (error) {
    if (!isInvalidDocxZipLike(error)) {
      throw error;
    }

    let textContent = "";
    try {
      textContent = await readFile(path);
    } catch {
      throw error;
    }

    const looksLikeText = !textContent.includes("\u0000") && textContent.trim().length > 0;
    if (!looksLikeText) {
      throw error;
    }

    const shouldRepair = window.confirm(
      `${name} is not a valid Word DOCX package. It looks like a text file with a .docx extension.\n\nConvert this text into a standard DOCX and overwrite the current file?`
    );
    if (!shouldRepair) {
      throw new Error("DOCX repair was cancelled.");
    }

    const repairedBase64 = await createDocxBase64FromPlainText(textContent);
    await writeFileBinary(path, repairedBase64);
    return parseDocxBase64(repairedBase64);
  }
}

function collectDocJsonText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const record = node as { text?: unknown; content?: unknown };
  if (typeof record.text === "string") return record.text;
  if (Array.isArray(record.content)) {
    return record.content.map(collectDocJsonText).filter(Boolean).join("\n");
  }
  return "";
}

function getHistoryTabTime(timestamp: string) {
  return new Date(timestamp).toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function snapshotToEditableContent(snapshot: VersionSnapshot): Promise<{
  content: string;
  fileMode: FileMode;
  docxPackageState?: DocxPackageState;
  plainText: string;
}> {
  if (!snapshot.isContentStored || snapshot.content === undefined) {
    throw new Error("This version content was not stored.");
  }

  const name = snapshot.path.split(/[/\\]/).pop() ?? snapshot.relativePath;
  const inferredMode = getFileMode(name);

  if (snapshot.mimeKind === "docx") {
    if (snapshot.encoding !== "base64") {
      throw new Error("DOCX history content is not stored as a DOCX package.");
    }
    const parsed = await parseDocxBase64(snapshot.content);
    const content = JSON.stringify(parsed.docJson);
    return {
      content,
      fileMode: "docx",
      docxPackageState: parsed.packageState,
      plainText: collectDocJsonText(parsed.docJson),
    };
  }

  if (snapshot.mimeKind === "text") {
    if (snapshot.encoding !== "utf8") {
      throw new Error("Text history content is not stored as text.");
    }
    return {
      content: snapshot.content,
      fileMode: inferredMode === "markdown" ? "markdown" : "txt",
      plainText: snapshot.content,
    };
  }

  throw new Error("Binary history content cannot be opened in the editor.");
}

function tabToPlainText(tab: OpenFileTab): string {
  if (tab.fileMode !== "docx") return tab.content;
  try {
    return collectDocJsonText(JSON.parse(tab.content));
  } catch {
    return "";
  }
}

async function readCurrentPlainText(path: string, name: string, openTabs: OpenFileTab[]) {
  const openTab = openTabs.find((tab) => tab.path === path && !tab.historyViewMode);
  if (openTab) return tabToPlainText(openTab);

  const mode = getFileMode(name);
  if (mode === "docx") {
    const parsed = await parseDocxBase64(await readFileBinary(path));
    return collectDocJsonText(parsed.docJson);
  }
  if (mode === "markdown" || mode === "txt") {
    return readFile(path);
  }
  return "";
}

function buildHistoryLineDiff(oldText: string, newText: string): HistoryDiffPart[] {
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const parts: HistoryDiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      parts.push({ type: "same", text: oldLines[i] });
      i++;
      j++;
    } else if (j < newLines.length && (i >= oldLines.length || dp[i][j + 1] >= dp[i + 1][j])) {
      parts.push({ type: "added", text: newLines[j] });
      j++;
    } else if (i < oldLines.length) {
      parts.push({ type: "removed", text: oldLines[i] });
      i++;
    }
  }

  return parts.length > 0 ? parts : [{ type: "same", text: "" }];
}

function withDefaultMarkdownExtension(name: string): string {
  return /\.[^./\\]+$/.test(name) ? name : `${name}.txt`;
}

function updateTabsWithRenamedPath(
  tabs: OpenFileTab[],
  oldPath: string,
  newPath: string,
  newName: string
): OpenFileTab[] {
  return tabs.map((tab) =>
    isSameOrDescendantPath(tab.path, oldPath)
      ? {
          ...tab,
          path: tab.path.replace(oldPath, newPath),
          name: tab.path === oldPath ? newName : tab.name,
        }
      : tab
  );
}

function filterTabsOutsidePath(tabs: OpenFileTab[], deletedPath: string): OpenFileTab[] {
  return tabs.filter((tab) => !isSameOrDescendantPath(tab.path, deletedPath));
}

function buildReferenceEntriesFromLists(lists: ReferenceListData[]): ReferenceEntry[] {
  const entries: ReferenceEntry[] = [];
  for (const list of lists) {
    for (const item of list.items) {
      entries.push({
        name: item.key,
        description: item.value,
        sourceList: list.name,
      });
    }
  }
  return entries;
}

const PRIMARY_GROUP_ID = "primary";

function createEditorGroupId(): string {
  return `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createEditorGroup(id: string): EditorGroup {
  return { id, tabs: [], activeTabPath: null };
}

function placeTabInHistoryTarget(editorGroups: EditorGroup[], tab: OpenFileTab) {
  const nextGroups = editorGroups.length < MAX_EDITOR_GROUPS
    ? [...editorGroups, createEditorGroup(createEditorGroupId())]
    : editorGroups;
  const targetGroupId = nextGroups.length >= MAX_EDITOR_GROUPS
    ? nextGroups[MAX_EDITOR_GROUPS - 1].id
    : nextGroups[nextGroups.length - 1].id;

  const groups = nextGroups.map((group) => {
    const tabsWithoutDuplicate = group.tabs.filter((item) => item.path !== tab.path);
    if (group.id !== targetGroupId) {
      return {
        ...group,
        tabs: tabsWithoutDuplicate,
        activeTabPath: group.activeTabPath === tab.path
          ? (tabsWithoutDuplicate[0]?.path ?? null)
          : group.activeTabPath,
      };
    }
    return {
      ...group,
      tabs: [...tabsWithoutDuplicate, tab],
      activeTabPath: tab.path,
    };
  });

  return { groups, targetGroupId };
}

export const useFileStore = create<FileState>()((set, get) => ({
  rootPath: null,
  rootName: null,
  files: [],
  activeFile: null,
  editorGroups: [createEditorGroup(PRIMARY_GROUP_ID)],
  activeGroupId: PRIMARY_GROUP_ID,
  referenceEntries: [],
  referenceLists: [],
  selectedListId: null,
  isLoadingWorkspace: false,
  errorMessage: null,
  fileChanges: new Map(),
  recentWorkspaces: loadRecentWorkspaces(),
  getOpenTabs: () => {
    const { editorGroups, activeGroupId } = get();
    const activeGroup = editorGroups.find((g) => g.id === activeGroupId);
    return activeGroup?.tabs ?? [];
  },
  setErrorMessage: (message) => set({ errorMessage: message }),
  saveRecentWorkspace: (path: string) => {
    const current = get().recentWorkspaces.filter((p) => p !== path);
    const next = [path, ...current].slice(0, MAX_RECENT_WORKSPACES);
    persistRecentWorkspaces(next);
    set({ recentWorkspaces: next });
  },
  clearRecentWorkspaces: () => {
    persistRecentWorkspaces([]);
    set({ recentWorkspaces: [] });
  },
  removeRecentWorkspace: (path: string) => {
    const next = get().recentWorkspaces.filter((p) => p !== path);
    persistRecentWorkspaces(next);
    set({ recentWorkspaces: next });
  },
  openRecentWorkspace: async (path: string) => {
    set({ isLoadingWorkspace: true, errorMessage: null });

    try {
      const workspace = await loadWorkspace(path);

      let referenceLists: ReferenceListData[] = [];
      try {
        const listIndex = await getReferenceListsFromDisk();
        referenceLists = await Promise.all(
          listIndex.map(async (index) => {
            const list = await getReferenceListFromDisk(index.id);
            return list || { id: index.id, name: index.name, items: [] };
          })
        );
      } catch (err) {
        console.error("[OpenRecentWorkspace] Failed to load reference lists:", err);
      }

      const referenceEntries = buildReferenceEntriesFromLists(referenceLists);

      get().saveRecentWorkspace(path);

      set({
        rootPath: workspace.rootPath,
        rootName: workspace.rootName,
        files: workspace.nodes,
        activeFile: null,
        referenceEntries,
        referenceLists,
        selectedListId: referenceLists[0]?.id ?? null,
        errorMessage: null,
        isLoadingWorkspace: false,
      });
    } catch (error) {
      get().removeRecentWorkspace(path);
      set({
        isLoadingWorkspace: false,
        errorMessage: error instanceof Error ? error.message : "Failed to open workspace.",
      });
    }
  },
  trackFileChange: (path, oldContent, newContent) => {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    let startLine = 0;
    while (startLine < Math.min(oldLines.length, newLines.length) &&
           oldLines[startLine] === newLines[startLine]) {
      startLine++;
    }

    let endLine = Math.max(oldLines.length, newLines.length);
    while (endLine > startLine &&
           oldLines[endLine - 1] === newLines[endLine - 1]) {
      endLine--;
    }

    if (startLine === endLine) return;

    const change: FileChange = {
      startLine: startLine + 1,
      endLine,
      oldContent: oldLines.slice(startLine, endLine).join('\n'),
      newContent: newLines.slice(startLine, endLine).join('\n'),
      timestamp: new Date().toISOString(),
    };

    set((state) => {
      const changes = state.fileChanges.get(path) || [];
      const newChanges = [...changes, change].slice(-20);
      const newMap = new Map(state.fileChanges);
      newMap.set(path, newChanges);
      return { fileChanges: newMap };
    });
  },
  getFileChanges: (path) => {
    return get().fileChanges.get(path) || [];
  },
  clearFileChanges: (path) => {
    set((state) => {
      const newMap = new Map(state.fileChanges);
      newMap.delete(path);
      return { fileChanges: newMap };
    });
  },
  restoreVersionSnapshot: async (snapshot) => {
    if (!snapshot.isContentStored || snapshot.content === undefined) {
      set({ errorMessage: "This version is too large to restore because its content was not stored." });
      return;
    }

    try {
      const name = snapshot.path.split(/[/\\]/).pop() ?? snapshot.relativePath;
      const mode = getFileMode(name);
      if (snapshot.mimeKind === "docx") {
        if (snapshot.encoding !== "base64") {
          throw new Error("DOCX history content is not stored as a DOCX package.");
        }
        const parsed = await parseDocxBase64(snapshot.content);
        const content = JSON.stringify(parsed.docJson);
        const restoredTab: OpenFileTab = {
          path: snapshot.path,
          name,
          content,
          savedContent: "",
          fileMode: "docx",
          docxPackageState: parsed.packageState,
          isDirty: true,
        };
        set((state) => {
          const targetGroupId = state.activeGroupId;
          const groups = state.editorGroups.map((group) =>
            group.id === targetGroupId
              ? {
                  ...group,
                  tabs: group.tabs.some((tab) => tab.path === snapshot.path)
                    ? group.tabs.map((tab) => (tab.path === snapshot.path ? restoredTab : tab))
                    : [...group.tabs, restoredTab],
                  activeTabPath: snapshot.path,
                }
              : group
          );
          return { editorGroups: groups, activeFile: restoredTab, errorMessage: null };
        });
        return;
      }

      if (snapshot.mimeKind === "text" && (mode === "txt" || mode === "markdown")) {
        if (snapshot.encoding !== "utf8") {
          throw new Error("Text history content is not stored as text.");
        }
        const restoredTab: OpenFileTab = {
          path: snapshot.path,
          name,
          content: snapshot.content,
          savedContent: "",
          fileMode: mode,
          isDirty: true,
        };
        set((state) => {
          const targetGroupId = state.activeGroupId;
          const groups = state.editorGroups.map((group) =>
            group.id === targetGroupId
              ? {
                  ...group,
                  tabs: group.tabs.some((tab) => tab.path === snapshot.path)
                    ? group.tabs.map((tab) => (tab.path === snapshot.path ? restoredTab : tab))
                    : [...group.tabs, restoredTab],
                  activeTabPath: snapshot.path,
                }
              : group
          );
          return { editorGroups: groups, activeFile: restoredTab, errorMessage: null };
        });
        return;
      }

      await restoreSnapshot(snapshot);
      await get().refreshWorkspace();
      set({ errorMessage: null });
    } catch (error) {
      set({
        errorMessage: error instanceof Error ? error.message : "Failed to restore version.",
      });
    }
  },
  openHistorySnapshotPreview: async (snapshot) => {
    try {
      const parsed = await snapshotToEditableContent(snapshot);
      const name = snapshot.path.split(/[/\\]/).pop() ?? snapshot.relativePath;
      const tabPath = `history-preview:${snapshot.id}`;
      const historyTab: OpenFileTab = {
        path: tabPath,
        name: `${name} · 历史 ${getHistoryTabTime(snapshot.timestamp)}`,
        content: parsed.content,
        savedContent: parsed.content,
        fileMode: parsed.fileMode,
        docxPackageState: parsed.docxPackageState,
        isReadOnly: true,
        historySnapshotId: snapshot.id,
        historySourcePath: snapshot.path,
        historyViewMode: "browse",
        isDirty: false,
      };

      set((state) => {
        const { groups, targetGroupId } = placeTabInHistoryTarget(state.editorGroups, historyTab);
        return { editorGroups: groups, activeGroupId: targetGroupId, activeFile: historyTab, errorMessage: null };
      });
    } catch (error) {
      set({
        errorMessage: error instanceof Error ? error.message : "Failed to open history preview.",
      });
    }
  },
  openHistorySnapshotCompare: async (snapshot) => {
    try {
      const parsed = await snapshotToEditableContent(snapshot);
      const name = snapshot.path.split(/[/\\]/).pop() ?? snapshot.relativePath;
      const currentText = await readCurrentPlainText(snapshot.path, name, get().getOpenTabs());
      const diff = buildHistoryLineDiff(parsed.plainText, currentText);
      const tabPath = `history-compare:${snapshot.id}`;
      const historyTab: OpenFileTab = {
        path: tabPath,
        name: `${name} · 对比`,
        content: JSON.stringify(diff),
        savedContent: JSON.stringify(diff),
        fileMode: "txt",
        isReadOnly: true,
        historySnapshotId: snapshot.id,
        historySourcePath: snapshot.path,
        historyViewMode: "compare",
        isDirty: false,
      };

      set((state) => {
        const { groups, targetGroupId } = placeTabInHistoryTarget(state.editorGroups, historyTab);
        return { editorGroups: groups, activeGroupId: targetGroupId, activeFile: historyTab, errorMessage: null };
      });
    } catch (error) {
      set({
        errorMessage: error instanceof Error ? error.message : "Failed to compare history version.",
      });
    }
  },
  openWorkspace: async () => {
    set({ isLoadingWorkspace: true, errorMessage: null });

    try {
      const selectedPath = await pickWorkspace();
      if (!selectedPath) {
        set({ isLoadingWorkspace: false });
        return;
      }

      const workspace = await loadWorkspace(selectedPath);

      // 加载参考列表
      let referenceLists: ReferenceListData[] = [];
      try {
        const listIndex = await getReferenceListsFromDisk();
        referenceLists = await Promise.all(
          listIndex.map(async (index) => {
            const list = await getReferenceListFromDisk(index.id);
            return list || { id: index.id, name: index.name, items: [] };
          })
        );
      } catch (err) {
        console.error("[OpenWorkspace] Failed to load reference lists:", err);
      }

      const referenceEntries = buildReferenceEntriesFromLists(referenceLists);

      get().saveRecentWorkspace(selectedPath);

      set({
        rootPath: workspace.rootPath,
        rootName: workspace.rootName,
        files: workspace.nodes,
        activeFile: null,
        referenceEntries,
        referenceLists,
        selectedListId: referenceLists[0]?.id ?? null,
        errorMessage: null,
        isLoadingWorkspace: false,
      });
    } catch (error) {
      set({
        isLoadingWorkspace: false,
        errorMessage: error instanceof Error ? error.message : "Failed to open workspace.",
      });
    }
  },
  ensureFolderLoaded: async (path) => {
    const targetNode = getNodeByPath(get().files, path);
    if (!targetNode || targetNode.type !== "folder" || targetNode.isLoaded) {
      return;
    }

    try {
      const children = await readDirectory(path);
      set((state) => ({
        files: replaceNodeChildren(state.files, path, mergeLoadedChildren(targetNode.children, children)),
        errorMessage: null,
      }));
    } catch (error) {
      set({
        errorMessage: error instanceof Error ? error.message : "Failed to load folder contents.",
      });
    }
  },
  refreshFolder: async (folderPath) => {
    const targetNode = getNodeByPath(get().files, folderPath);
    if (!targetNode || targetNode.type !== "folder") return;

    try {
      const children = await readDirectory(folderPath);
      set((state) => ({
        files: replaceNodeChildren(state.files, folderPath, mergeLoadedChildren(targetNode.children, children)),
        errorMessage: null,
      }));
    } catch (error) {
      set({
        errorMessage: error instanceof Error ? error.message : "Failed to refresh folder.",
      });
    }
  },
  loadFullWorkspaceTree: async () => {
    const { rootPath } = get();
    if (!rootPath) return;

    try {
      const workspace = await loadWorkspace(rootPath);
      set({
        rootName: workspace.rootName,
        files: workspace.nodes,
        errorMessage: null,
      });
    } catch (error) {
      set({
        errorMessage: error instanceof Error ? error.message : "Failed to load project files.",
      });
    }
  },
  refreshWorkspace: async () => {
    const { rootPath } = get();
    if (!rootPath) return;
    const requestId = ++refreshWorkspaceRequestId;

    try {
      const workspace = await loadWorkspaceTree(rootPath);
      if (requestId !== refreshWorkspaceRequestId) return;

      const latestState = get();
      const { editorGroups, activeGroupId } = latestState;
      const syncTab = async (tab: OpenFileTab): Promise<OpenFileTab> => {
        if (tab.isDirty) return tab;

        try {
          const fileMode = getFileMode(tab.name);
          if (tab.fileMode === "blueprint") {
            return tab;
          }
          if (fileMode === "docx") {
            const base64 = await readFileBinary(tab.path);
            const parsed = await parseDocxBase64(base64);
            const diskContent = JSON.stringify(parsed.docJson);
            return {
              ...tab,
              content: diskContent,
              savedContent: diskContent,
              fileMode,
              docxPackageState: parsed.packageState,
              isDirty: false,
            };
          }
          if (fileMode === "image") {
            const extension = getFileExtension(tab.name);
            const diskContent = `data:${getImageMimeType(extension)};base64,${await readFileBinary(tab.path)}`;
            return {
              ...tab,
              content: diskContent,
              savedContent: diskContent,
              fileMode,
              isDirty: false,
            };
          }
          if (fileMode === "unsupported") {
            return {
              ...tab,
              content: "",
              savedContent: "",
              fileMode,
              isDirty: false,
            };
          }

          const diskContent = await readFile(tab.path);
          return {
            ...tab,
            content: diskContent,
            savedContent: diskContent,
            fileMode,
            isDirty: false,
          };
        } catch {
          return tab;
        }
      };

      const updatedGroups = await Promise.all(
        editorGroups.map(async (group) => {
          const syncedTabs = await Promise.all(group.tabs.map(syncTab));
          const activeTabPath = syncedTabs.some((tab) => tab.path === group.activeTabPath)
            ? group.activeTabPath
            : syncedTabs[0]?.path ?? null;

          return {
            ...group,
            tabs: syncedTabs,
            activeTabPath,
          };
        })
      );

      const activeGroup = updatedGroups.find((g) => g.id === activeGroupId);
      const nextActiveFile = activeGroup?.tabs.find((tab) => tab.path === activeGroup.activeTabPath) ?? null;

      // 刷新参考列表（只更新 referenceLists，不更新 referenceEntries）
      let referenceLists = get().referenceLists;
      try {
        const listIndex = await getReferenceListsFromDisk();
        referenceLists = await Promise.all(
          listIndex.map(async (index) => {
            const list = await getReferenceListFromDisk(index.id);
            return list || { id: index.id, name: index.name, items: [] };
          })
        );
      } catch (err) {
        console.error("[RefreshWorkspace] Failed to load reference lists:", err);
      }

      // 不更新 referenceEntries，保持缓存
      const referenceEntries = get().referenceEntries;

      if (requestId !== refreshWorkspaceRequestId) return;

      set({
        rootName: workspace.rootName,
        files: workspace.nodes,
        editorGroups: updatedGroups,
        activeFile: nextActiveFile,
        referenceEntries,
        referenceLists,
        errorMessage: null,
      });
    } catch (error) {
      set({
        errorMessage: error instanceof Error ? error.message : "Failed to refresh workspace.",
      });
    }
  },
  refreshLoadedWorkspace: async () => {
    await get().refreshWorkspace();
  },
  openFile: async (path, groupId) => {
    refreshWorkspaceRequestId++;
    const targetGroupId = groupId ?? get().activeGroupId;
    const targetGroup = get().editorGroups.find((g) => g.id === targetGroupId);
    if (!targetGroup) return;

    const existingTab = targetGroup.tabs.find((tab) => tab.path === path);
    if (existingTab) {
      set((state) => ({
        activeFile: existingTab,
        editorGroups: state.editorGroups.map((g) =>
          g.id === targetGroupId ? { ...g, activeTabPath: path } : g
        ),
      }));
      return;
    }

    const node = getNodeByPath(get().files, path);
    if (!node || node.type !== "file") return;

    try {
      const fileMode = getFileMode(node.name);
      const parsedDocx = fileMode === "docx"
        ? await readDocxForOpen(path, node.name)
        : null;
      const extension = getFileExtension(node.name);
      const content = parsedDocx
        ? JSON.stringify(parsedDocx.docJson)
        : fileMode === "image"
          ? `data:${getImageMimeType(extension)};base64,${await readFileBinary(path)}`
          : fileMode === "unsupported"
            ? ""
            : await readFile(path);
      const newTab: OpenFileTab = {
        path,
        name: node.name,
        content,
        savedContent: content,
        fileMode,
        docxPackageState: parsedDocx?.packageState,
        isDirty: false,
      };

      set((state) => {
        const group = state.editorGroups.find((g) => g.id === targetGroupId);
        if (!group || group.tabs.some((tab) => tab.path === path)) {
          const existing = group?.tabs.find((tab) => tab.path === path) ?? null;
          return { activeFile: existing };
        }

        const updatedGroups = state.editorGroups.map((g) =>
          g.id === targetGroupId
            ? { ...g, tabs: [...g.tabs, newTab], activeTabPath: path }
            : g
        );

        return {
          editorGroups: updatedGroups,
          activeFile: targetGroupId === state.activeGroupId ? newTab : state.activeFile,
          errorMessage: null,
        };
      });
    } catch (error) {
      set({
        errorMessage: error instanceof Error ? error.message : "Failed to open file.",
      });
    }
  },
  openBlueprintTab: (blueprintId, name, focusedNodeId = null, groupId) => {
    const path = `blueprint:${blueprintId}`;
    const targetGroupId = groupId ?? get().activeGroupId;
    const tab: OpenFileTab = {
      path,
      name,
      content: "",
      savedContent: "",
      fileMode: "blueprint",
      blueprintId,
      blueprintFocusedNodeId: focusedNodeId,
      isDirty: false,
    };

    set((state) => {
      const group = state.editorGroups.find((item) => item.id === targetGroupId);
      if (!group) return state;
      const nextGroups = state.editorGroups.map((item) => {
        if (item.id !== targetGroupId) return item;
        const hasTab = item.tabs.some((existing) => existing.path === path);
        return {
          ...item,
          tabs: hasTab
            ? item.tabs.map((existing) =>
                existing.path === path
                  ? { ...existing, name, blueprintFocusedNodeId: focusedNodeId }
                  : existing
              )
            : [...item.tabs, tab],
          activeTabPath: path,
        };
      });
      const activeTab = nextGroups
        .find((item) => item.id === targetGroupId)
        ?.tabs.find((item) => item.path === path) ?? tab;
      return {
        editorGroups: nextGroups,
        activeGroupId: targetGroupId,
        activeFile: activeTab,
      };
    });
  },
  closeBlueprintTabs: (blueprintId) => {
    const path = `blueprint:${blueprintId}`;
    set((state) => {
      const nextGroups = state.editorGroups.map((group) => {
        const tabs = group.tabs.filter((tab) => tab.path !== path);
        const activeTabPath = group.activeTabPath === path
          ? tabs[tabs.length - 1]?.path ?? null
          : group.activeTabPath;
        return { ...group, tabs, activeTabPath };
      });
      const activeGroup = nextGroups.find((group) => group.id === state.activeGroupId);
      return {
        editorGroups: nextGroups,
        activeFile: activeGroup?.tabs.find((tab) => tab.path === activeGroup.activeTabPath) ?? null,
      };
    });
  },
  renameBlueprintTabs: (blueprintId, name) => {
    const path = `blueprint:${blueprintId}`;
    set((state) => {
      const updateTab = (tab: OpenFileTab) => (tab.path === path ? { ...tab, name } : tab);
      return {
        activeFile: state.activeFile?.path === path ? updateTab(state.activeFile) : state.activeFile,
        editorGroups: state.editorGroups.map((group) => ({
          ...group,
          tabs: group.tabs.map(updateTab),
        })),
      };
    });
  },
  setActiveFile: (path) => {
    refreshWorkspaceRequestId++;
    if (!path) {
      set((state) => ({
        activeFile: null,
        editorGroups: state.editorGroups.map((g) =>
          g.id === state.activeGroupId ? { ...g, activeTabPath: null } : g
        ),
      }));
      return;
    }

    const tab = get().getOpenTabs().find((item) => item.path === path) ?? null;
    set((state) => ({
      activeFile: tab,
      editorGroups: state.editorGroups.map((g) =>
        g.id === state.activeGroupId ? { ...g, activeTabPath: path } : g
      ),
    }));
  },
  closeTab: (path) => {
    refreshWorkspaceRequestId++;
    set((state) => {
      const activeGroup = state.editorGroups.find((g) => g.id === state.activeGroupId);
      const currentTabs = activeGroup?.tabs ?? [];
      const nextTabs = currentTabs.filter((tab) => tab.path !== path);
      const nextActivePath =
        activeGroup?.activeTabPath === path
          ? nextTabs[nextTabs.length - 1]?.path ?? null
          : activeGroup?.activeTabPath && nextTabs.some((tab) => tab.path === activeGroup.activeTabPath)
            ? activeGroup.activeTabPath
            : nextTabs[0]?.path ?? null;
      const nextActive = nextTabs.find((tab) => tab.path === nextActivePath) ?? null;

      return {
        activeFile: nextActive,
        editorGroups: state.editorGroups.map((g) =>
          g.id === state.activeGroupId
            ? {
                ...g,
                tabs: nextTabs,
                activeTabPath: nextActivePath,
              }
            : g
        ),
      };
    });
  },
  updateFileContent: (path, content) => {
    const previousTab = get().getOpenTabs().find((item) => item.path === path);
    if (
      previousTab?.isReadOnly ||
      previousTab?.fileMode === "blueprint" ||
      previousTab?.fileMode === "image" ||
      previousTab?.fileMode === "unsupported"
    ) return;
    set((state) => {
      let tab: OpenFileTab | undefined;
      for (const g of state.editorGroups) {
        tab = g.tabs.find((t) => t.path === path);
        if (tab) break;
      }
      if (!tab || tab.content === content) return state;

      state.trackFileChange(path, tab.content, content);

      const updatedTab = { ...tab, content, isDirty: content !== tab.savedContent };
      const nextActive = state.activeFile?.path === path ? updatedTab : state.activeFile;

      return {
        activeFile: nextActive,
        editorGroups: state.editorGroups.map((g) => ({
          ...g,
          tabs: g.tabs.map((t) => (t.path === path ? updatedTab : t)),
        })),
      };
    });

    const nextTab = get().getOpenTabs().find((item) => item.path === path);
    if (!previousTab || !nextTab || previousTab.content === content) return;

    const baselineKey = `${path}:${previousTab.savedContent.length}:${previousTab.savedContent.slice(0, 64)}`;
    if (!previousTab.isDirty && !historyBaselineKeys.has(baselineKey)) {
      historyBaselineKeys.add(baselineKey);
      if (previousTab.fileMode === "docx" && previousTab.docxPackageState) {
        void serializeDocxBase64(JSON.parse(previousTab.savedContent), previousTab.docxPackageState)
          .then((base64) => recordBinarySnapshot(get().rootPath, path, base64, "manual"))
          .then(() => rememberSnapshotContent(path, previousTab.savedContent))
          .catch(() => undefined);
      } else {
        void recordTextSnapshot(get().rootPath, path, previousTab.savedContent, "manual").catch(() => undefined);
      }
    }

    const lastSnapshotContent = historyLastSnapshotContent.get(path) ?? previousTab.savedContent;
    const changedBytes = Math.abs(
      estimateContentBytes(nextTab.content, "utf8") - estimateContentBytes(lastSnapshotContent, "utf8")
    );

    clearHistoryIdleTimer(path);
    if (changedBytes >= VERSION_HISTORY_SIZE_TRIGGER_BYTES) {
      void get().saveFile(path, "size");
      return;
    }

    const timer = window.setTimeout(() => {
      const currentTab = get().getOpenTabs().find((item) => item.path === path);
      if (currentTab?.isDirty) {
        void get().saveFile(path, "idle");
      }
      historyIdleTimers.delete(path);
    }, VERSION_HISTORY_IDLE_MS);
    historyIdleTimers.set(path, timer);
  },
  saveFile: async (path, reason = "manual") => {
    const targetPath = path ?? get().activeFile?.path;
    if (!targetPath) return;

    const tab = get().getOpenTabs().find((item) => item.path === targetPath);
    if (!tab) return;
    if (tab.isReadOnly) {
      set({ errorMessage: null });
      return;
    }
    if (tab.fileMode === "blueprint" || tab.fileMode === "image" || tab.fileMode === "unsupported") {
      set({ errorMessage: null });
      return;
    }

    const contentToSave = tab.content;

    try {
      clearHistoryIdleTimer(targetPath);
      if (tab.fileMode === "docx") {
        if (!tab.docxPackageState) {
          throw new Error("DOCX package state is missing. Reopen the file and try again.");
        }
        const docJson = JSON.parse(contentToSave);
        const nextBase64 = await serializeDocxBase64(docJson, tab.docxPackageState);
        await recordBinarySnapshot(get().rootPath, targetPath, nextBase64, reason);
        await writeFileBinary(targetPath, nextBase64);
        rememberSnapshotContent(targetPath, contentToSave);
        tab.docxPackageState.originalBase64 = nextBase64;
      } else {
        await recordTextSnapshot(get().rootPath, targetPath, contentToSave, reason);
        await writeFile(targetPath, contentToSave);
      }

      set((state) => {
        const updateTab = (item: OpenFileTab) =>
          item.path === targetPath
            ? {
                ...item,
                savedContent: contentToSave,
                docxPackageState: item.path === tab.path ? tab.docxPackageState : item.docxPackageState,
                isDirty: item.content !== contentToSave,
              }
            : item;

        const updatedActive = state.activeFile?.path === targetPath
          ? updateTab(state.activeFile)
          : state.activeFile;

        return {
          activeFile: updatedActive,
          editorGroups: state.editorGroups.map((g) => ({
            ...g,
            tabs: g.tabs.map(updateTab),
          })),
          errorMessage: null,
        };
      });
    } catch (error) {
      set({
        errorMessage: error instanceof Error ? error.message : "Failed to save file.",
      });
    }
  },
  saveAllFiles: async () => {
    const dirtyTabs = get().getOpenTabs().filter((tab) => tab.isDirty);
    for (const tab of dirtyTabs) {
      await get().saveFile(tab.path);
    }
  },
  createFile: async (name, parentPath) => {
    const { rootPath } = get();
    if (!rootPath) return;

    try {
      const safeName = withDefaultMarkdownExtension(assertValidNewEntryName(name));
      const targetFolder = parentPath ?? rootPath;
      const fullPath = joinPath(targetFolder, safeName);
      set((state) => ({
        files: hydrateFolderChain(state.files, targetFolder),
      }));
      await get().ensureFolderLoaded(targetFolder);
      await createFileOnDisk(fullPath);
      if (getFileMode(safeName) === "docx") {
        const emptyDocxBase64 = await createDocxBase64FromPlainText("");
        await writeFileBinary(fullPath, emptyDocxBase64);
      }
      await get().refreshWorkspace();
      await get().openFile(fullPath);
      set({ errorMessage: null });
    } catch (error) {
      set({
        errorMessage: error instanceof Error ? error.message : "Failed to create file.",
      });
    }
  },
  createFolder: async (name, parentPath) => {
    const { rootPath } = get();
    if (!rootPath) return;

    try {
      const safeName = assertValidNewEntryName(name);
      const targetFolder = parentPath ?? rootPath;
      set((state) => ({
        files: hydrateFolderChain(state.files, targetFolder),
      }));
      await get().ensureFolderLoaded(targetFolder);
      await createFolderOnDisk(joinPath(targetFolder, safeName));
      await get().refreshWorkspace();
      set({ errorMessage: null });
    } catch (error) {
      set({
        errorMessage: error instanceof Error ? error.message : "Failed to create folder.",
      });
    }
  },
  renameFile: async (path, newName) => {
    try {
      const newPath = await renamePath(path, newName);
      await updateSnapshotPaths(path, newPath);
      set((state) => {
        const renameInTabs = (tabs: OpenFileTab[]) =>
          updateTabsWithRenamedPath(tabs, path, newPath, newName);

        const nextActivePath = state.activeFile?.path?.replace(path, newPath);
        const updatedGroups = state.editorGroups.map((g) => ({
          ...g,
          tabs: renameInTabs(g.tabs),
          activeTabPath: g.activeTabPath?.replace(path, newPath) ?? null,
        }));

        const activeGroup = updatedGroups.find((g) => g.id === state.activeGroupId);
        const nextActive = activeGroup?.tabs.find((tab) => tab.path === nextActivePath || tab.path === newPath) ?? null;

        return {
          editorGroups: updatedGroups,
          activeFile: nextActive,
          errorMessage: null,
        };
      });
      await get().refreshWorkspace();
    } catch (error) {
      set({
        errorMessage: error instanceof Error ? error.message : "Failed to rename path.",
      });
    }
  },
  duplicateFile: async (path) => {
    try {
      const newPath = await duplicateFileOnDisk(path);
      await get().refreshWorkspace();
      await get().openFile(newPath);
      set({ errorMessage: null });
    } catch (error) {
      set({
        errorMessage: error instanceof Error ? error.message : "Failed to duplicate file.",
      });
    }
  },
  deleteFile: async (path) => {
    try {
      await deletePath(path);
      set((state) => {
        const filterTabs = (tabs: OpenFileTab[]) => filterTabsOutsidePath(tabs, path);

        const updatedGroups = state.editorGroups.map((g) => {
          const remainingTabs = filterTabs(g.tabs);
          return {
            ...g,
            tabs: remainingTabs,
            activeTabPath: g.activeTabPath === path
              ? (remainingTabs[remainingTabs.length - 1]?.path ?? null)
              : g.activeTabPath,
          };
        });

        const activeGroup = updatedGroups.find((g) => g.id === state.activeGroupId);
        const nextActive = activeGroup?.tabs.find((t) => t.path === activeGroup.activeTabPath) ?? null;

        return {
          editorGroups: updatedGroups,
          activeFile: nextActive,
          errorMessage: null,
        };
      });
      await get().refreshWorkspace();
    } catch (error) {
      set({
        errorMessage: error instanceof Error ? error.message : "Failed to delete path.",
      });
    }
  },
  moveFile: async (sourcePath, destinationFolderPath) => {
    try {
      const newPath = await movePath(sourcePath, destinationFolderPath);
      await updateSnapshotPaths(sourcePath, newPath);
      const movedName = newPath.split(/[/\\]/).pop() ?? newPath;
      set((state) => {
        const renameInTabs = (tabs: OpenFileTab[]) =>
          updateTabsWithRenamedPath(tabs, sourcePath, newPath, movedName);

        const nextActivePath = state.activeFile?.path?.replace(sourcePath, newPath);
        const updatedGroups = state.editorGroups.map((g) => ({
          ...g,
          tabs: renameInTabs(g.tabs),
          activeTabPath: g.activeTabPath?.replace(sourcePath, newPath) ?? null,
        }));

        const activeGroup = updatedGroups.find((g) => g.id === state.activeGroupId);
        const nextActive = activeGroup?.tabs.find((tab) => tab.path === nextActivePath || tab.path === newPath) ?? null;

        return {
          editorGroups: updatedGroups,
          activeFile: nextActive,
          errorMessage: null,
        };
      });
      await get().refreshWorkspace();
    } catch (error) {
      set({
        errorMessage: error instanceof Error ? error.message : "Failed to move path.",
      });
    }
  },
  loadReferenceLists: async () => {
    try {
      const listIndex = await getReferenceListsFromDisk();
      const referenceLists = await Promise.all(
        listIndex.map(async (index) => {
          const list = await getReferenceListFromDisk(index.id);
          return list || { id: index.id, name: index.name, items: [] };
        })
      );
      const referenceEntries = buildReferenceEntriesFromLists(referenceLists);
      set({ referenceLists, referenceEntries });
    } catch (error) {
      set({
        errorMessage: error instanceof Error ? error.message : "Failed to load reference lists.",
      });
    }
  },
  saveReferenceList: async (list) => {
    try {
      // 检查名称唯一性
      const { referenceLists } = get();
      const existingList = referenceLists.find(l => l.name === list.name && l.id !== list.id);
      if (existingList) {
        throw new Error("列表名称已存在");
      }

      await saveReferenceListToDisk(list);
      await get().loadReferenceLists();
      
      // 更新选中的列表
      if (get().selectedListId === list.id || !get().selectedListId) {
        set({ selectedListId: list.id });
      }
    } catch (error) {
      set({
        errorMessage: error instanceof Error ? error.message : "Failed to save reference list.",
      });
      throw error;
    }
  },
  deleteReferenceList: async (listId) => {
    try {
      await deleteReferenceListFromDisk(listId);
      
      const { referenceLists, selectedListId } = get();
      const newLists = referenceLists.filter(l => l.id !== listId);
      const referenceEntries = buildReferenceEntriesFromLists(newLists);
      
      set({
        referenceLists: newLists,
        referenceEntries,
        selectedListId: selectedListId === listId ? (newLists[0]?.id ?? null) : selectedListId,
      });
    } catch (error) {
      set({
        errorMessage: error instanceof Error ? error.message : "Failed to delete reference list.",
      });
    }
  },
  setSelectedListId: (listId) => {
    set({ selectedListId: listId });
  },
  splitEditor: (_direction) => {
    const { editorGroups, activeFile } = get();
    if (editorGroups.length >= MAX_EDITOR_GROUPS) return;

    const newGroupId = createEditorGroupId();
    const newGroup = createEditorGroup(newGroupId);

    if (activeFile) {
      newGroup.tabs = [{ ...activeFile }];
      newGroup.activeTabPath = activeFile.path;
    }

    set({
      editorGroups: [...editorGroups, newGroup],
      activeGroupId: newGroupId,
    });
  },
  openFileInNewGroup: async (path) => {
    const { editorGroups } = get();
    if (editorGroups.length >= MAX_EDITOR_GROUPS) {
      await get().openFile(path, get().activeGroupId);
      set({ errorMessage: "A maximum of 3 editor windows is supported." });
      return;
    }

    const newGroupId = createEditorGroupId();
    const newGroup = createEditorGroup(newGroupId);
    set((state) => ({
      editorGroups: [...state.editorGroups, newGroup],
      activeGroupId: newGroupId,
      activeFile: null,
    }));
    await get().openFile(path, newGroupId);
  },
  closeGroup: (groupId) => {
    const { editorGroups, activeGroupId } = get();
    if (editorGroups.length <= 1) return;

    const remaining = editorGroups.filter((g) => g.id !== groupId);
    const newActiveGroupId = activeGroupId === groupId
      ? (remaining[remaining.length - 1]?.id ?? PRIMARY_GROUP_ID)
      : activeGroupId;

    const activeGroup = remaining.find((g) => g.id === newActiveGroupId);
    set({
      editorGroups: remaining,
      activeGroupId: newActiveGroupId,
      activeFile: activeGroup?.tabs.find((t) => t.path === activeGroup.activeTabPath) ?? null,
    });
  },
  setActiveGroup: (groupId) => {
    const { editorGroups } = get();
    const group = editorGroups.find((g) => g.id === groupId);
    if (!group) return;

    set({
      activeGroupId: groupId,
      activeFile: group.tabs.find((t) => t.path === group.activeTabPath) ?? null,
    });
  },
  moveTabToGroup: (tabPath, targetGroupId) => {
    const { editorGroups } = get();
    const sourceGroup = editorGroups.find((g) => g.tabs.some((t) => t.path === tabPath));
    const targetGroup = editorGroups.find((g) => g.id === targetGroupId);
    if (!sourceGroup || !targetGroup) return;

    const tab = sourceGroup.tabs.find((t) => t.path === tabPath);
    if (!tab) return;

    if (sourceGroup.id === targetGroupId) {
      set({
        activeGroupId: targetGroupId,
        activeFile: tab,
        editorGroups: editorGroups.map((g) =>
          g.id === targetGroupId ? { ...g, activeTabPath: tabPath } : g
        ),
      });
      return;
    }

    const updatedGroups = editorGroups.map((g) => {
      if (g.id === sourceGroup.id) {
        const remainingTabs = g.tabs.filter((t) => t.path !== tabPath);
        return {
          ...g,
          tabs: remainingTabs,
          activeTabPath: g.activeTabPath === tabPath
            ? (remainingTabs[0]?.path ?? null)
            : g.activeTabPath,
        };
      }
      if (g.id === targetGroupId) {
        const tabs = g.tabs.filter((t) => t.path !== tabPath);
        return {
          ...g,
          tabs: [...tabs, tab],
          activeTabPath: tab.path,
        };
      }
      return g;
    });

    set({
      editorGroups: updatedGroups,
      activeGroupId: targetGroupId,
      activeFile: tab,
    });
  },
  moveTabToNewGroup: (tabPath) => {
    const { editorGroups } = get();
    const sourceGroup = editorGroups.find((g) => g.tabs.some((t) => t.path === tabPath));
    const tab = sourceGroup?.tabs.find((t) => t.path === tabPath);
    if (!sourceGroup || !tab) return;

    if (editorGroups.length >= MAX_EDITOR_GROUPS) {
      const fallbackGroupId = editorGroups[MAX_EDITOR_GROUPS - 1].id;
      get().moveTabToGroup(tabPath, fallbackGroupId);
      return;
    }

    const newGroupId = createEditorGroupId();
    const newGroup = {
      ...createEditorGroup(newGroupId),
      tabs: [tab],
      activeTabPath: tab.path,
    };

    const updatedGroups = editorGroups.map((group) => {
      if (group.id !== sourceGroup.id) return group;
      const remainingTabs = group.tabs.filter((item) => item.path !== tabPath);
      return {
        ...group,
        tabs: remainingTabs,
        activeTabPath: group.activeTabPath === tabPath
          ? (remainingTabs[0]?.path ?? null)
          : group.activeTabPath,
      };
    });

    set({
      editorGroups: [...updatedGroups, newGroup],
      activeGroupId: newGroupId,
      activeFile: tab,
      errorMessage: null,
    });
  },
}));
