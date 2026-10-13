// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import type { BoardsOverview } from "../../ipc/bindings";
import { createBoardUrl } from "./create-board-url";

const ORIGIN = "https://app.bp.example.dev";
const oneWorkspace = (slug: string): BoardsOverview => ({ workspaces: [{ id: "w", slug, name: "W", boards: [] }] });

describe("createBoardUrl", () => {
  it("lands on the only workspace's boards page", () => {
    expect(createBoardUrl(ORIGIN, oneWorkspace("fresh"))).toBe(`${ORIGIN}/fresh/boards`);
  });

  it("lands on the web root with several workspaces, none, or no catalog yet", () => {
    const two: BoardsOverview = { workspaces: [...oneWorkspace("a").workspaces, ...oneWorkspace("b").workspaces] };
    expect(createBoardUrl(ORIGIN, two)).toBe(`${ORIGIN}/`);
    expect(createBoardUrl(ORIGIN, { workspaces: [] })).toBe(`${ORIGIN}/`);
    expect(createBoardUrl(ORIGIN, null)).toBe(`${ORIGIN}/`);
  });

  const slugsThatStayOneSegment: [string, string, string][] = [
    ["a slash", "a/b", `${ORIGIN}/a%2Fb/boards`],
    ["a backslash", "a\\b", `${ORIGIN}/a%5Cb/boards`],
    ["an encoded dot-dot", "%2e%2e", `${ORIGIN}/%252e%252e/boards`],
    ["a query breakout", "x?next=https://evil.example", `${ORIGIN}/x%3Fnext%3Dhttps%3A%2F%2Fevil.example/boards`],
    ["a hash breakout", "x#frag", `${ORIGIN}/x%23frag/boards`],
    ["a unicode lookalike", "ｅvil", `${ORIGIN}/%EF%BD%85vil/boards`],
  ];

  it.each(slugsThatStayOneSegment)("keeps a slug with %s inside one path segment on the web origin", (_label, slug, expected) => {
    const url = createBoardUrl(ORIGIN, oneWorkspace(slug));
    expect(url).toBe(expected);
    const parsed = new URL(url ?? "");
    expect(parsed.origin).toBe(ORIGIN);
    expect(parsed.search).toBe("");
    expect(parsed.hash).toBe("");
    expect(parsed.pathname.split("/").filter(Boolean)).toHaveLength(2);
  });

  it("keeps a very long slug as one segment", () => {
    const slug = "w".repeat(5000);
    expect(createBoardUrl(ORIGIN, oneWorkspace(slug))).toBe(`${ORIGIN}/${slug}/boards`);
  });

  it.each(["", ".", ".."])("falls back to the web root for the slug %j, which is no path segment", (slug) => {
    expect(createBoardUrl(ORIGIN, oneWorkspace(slug))).toBe(`${ORIGIN}/`);
  });

  it("uses only the web origin's scheme, host and port", () => {
    expect(createBoardUrl("https://app.bp.example.dev/some/path?q=1#h", oneWorkspace("fresh"))).toBe(`${ORIGIN}/fresh/boards`);
    expect(createBoardUrl("https://app.bp.example.dev/", null)).toBe(`${ORIGIN}/`);
    expect(createBoardUrl("https://app.bp.example.dev:8443", null)).toBe("https://app.bp.example.dev:8443/");
  });

  it("drops userinfo from the web origin", () => {
    expect(createBoardUrl("https://user:secret@app.bp.example.dev", null)).toBe(`${ORIGIN}/`);
  });

  it("builds nothing without a parsable web origin", () => {
    expect(createBoardUrl(null, oneWorkspace("fresh"))).toBeNull();
    expect(createBoardUrl(undefined, null)).toBeNull();
    expect(createBoardUrl("", null)).toBeNull();
    expect(createBoardUrl("not a url", null)).toBeNull();
  });

  // The Rust opener refuses anything but https on the connected origin; this only builds the link.
  it("keeps a non-https origin's scheme for the opener to refuse", () => {
    expect(createBoardUrl("http://app.bp.example.dev", null)).toBe("http://app.bp.example.dev/");
  });
});
