// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { buildCardLink, parseCardLink } from "../card-link";

const ORIGIN = "http://localhost:3000";

describe("parseCardLink", () => {
  it("parses a relative board path carrying a card param", () => {
    expect(parseCardLink("/acme/boards/board-1?card=card-9", ORIGIN)).toEqual({
      slug: "acme",
      boardId: "board-1",
      cardId: "card-9",
    });
  });

  it("parses a tabbed board path (…/kanban?card=)", () => {
    expect(
      parseCardLink("/acme/boards/board-1/kanban?card=card-9", ORIGIN),
    ).toEqual({ slug: "acme", boardId: "board-1", cardId: "card-9" });
  });

  it("parses an absolute same-origin URL", () => {
    expect(
      parseCardLink(`${ORIGIN}/acme/boards/board-1?card=card-9`, ORIGIN),
    ).toEqual({ slug: "acme", boardId: "board-1", cardId: "card-9" });
  });

  it("rejects an absolute URL on another origin", () => {
    expect(
      parseCardLink(
        "https://elsewhere.example/acme/boards/board-1?card=card-9",
        ORIGIN,
      ),
    ).toBeNull();
  });

  it("rejects a board path without a card param", () => {
    expect(parseCardLink("/acme/boards/board-1", ORIGIN)).toBeNull();
  });

  it("rejects non-board paths even when a card param is present", () => {
    expect(parseCardLink("/acme/approvals?card=card-9", ORIGIN)).toBeNull();
    expect(parseCardLink("/acme/boards?card=card-9", ORIGIN)).toBeNull();
  });

  it("rejects unparseable hrefs", () => {
    expect(parseCardLink("", ORIGIN)).toBeNull();
    expect(parseCardLink("mailto:dev@valaris.dev", ORIGIN)).toBeNull();
  });

  it("round-trips through buildCardLink", () => {
    const reference = { slug: "acme", boardId: "board-1", cardId: "card-9" };
    expect(parseCardLink(buildCardLink(reference), ORIGIN)).toEqual(reference);
  });
});
