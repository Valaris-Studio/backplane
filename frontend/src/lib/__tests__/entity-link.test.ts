// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { buildEntityLink, type EntityRef } from "../entity-link";

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

// The boundary also consumes references decoded from server records. These
// cases exercise runtime behavior while the destination union is extended.
function destination(ref: unknown) { return buildEntityLink(ref as EntityRef); }

describe("continuity destinations", () => {
  it("links a session and exact content without copying private origin metadata", () => {
    expect(destination({ type: "session", slug, id: "session-1" })).toEqual({ href: "/acme/sessions/session-1", external: false });
    expect(destination({ type: "session", slug, id: "session-1", contentId: "content-19" })).toEqual({ href: "/acme/sessions/session-1#content-content-19", external: false });
  });

  it.each([undefined, "board-1"])("links an exact resource using its authorized scope (board: %s)", (boardId) => {
    expect(destination({ type: "resource", slug, id: "resource-51", boardId })).toEqual({
      href: boardId ? "/acme/boards/board-1/resources?resource=resource-51" : "/acme/resources?resource=resource-51", external: false,
    });
  });

  it("shares board-wide event identity without a private replay generation", () => {
    expect(destination({ type: "timeline", slug, boardId: "board-1", eventSequence: 451, generation: "private-generation", returnTo: "/acme/sessions/private-source?q=private-query" })).toEqual({
      href: "/acme/boards/board-1/timeline?at=451", external: false,
    });
  });

  it("rejects incomplete exact destinations instead of guessing another entity or event", () => {
    for (const ref of [
      { type: "session", slug }, { type: "resource", slug },
      { type: "timeline", slug, eventSequence: 451 },
      { type: "timeline", slug, boardId: "board-1", eventSequence: -1 },
      { type: "timeline", slug, boardId: "board-1", eventSequence: "today" },
    ]) expect(destination(ref)).toBeNull();
  });

  it("ignores source details and return URLs on shared card, note and resource references", () => {
    for (const type of ["card", "note", "resource"]) {
      const resolved = destination({ type, slug, id: "target", boardId: "board-1", returnTo: "https://external.example/private", originId: "private-session", title: "Private title", query: "Private query", snippet: "Private body" });
      expect(resolved).not.toBeNull();
      expect(resolved!.href).not.toMatch(/private|return|origin|external/i);
    }
  });
});
