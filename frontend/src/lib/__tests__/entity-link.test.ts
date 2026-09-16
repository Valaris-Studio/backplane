// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { buildEntityLink } from "../entity-link";

const slug = "acme";

describe("buildEntityLink", () => {
  it("links a card via the canonical card deep-link grammar", () => {
    const r = buildEntityLink({ type: "card", id: "c1", slug, boardId: "b1" });
    expect(r).toEqual({
      href: "/acme/boards/b1/kanban?card=c1",
      external: false,
    });
  });

  it("links an execution to the runner execution route", () => {
    expect(buildEntityLink({ type: "execution", id: "e1", slug })).toEqual({
      href: "/acme/runner/executions/e1",
      external: false,
    });
  });

  it("links an agent to the runner detail route", () => {
    expect(buildEntityLink({ type: "agent", id: "a1", slug })).toEqual({
      href: "/acme/runner/runners/a1",
      external: false,
    });
  });

  it("scopes a board-scoped note to the board notes page, carrying ?note=", () => {
    expect(buildEntityLink({ type: "note", id: "n1", slug, boardId: "b1" })).toEqual({
      href: "/acme/boards/b1/notes?note=n1",
      external: false,
    });
  });

  it("falls back to workspace notes when the note isn't board-scoped, carrying ?note=", () => {
    expect(buildEntityLink({ type: "note", id: "n1", slug })).toEqual({
      href: "/acme/notes?note=n1",
      external: false,
    });
  });

  it("links a workspace to its root route", () => {
    expect(buildEntityLink({ type: "workspace", slug })).toEqual({
      href: "/acme",
      external: false,
    });
  });

  it("marks a PR link as external", () => {
    const url = "https://github.com/x/y/pull/7";
    expect(buildEntityLink({ type: "pr", slug, externalUrl: url })).toEqual({
      href: url,
      external: true,
    });
  });

  it("returns null for an unresolvable reference (no dangling link)", () => {
    expect(buildEntityLink({ type: "card", slug })).toBeNull(); // missing id+boardId
    expect(buildEntityLink({ type: "execution", slug })).toBeNull(); // missing id
    expect(buildEntityLink({ type: "pr", slug })).toBeNull(); // missing url
  });
});
