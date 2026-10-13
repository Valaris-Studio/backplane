// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Dev-server-only primitives gallery for visual baselines; `vite build`
// never sees it (its only input is the app's index.html).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { MotionProvider } from "../../../src/motion/MotionProvider";
import { setPlatformForTests } from "../../../src/platform/platform";
import { DialogScene, Primitives, SheetScene } from "./scenes";
import "../../../src/styles/app.css";
import "../backdrop.css";

const SCENES = { primitives: Primitives, sheet: SheetScene, dialog: DialogScene };
const requested = new URLSearchParams(location.search).get("scene") ?? "primitives";
const Scene = SCENES[requested as keyof typeof SCENES] ?? Primitives;

// The baselines are the macOS rendering; components read their copy from the platform.
setPlatformForTests("macos");

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <MotionProvider>
      <Scene />
    </MotionProvider>
  </StrictMode>,
);
