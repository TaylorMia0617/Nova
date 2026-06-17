import { ArrowLeft, ArrowRight, ExternalLink, Home, Link2, Plus, RefreshCw, Search, Send, X } from "lucide-react";
import { FormEvent, useMemo, useRef, useState } from "react";
import { openExternalUrl, sendBrowserContextToMainApp } from "../services/fileSystemService";
import "./BrowserPanel.css";

const HOME_URL = "https://www.google.com";
const BROWSER_PARTITION = "persist:nova-browser";
const SYSTEM_BROWSER_BRIDGE_BOOKMARKLET = `javascript:(()=>{const url=encodeURIComponent(location.href);const title=encodeURIComponent(document.title||location.href);const selection=encodeURIComponent(String(window.getSelection?window.getSelection():"").trim());location.href="nova://send-to-ai?url="+url+"&title="+title+"&selection="+selection;})()`;

type BrowserWebView = HTMLElement & {
  src: string;
  getURL: () => string;
  getTitle: () => string;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  stop: () => void;
  executeJavaScript: <T = unknown>(code: string) => Promise<T>;
};

type BrowserTab = {
  id: string;
  title: string;
  url: string;
  address: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isDomReady: boolean;
  errorText: string;
};

const newId = () => `browser-tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function createTab(url = HOME_URL): BrowserTab {
  return {
    id: newId(),
    title: "New Tab",
    url,
    address: url,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    isDomReady: false,
    errorText: "",
  };
}

function normalizeBrowserInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return HOME_URL;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(trimmed)) return `https://${trimmed}`;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

function BrowserTabView({
  tab,
  active,
  setWebview,
  updateTab,
}: {
  tab: BrowserTab;
  active: boolean;
  setWebview: (id: string, webview: BrowserWebView | null) => void;
  updateTab: (id: string, patch: Partial<BrowserTab>) => void;
}) {
  const attachedRef = useRef(false);

  const attachEvents = (node: BrowserWebView | null) => {
    setWebview(tab.id, node);
    if (!node || attachedRef.current) return;
    attachedRef.current = true;

    const updateNavigationState = () => {
      if (!node || !node.isConnected) return;
      try {
        updateTab(tab.id, {
          canGoBack: node.canGoBack(),
          canGoForward: node.canGoForward(),
          address: node.getURL() || tab.address,
          title: node.getTitle() || tab.title,
        });
      } catch {
        // Electron webview navigation methods are only safe after dom-ready.
      }
    };

    node.addEventListener("dom-ready", () => {
      updateTab(tab.id, { isDomReady: true });
      updateNavigationState();
    });
    node.addEventListener("did-start-loading", () => {
      updateTab(tab.id, { isLoading: true, errorText: "" });
    });
    node.addEventListener("did-stop-loading", () => {
      updateTab(tab.id, { isLoading: false });
      updateNavigationState();
    });
    node.addEventListener("page-title-updated", (event: Event) => {
      const title = (event as Event & { title?: string }).title;
      if (title) updateTab(tab.id, { title });
    });
    node.addEventListener("did-navigate", (event: Event) => {
      const url = (event as Event & { url?: string }).url;
      updateTab(tab.id, { address: url || tab.address });
      updateNavigationState();
    });
    node.addEventListener("did-navigate-in-page", (event: Event) => {
      const url = (event as Event & { url?: string }).url;
      updateTab(tab.id, { address: url || tab.address });
      updateNavigationState();
    });
    node.addEventListener("did-fail-load", (event: Event) => {
      const typed = event as Event & { errorDescription?: string; validatedURL?: string };
      updateTab(tab.id, {
        isLoading: false,
        errorText: typed.errorDescription || "页面加载失败。",
        address: typed.validatedURL || tab.address,
      });
    });
  };

  return (
    <webview
      ref={attachEvents}
      className={`browser-webview ${active ? "active" : ""}`}
      src={tab.url}
      partition={BROWSER_PARTITION}
    />
  );
}

