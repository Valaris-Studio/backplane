// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useEffect, useState } from "react";

import type { CompanionError } from "../../ipc/errors";
import { platformCopy } from "../../platform/copy";
import { KEYCHAIN_UNAVAILABLE, PAIRING_FAILED_EXPLANATION, errorCode, isDaemonDown } from "./daemon-messages";
import type { CodeState } from "./onboarding-store";

// Shared by onboarding's code step and Settings' Switch server sheet.

const COUNTDOWN_TICK_MS = 1000;

export function formatCountdown(remainingMs: number): string {
  const seconds = Math.ceil(remainingMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** A settled pairing the stream announced; pending changes nothing, connected is handled by the caller. */
export function codeStateForPairingEvent(state: string): CodeState | null {
  switch (state) {
    case "denied":
      return { kind: "denied" };
    case "expired":
      return { kind: "expired" };
    case "failed":
      return { kind: "failed", ...PAIRING_FAILED_EXPLANATION };
    default:
      return null;
  }
}

/** What a failed poll means for the code card; null when the daemon itself is gone. */
export function codeStateForPollError(error: CompanionError): CodeState | null {
  if (isDaemonDown(error)) return null;
  switch (errorCode(error)) {
    case "pairing_pending":
      return { kind: "waiting" };
    case "server_unreachable":
      return { kind: "offline" };
    case "pairing_expired":
      return { kind: "expired" };
    case "pairing_denied":
      return { kind: "denied" };
    case KEYCHAIN_UNAVAILABLE:
      return { kind: "failed", ...platformCopy().credentialStore };
    case "not_found":
      return { kind: "failed", title: "This code is no longer valid", body: "A newer pairing replaced it, or Companion restarted. Get a new code to carry on." };
    default:
      return { kind: "failed", ...PAIRING_FAILED_EXPLANATION };
  }
}
