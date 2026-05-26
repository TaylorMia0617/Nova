import React, { useMemo, useState } from "react";
import { FolderOpen, SaveAll, Settings } from "lucide-react";
import { useSettingsStore } from "../stores/settingsStore";
import { useFileStore } from "../stores/fileStore";
import SettingsModal from "./SettingsModal";
import "./Header.css";

const Header: React.FC = () => {
  const { modelProfiles, defaultChatModelId, defaultSelectionModelId } = useSettingsStore();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const {
    rootName,
    openWorkspace,
    saveAllFiles,
    openTabs,
    isLoadingWorkspace,
    errorMessage,
    setErrorMessage,
  } = useFileStore();

  const dirtyCount = openTabs.filter((tab) => tab.isDirty).length;
  const chatModel = useMemo(
    () => modelProfiles.find((profile) => profile.id === defaultChatModelId) ?? null,
    [defaultChatModelId, modelProfiles]
  );
  const selectionModel = useMemo(
    () => modelProfiles.find((profile) => profile.id === defaultSelectionModelId) ?? null,
    [defaultSelectionModelId, modelProfiles]
  );

  return (
    <>
      <header className="header">
        <div className="header-left">
          <div>
            <h1 className="app-title">Nova/诺瓦</h1>
            <span className="app-subtitle">
              {rootName ? `Workspace: ${rootName}` : "Electron writing workspace"}
            </span>
            {rootName && !errorMessage && (
              <div className="workspace-hint">
                Chat model: {chatModel?.label || "Not configured"} · Selection model: {selectionModel?.label || "Not configured"}
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
          <button className="workspace-button" onClick={() => void openWorkspace()} disabled={isLoadingWorkspace}>
            <FolderOpen size={16} />
            <span>{isLoadingWorkspace ? "Opening..." : "Open Workspace"}</span>
          </button>
          <button className="workspace-button" onClick={() => void saveAllFiles()} disabled={dirtyCount === 0}>
            <SaveAll size={16} />
            <span>{dirtyCount > 0 ? `Save All (${dirtyCount})` : "Save All"}</span>
          </button>
          <button className="icon-button settings-launch" title="AI settings" onClick={() => setIsSettingsOpen(true)}>
            <Settings size={20} />
            <span>Settings</span>
          </button>
        </div>
      </header>
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
    </>
  );
};

export default Header;
