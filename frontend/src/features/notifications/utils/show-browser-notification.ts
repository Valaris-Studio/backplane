// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Fires an OS-level notification for an arriving live notification, with
// white-label GENERIC copy (the rich per-category sentence stays in the in-app
// inbox; INV-5 keeps display strings in i18n). Pure + defensive so it can run
// straight inside the WS handler without the React hook's state.
//
// Guards (all must hold, else no-op):
//   - the API is supported and permission is granted
//   - the user opted in on this device (localStorage flag — mirror of the hook)
//   - the tab is NOT currently focused — a focused tab already shows the in-app
//     toast + badge, so an OS notification would be redundant noise.
//
// DIAGNOSTIC (temporary): the path used to swallow every miss silently, which
// made a prod "OS toast never fires" report un-debuggable. Each early-return and
// the construction exception now log a one-line reason under a grep-able prefix.
// Remove once the prod root cause is confirmed.

const STORAGE_KEY = "valaris-browser-notifications-enabled";
const DIAG = "[valaris:browser-notification]";

export interface BrowserNotificationCopy {
  title: string;
  body: string;
  /** Deep-link path to focus/open when the notification is clicked. */
  url?: string;
}

export function showBrowserNotification(copy: BrowserNotificationCopy): void {
  // Guard on the VALUE, not just the key: some environments (and test stubs)
  // define `window.Notification` as undefined, so `"Notification" in window` is
  // true while `Notification.permission` would throw.
  if (typeof window === "undefined" || typeof window.Notification === "undefined") {
    console.warn(`${DIAG} skip: Notification API unsupported in this context`);
    return;
  }
  if (Notification.permission !== "granted") {
    console.warn(
      `${DIAG} skip: permission is "${Notification.permission}", not "granted"`,
    );
    return;
  }
  const optIn = window.localStorage.getItem(STORAGE_KEY);
  if (optIn !== "true") {
    console.warn(
      `${DIAG} skip: device opt-in flag is ${JSON.stringify(optIn)}, not "true" ` +
        `(toggle "Browser notifications" ON in this browser profile)`,
    );
    return;
  }
  // Don't double-notify a user who is already looking at the app.
  if (typeof document !== "undefined" && document.visibilityState === "visible") {
    console.warn(`${DIAG} skip: tab is visible (in-app toast suffices)`);
    return;
  }

  try {
    const notification = new Notification(copy.title, {
      body: copy.body,
      // A per-target tag (not a single static one) so two notifications about
      // the SAME entity coalesce, but distinct events don't silently replace one
      // another — a shared static tag made a second arrival overwrite the first.
      tag: copy.url ?? "valaris-notification",
      icon: "/brand/icon-192.png",
      // Keep the toast on screen until the user acts on it. A backgrounded user
      // returning to the machine still sees it instead of finding it auto-
      // dismissed after a few seconds.
      requireInteraction: true,
    });
    console.info(`${DIAG} fired OS notification`, { title: copy.title, url: copy.url });
    notification.onerror = (e) =>
      console.warn(`${DIAG} Notification onerror fired`, e);
    notification.onclick = () => {
      window.focus();
      if (copy.url) window.location.assign(copy.url);
      notification.close();
    };
  } catch (err) {
    // Some browsers throw if constructed in a disallowed context (e.g. Chrome
    // for Android requires ServiceWorkerRegistration.showNotification). Surface
    // the exact error so a prod repro is conclusive; never let it break the
    // live-sync handler.
    console.warn(`${DIAG} new Notification() threw`, err);
  }
}
