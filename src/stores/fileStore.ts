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

const SETTINGS_FOLDER_NAME = "settings";
const CHARACTER_FILE_NAME = "\u4eba\u7269\u5217\u8868.txt";
const PLACE_FILE_NAME = "\u5730\u7406\u540d\u79f0.txt";
const ITEM_FILE_NAME = "\u9053\u5177\u540d\u79f0.txt";
const SKILL_FILE_NAME = "\u62db\u5f0f\u5217\u8868.txt";
const WORLD_FILE_NAME = "\u4e16\u754c\u89c2.txt";

const PROJECT_REFERENCE_DEFINITIONS = [
  {
    key: "character",
    fileName: CHARACTER_FILE_NAME,
    template: `{{\u6797\u79cb}} \u51b7\u9759\u514b\u5236\u7684\u4fa6\u63a2\uff0c\u89c2\u5bdf\u529b\u6781\u5f3a
{{\u987e\u5b81}} \u5916\u8868\u6e29\u548c\uff0c\u771f\u5b9e\u8eab\u4efd\u6210\u8c1c
`,
  },
  {
    key: "place",
    fileName: PLACE_FILE_NAME,
    template: `{{\u9ed1\u6cb3\u9547}} \u5e38\u5e74\u96fe\u6c14\u7b3c\u7f69\u7684\u5c0f\u9547\uff0c\u662f\u6545\u4e8b\u7684\u4e3b\u8981\u821e\u53f0
{{\u957f\u68a6\u68ee\u6797}} \u9760\u8fd1\u9547\u5916\u7684\u539f\u59cb\u68ee\u6797\uff0c\u4f20\u95fb\u9690\u85cf\u7740\u8bb8\u591a\u79d8\u5bc6
`,
  },
  {
    key: "item",
    fileName: ITEM_FILE_NAME,
    template: `{{\u94dc\u949f}} \u53d1\u751f\u5f02\u5e38\u65f6\u4f1a\u81ea\u884c\u54cd\u8d77\u7684\u53e4\u8001\u9053\u5177
{{\u94f6\u8272\u94a5\u5319}} \u53ef\u4ee5\u6253\u5f00\u65e7\u5b85\u5730\u4e0b\u5ba4\u7684\u552f\u4e00\u94a5\u5319
`,
  },
  {
    key: "skill",
    fileName: SKILL_FILE_NAME,
    template: `{{\u65ad\u6708}} \u4ee5\u6781\u5feb\u5200\u52bf\u5f62\u6210\u7684\u5f27\u5f62\u659c\u65a9
{{\u8e0f\u98ce\u6b65}} \u77ed\u8ddd\u79bb\u9ad8\u901f\u632a\u79fb\u7684\u8eab\u6cd5
`,
  },
  {
    key: "world",
    fileName: WORLD_FILE_NAME,
    template: `\u5199\u4e0b\u4e16\u754c\u89c2\u80cc\u666f\u3001\u5386\u53f2\u6cbf\u9769\u3001\u9635\u8425\u5173\u7cfb\u4e0e\u89c4\u5219\u8bbe\u5b9a\u3002
`,
  },
] as const;

export interface OpenFileTab {
  path: string;
  name: string;
  content: string;
  savedContent: string;
  isDirty: boolean;
}

export interface NamedEntry {
  name: string;
  description: string;
}

export interface ReferenceEntry extends NamedEntry {
  category: "character" | "place" | "item" | "skill";
}

