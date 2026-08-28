// The end-to-end suite drives the real UI in a browser. One command starts everything:
// `pnpm test:ui` brings up Vite itself and reuses a dev server that is already running.

import { defineConfig } from "@playwright/test";

const PORT = 1440;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests",
  // Run before anything else, because `reuseExistingServer` below means the server on the port may
  // belong to another checkout, and a suite that tests somebody else's code is worse than no suite.
  // What it checks and why it can check it by comparing bytes is in tests/identity.ts.
  globalSetup: "./tests/identity.ts",
  fullyParallel: true,
  // No retries on purpose. A test that only passes on the second go is a test that is lying about
  // something.
  retries: 0,
  reporter: [["list"]],
  // Traces and failure screenshots go somewhere already ignored, so a run cannot leave anything
  // behind for the next `git add` to pick up. The paths are printed with the failure that made
  // them.
  outputDir: "node_modules/.cache/playwright",
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: BASE_URL,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "en-GB",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  // Deliberately not `devices["Desktop Chrome"]`: that device pins a Windows user agent, and the
  // keymap reads the platform off the user agent to decide whether the primary modifier is Command
  // or Control. A faked platform would test the wrong half of every shortcut.
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],

  webServer: {
    command: "pnpm dev",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
