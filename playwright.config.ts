import { defineConfig, devices } from "@playwright/test"

// The editor in a real browser, against the Vite dev server: the stylesheet, the lazy 3D chunk,
// the workers and the examples' JSON, none of which the unit tests see. Hermetic: no backend and
// no network beyond localhost. `E2E_PORT` moves it off 5173 when that is taken.
const port = Number(process.env.E2E_PORT ?? 5173)
const origin = `http://localhost:${port}`

export default defineConfig({
  testDir: "./e2e",
  // Most editor flows are stateful; running tests serially keeps them predictable.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  timeout: 30_000,

  use: {
    baseURL: origin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    command: `npm exec vite -- --host localhost --port ${port} --strictPort`,
    url: origin,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
})
