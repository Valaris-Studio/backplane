// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { fileURLToPath } from "node:url";

import type { TauriCapabilities } from "@wdio/tauri-service";

import { startFakeDaemon, type FakeDaemon } from "./e2e/smoke/fake-daemon";

// Built by `pnpm build:smoke-app`: a debug binary with the e2e-webdriver
// feature, in its own target dir so it never replaces a regular debug build.
const SMOKE_APP = fileURLToPath(
  new URL("./src-tauri/target/e2e/debug/backplane-companion-desktop", import.meta.url),
);

const smokeAppCapabilities: TauriCapabilities = {
  browserName: "tauri",
  "tauri:options": { application: SMOKE_APP },
};

let fakeDaemon: FakeDaemon | undefined;

export const config: WebdriverIO.Config = {
  runner: "local",
  tsConfigPath: "./e2e/smoke/tsconfig.json",
  specs: ["./e2e/smoke/**/*.e2e.ts"],
  maxInstances: 1,
  capabilities: [smokeAppCapabilities],
  services: [["@wdio/tauri-service", { driverProvider: "embedded" }]],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 90_000 },
  logLevel: "warn",
  outputDir: "./wdio-logs",
  // The app inherits this process's environment: point it at the fake daemon
  // and a throwaway HOME so nothing under the real home directory is touched.
  onPrepare: async () => {
    fakeDaemon = await startFakeDaemon();
    process.env.BACKPLANE_COMPANION_HOME = fakeDaemon.dataDir;
    process.env.HOME = fakeDaemon.homeDir;
  },
  onComplete: async () => {
    await fakeDaemon?.stop();
  },
};
