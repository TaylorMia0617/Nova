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
} from "../services/fileSystemService";
import type { FileChange } from "../types/ai";

const SETTINGS_FOLDER_NAME = "Settings";

export interface OpenFileTab {
  path: string;
  name: string;
  content: string;
  savedContent: string;
  isDirty: boolean;
}

export interface NamedEntry {
  name: string;
  description?: string;
}

export interface ReferenceEntry extends NamedEntry {
  sourceFile?: string;
}

interface FileState {
  rootPath: string | null;
  rootName: string | null;
  files: WorkspaceNode[];
  activeFile: OpenFileTab | null;
  openTabs: OpenFileTab[];
  referenceEntries: ReferenceEntry[];
  referenceFilePaths: string[];
  isLoadingWorkspace: boolean;
  errorMessage: string | null;
  fileChanges: Map<string, FileChange[]>;
  setErrorMessage: (message: string | null) => void;
  openWorkspace: () => Promise<void>;
  refreshWorkspace: () => Promise<void>;
  ensureFolderLoaded: (path: string) => Promise<void>;
  loadFullWorkspaceTree: () => Promise<void>;
  openFile: (path: string) => Promise<void>;
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
  createConfigFile: (fileName: string) => Promise<void>;
  trackFileChange: (path: string, oldContent: string, newContent: string) => void;
  getFileChanges: (path: string) => FileChange[];
  clearFileChanges: (path: string) => void;
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

function findFolderPath(nodes: WorkspaceNode[], folderName: string): string | null {
  for (const node of nodes) {
    if (node.type === "folder" && node.name.toLowerCase() === folderName.toLowerCase()) {
      return node.path;
    }
    if (node.children) {
      const found = findFolderPath(node.children, folderName);
      if (found) return found;
    }
  }
  return null;
}

function parseNamedEntries(content: string): NamedEntry[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): NamedEntry | null => {
      const match = line.match(/^\{\{(.+?)\}\}(?:\s+(.+))?$/);
      if (!match) return null;
      return {
        name: match[1].trim(),
        description: (match[2] ?? "").trim(),
      };
    })
    .filter((entry): entry is NamedEntry => entry !== null);
}

function reloadSingleReferenceFile(
  currentEntries: ReferenceEntry[],
  currentFilePaths: string[],
  filePath: string,
  content: string
): ReferenceEntry[] {
  if (!currentFilePaths.includes(filePath)) {
    return currentEntries;
  }

  const fileName = filePath.split(/[/\\]/).pop() ?? "";
  const newEntries = parseNamedEntries(content).map(entry => ({
    ...entry,
    sourceFile: fileName,
  }));

  const otherEntries = currentEntries.filter(e => e.sourceFile !== fileName);
  return [...otherEntries, ...newEntries];
}

async function loadAllReferenceFiles(
  nodes: WorkspaceNode[]
): Promise<{ entries: ReferenceEntry[]; filePaths: string[] }> {
  const settingsPath = findFolderPath(nodes, SETTINGS_FOLDER_NAME);
  console.log("[Reference] Looking for settings folder:", SETTINGS_FOLDER_NAME, "→ found:", settingsPath);

  if (!settingsPath) {
    console.log("[Reference] No settings folder found, returning empty");
    return { entries: [], filePaths: [] };
  }

  const entries: ReferenceEntry[] = [];
  const filePaths: string[] = [];

  const findTxtFiles = (nodeList: WorkspaceNode[]) => {
    for (const node of nodeList) {
      if (node.type === "file" && node.name.endsWith(".txt")) {
        filePaths.push(node.path);
      }
      if (node.children) {
        findTxtFiles(node.children);
      }
    }
  };

  const settingsNode = getNodeByPath(nodes, settingsPath);
  console.log("[Reference] Settings node:", settingsNode?.name, "isLoaded:", settingsNode?.isLoaded, "hasChildren:", !!settingsNode?.children);

  if (settingsNode) {
    // 如果 settings 文件夹的 children 是 undefined，需要先加载它
    if (!settingsNode.children) {
      try {
        console.log("[Reference] Loading settings folder contents...");
        const children = await readDirectory(settingsPath);
        console.log("[Reference] Loaded", children.length, "children:", children.map(c => c.name));
        findTxtFiles(children);
      } catch (err) {
        console.error("[Reference] Failed to load settings folder:", err);
        return { entries: [], filePaths: [] };
      }
    } else {
      console.log("[Reference] Settings folder already loaded, children:", settingsNode.children.map(c => c.name));
      findTxtFiles(settingsNode.children);
    }
  }

  console.log("[Reference] Found txt files:", filePaths);

  for (const filePath of filePaths) {
    try {
      const content = await readFile(filePath);
      const fileName = filePath.split(/[/\\]/).pop() ?? "";
      const namedEntries = parseNamedEntries(content);
      console.log("[Reference] File:", fileName, "→ entries:", namedEntries.length, namedEntries);
      for (const entry of namedEntries) {
        entries.push({ ...entry, sourceFile: fileName });
      }
    } catch (err) {
      console.error("[Reference] Failed to read file:", filePath, err);
    }
  }

  console.log("[Reference] Total reference entries:", entries.length, entries);
  return { entries, filePaths };
}

