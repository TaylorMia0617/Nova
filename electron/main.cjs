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

function resolveCommand(command) {
  return findCommand(`${command}.cmd`) || findCommand(`${command}.exe`) || findCommand(command);
}

function resolvePreferredWindowsCommand(command) {
  if (command === "opencode") {
    return findCommand("opencode.cmd") || findCommand("opencode.exe") || findCommand("opencode") || command;
  }
  return resolveCommand(command) || command;
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

function quotePowerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteCmdArg(value) {
  const stringValue = String(value);
  if (!stringValue.length) return "\"\"";
  if (!/[\s"&|<>^()]/.test(stringValue)) return stringValue;
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

function openExternalTerminal(cwd, commandToRun) {
  const workingDirectory = cwd ? normalizePath(cwd) : os.homedir();

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
    const execution = process.platform === "win32"
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
  const workingDirectory = cwd ? normalizePath(cwd) : os.homedir();
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

function normalizePath(filePath) {
  return path.normalize(filePath);
}

function getValidatedEntryName(targetPath) {
  const normalizedPath = normalizePath(targetPath);
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
