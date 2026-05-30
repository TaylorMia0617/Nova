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
            <h1 className="app-title">{t("header.title")}</h1>
            <span className="app-subtitle">
              {rootName ? t("header.workspace", { name: rootName }) : t("header.subtitle")}
            </span>
            {rootName && !errorMessage && (
              <div className="workspace-hint">
                {t("header.chatModel")}: {chatModel?.label || t("header.notConfigured")} · {t("header.selectionModel")}: {selectionModel?.label || t("header.notConfigured")}
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
          <div className="language-selector">
            <Globe size={14} />
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
            <FolderOpen size={16} />
            <span>{isLoadingWorkspace ? t("header.opening") : t("header.openWorkspace")}</span>
          </button>
          <button className="workspace-button" onClick={() => void saveAllFiles()} disabled={dirtyCount === 0}>
            <SaveAll size={16} />
            <span>{dirtyCount > 0 ? t("header.saveAllCount", { count: dirtyCount }) : t("header.saveAll")}</span>
          </button>
          <button className="icon-button settings-launch" title={t("header.settings")} onClick={() => setIsSettingsOpen(true)}>
            <Settings size={20} />
            <span>{t("header.settings")}</span>
          </button>
        </div>
      </header>
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
    </>
  );
};

export default Header;
