import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import BrowserPanel from "./components/BrowserPanel";
import { registerLocale } from "./i18n";
import zhCN from "./i18n/locales/zh-CN";
import enUS from "./i18n/locales/en-US";
import "./styles.css";

registerLocale("zh-CN", zhCN);
registerLocale("en-US", enUS);

const isBrowserWindow = new URLSearchParams(window.location.search).get("browser") === "1";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isBrowserWindow ? <BrowserPanel /> : <App />}
  </React.StrictMode>,
);
