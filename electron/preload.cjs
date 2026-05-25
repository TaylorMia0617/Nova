const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("novelHost", {
  isElectron: true,
  pickWorkspace: () => ipcRenderer.invoke("fs:pickWorkspace"),
  loadWorkspace: (rootPath, options) => ipcRenderer.invoke("fs:loadWorkspace", rootPath, options),
  readDirectory: (directoryPath, options) => ipcRenderer.invoke("fs:readDirectory", directoryPath, options),
  readFile: (filePath) => ipcRenderer.invoke("fs:readFile", filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke("fs:writeFile", filePath, content),
  readGlobalSettings: (name) => ipcRenderer.invoke("settings:read", name),
  writeGlobalSettings: (name, content) => ipcRenderer.invoke("settings:write", name, content),
  deleteGlobalSettings: (name) => ipcRenderer.invoke("settings:delete", name),
  createFile: (filePath) => ipcRenderer.invoke("fs:createFile", filePath),
  createFolder: (folderPath) => ipcRenderer.invoke("fs:createFolder", folderPath),
  renamePath: (currentPath, newName) => ipcRenderer.invoke("fs:renamePath", currentPath, newName),
  deletePath: (targetPath) => ipcRenderer.invoke("fs:deletePath", targetPath),
  duplicateFile: (sourcePath) => ipcRenderer.invoke("fs:duplicateFile", sourcePath),
  movePath: (sourcePath, destinationFolderPath) => ipcRenderer.invoke("fs:movePath", sourcePath, destinationFolderPath),
  ensureWorkspaceAppData: () => ipcRenderer.invoke("ai:ensureWorkspaceAppData"),
  listConversationSummaries: () => ipcRenderer.invoke("ai:listConversationSummaries"),
  readConversation: (conversationId) => ipcRenderer.invoke("ai:readConversation", conversationId),
  writeConversation: (record) => ipcRenderer.invoke("ai:writeConversation", record),
  deleteConversation: (conversationId) => ipcRenderer.invoke("ai:deleteConversation", conversationId),
  testMcpConnection: (profile) => ipcRenderer.invoke("ai:testMcpConnection", profile),
  pickAttachments: () => ipcRenderer.invoke("ai:pickAttachments"),
  readAttachmentText: (filePath) => ipcRenderer.invoke("ai:readAttachmentText", filePath),
  watchWorkspace: (rootPath) => ipcRenderer.invoke("workspace:watch", rootPath),
  unwatchWorkspace: (rootPath) => ipcRenderer.invoke("workspace:unwatch", rootPath),
  startTerminal: (options) => ipcRenderer.invoke("terminal:start", options),
  getTerminalShellInfo: () => ipcRenderer.invoke("terminal:getShellInfo"),
  openExternalTerminal: (options) => ipcRenderer.invoke("terminal:openExternal", options),
  diagnoseTerminal: (options) => ipcRenderer.invoke("terminal:diagnose", options),
  writeTerminal: (terminalId, data) => ipcRenderer.invoke("terminal:write", terminalId, data),
  resizeTerminal: (terminalId, cols, rows) => ipcRenderer.invoke("terminal:resize", terminalId, cols, rows),
  disposeTerminal: (terminalId) => ipcRenderer.invoke("terminal:dispose", terminalId),
  printToPDF: (html) => ipcRenderer.invoke("export:printToPDF", html),
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
  onWorkspaceChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("workspace:changed", listener);
    return () => ipcRenderer.removeListener("workspace:changed", listener);
  },
});