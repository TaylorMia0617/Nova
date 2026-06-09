const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const os = require("os");
let compareNodeNames = null;

const isDev = !app.isPackaged;
const workspaceWatchers = new Map();
let currentWorkspaceRoot = null;
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".csv",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".htm",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
]);
const MAX_ATTACHMENT_TEXT_LENGTH = 120000;
const GLOBAL_SETTINGS_DIR_NAME = "global-settings";
const SKIPPED_WORKSPACE_DIRECTORIES = new Set([
  ".git",
  ".novel-assistance",
  "node_modules",
  "dist",
  "release-dev",
  "build",
  ".cache",
]);

function configureChromiumCache() {
  const cacheRoot = path.join(
    os.tmpdir(),
    "Nova",
    app.isPackaged ? "chromium-cache" : `chromium-cache-dev-${process.pid}`
  );
  try {
    fsSync.mkdirSync(cacheRoot, { recursive: true });
    app.commandLine.appendSwitch("disk-cache-dir", cacheRoot);
    app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
  } catch (error) {
    console.warn("[startup] Unable to prepare Chromium cache directory:", error);
  }
}

configureChromiumCache();

function getGlobalSettingsPath(name = "novel-assistance-settings") {
  const safeName = String(name).replace(/[^a-zA-Z0-9._-]/g, "-") || "settings";
  return path.join(app.getPath("userData"), GLOBAL_SETTINGS_DIR_NAME, `${safeName}.json`);
}

function getGlobalApiConfigPath() {
  return path.join(os.homedir(), ".config", "nova", "NovaApi.json");
}

function normalizePath(filePath) {
  return path.normalize(filePath);
}

function getWorkspaceAppDataPaths() {
  if (!currentWorkspaceRoot) {
    throw new Error("No workspace is open. Please open a workspace first.");
  }

  const dataPath = path.join(currentWorkspaceRoot, ".novel-assistance");
  const conversationsPath = path.join(dataPath, "conversations");
  const indexPath = path.join(conversationsPath, "index.json");
  const referenceDataPath = path.join(dataPath, "data");
  const referenceListsPath = path.join(referenceDataPath, "lists.json");
  const versionHistoryPath = path.join(referenceDataPath, "version-history.json");
  const blueprintsPath = path.join(referenceDataPath, "blueprints.json");
  const blueprintTemplatesPath = path.join(referenceDataPath, "blueprint-templates.json");

  return {
    rootPath: currentWorkspaceRoot,
    dataPath,
    conversationsPath,
    indexPath,
    referenceDataPath,
    referenceListsPath,
    versionHistoryPath,
    blueprintsPath,
    blueprintTemplatesPath,
  };
}

async function ensureWorkspaceAppData() {
  const paths = getWorkspaceAppDataPaths();
  await fs.mkdir(paths.conversationsPath, { recursive: true });
  await fs.mkdir(paths.referenceDataPath, { recursive: true });

  if (!(await pathExists(paths.indexPath))) {
    await fs.writeFile(paths.indexPath, "[]", "utf8");
  }

  if (!(await pathExists(paths.referenceListsPath))) {
    await fs.writeFile(paths.referenceListsPath, "[]", "utf8");
  }

  if (!(await pathExists(paths.versionHistoryPath))) {
    await fs.writeFile(paths.versionHistoryPath, "[]", "utf8");
  }

  if (!(await pathExists(paths.blueprintsPath))) {
    await fs.writeFile(paths.blueprintsPath, "[]", "utf8");
  }

  if (!(await pathExists(paths.blueprintTemplatesPath))) {
    await fs.writeFile(paths.blueprintTemplatesPath, "[]", "utf8");
  }

  return paths;
}

