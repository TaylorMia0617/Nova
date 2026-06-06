const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("novelHost", {
  isElectron: true,
  // Window controls
  minimize: () => ipcRenderer.invoke("window:minimize"),
  maximize: () => ipcRenderer.invoke("window:maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
  createNewWindow: () => ipcRenderer.invoke("window:createNew"),
  // File system
  pickWorkspace: () => ipcRenderer.invoke("fs:pickWorkspace"),
  loadWorkspace: (rootPath, options) => ipcRenderer.invoke("fs:loadWorkspace", rootPath, options),
  readDirectory: (directoryPath, options) => ipcRenderer.invoke("fs:readDirectory", directoryPath, options),
  readFile: (filePath) => ipcRenderer.invoke("fs:readFile", filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke("fs:writeFile", filePath, content),
  readFileBinary: (filePath) => ipcRenderer.invoke("fs:readFileBinary", filePath),
  writeFileBinary: (filePath, base64Content) => ipcRenderer.invoke("fs:writeFileBinary", filePath, base64Content),
  readGlobalSettings: (name) => ipcRenderer.invoke("settings:read", name),
  writeGlobalSettings: (name, content) => ipcRenderer.invoke("settings:write", name, content),
  deleteGlobalSettings: (name) => ipcRenderer.invoke("settings:delete", name),
  readGlobalApiConfig: () => ipcRenderer.invoke("settings:readGlobalApiConfig"),
  writeGlobalApiConfig: (content) => ipcRenderer.invoke("settings:writeGlobalApiConfig", content),
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
  listVersionSnapshots: () => ipcRenderer.invoke("history:listSnapshots"),
  appendVersionSnapshot: (snapshot) => ipcRenderer.invoke("history:appendSnapshot", snapshot),
  updateVersionSnapshotPaths: (oldPath, newPath) => ipcRenderer.invoke("history:updateSnapshotPaths", oldPath, newPath),
  pruneVersionSnapshots: () => ipcRenderer.invoke("history:pruneSnapshots"),
  listBlueprints: () => ipcRenderer.invoke("blueprint:list"),
  saveBlueprint: (blueprint) => ipcRenderer.invoke("blueprint:save", blueprint),
  deleteBlueprint: (blueprintId) => ipcRenderer.invoke("blueprint:delete", blueprintId),
  renameBlueprint: (blueprintId, name) => ipcRenderer.invoke("blueprint:rename", blueprintId, name),
  listBlueprintTemplates: () => ipcRenderer.invoke("blueprintTemplate:list"),
  saveBlueprintTemplate: (template) => ipcRenderer.invoke("blueprintTemplate:save", template),
  deleteBlueprintTemplate: (templateId) => ipcRenderer.invoke("blueprintTemplate:delete", templateId),
  testMcpConnection: (profile) => ipcRenderer.invoke("ai:testMcpConnection", profile),
  pickAttachments: () => ipcRenderer.invoke("ai:pickAttachments"),
  pickImages: () => ipcRenderer.invoke("ai:pickImages"),
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
  // 参考列表管理
  getReferenceLists: () => ipcRenderer.invoke("reference:getLists"),
  getReferenceList: (listId) => ipcRenderer.invoke("reference:getList", listId),
  saveReferenceList: (list) => ipcRenderer.invoke("reference:saveList", list),
  deleteReferenceList: (listId) => ipcRenderer.invoke("reference:deleteList", listId),
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
