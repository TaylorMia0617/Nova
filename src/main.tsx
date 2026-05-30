import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { registerLocale } from "./i18n";
import zhCN from "./i18n/locales/zh-CN";
import enUS from "./i18n/locales/en-US";
import "./styles.css";

registerLocale("zh-CN", zhCN);
registerLocale("en-US", enUS);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);