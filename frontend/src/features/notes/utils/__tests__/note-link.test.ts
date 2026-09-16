// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { buildNoteLink, NOTE_SEARCH_PARAM } from "../note-link";

describe("buildNoteLink", () => {
  it("scopes to the board notes tab when boardId is present", () => {
    expect(
      buildNoteLink({ slug: "acme", boardId: "board-1", noteId: "note-9" }),
    ).toBe("/acme/boards/board-1/notes?note=note-9");
  });

  it("falls back to the workspace notes page when boardId is absent", () => {
    expect(buildNoteLink({ slug: "acme", noteId: "note-9" })).toBe(
      "/acme/notes?note=note-9",
    );
  });

  it("encodes the note id", () => {
    expect(
      buildNoteLink({ slug: "acme", boardId: "board-1", noteId: "n/9 z" }),
    ).toBe("/acme/boards/board-1/notes?note=n%2F9%20z");
  });

  it("exposes the shared search param name", () => {
    expect(NOTE_SEARCH_PARAM).toBe("note");
  });
});
