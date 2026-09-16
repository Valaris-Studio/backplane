// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineConfig, devices } from "@playwright/test";

// No `webServer` block by design: this gate is an ACCEPTANCE check run against
// an already-running stack (`make dev` — frontend 5173 + backend 8000), not a
// self-contained suite. Letting Playwright boot its own server would test a
// different build than the one being accepted, and the console-cleanliness
// signal is only meaningful against the real dev stack (Vite dev mode is where
// React StrictMode double-mounts and dev-only warnings surface at all).
export default defineConfig({
  testDir: "./e2e",
  // Flows mutate shared server state (workspaces/boards), and the console
  // collector attributes messages to whichever flow is running.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0, // a retry would mask console-error flakiness, which is the signal
  reporter: [["list"]],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.BACKPLANE_E2E_BASE_URL ?? "http://localhost:5173",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
