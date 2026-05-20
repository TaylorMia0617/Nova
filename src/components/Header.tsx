import React from "react";
import { FolderOpen, SaveAll, Settings } from "lucide-react";
import { useSettingsStore } from "../stores/settingsStore";
import { useFileStore } from "../stores/fileStore";
import "./Header.css";

const Header: React.FC = () => {
  const { apiKey, setApiKey, provider } = useSettingsStore();
  const {
    rootName,
    openWorkspace,
    saveAllFiles,
    openTabs,
    isLoadingWorkspace,
    errorMessage,
    setErrorMessage,
  } = useFileStore();

  const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setApiKey(e.target.value);
  };

  const dirtyCount = openTabs.filter((tab) => tab.isDirty).length;

  return (
    <header className="header">
      <div className="header-left">
        <div>
          <h1 className="app-title">NovelAssistance</h1>
          <span className="app-subtitle">
            {rootName ? `Workspace: ${rootName}` : "AI Writing Assistant"}
          </span>
          {rootName && !errorMessage && (
            <div className="workspace-hint">
              会自动创建“人物列表.txt”“地理名称.txt”“道具名称.txt”，正文里停顿 1 秒可弹出名称提示
            </div>
          )}
          {errorMessage && (
            <div className="workspace-error" onClick={() => setErrorMessage(null)}>
              {errorMessage}
            </div>
          )}
        </div>
      </div>
      <div className="header-right">
        <button className="workspace-button" onClick={openWorkspace} disabled={isLoadingWorkspace}>
          <FolderOpen size={16} />
          <span>{isLoadingWorkspace ? "Opening..." : "Open Workspace"}</span>
        </button>
        <button className="workspace-button" onClick={saveAllFiles} disabled={dirtyCount === 0}>
          <SaveAll size={16} />
          <span>{dirtyCount > 0 ? `Save All (${dirtyCount})` : "Save All"}</span>
        </button>
        <div className="api-key-section">
          <label htmlFor="api-key">API Key:</label>
          <input
            id="api-key"
            type="password"
            value={apiKey}
            onChange={handleApiKeyChange}
            placeholder={`Enter ${provider} API Key`}
            className="api-key-input"
          />
        </div>
        <button className="icon-button" title="Settings">
          <Settings size={20} />
        </button>
      </div>
    </header>
  );
};

export default Header;
