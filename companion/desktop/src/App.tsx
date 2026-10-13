// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { MotionProvider } from "./motion/MotionProvider";
import { AppShell } from "./shell/AppShell";

export function App() {
  return (
    <MotionProvider>
      <main className="relative flex h-full flex-col overflow-hidden rounded-window bg-material-popover shadow-[inset_0_0.5px_0_var(--material-edge)]">
        <AppShell />
      </main>
    </MotionProvider>
  );
}
