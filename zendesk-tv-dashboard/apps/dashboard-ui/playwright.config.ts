import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry"
  },
  webServer: {
    command: "npm run dev:dashboard",
    port: 3000,
    timeout: 120000,
    reuseExistingServer: true,
    env: {
      ...process.env,
      DASHBOARD_SPLASH_MIN_MS: "0",
      DASHBOARD_BASIC_AUTH_USERNAME: "",
      DASHBOARD_BASIC_AUTH_PASSWORD: "",
      OPS_UI_ENABLED: "true"
    }
  }
});
