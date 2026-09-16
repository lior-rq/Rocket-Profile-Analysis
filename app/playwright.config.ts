import { defineConfig } from "@playwright/test";
// Runs against a service started separately: `rpa gui --port 8799 --no-browser` (RPA_PORT to change).
const port = process.env.RPA_PORT || "8799";
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true, viewport: { width: 1440, height: 900 }, screenshot: "only-on-failure" },
  reporter: [["list"]],
  outputDir: "e2e/results",
});
