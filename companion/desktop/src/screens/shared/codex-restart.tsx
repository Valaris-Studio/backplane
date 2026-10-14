// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { ReactNode } from "react";

import { CommandChip } from "../../components/CommandChip";
import { platformCopy } from "../../platform/copy";

// The daemon's problem codes for a Codex app-server that started before the
// Companion installed or changed Codex's hooks, so it has not loaded them.
export const APP_RESTART = "restart_required";
export const DAEMON_RESTART = "daemon_restart_required";

export type CodexRestart = typeof APP_RESTART | typeof DAEMON_RESTART;

export const DAEMON_RESTART_COMMAND = "codex app-server daemon restart";

/** The app wins over its background server: quitting the app is the step users know. */
export function codexRestart(problems: readonly string[] | null | undefined): CodexRestart | null {
  if (problems?.includes(APP_RESTART)) return APP_RESTART;
  if (problems?.includes(DAEMON_RESTART)) return DAEMON_RESTART;
  return null;
}

export const RESTART_STEPS_LABEL: Record<CodexRestart, string> = {
  [APP_RESTART]: "How to restart Codex",
  [DAEMON_RESTART]: "How to restart Codex’s app server",
};

export const RESTART_STEPS: Record<CodexRestart, readonly ReactNode[]> = {
  // A getter: the quit step names the platform's shortcut, known only once the platform is.
  get [APP_RESTART]() {
    return [platformCopy().quitCodexStep, "Open Codex again."];
  },
  [DAEMON_RESTART]: [
    <>
      In a terminal, run <CommandChip command={DAEMON_RESTART_COMMAND} punctuation="." />
    </>,
  ],
};
