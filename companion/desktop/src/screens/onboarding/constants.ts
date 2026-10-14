// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// No server is built in: the user types the address their team uses. A
// development or test build may prefill one through VITE_COMPANION_SERVER_URL.
export function prefilledServer(): string {
  return import.meta.env.VITE_COMPANION_SERVER_URL ?? "";
}

// First-run completion is UI-only (the daemon has no notion of it), so it lives in the webview.
export const ONBOARDING_FINISHED_KEY = "backplane.companion.onboarding.finished";
