// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  shouldRedirectToLogin,
  redirectToLogin,
  takeReturnPath,
  LOGIN_PATH,
  markReturnedFromSignIn,
  returnedFromSignInTo,
  forgetReturnedFromSignIn,
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
      value: { assign: vi.fn(), pathname: "/acme/boards", search: "", href: "" },
    });
    window.sessionStorage.clear();
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

describe("return after sign-in", () => {
  const original = window.location;

  function visit(pathname: string, search = "") {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { assign: vi.fn(), pathname, search, href: "" },
    });
  }

  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => {
    Object.defineProperty(window, "location", { configurable: true, value: original });
    vi.useRealTimers();
  });

  it("returns to the page, query included, that sent the person to sign in", () => {
    visit("/acme/boards", "?view=list");
    redirectToLogin();
    expect(takeReturnPath()).toBe("/acme/boards?view=list");
  });

  it("never carries a pairing code in the return URL", () => {
    visit("/companion/pair", "?code=BCDF-GHJK&x=1");
    redirectToLogin();
    expect(takeReturnPath()).toBe("/companion/pair?x=1");
  });

  it("returns only once", () => {
    visit("/companion/pair", "?code=BCDF-GHJK");
    redirectToLogin();
    takeReturnPath();
    expect(takeReturnPath()).toBeNull();
  });

  it("forgets a return path older than a pairing code lives", () => {
    vi.useFakeTimers();
    visit("/companion/pair", "?code=BCDF-GHJK");
    redirectToLogin();
    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(takeReturnPath()).toBeNull();
  });

  it("never returns off-site", () => {
    window.sessionStorage.setItem(
      "backplane.returnAfterSignIn",
      JSON.stringify({ path: "//evil.example/steal", savedAt: Date.now() }),
    );
    expect(takeReturnPath()).toBeNull();
    window.sessionStorage.setItem(
      "backplane.returnAfterSignIn",
      JSON.stringify({ path: "https://evil.example/", savedAt: Date.now() }),
    );
    expect(takeReturnPath()).toBeNull();
  });

  it("has nothing to return to without a redirect", () => {
    expect(takeReturnPath()).toBeNull();
  });
});

describe("the returned-from-sign-in marker", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("names only the page sign-in returned to, until it is forgotten", () => {
    markReturnedFromSignIn("/companion/pair?x=1");
    expect(returnedFromSignInTo("/companion/pair")).toBe(true);
    expect(returnedFromSignInTo("/companion/pair")).toBe(true);
    expect(returnedFromSignInTo("/acme/boards")).toBe(false);
    forgetReturnedFromSignIn();
    expect(returnedFromSignInTo("/companion/pair")).toBe(false);
  });

  it("is absent when nothing returned from sign-in", () => {
    expect(returnedFromSignInTo("/companion/pair")).toBe(false);
  });
});
