// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderWithProviders, screen, stubReducedMotion } from "@/test/test-utils";
import type { Note } from "@/types/note";

vi.mock("../../api/use-notes", () => ({
  useUpdateNote: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteNote: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: ({ content }: { content: string }) => (
    <textarea data-testid="rte" defaultValue={content} />
  ),
}));

import { NoteEditor } from "../NoteEditor";

const STORAGE_KEY = "sheet-width:note-editor";
const DEFAULT_WIDTH = 896;

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

function makeNote(): Note {
  return {
    id: "note-1",
    workspace_id: "ws-1",
    board_id: null,
    card_id: null,
    title: "My workspace note",
    content: "<p>Body</p>",
    pinned: false,
    kind: "user_note",
    failure_class: null,
    findings: null,
    source_execution_id: null,
    created_by: "u1",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  };
}

function renderEditor() {
  return renderWithProviders(
    <NoteEditor note={makeNote()} slug="acme" open onOpenChange={() => {}} />,
  );
}

beforeEach(() => {
  stubReducedMotion(true);
  window.localStorage.clear();
  setViewportWidth(1600);
});

afterEach(() => {
  stubReducedMotion(false);
  window.localStorage.clear();
});

describe("NoteEditor — resizable panel opt-in", () => {
  it("renders the sheet resize handle", () => {
    renderEditor();

    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("opens at the long-form default width", () => {
    renderEditor();

    expect(screen.getByRole("dialog").style.width).toBe(`${DEFAULT_WIDTH}px`);
  });

  it("restores the operator's stored width", () => {
    window.localStorage.setItem(STORAGE_KEY, "1100");

    renderEditor();

    expect(screen.getByRole("dialog").style.width).toBe("1100px");
  });

  // Distinct storage namespaces are the whole point of per-surface keys: a
  // width set on the card sheet must not follow the operator into notes.
  it("ignores the card sheet's stored width", () => {
    window.localStorage.setItem("sheet-width:card-detail", "1240");

    renderEditor();

    expect(screen.getByRole("dialog").style.width).toBe(`${DEFAULT_WIDTH}px`);
  });
});