interface FileState {
  rootPath: string | null;
  rootName: string | null;
  files: WorkspaceNode[];
  activeFile: OpenFileTab | null;
  openTabs: OpenFileTab[];
  characterEntries: NamedEntry[];
  placeEntries: NamedEntry[];
  itemEntries: NamedEntry[];
  skillEntries: NamedEntry[];
  referenceEntries: ReferenceEntry[];
  characterFilePath: string | null;
  placeFilePath: string | null;
  itemFilePath: string | null;
  skillFilePath: string | null;
  worldFilePath: string | null;
  isLoadingWorkspace: boolean;
  errorMessage: string | null;
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

function findReferenceFilePath(nodes: WorkspaceNode[], fileName: string): string | null {
  for (const node of nodes) {
    if (node.type === "file" && node.name === fileName) {
      return node.path;
    }
    if (node.children) {
      const found = findReferenceFilePath(node.children, fileName);
      if (found) return found;
    }
  }
  return null;
}

function findFolderPath(nodes: WorkspaceNode[], folderName: string): string | null {
  for (const node of nodes) {
    if (node.type === "folder" && node.name === folderName) {
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
    .map((line) => {
      const match = line.match(/^\{\{(.+?)\}\}\s+(.+)$/);
      if (!match) return null;
      return {
        name: match[1].trim(),
        description: match[2].trim(),
      };
    })
    .filter((entry): entry is NamedEntry => entry !== null);
}

function buildReferenceEntries(
  characters: NamedEntry[],
  places: NamedEntry[],
  items: NamedEntry[],
  skills: NamedEntry[]
): ReferenceEntry[] {
  return [
    ...characters.map((entry) => ({ ...entry, category: "character" as const })),
    ...places.map((entry) => ({ ...entry, category: "place" as const })),
    ...items.map((entry) => ({ ...entry, category: "item" as const })),
    ...skills.map((entry) => ({ ...entry, category: "skill" as const })),
  ];
}

async function ensureProjectReferenceFiles(
  rootPath: string,
  files: WorkspaceNode[]
): Promise<{
  paths: Record<(typeof PROJECT_REFERENCE_DEFINITIONS)[number]["key"], string>;
  createdMissingFiles: boolean;
}> {
  const existingPaths = Object.fromEntries(
    PROJECT_REFERENCE_DEFINITIONS.map((definition) => [
      definition.key,
      findReferenceFilePath(files, definition.fileName),
    ])
  ) as Record<(typeof PROJECT_REFERENCE_DEFINITIONS)[number]["key"], string | null>;

  const hasAnyExistingReference = Object.values(existingPaths).some(Boolean);
  const hasAllExistingReference = PROJECT_REFERENCE_DEFINITIONS.every((definition) => existingPaths[definition.key]);

  if (hasAllExistingReference) {
    return {
      paths: Object.fromEntries(
        PROJECT_REFERENCE_DEFINITIONS.map((definition) => [definition.key, existingPaths[definition.key] as string])
      ) as Record<(typeof PROJECT_REFERENCE_DEFINITIONS)[number]["key"], string>,
      createdMissingFiles: false,
    };
  }

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

  const result = {} as Record<(typeof PROJECT_REFERENCE_DEFINITIONS)[number]["key"], string>;
  let createdMissingFiles = !existingSettingsFolderPath;

  for (const definition of PROJECT_REFERENCE_DEFINITIONS) {
    const existingPath = existingPaths[definition.key];
    if (existingPath) {
      result[definition.key] = existingPath;
      continue;
    }

    const filePath = joinPath(settingsFolderPath, definition.fileName);
    try {
      await createFileOnDisk(filePath);
      await writeFile(filePath, definition.template);
      createdMissingFiles = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("already exists")) {
        throw error;
      }
    }
    result[definition.key] = filePath;
  }

  if (!hasAnyExistingReference) {
    return {
      paths: result,
      createdMissingFiles,
    };
  }

  return {
    paths: {
      ...Object.fromEntries(
        PROJECT_REFERENCE_DEFINITIONS.map((definition) => [
          definition.key,
          existingPaths[definition.key] ?? result[definition.key],
        ])
      ),
    } as Record<(typeof PROJECT_REFERENCE_DEFINITIONS)[number]["key"], string>,
    createdMissingFiles,
  };
}

function buildReferenceState(
  characterEntries: NamedEntry[],
  placeEntries: NamedEntry[],
  itemEntries: NamedEntry[],
  skillEntries: NamedEntry[]
) {
  return {
    characterEntries,
    placeEntries,
    itemEntries,
    skillEntries,
    referenceEntries: buildReferenceEntries(characterEntries, placeEntries, itemEntries, skillEntries),
  };
}

export const useFileStore = create<FileState>()((set, get) => ({
  rootPath: null,
  rootName: null,
  files: [],
  activeFile: null,
  openTabs: [],
  characterEntries: [],
  placeEntries: [],
  itemEntries: [],
  skillEntries: [],
  referenceEntries: [],
  characterFilePath: null,
  placeFilePath: null,
  itemFilePath: null,
  skillFilePath: null,
  worldFilePath: null,
  isLoadingWorkspace: false,
  errorMessage: null,
  setErrorMessage: (message) => set({ errorMessage: message }),
  openWorkspace: async () => {
    set({ isLoadingWorkspace: true, errorMessage: null });

    try {
      const selectedPath = await pickWorkspace();
      if (!selectedPath) {
        set({ isLoadingWorkspace: false });
        return;
      }

      let workspace = await loadWorkspace(selectedPath);
      const { paths: referencePaths, createdMissingFiles } = await ensureProjectReferenceFiles(
        workspace.rootPath,
        workspace.nodes
      );

      if (createdMissingFiles) {
        workspace = await loadWorkspace(selectedPath);
      }

      const [characterContent, placeContent, itemContent, skillContent] = await Promise.all([
        readFile(referencePaths.character),
        readFile(referencePaths.place),
        readFile(referencePaths.item),
        readFile(referencePaths.skill),
      ]);
      const characterEntries = parseNamedEntries(characterContent);
      const placeEntries = parseNamedEntries(placeContent);
      const itemEntries = parseNamedEntries(itemContent);
      const skillEntries = parseNamedEntries(skillContent);

      set({
        rootPath: workspace.rootPath,
        rootName: workspace.rootName,
        files: workspace.nodes,
        openTabs: [],
        activeFile: null,
        characterFilePath: referencePaths.character,
        placeFilePath: referencePaths.place,
        itemFilePath: referencePaths.item,
        skillFilePath: referencePaths.skill,
        worldFilePath: referencePaths.world,
        ...buildReferenceState(characterEntries, placeEntries, itemEntries, skillEntries),
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

      const characterFilePath = findReferenceFilePath(workspace.nodes, CHARACTER_FILE_NAME);
      const placeFilePath = findReferenceFilePath(workspace.nodes, PLACE_FILE_NAME);
      const itemFilePath = findReferenceFilePath(workspace.nodes, ITEM_FILE_NAME);
      const skillFilePath = findReferenceFilePath(workspace.nodes, SKILL_FILE_NAME);
      const worldFilePath = findReferenceFilePath(workspace.nodes, WORLD_FILE_NAME);

      const [characterContent, placeContent, itemContent, skillContent] = await Promise.all([
        characterFilePath ? readFile(characterFilePath) : Promise.resolve(""),
        placeFilePath ? readFile(placeFilePath) : Promise.resolve(""),
        itemFilePath ? readFile(itemFilePath) : Promise.resolve(""),
        skillFilePath ? readFile(skillFilePath) : Promise.resolve(""),
      ]);

      const characterEntries = characterFilePath ? parseNamedEntries(characterContent) : [];
      const placeEntries = placeFilePath ? parseNamedEntries(placeContent) : [];
      const itemEntries = itemFilePath ? parseNamedEntries(itemContent) : [];
      const skillEntries = skillFilePath ? parseNamedEntries(skillContent) : [];

      set({
        rootName: workspace.rootName,
        files: workspace.nodes,
        openTabs: validTabs,
        activeFile: nextActiveFile,
        characterFilePath,
        placeFilePath,
        itemFilePath,
        skillFilePath,
        worldFilePath,
        ...buildReferenceState(characterEntries, placeEntries, itemEntries, skillEntries),
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
        const nextCharacterEntries =
          path === state.characterFilePath ? parseNamedEntries(content) : state.characterEntries;
        const nextPlaceEntries =
          path === state.placeFilePath ? parseNamedEntries(content) : state.placeEntries;
        const nextItemEntries =
          path === state.itemFilePath ? parseNamedEntries(content) : state.itemEntries;
        const nextSkillEntries =
          path === state.skillFilePath ? parseNamedEntries(content) : state.skillEntries;

        return {
          openTabs: [...state.openTabs, newTab],
          activeFile: newTab,
          ...buildReferenceState(nextCharacterEntries, nextPlaceEntries, nextItemEntries, nextSkillEntries),
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
      const nextTabs = state.openTabs.map((tab) =>
        tab.path === path
          ? {
              ...tab,
              content,
              isDirty: content !== tab.savedContent,
            }
          : tab
      );

      const nextCharacterEntries =
        path === state.characterFilePath ? parseNamedEntries(content) : state.characterEntries;
      const nextPlaceEntries =
        path === state.placeFilePath ? parseNamedEntries(content) : state.placeEntries;
      const nextItemEntries =
        path === state.itemFilePath ? parseNamedEntries(content) : state.itemEntries;
      const nextSkillEntries =
        path === state.skillFilePath ? parseNamedEntries(content) : state.skillEntries;

      return {
        openTabs: nextTabs,
        activeFile: nextTabs.find((tab) => tab.path === state.activeFile?.path) ?? null,
        ...buildReferenceState(nextCharacterEntries, nextPlaceEntries, nextItemEntries, nextSkillEntries),
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

        const nextCharacterEntries =
          targetPath === state.characterFilePath ? parseNamedEntries(tab.content) : state.characterEntries;
        const nextPlaceEntries =
          targetPath === state.placeFilePath ? parseNamedEntries(tab.content) : state.placeEntries;
        const nextItemEntries =
          targetPath === state.itemFilePath ? parseNamedEntries(tab.content) : state.itemEntries;
        const nextSkillEntries =
          targetPath === state.skillFilePath ? parseNamedEntries(tab.content) : state.skillEntries;

        return {
          openTabs: nextTabs,
          activeFile: nextTabs.find((item) => item.path === state.activeFile?.path) ?? null,
          ...buildReferenceState(nextCharacterEntries, nextPlaceEntries, nextItemEntries, nextSkillEntries),
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

        return {
          openTabs: nextTabs,
          activeFile: nextTabs.find((tab) => tab.path === nextActivePath || tab.path === newPath) ?? null,
          characterFilePath:
            state.characterFilePath && isSameOrDescendantPath(state.characterFilePath, path)
              ? state.characterFilePath.replace(path, newPath)
              : state.characterFilePath,
          placeFilePath:
            state.placeFilePath && isSameOrDescendantPath(state.placeFilePath, path)
              ? state.placeFilePath.replace(path, newPath)
              : state.placeFilePath,
          itemFilePath:
            state.itemFilePath && isSameOrDescendantPath(state.itemFilePath, path)
              ? state.itemFilePath.replace(path, newPath)
              : state.itemFilePath,
          skillFilePath:
            state.skillFilePath && isSameOrDescendantPath(state.skillFilePath, path)
              ? state.skillFilePath.replace(path, newPath)
              : state.skillFilePath,
          worldFilePath:
            state.worldFilePath && isSameOrDescendantPath(state.worldFilePath, path)
              ? state.worldFilePath.replace(path, newPath)
              : state.worldFilePath,
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

        const nextCharacterFilePath =
          state.characterFilePath && isSameOrDescendantPath(state.characterFilePath, path)
            ? null
            : state.characterFilePath;
        const nextPlaceFilePath =
          state.placeFilePath && isSameOrDescendantPath(state.placeFilePath, path)
            ? null
            : state.placeFilePath;
        const nextItemFilePath =
          state.itemFilePath && isSameOrDescendantPath(state.itemFilePath, path)
            ? null
            : state.itemFilePath;
        const nextSkillFilePath =
          state.skillFilePath && isSameOrDescendantPath(state.skillFilePath, path)
            ? null
            : state.skillFilePath;
        const nextWorldFilePath =
          state.worldFilePath && isSameOrDescendantPath(state.worldFilePath, path)
            ? null
            : state.worldFilePath;

        const nextCharacterEntries = nextCharacterFilePath ? state.characterEntries : [];
        const nextPlaceEntries = nextPlaceFilePath ? state.placeEntries : [];
        const nextItemEntries = nextItemFilePath ? state.itemEntries : [];
        const nextSkillEntries = nextSkillFilePath ? state.skillEntries : [];

        return {
          openTabs: nextTabs,
          activeFile: nextActive,
          characterFilePath: nextCharacterFilePath,
          placeFilePath: nextPlaceFilePath,
          itemFilePath: nextItemFilePath,
          skillFilePath: nextSkillFilePath,
          worldFilePath: nextWorldFilePath,
          ...buildReferenceState(nextCharacterEntries, nextPlaceEntries, nextItemEntries, nextSkillEntries),
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

        return {
          openTabs: nextTabs,
          activeFile: nextTabs.find((tab) => tab.path === nextActivePath || tab.path === newPath) ?? null,
          characterFilePath:
            state.characterFilePath && isSameOrDescendantPath(state.characterFilePath, sourcePath)
              ? state.characterFilePath.replace(sourcePath, newPath)
              : state.characterFilePath,
          placeFilePath:
            state.placeFilePath && isSameOrDescendantPath(state.placeFilePath, sourcePath)
              ? state.placeFilePath.replace(sourcePath, newPath)
              : state.placeFilePath,
          itemFilePath:
            state.itemFilePath && isSameOrDescendantPath(state.itemFilePath, sourcePath)
              ? state.itemFilePath.replace(sourcePath, newPath)
              : state.itemFilePath,
          skillFilePath:
            state.skillFilePath && isSameOrDescendantPath(state.skillFilePath, sourcePath)
              ? state.skillFilePath.replace(sourcePath, newPath)
              : state.skillFilePath,
          worldFilePath:
            state.worldFilePath && isSameOrDescendantPath(state.worldFilePath, sourcePath)
              ? state.worldFilePath.replace(sourcePath, newPath)
              : state.worldFilePath,
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
}));
