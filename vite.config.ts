import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(async () => ({
  base: "./",
  plugins: [react()],
  clearScreen: false,
  optimizeDeps: {
    exclude: ["jspdf", "canvg", "html2canvas", "core-js"],
  },
  build: {
    rolldownOptions: {
      external: (id) => id.startsWith("core-js/modules/"),
      output: {
        manualChunks(id) {
          if (id.includes("@monaco-editor/react")) return "monaco";
          if (id.includes("@xterm/xterm") || id.includes("@xterm/addon-fit")) return "terminal";
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/")) return "react";
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
