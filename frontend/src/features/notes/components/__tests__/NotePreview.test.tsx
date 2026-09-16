// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { NoteCard } from "../NoteCard";
import { NoteRow } from "../NoteRow";
import type { NoteSummary } from "@/types/note";

vi.mock("@/features/visuals/components/WaveCard", () => ({
  WaveCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function makeSummary(overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id: "n1",
    workspace_id: "ws-1",
    board_id: null,
    card_id: null,
    title: "Kickoff",
    preview: "Server-rendered plain text snippet",
    pinned: false,
    kind: "user_note",
    failure_class: null,
    findings: null,
    source_execution_id: null,
    created_by: "u1",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

describe("note list items render the server preview", () => {
  it("NoteCard shows `preview` — the body never reaches the list", () => {
    renderWithProviders(
      <NoteCard note={makeSummary()} authorName="Ada" onClick={() => {}} />,
    );
    expect(
      screen.getByText("Server-rendered plain text snippet"),
    ).toBeInTheDocument();
  });

  it("NoteCard falls back to the placeholder for an empty preview", () => {
    renderWithProviders(
      <NoteCard
        note={makeSummary({ preview: "" })}
        authorName="Ada"
        onClick={() => {}}
      />,
    );
    expect(screen.getByText(/content \(optional\)/i)).toBeInTheDocument();
  });

  it("NoteRow shows `preview`", () => {
    renderWithProviders(
      <NoteRow note={makeSummary()} authorName="Ada" onClick={() => {}} />,
    );
    expect(
      screen.getByText("Server-rendered plain text snippet"),
    ).toBeInTheDocument();
  });

  it("NoteRow omits the snippet line entirely when the preview is empty", () => {
    const { container } = renderWithProviders(
      <NoteRow
        note={makeSummary({ preview: "" })}
        authorName="Ada"
        onClick={() => {}}
      />,
    );
    expect(container.querySelectorAll(".truncate.text-xs").length).toBe(0);
  });
});
