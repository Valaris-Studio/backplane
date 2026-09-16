// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "@/test/test-utils";
import type { Card } from "@/types/kanban";
import type { Note } from "@/types/note";
import type { Execution } from "@/features/agents/api/agents";

// CardDetailSheet uses a Sheet that animates via GSAP. In JSDOM the animation
// never advances so the content stays at visibility:hidden — that's why every
// test in this file reaches into the DOM via querySelector instead of
// `getByRole`. The existing CardDetailSheet.test.tsx uses the same trick.

vi.mock("@/features/kanban/api/use-cards", () => ({
  useUpdateCard: () => ({ mutate: vi.fn(), isPending: false }),
  useAddParticipant: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveParticipant: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteCard: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/features/members/api/use-members", () => ({
  useMembers: () => ({
    data: [
      { user_id: "u1", name: "Alice", email: "alice@example.com" },
      { user_id: "u2", name: "Bob", email: "bob@example.com" },
    ],
  }),
}));
vi.mock("@/features/agents/hooks/useAgentMetrics", () => ({
  useExecutions: () => ({ data: [] as Execution[] }),
  useCardExecutions: () => ({ data: [] as Execution[] }),
}));
vi.mock("@/features/notes/api/use-notes", () => ({
  useNotes: () => ({ data: [] as Note[] }),
  useUpdateNote: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/features/agents/hooks/usePipelineConfig", () => ({
  usePipelineConfig: () => ({ pipelineConfig: null }),
}));

import { CardDetailSheet } from "../CardDetailSheet";

function makeCard(): Card {
  return {
    id: "card-1",
    title: "Build it",
    description: "",
    card_type: "task",
    priority: "medium",
    position: 1024,
    column_id: "col-1",
    participants: [],
    due_date: null,
    status: null,
    labels: null,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  };
}

function renderSheet() {
  return renderWithProviders(
    <CardDetailSheet
      card={makeCard()}
      columns={[
        {
          id: "col-1",
          name: "To Do",
          position: 1024,
          board_id: "board-1",
          column_type: "backlog",
          cards: [],
          created_at: "2026-04-01T00:00:00Z",
          updated_at: "2026-04-01T00:00:00Z",
        },
      ]}
      slug="acme"
      boardId="board-1"
      open
      onOpenChange={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AddParticipant a11y", () => {
  it("wraps the participants block in a labelled group landmark", () => {
    const { baseElement } = renderSheet();
    const group = baseElement.querySelector('[role="group"][aria-labelledby]');
    expect(group).not.toBeNull();
    const labelledBy = group!.getAttribute("aria-labelledby")!;
    const labelEl = baseElement.querySelector("#" + CSS.escape(labelledBy));
    expect(labelEl?.textContent).toMatch(/participants/i);
  });

  it("Select triggers in the participant block expose aria-haspopup=listbox and aria-expanded", () => {
    const { baseElement } = renderSheet();
    const group = baseElement.querySelector('[role="group"][aria-labelledby]')!;
    const popupTriggers = group.querySelectorAll('button[aria-haspopup="listbox"]');
    expect(popupTriggers.length).toBe(2);
    popupTriggers.forEach((b) =>
      expect(b.getAttribute("aria-expanded")).toBe("false"),
    );
  });

  it("aria-controls activates only while the listbox is open and references a listbox", () => {
    const { baseElement } = renderSheet();
    const group = baseElement.querySelector('[role="group"][aria-labelledby]')!;
    const memberTrigger = group.querySelector(
      'button[aria-haspopup="listbox"]',
    ) as HTMLButtonElement;
    expect(memberTrigger.getAttribute("aria-controls")).toBeNull();

    act(() => {
      memberTrigger.click();
    });

    expect(memberTrigger.getAttribute("aria-expanded")).toBe("true");
    const listboxId = memberTrigger.getAttribute("aria-controls");
    expect(listboxId).not.toBeNull();
    const listbox = baseElement.querySelector(
      "#" + CSS.escape(listboxId as string),
    );
    expect(listbox).not.toBeNull();
    expect(listbox!.getAttribute("role")).toBe("listbox");
  });

  it("returns focus to the trigger when the listbox closes via Escape", () => {
    const { baseElement } = renderSheet();
    const group = baseElement.querySelector('[role="group"][aria-labelledby]')!;
    const memberTrigger = group.querySelector(
      'button[aria-haspopup="listbox"]',
    ) as HTMLButtonElement;

    act(() => {
      memberTrigger.click();
    });
    expect(memberTrigger.getAttribute("aria-expanded")).toBe("true");

    // Escape on document closes the listbox per Select.tsx effect — the
    // popup-close `useEffect` in Select restores focus to the trigger.
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    expect(memberTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(memberTrigger);
  });

  it("Select triggers carry a visible focus ring class for keyboard users", () => {
    const { baseElement } = renderSheet();
    const group = baseElement.querySelector('[role="group"][aria-labelledby]')!;
    const memberTrigger = group.querySelector(
      'button[aria-haspopup="listbox"]',
    ) as HTMLButtonElement;
    expect(memberTrigger.className).toMatch(/focus-visible:ring/);
  });

  it("Select triggers expose an accessible name via aria-label", () => {
    const { baseElement } = renderSheet();
    const group = baseElement.querySelector('[role="group"][aria-labelledby]')!;
    const popupTriggers = Array.from(
      group.querySelectorAll('button[aria-haspopup="listbox"]'),
    );
    popupTriggers.forEach((b) => {
      const label = b.getAttribute("aria-label");
      expect(label).toBeTruthy();
      expect(label!.length).toBeGreaterThan(0);
    });
  });
});
