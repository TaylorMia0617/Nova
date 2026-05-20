const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const pty = require("node-pty");

const isDev = !app.isPackaged;
const terminals = new Map();

function buildTerminalEnv() {
  const env = { ...process.env };

  if (process.platform === "win32") {
    const userPath = process.env.USERPROFILE ? [
      path.join(process.env.USERPROFILE, "AppData", "Roaming", "npm"),
      path.join(process.env.USERPROFILE, ".npm-global", "bin"),
      path.join(process.env.USERPROFILE, ".bun", "bin"),
      path.join(process.env.USERPROFILE, ".deno", "bin"),
      path.join(process.env.USERPROFILE, ".cargo", "bin"),
    ] : [];
    const appDataPath = process.env.APPDATA ? [path.join(process.env.APPDATA, "npm")] : [];
    const localAppDataPath = process.env.LOCALAPPDATA ? [
      path.join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps"),
    ] : [];
    const machinePath = process.env.Path || process.env.PATH || "";
    const mergedPath = [...userPath, ...appDataPath, ...localAppDataPath, machinePath]
      .filter(Boolean)
      .join(path.delimiter);

    env.Path = mergedPath;
    env.PATH = mergedPath;
    env.TERM = "xterm-256color";
  }

  return env;
}

function getTerminalShell() {
  if (process.platform === "win32") {
    return {
      command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: ["-NoLogo", "-ExecutionPolicy", "Bypass"],
    };
  }

  return {
    command: process.env.SHELL || "bash",
    args: [],
  };
}

function normalizePath(filePath) {
  return path.normalize(filePath);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function buildTree(directoryPath) {
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
        children: await buildTree(entryPath),
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
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return nodes;
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

  return normalizePath(result.filePaths[0]);
});

ipcMain.handle("fs:loadWorkspace", async (_event, rootPath) => {
  const normalizedRoot = normalizePath(rootPath);
  return {
    rootPath: normalizedRoot,
    rootName: path.basename(normalizedRoot),
    nodes: await buildTree(normalizedRoot),
  };
});

ipcMain.handle("fs:readFile", async (_event, filePath) => {
  return fs.readFile(normalizePath(filePath), "utf8");
});

ipcMain.handle("fs:writeFile", async (_event, filePath, content) => {
  await fs.writeFile(normalizePath(filePath), content, "utf8");
});

ipcMain.handle("fs:createFile", async (_event, filePath) => {
  const normalizedPath = normalizePath(filePath);
  await fs.mkdir(path.dirname(normalizedPath), { recursive: true });
  const handle = await fs.open(normalizedPath, "a");
  await handle.close();
});

ipcMain.handle("fs:createFolder", async (_event, folderPath) => {
  await fs.mkdir(normalizePath(folderPath), { recursive: true });
});

ipcMain.handle("fs:renamePath", async (_event, currentPath, newName) => {
  const normalizedPath = normalizePath(currentPath);
  const nextPath = path.join(path.dirname(normalizedPath), newName);
  await fs.rename(normalizedPath, nextPath);
  return nextPath;
});

ipcMain.handle("fs:deletePath", async (_event, targetPath) => {
  await fs.rm(normalizePath(targetPath), { recursive: true, force: true });
});

ipcMain.handle("fs:duplicateFile", async (_event, sourcePath) => {
  const normalizedSource = normalizePath(sourcePath);
  const directory = path.dirname(normalizedSource);
  const extension = path.extname(normalizedSource);
  const baseName = path.basename(normalizedSource, extension);

  for (let index = 1; index < 1000; index += 1) {
    const candidateName = index === 1 ? `${baseName} Copy${extension}` : `${baseName} Copy ${index}${extension}`;
    const candidatePath = path.join(directory, candidateName);

    if (!(await pathExists(candidatePath))) {
      await fs.copyFile(normalizedSource, candidatePath);
      return candidatePath;
    }
  }

  throw new Error("Could not create a duplicate file name.");
});

ipcMain.handle("fs:movePath", async (_event, sourcePath, destinationFolderPath) => {
  const normalizedSource = normalizePath(sourcePath);
  const nextPath = path.join(normalizePath(destinationFolderPath), path.basename(normalizedSource));
  await fs.rename(normalizedSource, nextPath);
  return nextPath;
});

ipcMain.handle("terminal:start", async (event, options = {}) => {
  const cwd = options.cwd ? normalizePath(options.cwd) : os.homedir();
  const shell = getTerminalShell();
  const terminalId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ptyProcess = pty.spawn(shell.command, shell.args, {
    name: "xterm-256color",
    cols: options.cols || 80,
    rows: options.rows || 24,
    cwd,
    env: buildTerminalEnv(),
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
