// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it } from "vitest";
import { api } from "@/lib/api";
import { resolveMediaSrc, toStoredMediaSrc } from "@/lib/media-src";

const STABLE_PATH = "/api/workspaces/acme/media/3f1c9a52-7d2e-4c1b-9a0e-2b7f5d6c8e91/shot%20one.png";
const LEGACY_SIGNED =
  "https://storage.googleapis.com/bucket/media/ws/obj/shot.png?X-Goog-Signature=abc";
const SPLIT_API_BASE = "https://api.example.test/api";

const originalBaseURL = api.defaults.baseURL;
afterEach(() => {
  api.defaults.baseURL = originalBaseURL;
});

describe("resolveMediaSrc", () => {
  it("is identity for a stable /api path when the API shares the app origin", () => {
    api.defaults.baseURL = "/api";
    expect(resolveMediaSrc(STABLE_PATH)).toBe(STABLE_PATH);
  });

  it("maps a stable /api path onto a split-origin API base", () => {
    api.defaults.baseURL = SPLIT_API_BASE;
    expect(resolveMediaSrc(STABLE_PATH)).toBe(
      "https://api.example.test/api/workspaces/acme/media/3f1c9a52-7d2e-4c1b-9a0e-2b7f5d6c8e91/shot%20one.png",
    );
  });

  it("leaves legacy signed URLs and foreign images untouched (no client re-signing)", () => {
    api.defaults.baseURL = SPLIT_API_BASE;
    expect(resolveMediaSrc(LEGACY_SIGNED)).toBe(LEGACY_SIGNED);
    expect(resolveMediaSrc("https://cdn.example.org/x.png")).toBe("https://cdn.example.org/x.png");
  });

  it("does not treat a look-alike prefix as an API path", () => {
    api.defaults.baseURL = SPLIT_API_BASE;
    expect(resolveMediaSrc("/apis/thing.png")).toBe("/apis/thing.png");
    expect(resolveMediaSrc("//evil.test/api/x.png")).toBe("//evil.test/api/x.png");
  });

  it("passes empty values through", () => {
    expect(resolveMediaSrc(null)).toBeNull();
    expect(resolveMediaSrc("")).toBe("");
  });
});

describe("toStoredMediaSrc — inverse of resolveMediaSrc", () => {
  it("strips a split-origin API base back to the relative stable path", () => {
    api.defaults.baseURL = SPLIT_API_BASE;
    expect(toStoredMediaSrc(resolveMediaSrc(STABLE_PATH))).toBe(STABLE_PATH);
  });

  it("is identity on a shared origin and for anything not under the API base", () => {
    api.defaults.baseURL = "/api";
    expect(toStoredMediaSrc(STABLE_PATH)).toBe(STABLE_PATH);
    api.defaults.baseURL = SPLIT_API_BASE;
    expect(toStoredMediaSrc(LEGACY_SIGNED)).toBe(LEGACY_SIGNED);
    expect(toStoredMediaSrc("https://api.example.test/apix/a.png")).toBe(
      "https://api.example.test/apix/a.png",
    );
  });
});
