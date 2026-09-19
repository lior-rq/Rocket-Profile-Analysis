import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// The service the dev UI talks to: `rpa gui --port 8799 --no-browser` (or any port via RPA_PORT).
// @ts-expect-error process is a nodejs global
const servicePort = process.env.RPA_PORT || "8799";
const target = `http://127.0.0.1:${servicePort}`;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
    proxy: {
      "/api": { target, changeOrigin: true },
      "/files": { target, changeOrigin: true },
      "/download": { target, changeOrigin: true },
      "/static": { target, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Vendor code in its own files, so an edit to the app never rewrites them.
        manualChunks(id: string) {
          if (id.includes("node_modules/echarts") || id.includes("node_modules/zrender")) return "echarts";
          if (id.includes("node_modules/motion") || id.includes("node_modules/framer-motion")) return "motion";
          if (id.includes("node_modules/@tanstack")) return "tanstack";
          return undefined;
        },
      },
    },
  },
}));
