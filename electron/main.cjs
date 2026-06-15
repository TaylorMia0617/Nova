const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
let compareNodeNames = null;

const isDev = !app.isPackaged;
const workspaceWatchers = new Map();
const workspaceRootsByWebContents = new Map();
const workspaceRootStorage = new AsyncLocalStorage();
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
const CACHE_SCHEMA_VERSION = 1;
const CACHE_PROMPT_VERSION = "nova-cache-v1";
const DEFAULT_GLOBAL_HABITS = `---
template: true
confirmed_by_user: false
---

# 用户偏好

> 默认模板只说明用途，不代表真实用户偏好。只有用户明确表达、长期稳定出现，或达到高置信证据阈值的内容才应写入这里。

## 写作

待观察

## 代码

待观察

## Agent

待观察

## 输出习惯

- 中文回答
- 使用 Markdown

## 自动识别偏好

待观察
`;
const LEGACY_DEFAULT_GLOBAL_HABITS = `# 用户偏好

## 写作

- 偏好西幻
- 偏好轻小说风格
- 喜欢长篇规划
- 喜欢先大纲后正文

## 代码

- 默认 Typescript
- 默认 Vue3
- 默认 Tailwind

## Agent

- 默认 Smart Mode
- 超过3000字自动进入 Plan 模式

## 输出习惯

- 中文回答
- 使用Markdown
`;
const DEFAULT_AUTHOR_TEMPLATE = `# AuthorTemplate

??????????????AI ???????????

## Philosophy
?????

## Theology
?????

## Desire
?????

## Why This Novel Exists
?????

## Novel Core
?????

## Workflow
Prompt -> Blueprint -> Prose
`;
const DEFAULT_PROSE_STYLE = `# ProseStyle

???????????????????????????

## Style Notes
???
`;
const DEFAULT_DESCRIPTION_STATS = `# DescriptionStats

?????????????????????????? + ????/??????

## Scene Description
???

## Time Description
???

## Character Rhetoric
????????????uses: 0 / appearances: 0
`;
const DEFAULT_STORY_DATABASE = `# StoryDatabase

????????????????????????????????????????

## Characters
???

## Geography
???

## Factions
???

## Items
???
`;
const DEFAULT_REALTIME_DATABASE = `# RealtimeDatabase

??????????????????????????????????????????

## Current State
???
`;

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

function getGlobalHabitsPath() {
  return path.join(os.homedir(), ".config", "nova", "Nova.md");
}

function normalizePath(filePath) {
  return path.normalize(filePath);
}

function getWebContentsId(event) {
  return event?.sender?.id ?? null;
}

function getWorkspaceRootForEvent(event) {
  const webContentsId = getWebContentsId(event);
  return webContentsId ? workspaceRootsByWebContents.get(webContentsId) ?? currentWorkspaceRoot : currentWorkspaceRoot;
}

function getActiveWorkspaceRoot() {
  return workspaceRootStorage.getStore() ?? currentWorkspaceRoot;
}

function runWithWorkspaceRoot(event, fn) {
  const root = getWorkspaceRootForEvent(event);
  return workspaceRootStorage.run(root ?? null, fn);
}

