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
  renamePath,
  type WorkspaceNode,
  writeFile,
  getReferenceLists as getReferenceListsFromDisk,
  getReferenceList as getReferenceListFromDisk,
  saveReferenceList as saveReferenceListToDisk,
  deleteReferenceList as deleteReferenceListFromDisk,
  type ReferenceListData,
} from "../services/fileSystemService";
import type { FileChange } from "../types/ai";

export interface OpenFileTab {
  path: string;
  name: string;
  content: string;
  savedContent: string;
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
  ensureFolderLoaded: (path: string) => Promise<void>;
  loadFullWorkspaceTree: () => Promise<void>;
  openFile: (path: string, groupId?: string) => Promise<void>;
  setActiveFile: (path: string | null) => void;
  closeTab: (path: string) => void;
  updateFileContent: (path: string, content: string) => void;
  saveFile: (path?: string) => Promise<void>;
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
  splitEditor: (direction: "horizontal" | "vertical") => void;
  closeGroup: (groupId: string) => void;
  setActiveGroup: (groupId: string) => void;
  moveTabToGroup: (tabPath: string, targetGroupId: string) => void;
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

function createEditorGroup(id: string): EditorGroup {
  return { id, tabs: [], activeTabPath: null };
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
        files: replaceNodeChildren(state.files, path, children),
        errorMessage: null,
      }));
    } catch (error) {
      set({
        errorMessage: error instanceof Error ? error.message : "Failed to load folder contents.",
      });
    }
  },
  loadFullWorkspaceTree: async () => {
    const { rootPath } = get();
    if (!rootPath) return;

    try {
      const workspace = await loadWorkspaceTree(rootPath);
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
    const { rootPath, activeFile, editorGroups, activeGroupId } = get();
    if (!rootPath) return;

    const activeGroup = editorGroups.find((g) => g.id === activeGroupId);
    const currentTabs = activeGroup?.tabs ?? [];

    try {
      const workspace = await loadWorkspaceTree(rootPath);
      const validTabs = await Promise.all(
        currentTabs
          .filter((tab) => getNodeByPath(workspace.nodes, tab.path))
          .map(async (tab) => {
            if (tab.isDirty) return tab;

            try {
              const diskContent = await readFile(tab.path);
              return {
                ...tab,
                content: diskContent,
                savedContent: diskContent,
                isDirty: false,
              };
            } catch {
              return tab;
            }
          })
      );
      const nextActiveFile =
        activeFile && validTabs.some((tab) => tab.path === activeFile.path)
          ? validTabs.find((tab) => tab.path === activeFile.path) ?? null
          : validTabs[0] ?? null;

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

      set({
        rootName: workspace.rootName,
        files: workspace.nodes,
        editorGroups: editorGroups.map((g) =>
          g.id === activeGroupId
            ? { ...g, tabs: validTabs, activeTabPath: nextActiveFile?.path ?? null }
            : g
        ),
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
  openFile: async (path, groupId) => {
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
      const content = await readFile(path);
      const newTab: OpenFileTab = {
        path,
        name: node.name,
        content,
        savedContent: content,
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
  setActiveFile: (path) => {
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
    set((state) => {
      const activeGroup = state.editorGroups.find((g) => g.id === state.activeGroupId);
      const currentTabs = activeGroup?.tabs ?? [];
      const nextTabs = currentTabs.filter((tab) => tab.path !== path);
      const nextActive =
        state.activeFile?.path === path
          ? nextTabs[nextTabs.length - 1] ?? null
          : nextTabs.find((tab) => tab.path === state.activeFile?.path) ?? state.activeFile;

      return {
        activeFile: nextActive,
        editorGroups: state.editorGroups.map((g) =>
          g.id === state.activeGroupId
            ? {
                ...g,
                tabs: nextTabs,
                activeTabPath: nextActive?.path ?? null,
              }
            : g
        ),
      };
    });
  },
  updateFileContent: (path, content) => {
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
  },
  saveFile: async (path) => {
    const targetPath = path ?? get().activeFile?.path;
    if (!targetPath) return;

    const tab = get().getOpenTabs().find((item) => item.path === targetPath);
    if (!tab) return;

    const contentToSave = tab.content;

    try {
      await writeFile(targetPath, contentToSave);

      set((state) => {
        const updateTab = (item: OpenFileTab) =>
          item.path === targetPath
            ? { ...item, savedContent: contentToSave, isDirty: item.content !== contentToSave }
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
    const newGroupId = `group-${Date.now()}`;
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
    const { editorGroups, activeGroupId } = get();
    const sourceGroup = editorGroups.find((g) => g.tabs.some((t) => t.path === tabPath));
    const targetGroup = editorGroups.find((g) => g.id === targetGroupId);
    if (!sourceGroup || !targetGroup || sourceGroup.id === targetGroupId) return;

    const tab = sourceGroup.tabs.find((t) => t.path === tabPath);
    if (!tab) return;

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
        return {
          ...g,
          tabs: [...g.tabs, tab],
          activeTabPath: tab.path,
        };
      }
      return g;
    });

    const activeGroup = updatedGroups.find((g) => g.id === activeGroupId);
    set({
      editorGroups: updatedGroups,
      activeFile: activeGroup?.tabs.find((t) => t.path === activeGroup.activeTabPath) ?? null,
    });
  },
}));
