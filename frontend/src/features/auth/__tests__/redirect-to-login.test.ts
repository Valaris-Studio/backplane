// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  shouldRedirectToLogin,
  redirectToLogin,
  LOGIN_PATH,
} from "../redirect-to-login";

describe("shouldRedirectToLogin", () => {
  it("does not redirect an authorization 403 even with app-owned login", () => {
    expect(shouldRedirectToLogin(403, { loginAvailable: true })).toBe(false);
  });

  it("redirects on 401 as well", () => {
    expect(shouldRedirectToLogin(401, { loginAvailable: true })).toBe(true);
  });

  it("does nothing when sign-in is handled upstream", () => {
    // Behind IAP/proxy a 403 means 'not a member', not 'not signed in' —
    // bouncing to /login would loop against an endpoint that cannot help.
    expect(shouldRedirectToLogin(403, { loginAvailable: false })).toBe(false);
  });

  it("ignores non-auth failures", () => {
    expect(shouldRedirectToLogin(404, { loginAvailable: true })).toBe(false);
    expect(shouldRedirectToLogin(500, { loginAvailable: true })).toBe(false);
    expect(shouldRedirectToLogin(0, { loginAvailable: true })).toBe(false);
  });
});

describe("redirectToLogin", () => {
  const original = window.location;

  beforeEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { assign: vi.fn(), pathname: "/acme/boards", href: "" },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: original,
    });
  });

  it("sends the browser to the login page", () => {
    redirectToLogin();
    expect(window.location.assign).toHaveBeenCalledWith(LOGIN_PATH);
  });

  it("does not redirect again when already on the login page", () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { assign: vi.fn(), pathname: LOGIN_PATH, href: "" },
    });
    redirectToLogin();
    expect(window.location.assign).not.toHaveBeenCalled();
  });
});
