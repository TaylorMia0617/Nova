import { Plus, Save, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { useTranslation } from "../hooks/useTranslation";
import type { ModelProfile } from "../types/ai";
import { testMcpConnection } from "../services/mcpService";
import "./SettingsModal.css";

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

const createDraftProfile = (): ModelProfile => ({
  id: `model-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
  label: "New Model",
  model: "",
  apiKey: "",
  baseUrl: "https://api.openai.com/v1/responses",
  transportType: "sse-http",
  mcpServerUrl: "",
  headers: [],
  rememberSecrets: true,
});

const AUTO_SAVE_DELAY = 5000;

const SettingsModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const {
    modelProfiles,
    defaultChatModelId,
    defaultSelectionModelId,
    selectionPromptTemplates,
    contextMaxLength,
    tavilyApiKey,
    setModelProfiles,
    updateModelProfile,
    removeModelProfile,
    setDefaultChatModelId,
    setDefaultSelectionModelId,
    setSelectionPromptTemplate,
    setContextMaxLength,
    setTavilyApiKey,
  } = useSettingsStore();
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<"models" | "search">("models");
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(modelProfiles[0]?.id ?? null);
  const [profileDraft, setProfileDraft] = useState<ModelProfile | null>(null);
  const [testingProfileId, setTestingProfileId] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<string>("");
  const [saveStatus, setSaveStatus] = useState<string>("");
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestDraftRef = useRef<ModelProfile | null>(null);

  const selectedProfile = useMemo(
    () => modelProfiles.find((profile) => profile.id === selectedProfileId) ?? modelProfiles[0] ?? null,
    [modelProfiles, selectedProfileId]
  );

  const flushAutoSave = useCallback(() => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    const draft = latestDraftRef.current;
    if (!draft) return;
    updateModelProfile(draft.id, draft);
  }, [updateModelProfile]);

  useEffect(() => {
    latestDraftRef.current = profileDraft;
  }, [profileDraft]);

  useEffect(() => {
    if (!selectedProfile && modelProfiles[0]) {
      setSelectedProfileId(modelProfiles[0].id);
      return;
    }

    setProfileDraft(selectedProfile ? { ...selectedProfile } : null);
    setSaveStatus("");
    setTestStatus("");
  }, [selectedProfile, modelProfiles]);

  useEffect(() => {
    if (!isOpen) {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
      return;
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushAutoSave();
      }
    };

    const handleWindowBlur = () => {
      flushAutoSave();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [isOpen, flushAutoSave]);

  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, []);

  if (!isOpen) return null;

  const handleAddProfile = () => {
    const next = createDraftProfile();
    setModelProfiles([...modelProfiles, next]);
    setDefaultChatModelId(next.id);
    setDefaultSelectionModelId(next.id);
    setSelectedProfileId(next.id);
    setProfileDraft(next);
    setSaveStatus(t("settings.newProfileCreated"));
  };

  const scheduleAutoSave = (draft: ModelProfile) => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }
    autoSaveTimerRef.current = setTimeout(() => {
      autoSaveTimerRef.current = null;
      updateModelProfile(draft.id, draft);
      setSaveStatus(t("settings.profileSaved"));
    }, AUTO_SAVE_DELAY);
  };

  const updateDraft = (patch: Partial<ModelProfile>) => {
    setProfileDraft((current) => {
      if (!current) return current;
      const next = { ...current, ...patch };
      scheduleAutoSave(next);
      return next;
    });
    setSaveStatus("");
  };

  const handleSaveProfile = () => {
    if (!profileDraft) return;
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    updateModelProfile(profileDraft.id, profileDraft);
    setDefaultChatModelId(profileDraft.id);
    setDefaultSelectionModelId(profileDraft.id);
    setSaveStatus(t("settings.profileSaved"));
  };

  const handleSelectProfile = (id: string) => {
    if (id === selectedProfileId) return;
    flushAutoSave();
    setSelectedProfileId(id);
  };

  const handleClose = () => {
    flushAutoSave();
    onClose();
  };

  const handleDeleteProfile = () => {
    if (!selectedProfile) return;
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    removeModelProfile(selectedProfile.id);
    const nextProfile = modelProfiles.find((profile) => profile.id !== selectedProfile.id) ?? null;
    setSelectedProfileId(nextProfile?.id ?? null);
    setProfileDraft(nextProfile ? { ...nextProfile } : null);
    setSaveStatus(t("settings.profileDeleted"));
  };

  const handleTest = async () => {
    if (!profileDraft) return;
    setTestingProfileId(profileDraft.id);
    setTestStatus("");

    try {
      const result = await testMcpConnection(profileDraft);
      const toolCount =
        typeof result === "object" && result && "tools" in result && Array.isArray((result as any).tools)
          ? (result as any).tools.length
          : 0;
      setTestStatus(toolCount > 0 ? t("settings.connected", { count: toolCount }) : t("settings.connectedNoTools"));
    } catch (error) {
      setTestStatus(error instanceof Error ? error.message : t("settings.connectionFailed"));
    } finally {
      setTestingProfileId(null);
    }
  };

  return (
    <div className="dialog-backdrop settings-backdrop" onClick={handleClose}>
      <div className="settings-modal" onClick={(event) => event.stopPropagation()}>
        <div className="settings-header">
          <div>
            <h2>{t("settings.title")}</h2>
            <p>{t("settings.description")}</p>
          </div>
          <button className="icon-button" onClick={handleClose} aria-label="Close settings">
            <X size={18} />
          </button>
        </div>
        <div className="settings-layout">
          <aside className="settings-sidebar">
            <div className="settings-sidebar-tabs">
              <button
                type="button"
                className={`tab-button ${activeTab === "models" ? "active" : ""}`}
                onClick={() => setActiveTab("models")}
              >
                {t("settings.modelProfiles")}
              </button>
              <button
                type="button"
                className={`tab-button ${activeTab === "search" ? "active" : ""}`}
                onClick={() => setActiveTab("search")}
              >
                {t("settings.searchSettings")}
              </button>
            </div>
            {activeTab === "models" && (
              <>
                <div className="settings-sidebar-header">
                  <h3>{t("settings.modelProfiles")}</h3>
                  <button onClick={handleAddProfile} className="workspace-button compact-button" type="button">
                    <Plus size={14} />
                    <span>{t("settings.add")}</span>
                  </button>
                </div>
                <div className="settings-profile-list">
                  {modelProfiles.map((profile) => (
                    <button
                      key={profile.id}
                      type="button"
                      className={`settings-profile-item ${selectedProfile?.id === profile.id ? "active" : ""}`}
                      onClick={() => handleSelectProfile(profile.id)}
                    >
                      <strong>{profile.label || t("settings.untitledModel")}</strong>
                      <span>{profile.model || t("settings.noModelId")}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </aside>
          <div className="settings-content">
            {activeTab === "search" ? (
              <div className="settings-section">
                <h3>{t("settings.tavilyConfig")}</h3>
                <label>
                  <span>{t("settings.tavilyApiKey")}</span>
                  <input
                    type="password"
                    value={tavilyApiKey}
                    onChange={(event) => setTavilyApiKey(event.target.value)}
                    placeholder="tvly-..."
                    autoComplete="new-password"
                  />
                </label>
                <div className="settings-hint">
                  <span>{t("settings.tavilyApiKeyHint")}</span>
                  <a href="https://app.tavily.com" target="_blank" rel="noopener noreferrer">
                    app.tavily.com
                  </a>
                </div>
              </div>
            ) : (
              <>
                <div className="settings-section">
                  <h3>{t("settings.contextMaxLength")}</h3>
                  <label>
                    <input
                      type="number"
                      min={1000}
                      max={20000}
                      step={500}
                      value={contextMaxLength}
                      onChange={(event) => setContextMaxLength(Number(event.target.value))}
                    />
                    <span>{t("settings.contextMaxLengthHint")}</span>
                  </label>
                </div>
                {profileDraft ? (
              <>
                <div className="settings-grid">
                  <label>
                    <span>{t("settings.name")}</span>
                    <input
                      type="text"
                      value={profileDraft.label}
                      onChange={(event) => updateDraft({ label: event.target.value })}
                      autoComplete="off"
                    />
                  </label>
                  <label>
                    <span>{t("settings.modelId")}</span>
                    <input
                      type="text"
                      value={profileDraft.model}
                      onChange={(event) => updateDraft({ model: event.target.value })}
                      autoComplete="off"
                    />
                  </label>
                  <label>
                    <span>{t("settings.aiBaseUrl")}</span>
                    <input
                      type="text"
                      value={profileDraft.baseUrl}
                      onChange={(event) => updateDraft({ baseUrl: event.target.value })}
                      autoComplete="off"
                    />
                  </label>
                  <label>
                    <span>{t("settings.mcpServerUrl")}</span>
                    <input
                      type="text"
                      value={profileDraft.mcpServerUrl}
                      onChange={(event) => updateDraft({ mcpServerUrl: event.target.value })}
                      autoComplete="off"
                    />
                  </label>
                  <label className="settings-span-2">
                    <span>{t("settings.apiKey")}</span>
                    <input
                      type="password"
                      value={profileDraft.apiKey}
                      onChange={(event) => updateDraft({ apiKey: event.target.value })}
                      autoComplete="new-password"
                    />
                  </label>
                </div>
                <div className="settings-checks">
                  <label className="remember-key-toggle">
                    <input
                      type="checkbox"
                      checked={profileDraft.rememberSecrets}
                      onChange={(event) => updateDraft({ rememberSecrets: event.target.checked })}
                    />
                    <span>{t("settings.rememberSecrets")}</span>
                  </label>
                </div>
                <div className="settings-row">
                  <label>
                    <span>{t("settings.defaultChatModel")}</span>
                    <select
                      value={defaultChatModelId}
                      onChange={(event) => setDefaultChatModelId(event.target.value)}
                    >
                      {modelProfiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>{t("settings.defaultSelectionModel")}</span>
                    <select
                      value={defaultSelectionModelId}
                      onChange={(event) => setDefaultSelectionModelId(event.target.value)}
                    >
                      {modelProfiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="settings-prompts">
                  <h3>{t("settings.selectionPrompts")}</h3>
                  <label>
                    <span>{t("settings.polish")}</span>
                    <textarea
                      rows={3}
                      value={selectionPromptTemplates.polish}
                      onChange={(event) => setSelectionPromptTemplate("polish", event.target.value)}
                    />
                  </label>
                  <label>
                    <span>{t("settings.correct")}</span>
                    <textarea
                      rows={3}
                      value={selectionPromptTemplates.correct}
                      onChange={(event) => setSelectionPromptTemplate("correct", event.target.value)}
                    />
                  </label>
                  <label>
                    <span>{t("settings.stylize")}</span>
                    <textarea
                      rows={3}
                      value={selectionPromptTemplates.stylize}
                      onChange={(event) => setSelectionPromptTemplate("stylize", event.target.value)}
                    />
                  </label>
                </div>
                <div className="settings-actions">
                  <button className="workspace-button" onClick={handleSaveProfile} type="button">
                    <Save size={14} />
                    <span>{t("settings.saveProfile")}</span>
                  </button>
                  <button
                    className="workspace-button"
                    onClick={() => void handleTest()}
                    disabled={testingProfileId === profileDraft.id}
                    type="button"
                  >
                    <Save size={14} />
                    <span>{testingProfileId === profileDraft.id ? t("settings.testing") : t("settings.testMcpConnection")}</span>
                  </button>
                  <button
                    className="workspace-button danger-button"
                    onClick={handleDeleteProfile}
                    disabled={modelProfiles.length <= 1}
                    type="button"
                  >
                    <Trash2 size={14} />
                    <span>{t("settings.deleteProfile")}</span>
                  </button>
                </div>
                {saveStatus && <div className="settings-status">{saveStatus}</div>}
                {testStatus && <div className="settings-status">{testStatus}</div>}
              </>
            ) : (
              <div className="settings-empty">{t("settings.createProfile")}</div>
            )}
            </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
