import { defineConfig, devices } from "@playwright/test";

// Smoke tests drive the app in a real browser against the Vite dev server —
// the same way it ships.
export default defineConfig({
  testDir: "./e2e",
  // Most editor flows are stateful; running tests serially keeps them
  // predictable while the suite is small.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  timeout: 30_000,

  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    // E2E runs against the signed-out app and does not need Doppler secrets.
    // Starting Vite directly keeps the suite runnable in fresh workspaces + CI.
    command: "npm exec vite -- --host 127.0.0.1 --port 5173",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
