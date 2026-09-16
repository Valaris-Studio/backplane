// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { toast } from "sonner";
import i18n from "@/i18n/config";

// navigator.clipboard is undefined on non-secure-context origins (plain HTTP,
// e.g. a self-hosted instance at http://192.168.1.50:8080) — feature-detect the
// object itself rather than window.isSecureContext.
async function copyViaClipboardApi(text: string): Promise<boolean> {
  if (!navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function copyViaExecCommand(text: string): boolean {
  const previouslyFocused = document.activeElement as HTMLElement | null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  // Keep it out of the viewport/tab order without triggering scroll-into-view.
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
    previouslyFocused?.focus();
  }
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (await copyViaClipboardApi(text)) return true;
  if (copyViaExecCommand(text)) return true;

  toast.error(i18n.t("common.clipboard.manualCopyError"));
  return false;
}
