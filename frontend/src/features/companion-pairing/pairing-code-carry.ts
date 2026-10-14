// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { normalizeUserCode } from "./user-code";

// The code arrives in a URL fragment, which the page removes at once and which
// no server ever sees; sign-in is a full-page round trip, so the code waits
// here (this tab only) instead of in any URL. Same window as the return path.
const CARRY_KEY = "backplane.pairingCodeAfterSignIn";
const CARRY_TTL_MS = 15 * 60 * 1000;

// Carrying the same code again keeps its first time, so re-renders never
// stretch the window past 15 minutes; a different code starts its own.
export function carryPairingCode(code: string): void {
  try {
    const carried = readCarried();
    if (carried?.code === code) return;
    window.sessionStorage.setItem(CARRY_KEY, JSON.stringify({ code, savedAt: Date.now() }));
  } catch {
    // Storage unavailable: the person retypes the code after signing in.
  }
}

export function forgetCarriedPairingCode(): void {
  try {
    window.sessionStorage.removeItem(CARRY_KEY);
  } catch {
    // Nothing was carried.
  }
}

// Reading does not consume: render may run twice (StrictMode), and the page
// forgets the code itself once the person is done with it.
export function readCarriedPairingCode(): string | null {
  try {
    return readCarried()?.code ?? null;
  } catch {
    return null;
  }
}

function readCarried(): { code: string } | null {
  const saved = window.sessionStorage.getItem(CARRY_KEY);
  if (!saved) return null;
  const { code, savedAt } = JSON.parse(saved) as { code?: unknown; savedAt?: unknown };
  const fresh = typeof savedAt === "number" && Date.now() - savedAt < CARRY_TTL_MS;
  const valid = fresh && typeof code === "string" ? normalizeUserCode(code) : null;
  return valid ? { code: valid } : null;
}
