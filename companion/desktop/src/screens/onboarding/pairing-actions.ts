// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { commands } from "../../ipc/bindings";
import { callDaemon } from "../../ipc/daemon";
import { hasErrorCode, type CompanionError } from "../../ipc/errors";
import { statusStore } from "../../stores/daemon-stream";
import {
  abandonPairing,
  beginPairing,
  isCurrentPairingAttempt,
  markConnected,
  claimPendingPairingCheck,
  nextPairingAttempt,
  onboardingStore,
  settlePairingAttempt,
  settlePendingPairingCheck,
  startPairingAttempt,
} from "./onboarding-store";

/** Starts (or restarts) pairing; resolves to the error the step should explain, or null when it moved on. */
export async function startPairing(endpoint: string, deviceName: string | null = null): Promise<CompanionError | null> {
  const attempt = startPairingAttempt();
  const result = await callDaemon(() => commands.pairStart(endpoint, deviceName, null));
  settlePairingAttempt(attempt);
  if (!isCurrentPairingAttempt(attempt)) {
    // The user left (Back) or started again meanwhile: nobody will show this code, so don't leave it approvable.
    if (result.ok) void callDaemon(() => commands.pairCancel(result.value.pairing_id));
    return null;
  }
  if (result.ok) {
    beginPairing(result.value, endpoint, deviceName);
    return null;
  }
  if (hasErrorCode(result.error, "already_connected")) {
    markConnected();
    return null;
  }
  return result.error;
}

/** A revoked device keeps its dead credential until it disconnects; clearing it lets a new pairing start. */
export async function disconnectThenPair(endpoint: string, deviceName: string | null = null): Promise<CompanionError | null> {
  const attempt = startPairingAttempt();
  const disconnected = await callDaemon(() => commands.disconnect());
  settlePairingAttempt(attempt);
  if (!isCurrentPairingAttempt(attempt)) return null;
  if (!disconnected.ok) return disconnected.error;
  return startPairing(endpoint, deviceName);
}

export function cancelPairing(): void {
  const pending = onboardingStore.get().pairing;
  abandonPairing();
  // Best effort: a pairing the daemon already forgot (expired, superseded) needs no cancel.
  if (pending) void callDaemon(() => commands.pairCancel(pending.ticket.pairing_id));
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * After a relaunch the webview forgets its code, but the daemon still holds
 * the pairing: pick it up again, unless the user has already moved on. Asked
 * until the daemon answers, since it may not be up yet at launch.
 */
export async function resumePendingPairing(): Promise<void> {
  const untouched = () => {
    const state = onboardingStore.get();
    return state.pairing === null && state.chosenStep === null && !state.connectedByDaemon;
  };
  if (!untouched() || !claimPendingPairingCheck()) return;
  const attempt = nextPairingAttempt();
  const result = await callDaemon(() => commands.pairCurrent());
  settlePendingPairingCheck(result.ok);
  if (!result.ok) return;
  const pending = result.value;
  if (!pending || statusStore.get()?.connected) return;
  if (!isCurrentPairingAttempt(attempt) || !untouched()) {
    // Nobody will show this code, so don't leave it approvable, unless it is the pairing the user started meanwhile.
    if (onboardingStore.get().pairing?.ticket.pairing_id !== pending.pairing_id) void callDaemon(() => commands.pairCancel(pending.pairing_id));
    return;
  }
  // v1.9: the approval page shares the pairing endpoint's origin, so it stands in when the daemon omits the endpoint.
  const endpoint = pending.endpoint ?? originOf(pending.verification_uri);
  if (endpoint) beginPairing(pending, endpoint);
}
