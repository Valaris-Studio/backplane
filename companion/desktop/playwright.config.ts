// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { defineConfig, devices } from "@playwright/test";

const HARNESS_PORT = 4173;

// WebKit is the engine WKWebView runs, so it is the only browser that matters.
export default defineConfig({
  testDir: "./e2e/visual",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${HARNESS_PORT}`,
    colorScheme: "light",
    viewport: { width: 360, height: 540 },
  },
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.01 },
  },
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 360, height: 540 } } }],
  webServer: {
    command: `pnpm exec vite --port ${HARNESS_PORT} --strictPort`,
    url: `http://localhost:${HARNESS_PORT}/e2e/harness/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
