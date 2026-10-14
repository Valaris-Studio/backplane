// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { loadPlatform } from "./platform/platform";
import { trackPopoverVisibility } from "./shell/popover-visibility";
import { installWindowDrag } from "./shell/window-drag";
import { startDaemonStream } from "./stores/daemon-stream";
import { startSessionEnrichment } from "./stores/sessions";
import "./styles/app.css";

// Smoke-test builds only (`vite build --mode e2e`); dead code everywhere else.
if (import.meta.env.MODE === "e2e") {
  await import("@wdio/tauri-plugin");
}

// Before anything can produce copy, so no Mac wording shows on another platform (or the reverse).
await loadPlatform();

// Module scope, not an effect: one subscription per page, immune to StrictMode double-mounts.
startDaemonStream();
trackPopoverVisibility();
installWindowDrag();
startSessionEnrichment();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
