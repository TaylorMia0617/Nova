import React, { useMemo, useState } from "react";
import { FolderOpen, SaveAll, Settings, Globe } from "lucide-react";
import { useSettingsStore } from "../stores/settingsStore";
import { useFileStore } from "../stores/fileStore";
import { useTranslation } from "../hooks/useTranslation";
import type { Locale } from "../i18n";
import SettingsModal from "./SettingsModal";
import "./Header.css";

const LOCALE_OPTIONS: { value: Locale; label: string }[] = [
  { value: "zh-CN", label: "中文" },
  { value: "en-US", label: "English" },
];

const Header: React.FC = () => {
  const { modelProfiles, defaultChatModelId, defaultSelectionModelId, language, setLanguage } = useSettingsStore();
  const { t } = useTranslation();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const {
    rootName,
    openWorkspace,
    saveAllFiles,
    getOpenTabs,
    isLoadingWorkspace,
    errorMessage,
    setErrorMessage,
  } = useFileStore();

  const dirtyCount = getOpenTabs().filter((tab) => tab.isDirty).length;
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
          <span className="header-title">Nova</span>
          {rootName && (
            <>
              <span className="header-separator">·</span>
              <span className="workspace-name">{rootName}</span>
            </>
          )}
        </div>
        <div className="header-center">
          {rootName && !errorMessage && (
            <span className="workspace-hint">
              {t("header.chatModel")}: {chatModel?.label || t("header.notConfigured")}
              <span className="header-separator">·</span>
              {t("header.selectionModel")}: {selectionModel?.label || t("header.notConfigured")}
            </span>
          )}
          {errorMessage && (
            <span className="workspace-error" onClick={() => setErrorMessage(null)}>
              {errorMessage}
            </span>
          )}
        </div>
        <div className="header-right">
          <div className="language-selector">
            <Globe size={12} />
            <select
              value={language}
              onChange={(event) => setLanguage(event.target.value as Locale)}
              title={t("header.language")}
            >
              {LOCALE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <button className="workspace-button" onClick={() => void openWorkspace()} disabled={isLoadingWorkspace}>
            <FolderOpen size={14} />
            <span>{isLoadingWorkspace ? t("header.opening") : t("header.openWorkspace")}</span>
          </button>
          <button className="workspace-button" onClick={() => void saveAllFiles()} disabled={dirtyCount === 0}>
            <SaveAll size={14} />
            <span>{dirtyCount > 0 ? t("header.saveAllCount", { count: dirtyCount }) : t("header.saveAll")}</span>
          </button>
          <button className="icon-button settings-launch" title={t("header.settings")} onClick={() => setIsSettingsOpen(true)}>
            <Settings size={16} />
            <span>{t("header.settings")}</span>
          </button>
        </div>
      </header>
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
    </>
  );
};

export default Header;
