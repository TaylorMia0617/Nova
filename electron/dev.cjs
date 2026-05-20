const { spawn } = require("child_process");
const net = require("net");
const path = require("path");

const root = path.join(__dirname, "..");
const devPort = 1420;

function isPortOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, host);

    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });

    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function waitForPort(port, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const check = () => {
      const socket = net.createConnection(port, host);

      socket.once("connect", () => {
        socket.end();
        resolve();
      });

      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - startedAt > 30000) {
          reject(new Error(`Timed out waiting for Vite on ${host}:${port}`));
          return;
        }
        setTimeout(check, 250);
      });
    };

    check();
  });
}

function startVite() {
  const viteCli = path.join(root, "node_modules", "vite", "bin", "vite.js");
  return spawn(process.execPath, [viteCli, "--host", "127.0.0.1"], {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
}

async function main() {
  const hasViteServer = await isPortOpen(devPort);
  const vite = hasViteServer ? null : startVite();

  vite?.once("exit", (code) => {
    if (code !== 0) {
      process.exit(code ?? 1);
    }
  });

  await waitForPort(devPort);

  const electronPath = require("electron");
  const electron = spawn(electronPath, ["."], {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });

  electron.once("exit", (code) => {
    vite?.kill();
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