export default function BrowserPanel() {
  const [tabs, setTabs] = useState<BrowserTab[]>(() => [createTab()]);
  const [activeTabId, setActiveTabId] = useState(() => tabs[0].id);
  const [bridgeStatus, setBridgeStatus] = useState("");
  const webviewsRef = useRef(new Map<string, BrowserWebView>());

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0],
    [activeTabId, tabs]
  );

  const updateTab = (id: string, patch: Partial<BrowserTab>) => {
    setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, ...patch } : tab));
  };

  const setWebview = (id: string, webview: BrowserWebView | null) => {
    if (webview) {
      webviewsRef.current.set(id, webview);
    } else {
      webviewsRef.current.delete(id);
    }
  };

  const addTab = () => {
    const tab = createTab();
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
  };

  const closeTab = (id: string) => {
    setTabs((current) => {
      const remaining = current.filter((tab) => tab.id !== id);
      const nextTabs = remaining.length > 0 ? remaining : [createTab()];
      if (activeTabId === id) {
        setActiveTabId(nextTabs[Math.max(0, current.findIndex((tab) => tab.id === id) - 1)]?.id ?? nextTabs[0].id);
      }
      return nextTabs;
    });
  };

  const submitAddress = (event: FormEvent) => {
    event.preventDefault();
    if (!activeTab) return;
    const nextUrl = normalizeBrowserInput(activeTab.address);
    updateTab(activeTab.id, {
      url: nextUrl,
      address: nextUrl,
      isDomReady: false,
      errorText: "",
    });
  };

  const activeWebview = activeTab ? webviewsRef.current.get(activeTab.id) : null;
  const canUseWebview = Boolean(activeWebview && activeTab?.isDomReady);

  const goHome = () => {
    if (!activeTab) return;
    updateTab(activeTab.id, {
      url: HOME_URL,
      address: HOME_URL,
      isDomReady: false,
      errorText: "",
    });
  };

  const sendToAi = async () => {
    if (!activeTab) return;
    const webview = activeWebview;
    let selection = "";
    if (webview && activeTab.isDomReady) {
      try {
        selection = await webview.executeJavaScript<string>("window.getSelection()?.toString() || ''");
      } catch {
        selection = "";
      }
    }
    await sendBrowserContextToMainApp({
      title: activeTab.title,
      url: activeTab.address || activeTab.url,
      selection: selection.trim(),
      source: "nova-browser",
    });
  };

  const copySystemBrowserBridge = async () => {
    try {
      await navigator.clipboard.writeText(SYSTEM_BROWSER_BRIDGE_BOOKMARKLET);
      setBridgeStatus("已复制系统浏览器桥接按钮，可把它保存到 Chrome/Edge 书签栏");
    } catch {
      setBridgeStatus("复制失败，请确认系统剪贴板权限");
    }
    window.setTimeout(() => setBridgeStatus(""), 5000);
  };

  return (
    <div className="browser-panel browser-window-panel">
      <div className="browser-tabbar">
        <div className="browser-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`browser-tab ${tab.id === activeTabId ? "active" : ""}`}
              onClick={() => setActiveTabId(tab.id)}
            >
              <span>{tab.title || "New Tab"}</span>
              <X
                size={12}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.id);
                }}
              />
            </button>
          ))}
        </div>
        <button type="button" className="browser-new-tab" onClick={addTab} title="新建标签页">
          <Plus size={15} />
        </button>
      </div>
      <div className="browser-toolbar">
        <button type="button" onClick={() => activeWebview?.goBack()} disabled={!canUseWebview || !activeTab?.canGoBack} title="后退">
          <ArrowLeft size={15} />
        </button>
        <button type="button" onClick={() => activeWebview?.goForward()} disabled={!canUseWebview || !activeTab?.canGoForward} title="前进">
          <ArrowRight size={15} />
        </button>
        <button type="button" onClick={() => activeTab?.isLoading ? activeWebview?.stop() : activeWebview?.reload()} disabled={!canUseWebview} title={activeTab?.isLoading ? "停止" : "刷新"}>
          {activeTab?.isLoading ? <X size={15} /> : <RefreshCw size={15} />}
        </button>
        <button type="button" onClick={goHome} title="主页">
          <Home size={15} />
        </button>
        <form className="browser-address" onSubmit={submitAddress}>
          <Search size={14} />
          <input value={activeTab?.address ?? ""} onChange={(event) => activeTab && updateTab(activeTab.id, { address: event.target.value })} />
        </form>
        <button type="button" onClick={() => void sendToAi()} title="发送当前页面给 AI">
          <Send size={15} />
          <span>发送给 AI</span>
        </button>
        <button type="button" onClick={() => activeTab && void openExternalUrl(activeTab.address || activeTab.url)} title="在外部浏览器打开">
          <ExternalLink size={15} />
        </button>
        <button type="button" onClick={() => void copySystemBrowserBridge()} title="复制 Chrome/Edge 发送到 Nova 的桥接按钮">
          <Link2 size={15} />
        </button>
      </div>
      <div className="browser-status">
        <span>{activeTab?.isLoading ? "加载中..." : activeTab?.title}</span>
        {activeTab?.errorText && <strong>{activeTab.errorText}</strong>}
        {bridgeStatus && <strong>{bridgeStatus}</strong>}
      </div>
      <div className="browser-webview-stack">
        {tabs.map((tab) => (
          <BrowserTabView
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            setWebview={setWebview}
            updateTab={updateTab}
          />
        ))}
      </div>
    </div>
  );
}
