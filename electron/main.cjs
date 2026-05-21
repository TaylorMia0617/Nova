const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const os = require("os");
const pty = require("node-pty");
const { spawn, spawnSync } = require("child_process");

const isDev = !app.isPackaged;
const terminals = new Map();

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
    const candidates = process.platform === "win32" && path.extname(command)
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
      path.join(process.env.LOCALAPPDATA, "Programs", "opencode"),
    ] : [];
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
    const pathBootstrap =
      "$machine=[Environment]::GetEnvironmentVariable('Path','Machine');" +
      "$user=[Environment]::GetEnvironmentVariable('Path','User');" +
      "$extra=@(\"$env:APPDATA\\npm\",\"$env:USERPROFILE\\AppData\\Roaming\\npm\",\"$env:LOCALAPPDATA\\Microsoft\\WindowsApps\") -join ';';" +
      "$env:Path=@($extra,$user,$machine,$env:Path) -join ';';";

    const pwshPath = findCommand("pwsh.exe");
    if (pwshPath) {
      return {
        label: "PowerShell 7",
        command: pwshPath,
        args: ["-NoLogo", "-NoExit", "-Command", pathBootstrap],
      };
    }

    const powershellPath =
      findCommand("powershell.exe") || "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    if (powershellPath) {
      return {
        label: "Windows PowerShell",
        command: powershellPath,
        args: ["-NoLogo", "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", pathBootstrap],
      };
    }

    return {
      label: "Command Prompt",
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [],
    };
  }

  return {
    label: path.basename(process.env.SHELL || "bash"),
    command: process.env.SHELL || "bash",
    args: [],
  };
}

function quotePowerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function openExternalTerminal(cwd, commandToRun) {
  const workingDirectory = cwd ? normalizePath(cwd) : os.homedir();

  if (process.platform === "win32") {
    const escapedDirectory = workingDirectory.replace(/"/g, '\\"');
    const escapedCommand = commandToRun ? commandToRun.replace(/"/g, '\\"') : "";
    const wtCommand = commandToRun
      ? `wt.exe -d "${escapedDirectory}" powershell.exe -NoExit -Command "${escapedCommand}"`
      : `wt.exe -d "${escapedDirectory}"`;
    const powershellBody = commandToRun
      ? `Set-Location -LiteralPath ${quotePowerShellLiteral(workingDirectory)}; ${commandToRun}`
      : `Set-Location -LiteralPath ${quotePowerShellLiteral(workingDirectory)}`;
    const powershellCommand = `start "" powershell.exe -NoExit -Command "${powershellBody.replace(/"/g, '\\"')}"`;
    const command = `${wtCommand} || ${powershellCommand}`;

    spawn("C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", command], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: buildTerminalEnv(),
    }).unref();
    return;
  }

  spawn(getTerminalShell().command, getTerminalShell().args, {
    cwd: workingDirectory,
    detached: true,
    stdio: "ignore",
    env: buildTerminalEnv(),
  }).unref();
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
