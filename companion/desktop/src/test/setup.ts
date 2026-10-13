// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import "@testing-library/jest-dom/vitest";
import { clearMocks } from "@tauri-apps/api/mocks";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

import { setPlatformForTests } from "../platform/platform";
import { resetHomeViewForTests } from "../screens/home/use-home-view";
import { resetLayersForTests } from "../shell/layers";
import { resetNavigationForTests } from "../shell/navigation";
import { resetDaemonStreamForTests } from "../stores/daemon-stream";

// The screen suites were written against the macOS copy; a test pins another platform itself.
beforeEach(() => setPlatformForTests("macos"));

afterEach(() => {
  // Node-environment suites (the eslint rule tests) have no DOM to clean.
  if (typeof window === "undefined") return;
  cleanup();
  resetDaemonStreamForTests();
  resetNavigationForTests();
  resetLayersForTests();
  resetHomeViewForTests();
  clearMocks();
  vi.unstubAllGlobals();
});
