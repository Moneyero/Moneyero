import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  define: {
    // @solana/web3.js expects a global Buffer in some code paths
    global: "globalThis",
  },
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    outDir: "dist",
    rollupOptions: {
      input: {
        site: "index.html",
        app: "app.html",
        terminal: "terminal.html",
        vault: "vault.html",
        exchange: "exchange.html",
        agent: "agent.html",
        network: "network.html",
        privacy: "privacy.html",
        download: "download.html",
        guide: "guide.html",
      },
    },
  },
});
