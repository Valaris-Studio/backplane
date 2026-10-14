// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export const LOGIN_PATH = "/login";

// The axios interceptor runs outside React, so it cannot read the auth-modes
// query. useAuthModes publishes the answer here once it resolves; until then
// this stays false and a 403 is surfaced to the caller as an ordinary error.
let loginAvailable = false;

export function setLoginAvailable(enabled: boolean): void {
  loginAvailable = enabled;
}

export function isLoginAvailable(): boolean {
  return loginAvailable;
}

// Only a deployment that owns its sessions (OIDC or local password) can act on
// session rejection by showing a login page. A permission denial cannot be
// repaired by signing in again, even when the deployment owns its login.
// Behind IAP or an authenticating proxy, sign-in happens upstream.
export function shouldRedirectToLogin(
  status: number,
  { loginAvailable, errorCode }: { loginAvailable: boolean; errorCode?: string },
): boolean {
  if (!loginAvailable) return false;
  return status === 401 || (status === 403 && (
    errorCode === "authentication_required" ||
    errorCode === "session_invalid" ||
    errorCode === "session_user_not_found"
  ));
}

const RETURN_KEY = "backplane.returnAfterSignIn";
// As long as a companion pairing code lives, plus slack for the sign-in itself.
const RETURN_TTL_MS = 15 * 60 * 1000;

export function redirectToLogin(): void {
  if (window.location.pathname === LOGIN_PATH) return;
  rememberReturnPath(window.location.pathname + withoutPairingCode(window.location.search ?? ""));
  window.location.assign(LOGIN_PATH);
}

// A companion pairing code must never ride a URL back from sign-in (the
// pairing page carries it itself); strip the legacy `?code=` form.
function withoutPairingCode(search: string): string {
  if (window.location.pathname !== "/companion/pair") return search;
  const params = new URLSearchParams(search);
  params.delete("code");
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

function rememberReturnPath(path: string): void {
  try {
    window.sessionStorage.setItem(RETURN_KEY, JSON.stringify({ path, savedAt: Date.now() }));
  } catch {
    // Storage unavailable (private mode): sign-in still works, it lands on home.
  }
}

// Same-origin paths only: "//host" and "/\host" are protocol-relative URLs.
function isInAppPath(path: unknown): path is string {
  return typeof path === "string" && path.startsWith("/") && !/^\/[/\\]/.test(path);
}

/** The page that sent the person to sign in, once, if recent and in-app. */
export function takeReturnPath(): string | null {
  try {
    const saved = window.sessionStorage.getItem(RETURN_KEY);
    window.sessionStorage.removeItem(RETURN_KEY);
    if (!saved) return null;
    const { path, savedAt } = JSON.parse(saved) as { path?: unknown; savedAt?: unknown };
    const fresh = typeof savedAt === "number" && Date.now() - savedAt < RETURN_TTL_MS;
    return fresh && isInAppPath(path) && path !== LOGIN_PATH ? path : null;
  } catch {
    return null;
  }
}

// Set once sign-in hands the person back to a page, so that page can tell a
// return from sign-in from a fresh visit (e.g. to refill a carried pairing
// code only for the former). The page forgets it once read.
const RETURNED_KEY = "backplane.returnedFromSignIn";

export function markReturnedFromSignIn(path: string): void {
  try {
    window.sessionStorage.setItem(RETURNED_KEY, path.split(/[?#]/, 1)[0] ?? path);
  } catch {
    // Storage unavailable: the page treats it as a fresh visit.
  }
}

export function returnedFromSignInTo(pathname: string): boolean {
  try {
    return window.sessionStorage.getItem(RETURNED_KEY) === pathname;
  } catch {
    return false;
  }
}

export function forgetReturnedFromSignIn(): void {
  try {
    window.sessionStorage.removeItem(RETURNED_KEY);
  } catch {
    // Nothing was marked.
  }
}
