const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("novelHost", {
  isElectron: true,
  pickWorkspace: () => ipcRenderer.invoke("fs:pickWorkspace"),
  loadWorkspace: (rootPath) => ipcRenderer.invoke("fs:loadWorkspace", rootPath),
  readFile: (filePath) => ipcRenderer.invoke("fs:readFile", filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke("fs:writeFile", filePath, content),
  createFile: (filePath) => ipcRenderer.invoke("fs:createFile", filePath),
  createFolder: (folderPath) => ipcRenderer.invoke("fs:createFolder", folderPath),
  renamePath: (currentPath, newName) => ipcRenderer.invoke("fs:renamePath", currentPath, newName),
  deletePath: (targetPath) => ipcRenderer.invoke("fs:deletePath", targetPath),
  duplicateFile: (sourcePath) => ipcRenderer.invoke("fs:duplicateFile", sourcePath),
  movePath: (sourcePath, destinationFolderPath) => ipcRenderer.invoke("fs:movePath", sourcePath, destinationFolderPath),
  startTerminal: (options) => ipcRenderer.invoke("terminal:start", options),
  getTerminalShellInfo: () => ipcRenderer.invoke("terminal:getShellInfo"),
  openExternalTerminal: (options) => ipcRenderer.invoke("terminal:openExternal", options),
  writeTerminal: (terminalId, data) => ipcRenderer.invoke("terminal:write", terminalId, data),
  resizeTerminal: (terminalId, cols, rows) => ipcRenderer.invoke("terminal:resize", terminalId, cols, rows),
  disposeTerminal: (terminalId) => ipcRenderer.invoke("terminal:dispose", terminalId),
  onTerminalData: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("terminal:data", listener);
    return () => ipcRenderer.removeListener("terminal:data", listener);
  },
  onTerminalExit: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("terminal:exit", listener);
    return () => ipcRenderer.removeListener("terminal:exit", listener);
  },
});
