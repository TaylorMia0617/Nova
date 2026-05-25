const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const os = require("os");
const pty = require("node-pty");
const { spawn, spawnSync } = require("child_process");
let compareNodeNames = null;

const isDev = !app.isPackaged;
const terminals = new Map();
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

function getGlobalSettingsPath(name = "novel-assistance-settings") {
  const safeName = String(name).replace(/[^a-zA-Z0-9._-]/g, "-") || "settings";
  return path.join(app.getPath("userData"), GLOBAL_SETTINGS_DIR_NAME, `${safeName}.json`);
}

function expandWindowsEnv(value) {
  return value.replace(/%([^%]+)%/g, (_match, name) => process.env[name] || "");
}

function readRegistryPath(root, key) {
  try {
    const result = spawnSync("reg", ["query", root, "/v", key], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const output = result.stdout || "";
    const match = output.match(new RegExp(`${key}\\s+REG_\\w+\\s+(.+)`, "i"));
    return match ? expandWindowsEnv(match[1].trim()) : "";
  } catch {
    return "";
  }
}

function uniquePathEntries(entries) {
  const seen = new Set();
  return entries
    .flatMap((entry) => String(entry || "").split(path.delimiter))
    .map((entry) => expandWindowsEnv(entry.trim()))
    .filter(Boolean)
    .filter((entry) => {
      const key = entry.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function findCommand(command) {
  const pathValue = uniquePathEntries([
    readRegistryPath("HKCU\\Environment", "Path"),
    readRegistryPath("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "Path"),
    process.env.Path || process.env.PATH || "",
  ]).join(path.delimiter);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];

  for (const directory of uniquePathEntries([pathValue])) {
    const candidates =
      process.platform === "win32" && path.extname(command)
        ? [path.join(directory, command)]
        : extensions.map((extension) => path.join(directory, `${command}${extension}`));

    for (const candidate of candidates) {
      if (fsSync.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function resolveCommand(command) {
  return findCommand(`${command}.cmd`) || findCommand(`${command}.exe`) || findCommand(command);
}

function resolvePreferredWindowsCommand(command) {
  if (command === "opencode") {
    return findCommand("opencode.cmd") || findCommand("opencode.exe") || findCommand("opencode") || command;
  }
  return resolveCommand(command) || command;
}

function buildTerminalEnv() {
  const env = { ...process.env };

  if (process.platform === "win32") {
    const userPath = process.env.USERPROFILE
      ? [
          path.join(process.env.USERPROFILE, "AppData", "Roaming", "npm"),
          path.join(process.env.USERPROFILE, ".npm-global", "bin"),
          path.join(process.env.USERPROFILE, ".bun", "bin"),
          path.join(process.env.USERPROFILE, ".deno", "bin"),
          path.join(process.env.USERPROFILE, ".cargo", "bin"),
        ]
      : [];
    const appDataPath = process.env.APPDATA ? [path.join(process.env.APPDATA, "npm")] : [];
    const localAppDataPath = process.env.LOCALAPPDATA
      ? [
          path.join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps"),
          path.join(process.env.LOCALAPPDATA, "Programs", "opencode"),
        ]
      : [];
    const machineRegistryPath = readRegistryPath(
      "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
      "Path"
    );
    const userRegistryPath = readRegistryPath("HKCU\\Environment", "Path");
    const processPath = process.env.Path || process.env.PATH || "";
    const mergedPath = uniquePathEntries([
      ...userPath,
      ...appDataPath,
      ...localAppDataPath,
      userRegistryPath,
      machineRegistryPath,
      processPath,
    ]).join(path.delimiter);

    env.Path = mergedPath;
    env.PATH = mergedPath;
    env.TERM = "xterm-256color";
    env.PATHEXT = env.PATHEXT || ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL";
  }

  return env;
}

function getTerminalShell() {
  if (process.platform === "win32") {
    return {
      label: "Command Prompt",
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d"],
    };
  }

  return {
    label: path.basename(process.env.SHELL || "bash"),
    command: process.env.SHELL || "bash",
    args: [],
  };
}

function quoteCmdArg(value) {
  const stringValue = String(value);
  if (!stringValue.length) return "\"\"";
  if (!/[\s\"&|<>^()]/.test(stringValue)) return stringValue;
  return `"${stringValue.replace(/"/g, "\"\"")}"`;
}

function buildShellStyleInvocation(command, args = []) {
  return [quoteCmdArg(command), ...args.map((arg) => quoteCmdArg(arg))].join(" ");
}

function getWindowsCommandExecution(command, args = []) {
  const resolvedCommand =
    typeof command === "string" && !command.includes("\\") && !path.extname(command)
      ? resolvePreferredWindowsCommand(command)
      : command;
  const isCommandScript = /\.(cmd|bat)$/i.test(resolvedCommand);
  const invocation = buildShellStyleInvocation(resolvedCommand, args);

  if (isCommandScript) {
    return {
      resolvedCommand,
      launcher: "cmd.exe",
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", invocation],
      invocation,
    };
  }

  return {
    resolvedCommand,
    launcher: "direct",
    command: resolvedCommand,
    args,
    invocation,
  };
}

function inspectPathKind(targetPath) {
  try {
    const stat = fsSync.statSync(targetPath);
    return {
      path: targetPath,
      exists: true,
      kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
    };
  } catch {
    return {
      path: targetPath,
      exists: false,
      kind: "missing",
    };
  }
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

  return {
    rootPath: currentWorkspaceRoot,
    dataPath,
    conversationsPath,
    indexPath,
  };
}

async function ensureWorkspaceAppData() {
  const paths = getWorkspaceAppDataPaths();
  await fs.mkdir(paths.conversationsPath, { recursive: true });

  if (!(await pathExists(paths.indexPath))) {
    await fs.writeFile(paths.indexPath, "[]", "utf8");
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

function openExternalTerminal(cwd, commandToRun) {
  const workingDirectory = cwd ? assertWorkspacePath(cwd) : currentWorkspaceRoot || os.homedir();

  if (process.platform === "win32") {
    const execution = commandToRun ? getWindowsCommandExecution(commandToRun) : null;
    const cmdArgs = execution ? ["/d", "/k", execution.invocation] : ["/d"];
    const wtProcess = spawn("wt.exe", ["-d", workingDirectory, "cmd.exe", ...cmdArgs], {
      cwd: workingDirectory,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: buildTerminalEnv(),
    });
    wtProcess.on("error", () => {
      spawn("C:\\Windows\\System32\\cmd.exe", ["/d", "/c", "start", "\"\"", "cmd.exe", ...cmdArgs], {
        cwd: workingDirectory,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: buildTerminalEnv(),
      }).unref();
    });
    wtProcess.unref();
    return;
  }

  spawn(getTerminalShell().command, getTerminalShell().args, {
    cwd: workingDirectory,
    detached: true,
    stdio: "ignore",
    env: buildTerminalEnv(),
  }).unref();
}

function runProbe(command, args = [], cwd = os.homedir()) {
  try {
    const execution =
      process.platform === "win32"
        ? getWindowsCommandExecution(command, args)
        : {
            resolvedCommand: command,
            launcher: "direct",
            command,
            args,
            invocation: [command, ...args].join(" "),
          };
    const result = spawnSync(execution.command, execution.args, {
      cwd,
      env: buildTerminalEnv(),
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = (result.stdout || "").trim();
    const stderr = (result.stderr || "").trim();
    const details = [];
    if (/EEXIST/i.test(`${stdout}\n${stderr}`)) {
      details.push("CLI started but failed during internal initialization (EEXIST).");
    }

    return {
      ok: result.status === 0,
      status: result.status,
      stdout,
      stderr,
      error: result.error?.message || null,
      resolvedCommand: execution.resolvedCommand,
      launcher: execution.launcher,
      invocation: execution.invocation,
      details,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error.message : String(error),
      resolvedCommand: command,
      launcher: process.platform === "win32" ? "cmd.exe" : "direct",
      invocation: [command, ...args].join(" "),
      details: [],
    };
  }
}

function diagnoseTerminal(cwd) {
  const workingDirectory = cwd ? assertWorkspacePath(cwd) : currentWorkspaceRoot || os.homedir();
  const env = buildTerminalEnv();
  const shell = getTerminalShell();
  const pathEntries = uniquePathEntries([env.Path || env.PATH || ""]);
  const commands = ["pwsh.exe", "powershell.exe", "cmd.exe", "wt.exe", "opencode.cmd", "opencode.exe", "opencode"];
  const opencodeConfigPath = path.join(os.homedir(), ".config", "opencode");

  return {
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    cwd: workingDirectory,
    shell,
    commands: Object.fromEntries(commands.map((command) => [command, findCommand(command)])),
    pathEntries,
    opencodeConfig: inspectPathKind(opencodeConfigPath),
    probes: {
      powershellVersion: runProbe(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "$PSVersionTable.PSVersion.ToString()"],
        workingDirectory
      ),
      cmdEcho: runProbe("C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", "echo terminal-ok"], workingDirectory),
      npmVersion: runProbe("npm", ["--version"], workingDirectory),
      opencodeWhere: runProbe("C:\\Windows\\System32\\where.exe", ["opencode"], workingDirectory),
      opencodeVersion: runProbe("opencode", ["--version"], workingDirectory),
    },
  };
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#1e1e1e",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    await win.loadURL("http://127.0.0.1:1420");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    await win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
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
  await fs.writeFile(settingsPath, content, "utf8");
});

ipcMain.handle("settings:delete", async (_event, name) => {
  const settingsPath = getGlobalSettingsPath(name);
  await fs.rm(settingsPath, { force: true });
});

ipcMain.handle("fs:createFile", async (_event, filePath) => {
  const { normalizedPath } = getValidatedEntryName(filePath);

  if (await pathExists(normalizedPath)) {
    throw new Error("A file or folder with that name already exists.");
  }

  const handle = await fs.open(normalizedPath, "wx");
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
  if (await pathExists(filePath)) {
    await fs.rm(filePath, { force: true });
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

ipcMain.handle("ai:readAttachmentText", async (_event, filePath) => {
  return readAttachmentText(filePath);
});

ipcMain.handle("workspace:watch", async (_event, rootPath) => {
  await watchWorkspace(rootPath);
});

ipcMain.handle("workspace:unwatch", async (_event, rootPath) => {
  await closeWorkspaceWatcher(rootPath);
});

ipcMain.handle("terminal:start", async (event, options = {}) => {
  const cwd = options.cwd ? assertWorkspacePath(options.cwd) : currentWorkspaceRoot || os.homedir();
  const shell = getTerminalShell();
  const terminalId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ptyProcess = pty.spawn(shell.command, shell.args, {
    name: "xterm-256color",
    cols: options.cols || 80,
    rows: options.rows || 24,
    cwd,
    env: buildTerminalEnv(),
    useConpty: true,
    conptyInheritCursor: true,
  });

  terminals.set(terminalId, ptyProcess);

  ptyProcess.onData((data) => {
    event.sender.send("terminal:data", { terminalId, data });
  });

  ptyProcess.onExit(({ exitCode }) => {
    terminals.delete(terminalId);
    event.sender.send("terminal:exit", { terminalId, exitCode });
  });

  return terminalId;
});

ipcMain.handle("terminal:getShellInfo", async () => {
  const shell = getTerminalShell();
  return {
    label: shell.label,
    command: shell.command,
  };
});

ipcMain.handle("terminal:openExternal", async (_event, options = {}) => {
  openExternalTerminal(options.cwd, options.command);
});

ipcMain.handle("terminal:diagnose", async (_event, options = {}) => {
  return diagnoseTerminal(options.cwd);
});

ipcMain.handle("terminal:write", async (_event, terminalId, data) => {
  terminals.get(terminalId)?.write(data);
});

ipcMain.handle("terminal:resize", async (_event, terminalId, cols, rows) => {
  terminals.get(terminalId)?.resize(cols, rows);
});

ipcMain.handle("terminal:dispose", async (_event, terminalId) => {
  const terminal = terminals.get(terminalId);
  if (!terminal) return;
  terminal.kill();
  terminals.delete(terminalId);
});
async function ensureWorkspaceSortLoaded() {
  if (compareNodeNames) return;

  const moduleUrl = new URL("../shared/workspaceSort.js", `file://${__filename}`);
  const sharedSortModule = await import(moduleUrl.href);
  compareNodeNames = sharedSortModule.compareNodeNames;
}
