// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// aria-busy alone is silent in VoiceOver, and changing a button's name breaks
// its identity for scripts and tests, so a busy action is spoken through one
// shared polite live region instead.

const WORKING_SUFFIX = ", working…";

let region: HTMLElement | null = null;
let pendingText: ReturnType<typeof setTimeout> | undefined;

/** The live region must exist before its text changes, or the change is not read. */
export function ensureBusyRegion(): HTMLElement {
  if (region?.isConnected) return region;
  region = document.createElement("div");
  region.className = "sr-only";
  region.setAttribute("aria-live", "polite");
  region.dataset.busyAnnouncer = "";
  document.body.append(region);
  return region;
}

export function announceBusy(label: string): void {
  const live = ensureBusyRegion();
  clearTimeout(pendingText);
  live.textContent = "";
  // A fresh text node after the clear, so the same label announces again.
  pendingText = setTimeout(() => {
    live.textContent = `${label.trim()}${WORKING_SUFFIX}`;
  }, 0);
}

export function clearBusyAnnouncement(): void {
  clearTimeout(pendingText);
  if (region) region.textContent = "";
}
