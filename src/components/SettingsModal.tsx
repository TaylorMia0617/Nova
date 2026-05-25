import { Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSettingsStore } from "../stores/settingsStore";
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
  rememberSecrets: false,
});

const SettingsModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const {
    modelProfiles,
    defaultChatModelId,
    defaultSelectionModelId,
    selectionPromptTemplates,
    setModelProfiles,
    updateModelProfile,
    removeModelProfile,
    setDefaultChatModelId,
    setDefaultSelectionModelId,
    setSelectionPromptTemplate,
  } = useSettingsStore();
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(modelProfiles[0]?.id ?? null);
  const [profileDraft, setProfileDraft] = useState<ModelProfile | null>(null);
  const [testingProfileId, setTestingProfileId] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<string>("");
  const [saveStatus, setSaveStatus] = useState<string>("");

  const selectedProfile = useMemo(
    () => modelProfiles.find((profile) => profile.id === selectedProfileId) ?? modelProfiles[0] ?? null,
    [modelProfiles, selectedProfileId]
  );

  useEffect(() => {
    if (!selectedProfile && modelProfiles[0]) {
      setSelectedProfileId(modelProfiles[0].id);
      return;
    }

    setProfileDraft(selectedProfile ? { ...selectedProfile } : null);
    setSaveStatus("");
    setTestStatus("");
  }, [selectedProfile, modelProfiles]);

  if (!isOpen) return null;

  const handleAddProfile = () => {
    const next = createDraftProfile();
    setModelProfiles([...modelProfiles, next]);
    setDefaultChatModelId(next.id);
    setDefaultSelectionModelId(next.id);
    setSelectedProfileId(next.id);
    setProfileDraft(next);
    setSaveStatus("New profile created. Fill in the fields and click Save Profile.");
  };

  const updateDraft = (patch: Partial<ModelProfile>) => {
    setProfileDraft((current) => (current ? { ...current, ...patch } : current));
    setSaveStatus("");
  };

  const handleSaveProfile = () => {
    if (!profileDraft) return;
    updateModelProfile(profileDraft.id, profileDraft);
    setDefaultChatModelId(profileDraft.id);
    setDefaultSelectionModelId(profileDraft.id);
    setSaveStatus("Profile saved.");
  };

  const handleDeleteProfile = () => {
    if (!selectedProfile) return;
    removeModelProfile(selectedProfile.id);
    const nextProfile = modelProfiles.find((profile) => profile.id !== selectedProfile.id) ?? null;
    setSelectedProfileId(nextProfile?.id ?? null);
    setProfileDraft(nextProfile ? { ...nextProfile } : null);
    setSaveStatus("Profile deleted.");
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
      setTestStatus(toolCount > 0 ? `Connected. ${toolCount} tool(s) available.` : "Connected, but no tools were listed.");
    } catch (error) {
      setTestStatus(error instanceof Error ? error.message : "Connection test failed.");
    } finally {
      setTestingProfileId(null);
    }
  };

  return (
    <div className="dialog-backdrop settings-backdrop" onClick={onClose}>
      <div className="settings-modal" onClick={(event) => event.stopPropagation()}>
        <div className="settings-header">
          <div>
            <h2>AI Settings</h2>
            <p>Configure model profiles, MCP endpoints, and selection prompts.</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close settings">
            <X size={18} />
          </button>
        </div>
        <div className="settings-layout">
          <aside className="settings-sidebar">
            <div className="settings-sidebar-header">
              <h3>Model Profiles</h3>
              <button onClick={handleAddProfile} className="workspace-button compact-button" type="button">
                <Plus size={14} />
                <span>Add</span>
              </button>
            </div>
            <div className="settings-profile-list">
              {modelProfiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  className={`settings-profile-item ${selectedProfile?.id === profile.id ? "active" : ""}`}
                  onClick={() => setSelectedProfileId(profile.id)}
                >
                  <strong>{profile.label || "Untitled Model"}</strong>
                  <span>{profile.model || "No model id"}</span>
                </button>
              ))}
            </div>
          </aside>
          <div className="settings-content">
            {profileDraft ? (
              <>
                <div className="settings-grid">
                  <label>
                    <span>Name</span>
                    <input
                      type="text"
                      value={profileDraft.label}
                      onChange={(event) => updateDraft({ label: event.target.value })}
                      autoComplete="off"
                    />
                  </label>
                  <label>
                    <span>Model ID</span>
                    <input
                      type="text"
                      value={profileDraft.model}
                      onChange={(event) => updateDraft({ model: event.target.value })}
                      autoComplete="off"
                    />
                  </label>
                  <label>
                    <span>AI Base URL</span>
                    <input
                      type="text"
                      value={profileDraft.baseUrl}
                      onChange={(event) => updateDraft({ baseUrl: event.target.value })}
                      autoComplete="off"
                    />
                  </label>
                  <label>
                    <span>MCP Server URL</span>
                    <input
                      type="text"
                      value={profileDraft.mcpServerUrl}
                      onChange={(event) => updateDraft({ mcpServerUrl: event.target.value })}
                      autoComplete="off"
                    />
                  </label>
                  <label className="settings-span-2">
                    <span>API Key</span>
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
                    <span>Remember secrets on this device</span>
                  </label>
                </div>
                <div className="settings-row">
                  <label>
                    <span>Default Chat Model</span>
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
                    <span>Default Selection Model</span>
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
                  <h3>Selection Prompts</h3>
                  <label>
                    <span>润色</span>
                    <textarea
                      rows={3}
                      value={selectionPromptTemplates.polish}
                      onChange={(event) => setSelectionPromptTemplate("polish", event.target.value)}
                    />
                  </label>
                  <label>
                    <span>纠错</span>
                    <textarea
                      rows={3}
                      value={selectionPromptTemplates.correct}
                      onChange={(event) => setSelectionPromptTemplate("correct", event.target.value)}
                    />
                  </label>
                  <label>
                    <span>风格化</span>
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
                    <span>Save Profile</span>
                  </button>
                  <button
                    className="workspace-button"
                    onClick={() => void handleTest()}
                    disabled={testingProfileId === profileDraft.id}
                    type="button"
                  >
                    <Save size={14} />
                    <span>{testingProfileId === profileDraft.id ? "Testing..." : "Test MCP Connection"}</span>
                  </button>
                  <button
                    className="workspace-button danger-button"
                    onClick={handleDeleteProfile}
                    disabled={modelProfiles.length <= 1}
                    type="button"
                  >
                    <Trash2 size={14} />
                    <span>Delete Profile</span>
                  </button>
                </div>
                {saveStatus && <div className="settings-status">{saveStatus}</div>}
                {testStatus && <div className="settings-status">{testStatus}</div>}
              </>
            ) : (
              <div className="settings-empty">Create a model profile to begin.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