export const useFileStore = create<FileState>()((set, get) => ({
  rootPath: null,
  rootName: null,
  files: [],
  activeFile: null,
  openTabs: [],
  referenceEntries: [],
  referenceFilePaths: [],
  isLoadingWorkspace: false,
  errorMessage: null,
  fileChanges: new Map(),
  setErrorMessage: (message) => set({ errorMessage: message }),
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

      // 如果 Settings 文件夹不存在，自动创建它
      const settingsPath = findFolderPath(workspace.nodes, SETTINGS_FOLDER_NAME);
      if (!settingsPath) {
        const newSettingsPath = joinPath(workspace.rootPath, SETTINGS_FOLDER_NAME);
        try {
          await createFolderOnDisk(newSettingsPath);
          // 重新加载工作区以包含新创建的 Settings 文件夹
          const updatedWorkspace = await loadWorkspace(selectedPath);
          workspace.nodes = updatedWorkspace.nodes;
        } catch (error) {
          // 如果文件夹已存在，忽略错误
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("already exists")) {
            console.error("[OpenWorkspace] Failed to create Settings folder:", error);
          }
        }
      }

      const { entries: referenceEntries, filePaths: referenceFilePaths } = 
        await loadAllReferenceFiles(workspace.nodes);

      set({
        rootPath: workspace.rootPath,
        rootName: workspace.rootName,
        files: workspace.nodes,
        openTabs: [],
        activeFile: null,
        referenceEntries,
        referenceFilePaths,
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
    const { rootPath, activeFile, openTabs } = get();
    if (!rootPath) return;

    try {
      const workspace = await loadWorkspaceTree(rootPath);
      const validTabs = await Promise.all(
        openTabs
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

      const { entries: referenceEntries, filePaths: referenceFilePaths } = 
        await loadAllReferenceFiles(workspace.nodes);

      set({
        rootName: workspace.rootName,
        files: workspace.nodes,
        openTabs: validTabs,
        activeFile: nextActiveFile,
        referenceEntries,
        referenceFilePaths,
        errorMessage: null,
      });
    } catch (error) {
      set({
        errorMessage: error instanceof Error ? error.message : "Failed to refresh workspace.",
      });
    }
  },
  openFile: async (path) => {
    const existingTab = get().openTabs.find((tab) => tab.path === path);
    if (existingTab) {
      set({ activeFile: existingTab });
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
        const nextReferenceEntries = reloadSingleReferenceFile(
          state.referenceEntries,
          state.referenceFilePaths,
          path,
          content
        );

        return {
          openTabs: [...state.openTabs, newTab],
          activeFile: newTab,
          referenceEntries: nextReferenceEntries,
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
      set({ activeFile: null });
      return;
    }

    const tab = get().openTabs.find((item) => item.path === path) ?? null;
    set({ activeFile: tab });
  },
  closeTab: (path) => {
    set((state) => {
      const nextTabs = state.openTabs.filter((tab) => tab.path !== path);
      const nextActive =
        state.activeFile?.path === path
          ? nextTabs[nextTabs.length - 1] ?? null
          : nextTabs.find((tab) => tab.path === state.activeFile?.path) ?? state.activeFile;

      return {
        openTabs: nextTabs,
        activeFile: nextActive,
      };
    });
  },
  updateFileContent: (path, content) => {
    set((state) => {
      const tab = state.openTabs.find((t) => t.path === path);
      if (tab && tab.content !== content) {
        state.trackFileChange(path, tab.content, content);
      }

      const nextTabs = state.openTabs.map((tab) =>
        tab.path === path
          ? {
              ...tab,
              content,
              isDirty: content !== tab.savedContent,
            }
          : tab
      );

      const nextReferenceEntries = reloadSingleReferenceFile(
        state.referenceEntries,
        state.referenceFilePaths,
        path,
        content
      );

      return {
        openTabs: nextTabs,
        activeFile: nextTabs.find((tab) => tab.path === state.activeFile?.path) ?? null,
        referenceEntries: nextReferenceEntries,
      };
    });
  },
  saveFile: async (path) => {
    const targetPath = path ?? get().activeFile?.path;
    if (!targetPath) return;

    const tab = get().openTabs.find((item) => item.path === targetPath);
    if (!tab) return;

    try {
      await writeFile(targetPath, tab.content);

      set((state) => {
        const nextTabs = state.openTabs.map((item) =>
          item.path === targetPath
            ? {
                ...item,
                savedContent: item.content,
                isDirty: false,
              }
            : item
        );

        const nextReferenceEntries = reloadSingleReferenceFile(
          state.referenceEntries,
          state.referenceFilePaths,
          targetPath,
          tab.content
        );

        return {
          openTabs: nextTabs,
          activeFile: nextTabs.find((item) => item.path === state.activeFile?.path) ?? null,
          referenceEntries: nextReferenceEntries,
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
    const dirtyTabs = get().openTabs.filter((tab) => tab.isDirty);
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
        const nextTabs = updateTabsWithRenamedPath(state.openTabs, path, newPath, newName);
        const nextActivePath = state.activeFile?.path?.replace(path, newPath);

        const nextReferenceFilePaths = state.referenceFilePaths.map(fp =>
          isSameOrDescendantPath(fp, path) ? fp.replace(path, newPath) : fp
        );

        return {
          openTabs: nextTabs,
          activeFile: nextTabs.find((tab) => tab.path === nextActivePath || tab.path === newPath) ?? null,
          referenceFilePaths: nextReferenceFilePaths,
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
        const nextTabs = filterTabsOutsidePath(state.openTabs, path);
        const nextActive =
          state.activeFile && nextTabs.some((tab) => tab.path === state.activeFile?.path)
            ? nextTabs.find((tab) => tab.path === state.activeFile?.path) ?? null
            : nextTabs[nextTabs.length - 1] ?? null;

        const nextReferenceFilePaths = state.referenceFilePaths.filter(
          fp => !isSameOrDescendantPath(fp, path)
        );

        const deletedFileName = path.split(/[/\\]/).pop() ?? "";
        const nextReferenceEntries = state.referenceEntries.filter(
          e => e.sourceFile !== deletedFileName
        );

        return {
          openTabs: nextTabs,
          activeFile: nextActive,
          referenceFilePaths: nextReferenceFilePaths,
          referenceEntries: nextReferenceEntries,
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
        const nextTabs = updateTabsWithRenamedPath(state.openTabs, sourcePath, newPath, movedName);
        const nextActivePath = state.activeFile?.path?.replace(sourcePath, newPath);

        const nextReferenceFilePaths = state.referenceFilePaths.map(fp =>
          isSameOrDescendantPath(fp, sourcePath) ? fp.replace(sourcePath, newPath) : fp
        );

        return {
          openTabs: nextTabs,
          activeFile: nextTabs.find((tab) => tab.path === nextActivePath || tab.path === newPath) ?? null,
          referenceFilePaths: nextReferenceFilePaths,
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
  createConfigFile: async (fileName) => {
    const { rootPath, files } = get();
    if (!rootPath) return;

    const existingSettingsFolderPath = findFolderPath(files, SETTINGS_FOLDER_NAME);
    const settingsFolderPath = existingSettingsFolderPath ?? joinPath(rootPath, SETTINGS_FOLDER_NAME);

    if (!existingSettingsFolderPath) {
      try {
        await createFolderOnDisk(settingsFolderPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("already exists")) {
          throw error;
        }
      }
    }

    const finalFileName = fileName.endsWith('.txt') ? fileName : `${fileName}.txt`;
    const filePath = joinPath(settingsFolderPath, finalFileName);

    const existingPath = get().referenceFilePaths.find(fp => fp.endsWith(`/${finalFileName}`) || fp.endsWith(`\\${finalFileName}`));
    if (existingPath) {
      throw new Error(`文件 "${finalFileName}" 已存在`);
    }

    await createFileOnDisk(filePath);
    await writeFile(filePath, "");

    await get().refreshWorkspace();
  },
}));