function getWorkspaceAppDataPaths() {
  const workspaceRoot = getActiveWorkspaceRoot();
  if (!workspaceRoot) {
    throw new Error("No workspace is open. Please open a workspace first.");
  }

  const dataPath = path.join(workspaceRoot, ".novel-assistance");
  const conversationsPath = path.join(dataPath, "conversations");
  const indexPath = path.join(conversationsPath, "index.json");
  const referenceDataPath = path.join(dataPath, "data");
  const referenceListsPath = path.join(referenceDataPath, "lists.json");
  const versionHistoryPath = path.join(referenceDataPath, "version-history.json");
  const blueprintsPath = path.join(referenceDataPath, "blueprints.json");
  const blueprintTemplatesPath = path.join(referenceDataPath, "blueprint-templates.json");
  const habitsPath = path.join(dataPath, "habits");
  const authorTemplatePath = path.join(habitsPath, "AuthorTemplate.md");
  const proseStylePath = path.join(habitsPath, "ProseStyle.md");
  const descriptionStatsPath = path.join(habitsPath, "DescriptionStats.md");
  const storyDatabasePath = path.join(habitsPath, "StoryDatabase.md");
  const realtimeDatabasePath = path.join(habitsPath, "RealtimeDatabase.md");
  const cachePath = path.join(dataPath, "cache");
  const cacheIndexPath = path.join(cachePath, "index.json");

  return {
    rootPath: workspaceRoot,
    dataPath,
    conversationsPath,
    indexPath,
    referenceDataPath,
    referenceListsPath,
    versionHistoryPath,
    blueprintsPath,
    blueprintTemplatesPath,
    habitsPath,
    authorTemplatePath,
    proseStylePath,
    descriptionStatsPath,
    storyDatabasePath,
    realtimeDatabasePath,
    cachePath,
    cacheIndexPath,
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

async function ensureGlobalHabits() {
  const habitsPath = getGlobalHabitsPath();
  await fs.mkdir(path.dirname(habitsPath), { recursive: true });
  if (!(await pathExists(habitsPath))) {
    await fs.writeFile(habitsPath, DEFAULT_GLOBAL_HABITS, "utf8");
  } else {
    const current = await fs.readFile(habitsPath, "utf8");
    if (isLegacyDefaultGlobalHabits(current)) {
      await writeWithRetry(habitsPath, DEFAULT_GLOBAL_HABITS);
    }
  }
  return habitsPath;
}

async function ensureWorkspaceHabits() {
  const paths = await ensureWorkspaceAppData();
  await fs.mkdir(paths.habitsPath, { recursive: true });
  if (!(await pathExists(paths.authorTemplatePath))) {
    await fs.writeFile(paths.authorTemplatePath, DEFAULT_AUTHOR_TEMPLATE, "utf8");
  }
  if (!(await pathExists(paths.proseStylePath))) {
    await fs.writeFile(paths.proseStylePath, DEFAULT_PROSE_STYLE, "utf8");
  }
  if (!(await pathExists(paths.descriptionStatsPath))) {
    await fs.writeFile(paths.descriptionStatsPath, DEFAULT_DESCRIPTION_STATS, "utf8");
  }
  if (!(await pathExists(paths.storyDatabasePath))) {
    await fs.writeFile(paths.storyDatabasePath, DEFAULT_STORY_DATABASE, "utf8");
  }
  if (!(await pathExists(paths.realtimeDatabasePath))) {
    await fs.writeFile(paths.realtimeDatabasePath, DEFAULT_REALTIME_DATABASE, "utf8");
  }
  return {
    rootPath: paths.rootPath,
    habitsPath: paths.habitsPath,
    authorTemplatePath: paths.authorTemplatePath,
    proseStylePath: paths.proseStylePath,
    descriptionStatsPath: paths.descriptionStatsPath,
    storyDatabasePath: paths.storyDatabasePath,
    realtimeDatabasePath: paths.realtimeDatabasePath,
  };
}

function getGlobalContentCachePaths() {
  const cacheRoot = path.join(app.getPath("userData"), "global_cache");
  return {
    cacheRoot,
    blobsPath: path.join(cacheRoot, "blobs"),
  };
}

function stableJsonStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function buildContentCacheKey({ content, schemaVersion, modelVersion, promptVersion, paramsVersion }) {
  const contentHash = sha256(content ?? "");
  const keyMaterial = stableJsonStringify({
    contentHash,
    schemaVersion: schemaVersion ?? CACHE_SCHEMA_VERSION,
    modelVersion: modelVersion ?? "default",
    promptVersion: promptVersion ?? CACHE_PROMPT_VERSION,
    paramsVersion: paramsVersion ?? "default",
  });
  return {
    contentHash,
    cacheKey: sha256(keyMaterial),
  };
}

async function readProjectCacheIndex() {
  const paths = await ensureWorkspaceAppData();
  await fs.mkdir(paths.cachePath, { recursive: true });
  if (!(await pathExists(paths.cacheIndexPath))) {
    await fs.writeFile(paths.cacheIndexPath, JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, entries: {} }, null, 2), "utf8");
  }
  try {
    const parsed = JSON.parse(await fs.readFile(paths.cacheIndexPath, "utf8"));
    return parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object"
      ? parsed
      : { schemaVersion: CACHE_SCHEMA_VERSION, entries: {} };
  } catch {
    return { schemaVersion: CACHE_SCHEMA_VERSION, entries: {} };
  }
}

