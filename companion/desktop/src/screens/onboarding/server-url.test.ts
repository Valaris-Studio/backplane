// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { serverHost, validateServerUrl } from "./server-url";

const RELEASE = { allowLoopbackHttp: false };
const DEV = { allowLoopbackHttp: true };

describe("validateServerUrl", () => {
  it("accepts an https URL and sends it normalised, like the daemon", () => {
    expect(validateServerUrl("  https://backplane.northwind.dev  ", RELEASE)).toEqual({ ok: true, url: "https://backplane.northwind.dev" });
    expect(validateServerUrl("HTTPS://Backplane.Example.dev/", RELEASE)).toEqual({ ok: true, url: "https://backplane.example.dev" });
  });

  it("keeps a port and a path", () => {
    expect(validateServerUrl("https://bp.example.dev:8443/api", RELEASE)).toEqual({ ok: true, url: "https://bp.example.dev:8443/api" });
  });

  it("rejects an empty address", () => {
    expect(validateServerUrl("   ", RELEASE)).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects plain http and an address without a scheme", () => {
    expect(validateServerUrl("http://backplane.example.dev", RELEASE)).toEqual({ ok: false, reason: "not_https" });
    expect(validateServerUrl("backplane.example.dev", RELEASE)).toEqual({ ok: false, reason: "not_https" });
  });

  it("rejects an https prefix that is not a valid URL", () => {
    expect(validateServerUrl("https://", RELEASE)).toEqual({ ok: false, reason: "invalid" });
    expect(validateServerUrl("https://exa mple.dev", RELEASE)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects credentials, a query or a fragment, as the daemon does", () => {
    expect(validateServerUrl("https://user:secret@backplane.example.dev", RELEASE)).toEqual({ ok: false, reason: "invalid" });
    expect(validateServerUrl("https://backplane.example.dev/?team=a", RELEASE)).toEqual({ ok: false, reason: "extras" });
    expect(validateServerUrl("https://backplane.example.dev/#pair", RELEASE)).toEqual({ ok: false, reason: "extras" });
  });

  it("rejects a host with an empty label", () => {
    expect(validateServerUrl("https://backplane..example.dev", RELEASE)).toEqual({ ok: false, reason: "invalid" });
  });

  it("allows plain http to a literal loopback IP only in development", () => {
    expect(validateServerUrl("http://127.0.0.1:8000", DEV)).toEqual({ ok: true, url: "http://127.0.0.1:8000" });
    expect(validateServerUrl("http://[::1]:8000/", DEV)).toEqual({ ok: true, url: "http://[::1]:8000" });
    expect(validateServerUrl("http://127.0.0.1:8000", RELEASE)).toEqual({ ok: false, reason: "not_https" });
  });

  it("never allows plain http to localhost or another host, even in development", () => {
    expect(validateServerUrl("http://localhost:8000", DEV)).toEqual({ ok: false, reason: "not_https" });
    expect(validateServerUrl("http://10.0.0.5:8000", DEV)).toEqual({ ok: false, reason: "not_https" });
  });
});

describe("serverHost", () => {
  it("names a server by its host", () => {
    expect(serverHost("https://backplane.example.dev")).toBe("backplane.example.dev");
    expect(serverHost("https://bp.example.dev:8443/api")).toBe("bp.example.dev:8443");
  });

  it("falls back to the raw text for something that is not a URL", () => {
    expect(serverHost("not a url")).toBe("not a url");
  });
});
