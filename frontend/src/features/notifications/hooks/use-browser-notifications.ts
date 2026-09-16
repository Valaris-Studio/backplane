// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useState } from "react";

// Device-local browser-notification preference + OS permission state. Browser
// notifications are inherently per-device (a granted permission and the user's
// "yes I want OS pings on THIS machine" choice don't travel with the account),
// so the enabled flag lives in localStorage, NOT in the server-side per-user
// prefs. The server prefs still gate WHICH categories generate a notification
// at all; this only governs whether an already-delivered live notification also
// surfaces as an OS-level toast on this device.

const STORAGE_KEY = "valaris-browser-notifications-enabled";

export type BrowserPermission =
  | "granted"
  | "denied"
  | "default"
  | "unsupported";

function readPermission(): BrowserPermission {
  // Guard on the value, not just the key — `window.Notification` can be defined
  // as undefined in some environments / test stubs.
  if (typeof window === "undefined" || typeof window.Notification === "undefined") {
    return "unsupported";
  }
  return Notification.permission as BrowserPermission;
}

function readEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(STORAGE_KEY) === "true";
}

export interface BrowserNotificationsState {
  /** OS-level permission for this origin. */
  permission: BrowserPermission;
  /** The user's per-device opt-in (independent of the OS grant). */
  enabled: boolean;
  /** True when notifications can actually fire: supported + granted + opted-in. */
  active: boolean;
  supported: boolean;
  /** Flip the device opt-in. Turning ON requests OS permission if not yet granted. */
  setEnabled: (next: boolean) => Promise<void>;
}

export function useBrowserNotifications(): BrowserNotificationsState {
  const [permission, setPermission] = useState<BrowserPermission>(readPermission);
  const [enabled, setEnabledState] = useState<boolean>(readEnabled);

  // Re-sync the permission when the tab regains focus — the user may have
  // changed it in site settings while away, and there's no permission event.
  useEffect(() => {
    const sync = () => setPermission(readPermission());
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, []);

  const setEnabled = useCallback(async (next: boolean) => {
    if (!next) {
      window.localStorage.setItem(STORAGE_KEY, "false");
      setEnabledState(false);
      return;
    }
    // Turning ON: ensure OS permission. requestPermission MUST be called from a
    // user gesture (the toggle click is one). A denied/blocked permission can't
    // be re-prompted programmatically — the UI surfaces guidance instead.
    let perm = readPermission();
    if (perm === "default") {
      try {
        perm = (await Notification.requestPermission()) as BrowserPermission;
      } catch {
        perm = readPermission();
      }
      setPermission(perm);
    }
    // Only persist the opt-in if permission actually landed granted; otherwise
    // leave it off so the toggle reflects reality (no silent "on but blocked").
    const ok = perm === "granted";
    window.localStorage.setItem(STORAGE_KEY, ok ? "true" : "false");
    setEnabledState(ok);
  }, []);

  const supported = permission !== "unsupported";
  const active = supported && permission === "granted" && enabled;

  return { permission, enabled, active, supported, setEnabled };
}
