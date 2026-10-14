// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { getCurrentWindow } from "@tauri-apps/api/window";

import { currentPlatform } from "../platform/platform";

/**
 * The popover has no title bar, so its header moves the window. Rather than
 * Tauri's `data-tauri-drag-region`, which only fires when the pressed element
 * itself carries the attribute, a press anywhere inside `[data-window-drag]`
 * drags, unless it lands on a control or inside `[data-no-window-drag]`.
 */
const NOT_A_DRAG_HANDLE = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "[contenteditable]",
  "[role=button]",
  "[role=link]",
  "[role=tab]",
  "[role=switch]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=menuitem]",
  "[role=option]",
  "[role=slider]",
  "[role=combobox]",
  "[role=menuitemcheckbox]",
  "[role=menuitemradio]",
  "[role=treeitem]",
  "[role=spinbutton]",
  "[role=textbox]",
  "[role=searchbox]",
  "[role=gridcell]",
  // Anything reachable by Tab is something to press, not a handle.
  '[tabindex]:not([tabindex="-1"])',
  "[data-no-window-drag]",
].join(",");

const PRIMARY_BUTTON = 0;

function onMouseDown(event: MouseEvent) {
  // A second press of a double click would restart the drag; maximize is off anyway.
  if (event.button !== PRIMARY_BUTTON || event.detail > 1 || event.defaultPrevented) return;
  if (!(event.target instanceof Element)) return;
  if (!event.target.closest("[data-window-drag]") || event.target.closest(NOT_A_DRAG_HANDLE)) return;
  // Without this the press would start a text selection under the moving window.
  event.preventDefault();
  void startDragging();
}

/** A failed drag leaves the window where it is; nothing to report. */
async function startDragging() {
  try {
    await getCurrentWindow().startDragging();
  } catch {
    // Outside Tauri (a plain browser) there is no window to move.
  }
}

/**
 * One document listener for every drag region; returns the matching uninstall.
 * Not on Linux: the window there has a native title bar, and an X11 window
 * manager can leave a client-started move stuck to the cursor.
 */
export function installWindowDrag(): () => void {
  if (currentPlatform().os === "linux") return () => undefined;
  document.addEventListener("mousedown", onMouseDown);
  return () => document.removeEventListener("mousedown", onMouseDown);
}
