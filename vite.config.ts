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
    rollupOptions: {
      external: (id) => id.startsWith("core-js/modules/"),
      output: {
        manualChunks: {
          monaco: ["@monaco-editor/react"],
          terminal: ["@xterm/xterm", "@xterm/addon-fit"],
          react: ["react", "react-dom"],
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