async function readConversationIndex() {
  const { indexPath } = await ensureWorkspaceAppData();
  try {
    const content = await fs.readFile(indexPath, "utf8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeConversationIndex(index) {
  const { indexPath } = await ensureWorkspaceAppData();
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");
  return index;
}

function getConversationFilePath(conversationId) {
  const { conversationsPath } = getWorkspaceAppDataPaths();
  return path.join(conversationsPath, `${conversationId}.json`);
}

// 参考列表管理函数
function getReferenceListFilePath(listId) {
  const { referenceDataPath } = getWorkspaceAppDataPaths();
  return path.join(referenceDataPath, `list-${listId}.json`);
}

async function readReferenceListsIndex() {
  const { referenceListsPath } = await ensureWorkspaceAppData();
  try {
    const content = await fs.readFile(referenceListsPath, "utf8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeReferenceListsIndex(index) {
  const { referenceListsPath } = await ensureWorkspaceAppData();
  await fs.writeFile(referenceListsPath, JSON.stringify(index, null, 2), "utf8");
  return index;
}

async function readBlueprints() {
  const { blueprintsPath } = await ensureWorkspaceAppData();
  try {
    const content = await fs.readFile(blueprintsPath, "utf8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeBlueprints(blueprints) {
  const { blueprintsPath } = await ensureWorkspaceAppData();
  await fs.writeFile(blueprintsPath, JSON.stringify(blueprints, null, 2), "utf8");
  return blueprints;
}

async function readBlueprintTemplates() {
  const { blueprintTemplatesPath } = await ensureWorkspaceAppData();
  try {
    const content = await fs.readFile(blueprintTemplatesPath, "utf8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeBlueprintTemplates(templates) {
  const { blueprintTemplatesPath } = await ensureWorkspaceAppData();
  await fs.writeFile(blueprintTemplatesPath, JSON.stringify(templates, null, 2), "utf8");
  return templates;
}

async function saveBlueprintTemplate(template) {
  const templates = await readBlueprintTemplates();
  const now = new Date().toISOString();
  const nextTemplate = {
    ...template,
    createdAt: template.createdAt || now,
    updatedAt: now,
  };
  const existingIndex = templates.findIndex((item) => item.id === nextTemplate.id);
  const next = existingIndex >= 0
    ? templates.map((item) => (item.id === nextTemplate.id ? nextTemplate : item))
    : [...templates, nextTemplate];
  await writeBlueprintTemplates(next);
  return nextTemplate;
}

async function deleteBlueprintTemplate(templateId) {
  const templates = await readBlueprintTemplates();
  return writeBlueprintTemplates(templates.filter((item) => item.id !== templateId));
}

async function saveBlueprint(blueprint) {
  const blueprints = await readBlueprints();
  const nextBlueprint = {
    ...blueprint,
    updatedAt: blueprint.updatedAt || new Date().toISOString(),
  };
  const existingIndex = blueprints.findIndex((item) => item.id === nextBlueprint.id);
  const next = existingIndex >= 0
    ? blueprints.map((item) => (item.id === nextBlueprint.id ? nextBlueprint : item))
    : [...blueprints, nextBlueprint];
  await writeBlueprints(next);
  return nextBlueprint;
}

async function deleteBlueprint(blueprintId) {
  const blueprints = await readBlueprints();
  return writeBlueprints(blueprints.filter((item) => item.id !== blueprintId));
}

async function renameBlueprint(blueprintId, name) {
  const blueprints = await readBlueprints();
  const now = new Date().toISOString();
  const next = blueprints.map((item) =>
    item.id === blueprintId ? { ...item, name, updatedAt: now } : item
  );
  await writeBlueprints(next);
  return next.find((item) => item.id === blueprintId) ?? null;
}

async function readReferenceList(listId) {
  const filePath = getReferenceListFilePath(listId);
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function writeReferenceList(list) {
  const filePath = getReferenceListFilePath(list.id);
  await fs.writeFile(filePath, JSON.stringify(list, null, 2), "utf8");
  
  // 更新索引
  const index = await readReferenceListsIndex();
  const existingIndex = index.findIndex(item => item.id === list.id);
  const indexItem = {
    id: list.id,
    name: list.name,
    createdAt: existingIndex >= 0 ? index[existingIndex].createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  
  if (existingIndex >= 0) {
    index[existingIndex] = indexItem;
  } else {
    index.push(indexItem);
  }
  
  await writeReferenceListsIndex(index);
  return list;
}

async function deleteReferenceList(listId) {
  const filePath = getReferenceListFilePath(listId);
  try {
    await fs.unlink(filePath);
  } catch {}
  
  // 更新索引
  const index = await readReferenceListsIndex();
  const newIndex = index.filter(item => item.id !== listId);
  await writeReferenceListsIndex(newIndex);
}

const VERSION_HISTORY_RETENTION_MS = 48 * 60 * 60 * 1000;

function pruneVersionSnapshots(snapshots) {
  const cutoff = Date.now() - VERSION_HISTORY_RETENTION_MS;
  return snapshots.filter((snapshot) => {
    const timestamp = Date.parse(snapshot?.timestamp ?? "");
    return Number.isFinite(timestamp) && timestamp >= cutoff;
  });
}

async function readVersionSnapshots() {
  const { versionHistoryPath } = await ensureWorkspaceAppData();
  try {
    const content = await fs.readFile(versionHistoryPath, "utf8");
    const parsed = JSON.parse(content);
    const snapshots = Array.isArray(parsed) ? parsed : [];
    const pruned = pruneVersionSnapshots(snapshots);
    if (pruned.length !== snapshots.length) {
      await fs.writeFile(versionHistoryPath, JSON.stringify(pruned, null, 2), "utf8");
    }
    return pruned;
  } catch {
    return [];
  }
}

async function writeVersionSnapshots(snapshots) {
  const { versionHistoryPath } = await ensureWorkspaceAppData();
  const pruned = pruneVersionSnapshots(snapshots);
  await fs.writeFile(versionHistoryPath, JSON.stringify(pruned, null, 2), "utf8");
  return pruned;
}

async function testMcpConnection(profile) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  for (const header of profile.headers || []) {
    if (header?.key) {
      headers[header.key] = header.value || "";
    }
  }

  if (profile.apiKey) {
    headers.Authorization = `Bearer ${profile.apiKey}`;
  }

  const response = await fetch(profile.mcpServerUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/list",
    }),
  });

  if (!response.ok) {
    throw new Error(`MCP server error: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean)
        .pop()
    : text;

  if (!payload) {
    throw new Error("MCP server returned no payload.");
  }

  const data = JSON.parse(payload);
  if (data.error) {
    throw new Error(data.error.message || "MCP server request failed.");
  }

  return data.result || { tools: [] };
}

function getMimeTypeForExtension(extension) {
  switch (extension) {
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    case ".xml":
      return "application/xml";
    case ".html":
    case ".htm":
      return "text/html";
    default:
      return "text/plain";
  }
}

async function pickAttachments() {
  const result = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Text Files",
        extensions: [...TEXT_ATTACHMENT_EXTENSIONS].map((ext) => ext.replace(".", "")),
      },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return [];
  }

  const files = await Promise.all(
    result.filePaths.map(async (filePath) => {
      const stats = await fs.stat(filePath);
      const extension = path.extname(filePath).toLowerCase();
      if (!TEXT_ATTACHMENT_EXTENSIONS.has(extension)) {
        throw new Error(`Unsupported attachment type: ${path.basename(filePath)}`);
      }

      return {
        path: normalizePath(filePath),
        name: path.basename(filePath),
        size: stats.size,
        mimeType: getMimeTypeForExtension(extension),
      };
    })
  );

  return files;
}

async function pickImages() {
  const result = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Image Files",
        extensions: ["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg"],
      },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return [];
  }

  return result.filePaths.map((filePath) => ({
    path: filePath,
    name: path.basename(filePath),
  }));
}

async function readAttachmentText(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!TEXT_ATTACHMENT_EXTENSIONS.has(extension)) {
    throw new Error("Only text attachments are supported.");
  }

  const buffer = await fs.readFile(filePath);
  const textContent = buffer.toString("utf8");
  const truncated = textContent.length > MAX_ATTACHMENT_TEXT_LENGTH;

  return {
    textContent: truncated ? textContent.slice(0, MAX_ATTACHMENT_TEXT_LENGTH) : textContent,
    truncated,
  };
}

function setCurrentWorkspaceRoot(rootPath) {
  currentWorkspaceRoot = normalizePath(rootPath);
}

function isPathInsideWorkspace(targetPath) {
  if (!currentWorkspaceRoot) return false;

  const normalizedTarget = normalizePath(targetPath);
  const relative = path.relative(currentWorkspaceRoot, normalizedTarget);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertWorkspacePath(targetPath) {
  const normalizedTarget = normalizePath(targetPath);

  if (!currentWorkspaceRoot) {
    throw new Error("No workspace is open. Please open a workspace first.");
  }

  if (!isPathInsideWorkspace(normalizedTarget)) {
    throw new Error("This path is outside the current workspace and cannot be accessed.");
  }

  return normalizedTarget;
}

function getValidatedEntryName(targetPath) {
  const normalizedPath = assertWorkspacePath(targetPath);
  const entryName = path.basename(normalizedPath);

  if (!entryName || entryName === "." || entryName === "..") {
    throw new Error("Name cannot be empty.");
  }

  if (entryName !== normalizedPath && path.dirname(normalizedPath) === normalizedPath) {
    throw new Error("Invalid target path.");
  }

  if (/[\\/]/.test(entryName)) {
    throw new Error("Name cannot contain path separators.");
  }

  return {
    normalizedPath,
    entryName,
  };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function buildTree(directoryPath, recursive = false) {
  await ensureWorkspaceSortLoaded();
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const nodes = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory() && SKIPPED_WORKSPACE_DIRECTORIES.has(entry.name)) continue;

    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      nodes.push({
        path: entryPath,
        name: entry.name,
        type: "folder",
        hasChildren: true,
        isLoaded: recursive,
        children: recursive ? await buildTree(entryPath, true) : undefined,
      });
    } else if (entry.isFile()) {
      nodes.push({
        path: entryPath,
        name: entry.name,
        type: "file",
      });
    }
  }

  nodes.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "folder" ? -1 : 1;
    }
    return compareNodeNames(a.name, b.name);
  });

  return nodes;
}

function emitWorkspaceChanged(rootPath, changedPath = null) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("workspace:changed", {
      rootPath,
      changedPath,
    });
  }
}

async function closeWorkspaceWatcher(rootPath) {
  const normalizedRoot = normalizePath(rootPath);
  const watcher = workspaceWatchers.get(normalizedRoot);
  if (!watcher) return;

  watcher.close();
  workspaceWatchers.delete(normalizedRoot);
}

async function watchWorkspace(rootPath) {
  const normalizedRoot = assertWorkspacePath(rootPath);
  if (workspaceWatchers.has(normalizedRoot)) return;

  const watcher = fsSync.watch(
    normalizedRoot,
    { recursive: true },
    (_eventType, filename) => {
      const changedPath = filename ? path.join(normalizedRoot, filename.toString()) : null;
      emitWorkspaceChanged(normalizedRoot, changedPath);
    }
  );

  watcher.on("error", () => {
    emitWorkspaceChanged(normalizedRoot, null);
  });

  workspaceWatchers.set(normalizedRoot, watcher);
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#1a1f2e",
    frame: false,
    titleBarStyle: "hidden",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  windows.add(win);

  win.on("closed", () => {
    windows.delete(win);
  });

  if (isDev) {
    await win.loadURL("http://127.0.0.1:1420");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    await win.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  return win;
}

app.whenReady().then(async () => {
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("before-quit", () => {
  for (const watcher of workspaceWatchers.values()) {
    watcher.close();
  }
  workspaceWatchers.clear();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  for (const watcher of workspaceWatchers.values()) {
    try {
      watcher.close();
    } catch {}
  }
  workspaceWatchers.clear();
});

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

// Window controls
const windows = new Set();

ipcMain.handle("window:minimize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  win?.minimize();
});

ipcMain.handle("window:maximize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win?.isMaximized()) {
    win.unmaximize();
  } else {
    win?.maximize();
  }
});

ipcMain.handle("window:close", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  win?.close();
});

ipcMain.handle("window:isMaximized", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win?.isMaximized() ?? false;
});

ipcMain.handle("window:createNew", () => {
  createWindow();
});

ipcMain.handle("fs:pickWorkspace", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const rootPath = normalizePath(result.filePaths[0]);
  setCurrentWorkspaceRoot(rootPath);
  return rootPath;
});

ipcMain.handle("fs:loadWorkspace", async (_event, rootPath, options = {}) => {
  const normalizedRoot = normalizePath(rootPath);
  setCurrentWorkspaceRoot(normalizedRoot);
  const recursive = Boolean(options.recursive);
  return {
    rootPath: normalizedRoot,
    rootName: path.basename(normalizedRoot),
    nodes: await buildTree(assertWorkspacePath(normalizedRoot), recursive),
  };
});

ipcMain.handle("fs:readDirectory", async (_event, directoryPath, options = {}) => {
  const normalizedPath = assertWorkspacePath(directoryPath);
  const recursive = Boolean(options.recursive);
  return buildTree(normalizedPath, recursive);
});

ipcMain.handle("fs:readFile", async (_event, filePath) => {
  return fs.readFile(assertWorkspacePath(filePath), "utf8");
});

ipcMain.handle("fs:writeFile", async (_event, filePath, content) => {
  await fs.writeFile(assertWorkspacePath(filePath), content, "utf8");
});

ipcMain.handle("fs:readFileBinary", async (_event, filePath) => {
  const buffer = await fs.readFile(assertWorkspacePath(filePath));
  return buffer.toString("base64");
});

ipcMain.handle("fs:writeFileBinary", async (_event, filePath, base64Content) => {
  await fs.writeFile(assertWorkspacePath(filePath), Buffer.from(base64Content, "base64"));
});

async function writeWithRetry(filePath, content, maxRetries = 3, delay = 200) {
  let lastError = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await fs.writeFile(filePath, content, "utf8");
      return;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries - 1 && error.code === "EPERM" || error.code === "EACCES") {
        await new Promise((resolve) => setTimeout(resolve, delay * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

ipcMain.handle("settings:read", async (_event, name) => {
  const settingsPath = getGlobalSettingsPath(name);
  if (!(await pathExists(settingsPath))) {
    return null;
  }
  return fs.readFile(settingsPath, "utf8");
});

ipcMain.handle("settings:write", async (_event, name, content) => {
  const settingsPath = getGlobalSettingsPath(name);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await writeWithRetry(settingsPath, content);
});

ipcMain.handle("settings:delete", async (_event, name) => {
  const settingsPath = getGlobalSettingsPath(name);
  await fs.rm(settingsPath, { force: true });
});

ipcMain.handle("settings:readGlobalApiConfig", async () => {
  const configPath = getGlobalApiConfigPath();
  if (!(await pathExists(configPath))) {
    return null;
  }
  return fs.readFile(configPath, "utf8");
});

ipcMain.handle("settings:writeGlobalApiConfig", async (_event, content) => {
  const configPath = getGlobalApiConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await writeWithRetry(configPath, content);
});

// 参考列表管理 IPC 处理器
ipcMain.handle("reference:getLists", async () => {
  return readReferenceListsIndex();
});

ipcMain.handle("reference:getList", async (_event, listId) => {
  return readReferenceList(listId);
});

ipcMain.handle("reference:saveList", async (_event, list) => {
  return writeReferenceList(list);
});

ipcMain.handle("reference:deleteList", async (_event, listId) => {
  return deleteReferenceList(listId);
});

ipcMain.handle("history:listSnapshots", async () => {
  const snapshots = await readVersionSnapshots();
  await writeVersionSnapshots(snapshots);
  return snapshots;
});

ipcMain.handle("history:appendSnapshot", async (_event, snapshot) => {
  const snapshots = await readVersionSnapshots();
  snapshots.push(snapshot);
  return writeVersionSnapshots(snapshots);
});

ipcMain.handle("history:updateSnapshotPaths", async (_event, oldPath, newPath) => {
  const snapshots = await readVersionSnapshots();
  const updated = snapshots.map((snapshot) => {
    if (snapshot.path !== oldPath && !snapshot.path.startsWith(`${oldPath}${path.sep}`)) {
      return snapshot;
    }
    const nextPath = snapshot.path.replace(oldPath, newPath);
    return {
      ...snapshot,
      path: nextPath,
      relativePath: currentWorkspaceRoot ? path.relative(currentWorkspaceRoot, nextPath) : snapshot.relativePath,
    };
  });
  return writeVersionSnapshots(updated);
});

ipcMain.handle("history:pruneSnapshots", async () => {
  return writeVersionSnapshots(await readVersionSnapshots());
});

ipcMain.handle("blueprint:list", async () => {
  return readBlueprints();
});

ipcMain.handle("blueprint:save", async (_event, blueprint) => {
  return saveBlueprint(blueprint);
});

ipcMain.handle("blueprint:delete", async (_event, blueprintId) => {
  return deleteBlueprint(blueprintId);
});

ipcMain.handle("blueprint:rename", async (_event, blueprintId, name) => {
  return renameBlueprint(blueprintId, name);
});

ipcMain.handle("blueprintTemplate:list", async () => {
  return readBlueprintTemplates();
});

ipcMain.handle("blueprintTemplate:save", async (_event, template) => {
  return saveBlueprintTemplate(template);
});

ipcMain.handle("blueprintTemplate:delete", async (_event, templateId) => {
  return deleteBlueprintTemplate(templateId);
});

ipcMain.handle("fs:createFile", async (_event, filePath) => {
  const { normalizedPath } = getValidatedEntryName(filePath);
  const handle = await fs.open(normalizedPath, "w");
  await handle.close();
});

ipcMain.handle("fs:createFolder", async (_event, folderPath) => {
  const { normalizedPath } = getValidatedEntryName(folderPath);
  if (await pathExists(normalizedPath)) {
    throw new Error("A file or folder with that name already exists.");
  }
  await fs.mkdir(normalizedPath);
});

ipcMain.handle("fs:renamePath", async (_event, currentPath, newName) => {
  const normalizedPath = assertWorkspacePath(currentPath);
  const nextPath = assertWorkspacePath(path.join(path.dirname(normalizedPath), newName));
  await fs.rename(normalizedPath, nextPath);
  return nextPath;
});

ipcMain.handle("fs:deletePath", async (_event, targetPath) => {
  await fs.rm(assertWorkspacePath(targetPath), { recursive: true, force: true });
});

ipcMain.handle("fs:duplicateFile", async (_event, sourcePath) => {
  const normalizedSource = assertWorkspacePath(sourcePath);
  const directory = path.dirname(normalizedSource);
  const extension = path.extname(normalizedSource);
  const baseName = path.basename(normalizedSource, extension);

  for (let index = 1; index < 1000; index += 1) {
    const candidateName = index === 1 ? `${baseName} Copy${extension}` : `${baseName} Copy ${index}${extension}`;
    const candidatePath = assertWorkspacePath(path.join(directory, candidateName));
    if (!(await pathExists(candidatePath))) {
      await fs.copyFile(normalizedSource, candidatePath);
      return candidatePath;
    }
  }

  throw new Error("Could not create a duplicate file name.");
});

ipcMain.handle("fs:movePath", async (_event, sourcePath, destinationFolderPath) => {
  const normalizedSource = assertWorkspacePath(sourcePath);
  const normalizedDestination = assertWorkspacePath(destinationFolderPath);
  const nextPath = assertWorkspacePath(path.join(normalizedDestination, path.basename(normalizedSource)));
  await fs.rename(normalizedSource, nextPath);
  return nextPath;
});

ipcMain.handle("ai:ensureWorkspaceAppData", async () => {
  const paths = await ensureWorkspaceAppData();
  return {
    rootPath: paths.rootPath,
    dataPath: paths.dataPath,
    conversationsPath: paths.conversationsPath,
  };
});

ipcMain.handle("ai:listConversationSummaries", async () => {
  return readConversationIndex();
});

ipcMain.handle("ai:readConversation", async (_event, conversationId) => {
  const filePath = getConversationFilePath(conversationId);
  if (!(await pathExists(filePath))) {
    return null;
  }
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
});

ipcMain.handle("ai:writeConversation", async (_event, record) => {
  await ensureWorkspaceAppData();
  const filePath = getConversationFilePath(record.id);
  await fs.writeFile(filePath, JSON.stringify(record, null, 2), "utf8");

  const currentIndex = await readConversationIndex();
  const summary = {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    modelId: record.modelId ?? null,
  };
  const nextIndex = [summary, ...currentIndex.filter((item) => item.id !== record.id)].sort(
    (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  );

  return writeConversationIndex(nextIndex);
});

ipcMain.handle("ai:deleteConversation", async (_event, conversationId) => {
  await ensureWorkspaceAppData();
  const filePath = getConversationFilePath(conversationId);
  try {
    await fs.unlink(filePath);
  } catch (unlinkError) {
    try {
      await fs.rm(filePath, { force: true });
    } catch (rmError) {
      console.warn(`Failed to delete conversation file ${filePath}:`, rmError.message);
    }
  }
  const currentIndex = await readConversationIndex();
  const nextIndex = currentIndex.filter((item) => item.id !== conversationId);
  return writeConversationIndex(nextIndex);
});

ipcMain.handle("ai:testMcpConnection", async (_event, profile) => {
  return testMcpConnection(profile);
});

ipcMain.handle("ai:pickAttachments", async () => {
  return pickAttachments();
});

ipcMain.handle("ai:pickImages", async () => {
  return pickImages();
});

ipcMain.handle("ai:readAttachmentText", async (_event, filePath) => {
  return readAttachmentText(filePath);
});

ipcMain.handle("workspace:watch", async (_event, rootPath) => {
  await watchWorkspace(rootPath);
});

ipcMain.handle("workspace:unwatch", async (_event, rootPath) => {
  await closeWorkspaceWatcher(rootPath);
});


// PDF 导出：用隐藏窗口渲染 HTML，调用 Electron 原生 printToPDF
// 替代 jspdf + html2canvas，导出的 PDF 文字可选中
ipcMain.handle("export:printToPDF", async (_event, html) => {
  const pdfWin = new BrowserWindow({
    show: false,
    webPreferences: {
      javascript: false,
    },
  });

  try {
    await pdfWin.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
    );

    const data = await pdfWin.webContents.printToPDF({
      printBackground: true,
      pageSize: "A4",
      marginsType: 1,
    });

    return data;
  } finally {
    pdfWin.close();
  }
});

async function ensureWorkspaceSortLoaded() {
  if (compareNodeNames) return;

  const moduleUrl = new URL("../shared/workspaceSort.js", `file://${__filename}`);
  const sharedSortModule = await import(moduleUrl.href);
  compareNodeNames = sharedSortModule.compareNodeNames;
}
