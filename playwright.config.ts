import { defineConfig, devices } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Inherited by workers and the web server; never use the owner's database.
process.env.INSTALOOM_E2E_DB ??= join(tmpdir(), `instaloom-e2e-${randomUUID()}.db`);

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  globalSetup: "./tests/e2e/setup.ts",
  use: {
    baseURL: "http://127.0.0.1:3101",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
    channel: process.env.PLAYWRIGHT_CHANNEL,
  },
  webServer: {
    command: "yarn start --hostname 127.0.0.1 --port 3101",
    url: "http://127.0.0.1:3101/login",
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      DATABASE_PATH: process.env.INSTALOOM_E2E_DB,
      DATABASE_URL: process.env.INSTALOOM_E2E_DATABASE_URL || "",
      OWNER_INSTAGRAM_ID: "200",
      APP_URL: "http://127.0.0.1:3101",
      PORT: "3101",
      INSTAGRAM_APP_ID: "123456789",
      INSTAGRAM_APP_SECRET: "e2e-instagram-secret",
      WEBHOOK_VERIFY_TOKEN: "e2e-verify-token",
    },
  },
});
