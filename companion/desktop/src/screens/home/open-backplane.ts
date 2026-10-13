// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { commands, type CompanionStatus } from "../../ipc/bindings";
import { callDaemon } from "../../ipc/daemon";
import { showToast } from "../../shell/layers";
import { statusStore } from "../../stores/daemon-stream";
import { boardLinkForSession, type SessionCapture } from "../../stores/projects";
import { useStoreSelector } from "../../stores/external-store";

/**
 * The web app's root. Contract v1.3: `endpoint` is the API origin and is only
 * the fallback when the account carries no web origin. The web has no session
 * or device pages yet (v1.6), so links without a board land here.
 */
function webRootUrl(status: CompanionStatus | null): string | null {
  const origin = status?.account?.web_origin ?? status?.endpoint;
  if (!origin) return null;
  try {
    return `${new URL(origin).origin}/`;
  } catch {
    return null;
  }
}

export function useWebRootUrl(): string | null {
  return useStoreSelector(statusStore, webRootUrl);
}

export function useServerHost(): string | null {
  return useStoreSelector(statusStore, (status) => {
    try {
      return status ? new URL(status.endpoint).host : null;
    } catch {
      return null;
    }
  });
}

/** The board that captured the session when one is known, else the web root. */
export function sessionLink(session: SessionCapture, webRootUrl: string | null): string | null {
  return boardLinkForSession(session) ?? webRootUrl;
}

export async function openInBackplane(url: string | null): Promise<void> {
  const result = url ? await callDaemon(() => commands.openBackplaneUrl(url)) : null;
  if (!result?.ok) showToast("Couldn’t open Backplane in your browser.", { tone: "error" });
}