async function writeProjectCacheIndex(index) {
  const paths = await ensureWorkspaceAppData();
  await fs.mkdir(paths.cachePath, { recursive: true });
  await writeWithRetry(paths.cacheIndexPath, JSON.stringify(index, null, 2));
  return index;
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
  const { referenceDataPath, referenceListsPath } = await ensureWorkspaceAppData();
  let index = [];
  try {
    const content = await fs.readFile(referenceListsPath, "utf8");
    const parsed = JSON.parse(content);
    index = Array.isArray(parsed) ? parsed : [];
  } catch {
    index = [];
  }

  try {
    const files = await fs.readdir(referenceDataPath);
    let changed = false;
    for (const fileName of files) {
      if (!/^list-.+\.json$/i.test(fileName)) continue;
      const filePath = path.join(referenceDataPath, fileName);
      const content = await fs.readFile(filePath, "utf8");
      const list = JSON.parse(content);
      if (!list || typeof list !== "object" || !list.id || !list.name) continue;
      if (index.some((item) => item.id === list.id)) continue;
      const now = new Date().toISOString();
      index.push({
        id: list.id,
        name: list.name,
        createdAt: list.createdAt || now,
        updatedAt: list.updatedAt || now,
      });
      changed = true;
    }
    if (changed) {
      await fs.writeFile(referenceListsPath, JSON.stringify(index, null, 2), "utf8");
    }
  } catch {
    // Keep the explicit index if repair scanning fails.
  }

  return index;
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

function setCurrentWorkspaceRoot(rootPath, event = null) {
  const normalizedRoot = normalizePath(rootPath);
  currentWorkspaceRoot = normalizedRoot;
  const webContentsId = getWebContentsId(event);
  if (webContentsId) {
    workspaceRootsByWebContents.set(webContentsId, normalizedRoot);
  }
  return normalizedRoot;
}

function isPathInsideWorkspace(targetPath) {
  const workspaceRoot = getActiveWorkspaceRoot();
  if (!workspaceRoot) return false;

  const normalizedTarget = normalizePath(targetPath);
  const relative = path.relative(workspaceRoot, normalizedTarget);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertWorkspacePath(targetPath) {
  const normalizedTarget = normalizePath(targetPath);
  const workspaceRoot = getActiveWorkspaceRoot();

  if (!workspaceRoot) {
    throw new Error("No workspace is open. Please open a workspace first.");
  }

  if (!isPathInsideWorkspace(normalizedTarget)) {
    throw new Error("This file is not part of the current workspace. Please reopen the matching workspace.");
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
  const webContentsId = win.webContents.id;

  win.on("closed", () => {
    try {
      windows.delete(win);
      workspaceRootsByWebContents.delete(webContentsId);
    } catch {
      // The window is already gone; shutdown cleanup must never surface as a main-process error.
    }
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

ipcMain.handle("fs:pickWorkspace", async (event) => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const rootPath = normalizePath(result.filePaths[0]);
  setCurrentWorkspaceRoot(rootPath, event);
  return rootPath;
});

ipcMain.handle("fs:loadWorkspace", async (event, rootPath, options = {}) => {
  const normalizedRoot = normalizePath(rootPath);
  setCurrentWorkspaceRoot(normalizedRoot, event);
  return runWithWorkspaceRoot(event, async () => {
    const recursive = Boolean(options.recursive);
    return {
      rootPath: normalizedRoot,
      rootName: path.basename(normalizedRoot),
      nodes: await buildTree(assertWorkspacePath(normalizedRoot), recursive),
    };
  });
});

ipcMain.handle("fs:readDirectory", async (event, directoryPath, options = {}) => {
  return runWithWorkspaceRoot(event, async () => {
    const normalizedPath = assertWorkspacePath(directoryPath);
    const recursive = Boolean(options.recursive);
    return buildTree(normalizedPath, recursive);
  });
});

ipcMain.handle("fs:readFile", async (event, filePath) => {
  return runWithWorkspaceRoot(event, async () => fs.readFile(assertWorkspacePath(filePath), "utf8"));
});

ipcMain.handle("fs:writeFile", async (event, filePath, content) => {
  return runWithWorkspaceRoot(event, async () => {
    const normalizedPath = assertWorkspacePath(filePath);
    await fs.mkdir(path.dirname(normalizedPath), { recursive: true });
    await fs.writeFile(normalizedPath, content, "utf8");
  });
});

ipcMain.handle("fs:readFileBinary", async (event, filePath) => {
  return runWithWorkspaceRoot(event, async () => {
    const buffer = await fs.readFile(assertWorkspacePath(filePath));
    return buffer.toString("base64");
  });
});

ipcMain.handle("fs:writeFileBinary", async (event, filePath, base64Content) => {
  return runWithWorkspaceRoot(event, async () => {
    const normalizedPath = assertWorkspacePath(filePath);
    await fs.mkdir(path.dirname(normalizedPath), { recursive: true });
    await fs.writeFile(normalizedPath, Buffer.from(base64Content, "base64"));
  });
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
ipcMain.handle("memory:readGlobalHabits", async () => {
  const habitsPath = await ensureGlobalHabits();
  return fs.readFile(habitsPath, "utf8");
});

ipcMain.handle("memory:writeGlobalHabits", async (_event, content) => {
  const habitsPath = await ensureGlobalHabits();
  await writeWithRetry(habitsPath, String(content ?? ""));
});

ipcMain.handle("memory:ensureWorkspaceHabits", async (event) => runWithWorkspaceRoot(event, async () => {
  return ensureWorkspaceHabits();
}));

ipcMain.handle("memory:readProjectAuthorTemplate", async (event) => runWithWorkspaceRoot(event, async () => {
  const paths = await ensureWorkspaceHabits();
  return fs.readFile(paths.authorTemplatePath, "utf8");
}));

ipcMain.handle("memory:writeProjectAuthorTemplate", async (event, content) => runWithWorkspaceRoot(event, async () => {
  const paths = await ensureWorkspaceHabits();
  await writeWithRetry(paths.authorTemplatePath, String(content ?? ""));
}));

ipcMain.handle("memory:readProjectProseStyle", async (event) => runWithWorkspaceRoot(event, async () => {
  const paths = await ensureWorkspaceHabits();
  return fs.readFile(paths.proseStylePath, "utf8");
}));

ipcMain.handle("memory:writeProjectProseStyle", async (event, content) => runWithWorkspaceRoot(event, async () => {
  const paths = await ensureWorkspaceHabits();
  await writeWithRetry(paths.proseStylePath, String(content ?? ""));
}));

ipcMain.handle("memory:readProjectDescriptionStats", async (event) => runWithWorkspaceRoot(event, async () => {
  const paths = await ensureWorkspaceHabits();
  return fs.readFile(paths.descriptionStatsPath, "utf8");
}));

ipcMain.handle("memory:writeProjectDescriptionStats", async (event, content) => runWithWorkspaceRoot(event, async () => {
  const paths = await ensureWorkspaceHabits();
  await writeWithRetry(paths.descriptionStatsPath, String(content ?? ""));
}));

ipcMain.handle("memory:readProjectStoryDatabase", async (event) => runWithWorkspaceRoot(event, async () => {
  const paths = await ensureWorkspaceHabits();
  return fs.readFile(paths.storyDatabasePath, "utf8");
}));

ipcMain.handle("memory:writeProjectStoryDatabase", async (event, content) => runWithWorkspaceRoot(event, async () => {
  const paths = await ensureWorkspaceHabits();
  await writeWithRetry(paths.storyDatabasePath, String(content ?? ""));
}));

ipcMain.handle("memory:readProjectRealtimeDatabase", async (event) => runWithWorkspaceRoot(event, async () => {
  const paths = await ensureWorkspaceHabits();
  return fs.readFile(paths.realtimeDatabasePath, "utf8");
}));

ipcMain.handle("memory:writeProjectRealtimeDatabase", async (event, content) => runWithWorkspaceRoot(event, async () => {
  const paths = await ensureWorkspaceHabits();
  await writeWithRetry(paths.realtimeDatabasePath, String(content ?? ""));
}));

ipcMain.handle("cache:get", async (event, request) => runWithWorkspaceRoot(event, async () => {
  const { blobsPath } = getGlobalContentCachePaths();
  const { contentHash, cacheKey } = buildContentCacheKey(request ?? {});
  const blobPath = path.join(blobsPath, `${cacheKey}.json`);
  if (!(await pathExists(blobPath))) {
    return { hit: false, contentHash, cacheKey };
  }
  try {
    return { hit: true, contentHash, cacheKey, value: JSON.parse(await fs.readFile(blobPath, "utf8")) };
  } catch {
    return { hit: false, contentHash, cacheKey };
  }
}));

ipcMain.handle("cache:put", async (event, request) => runWithWorkspaceRoot(event, async () => {
  const { blobsPath } = getGlobalContentCachePaths();
  await fs.mkdir(blobsPath, { recursive: true });
  const { contentHash, cacheKey } = buildContentCacheKey(request ?? {});
  const now = new Date().toISOString();
  const blob = {
    schemaVersion: request?.schemaVersion ?? CACHE_SCHEMA_VERSION,
    promptVersion: request?.promptVersion ?? CACHE_PROMPT_VERSION,
    modelVersion: request?.modelVersion ?? "default",
    paramsVersion: request?.paramsVersion ?? "default",
    contentHash,
    cacheKey,
    kind: request?.kind ?? "generic",
    value: request?.value ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await writeWithRetry(path.join(blobsPath, `${cacheKey}.json`), JSON.stringify(blob, null, 2));

  const index = await readProjectCacheIndex();
  index.entries[cacheKey] = {
    contentHash,
    kind: blob.kind,
    relativePath: request?.relativePath ?? null,
    updatedAt: now,
  };
  await writeProjectCacheIndex(index);
  return { hit: true, contentHash, cacheKey, value: blob };
}));

ipcMain.handle("cache:index", async (event) => runWithWorkspaceRoot(event, async () => {
  return readProjectCacheIndex();
}));

ipcMain.handle("reference:getLists", async (event) => runWithWorkspaceRoot(event, async () => {
  return readReferenceListsIndex();
}));

ipcMain.handle("reference:getList", async (event, listId) => runWithWorkspaceRoot(event, async () => {
  return readReferenceList(listId);
}));

ipcMain.handle("reference:saveList", async (event, list) => runWithWorkspaceRoot(event, async () => {
  return writeReferenceList(list);
}));

ipcMain.handle("reference:deleteList", async (event, listId) => runWithWorkspaceRoot(event, async () => {
  return deleteReferenceList(listId);
}));

ipcMain.handle("history:listSnapshots", async (event) => runWithWorkspaceRoot(event, async () => {
  const snapshots = await readVersionSnapshots();
  await writeVersionSnapshots(snapshots);
  return snapshots;
}));

ipcMain.handle("history:appendSnapshot", async (event, snapshot) => runWithWorkspaceRoot(event, async () => {
  const snapshots = await readVersionSnapshots();
  snapshots.push(snapshot);
  return writeVersionSnapshots(snapshots);
}));

ipcMain.handle("history:updateSnapshotPaths", async (event, oldPath, newPath) => runWithWorkspaceRoot(event, async () => {
  const snapshots = await readVersionSnapshots();
  const updated = snapshots.map((snapshot) => {
    if (snapshot.path !== oldPath && !snapshot.path.startsWith(`${oldPath}${path.sep}`)) {
      return snapshot;
    }
    const nextPath = snapshot.path.replace(oldPath, newPath);
    return {
      ...snapshot,
      path: nextPath,
      relativePath: getActiveWorkspaceRoot() ? path.relative(getActiveWorkspaceRoot(), nextPath) : snapshot.relativePath,
    };
  });
  return writeVersionSnapshots(updated);
}));

ipcMain.handle("history:pruneSnapshots", async (event) => runWithWorkspaceRoot(event, async () => {
  return writeVersionSnapshots(await readVersionSnapshots());
}));

ipcMain.handle("blueprint:list", async (event) => runWithWorkspaceRoot(event, async () => {
  return readBlueprints();
}));

ipcMain.handle("blueprint:save", async (event, blueprint) => runWithWorkspaceRoot(event, async () => {
  return saveBlueprint(blueprint);
}));

ipcMain.handle("blueprint:delete", async (event, blueprintId) => runWithWorkspaceRoot(event, async () => {
  return deleteBlueprint(blueprintId);
}));

ipcMain.handle("blueprint:rename", async (event, blueprintId, name) => runWithWorkspaceRoot(event, async () => {
  return renameBlueprint(blueprintId, name);
}));

ipcMain.handle("blueprintTemplate:list", async (event) => runWithWorkspaceRoot(event, async () => {
  return readBlueprintTemplates();
}));

ipcMain.handle("blueprintTemplate:save", async (event, template) => runWithWorkspaceRoot(event, async () => {
  return saveBlueprintTemplate(template);
}));

ipcMain.handle("blueprintTemplate:delete", async (event, templateId) => runWithWorkspaceRoot(event, async () => {
  return deleteBlueprintTemplate(templateId);
}));

ipcMain.handle("fs:createFile", async (event, filePath) => runWithWorkspaceRoot(event, async () => {
  const { normalizedPath } = getValidatedEntryName(filePath);
  await fs.mkdir(path.dirname(normalizedPath), { recursive: true });
  const handle = await fs.open(normalizedPath, "wx");
  await handle.close();
}));

ipcMain.handle("fs:createFolder", async (event, folderPath) => runWithWorkspaceRoot(event, async () => {
  const { normalizedPath } = getValidatedEntryName(folderPath);
  if (await pathExists(normalizedPath)) {
    throw new Error("A file or folder with that name already exists.");
  }
  await fs.mkdir(normalizedPath, { recursive: true });
}));

ipcMain.handle("fs:renamePath", async (event, currentPath, newName) => runWithWorkspaceRoot(event, async () => {
  const normalizedPath = assertWorkspacePath(currentPath);
  const nextPath = assertWorkspacePath(path.join(path.dirname(normalizedPath), newName));
  await fs.rename(normalizedPath, nextPath);
  return nextPath;
}));

ipcMain.handle("fs:deletePath", async (event, targetPath) => runWithWorkspaceRoot(event, async () => {
  await fs.rm(assertWorkspacePath(targetPath), { recursive: true, force: true });
}));

ipcMain.handle("fs:duplicateFile", async (event, sourcePath) => runWithWorkspaceRoot(event, async () => {
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
}));

ipcMain.handle("fs:movePath", async (event, sourcePath, destinationFolderPath) => runWithWorkspaceRoot(event, async () => {
  const normalizedSource = assertWorkspacePath(sourcePath);
  const normalizedDestination = assertWorkspacePath(destinationFolderPath);
  const nextPath = assertWorkspacePath(path.join(normalizedDestination, path.basename(normalizedSource)));
  await fs.rename(normalizedSource, nextPath);
  return nextPath;
}));

ipcMain.handle("ai:ensureWorkspaceAppData", async (event) => runWithWorkspaceRoot(event, async () => {
  const paths = await ensureWorkspaceAppData();
  return {
    rootPath: paths.rootPath,
    dataPath: paths.dataPath,
    conversationsPath: paths.conversationsPath,
  };
}));

ipcMain.handle("ai:listConversationSummaries", async (event) => runWithWorkspaceRoot(event, async () => {
  return readConversationIndex();
}));

ipcMain.handle("ai:readConversation", async (event, conversationId) => runWithWorkspaceRoot(event, async () => {
  const filePath = getConversationFilePath(conversationId);
  if (!(await pathExists(filePath))) {
    return null;
  }
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
}));

ipcMain.handle("ai:writeConversation", async (event, record) => runWithWorkspaceRoot(event, async () => {
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
}));

ipcMain.handle("ai:deleteConversation", async (event, conversationId) => runWithWorkspaceRoot(event, async () => {
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
}));

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

ipcMain.handle("workspace:watch", async (event, rootPath) => {
  return runWithWorkspaceRoot(event, async () => {
    await watchWorkspace(rootPath);
  });
});

ipcMain.handle("workspace:unwatch", async (event, rootPath) => {
  return runWithWorkspaceRoot(event, async () => {
    await closeWorkspaceWatcher(rootPath);
  });
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
