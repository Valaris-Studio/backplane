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

export function redirectToLogin(): void {
  if (window.location.pathname === LOGIN_PATH) return;
  window.location.assign(LOGIN_PATH);
}
