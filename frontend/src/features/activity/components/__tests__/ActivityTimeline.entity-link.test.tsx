// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  renderWithProviders,
  screen,
  userEvent,
} from "@/test/test-utils";
import i18n from "@/i18n/config";
import type { Activity } from "@/types/activity";

// gsap is a no-op here — the mount stagger is irrelevant to link rendering.
// `progress` returns the tween so cleanup can chain `progress(1).kill()`, the
// real GSAP contract the entrance cleanups rely on.
const { tweenStub } = vi.hoisted(() => ({
  tweenStub: () => {
    const tween = { kill: vi.fn(), progress: vi.fn(() => tween) };
    return tween;
  },
}));

vi.mock("gsap", () => ({
  gsap: {
    fromTo: vi.fn(tweenStub),
    to: vi.fn(tweenStub),
    set: vi.fn(),
    ticker: { add: vi.fn(), remove: vi.fn() },
    utils: {
      toArray: (selector: string, scope?: Element) =>
        Array.from((scope ?? document).querySelectorAll(selector)),
    },
  },
}));

const { activitiesRef } = vi.hoisted(() => ({
  activitiesRef: { current: [] as Activity[] },
}));

vi.mock("../../api/use-activity", () => ({
  useActivity: () => ({
    data: { pages: [activitiesRef.current] },
    isLoading: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    isFetchingNextPage: false,
  }),
}));

import { ActivityTimeline } from "../ActivityTimeline";

function makeActivity(overrides: Partial<Activity>): Activity {
  return {
    id: "act-1",
    workspace_id: "ws1",
    board_id: "board-1",
    actor_id: "u1",
    actor_name: "Ada",
    actor_email: "ada@example.com",
    agent_id: null,
    entity_type: "card",
    entity_id: "card-1",
    action: "updated",
    summary: "changed the priority",
    changes: null,
    via_api_key: null,
    entity_title: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function renderTimeline() {
  return renderWithProviders(<ActivityTimeline slug="acme" />, {
    routerProps: { initialEntries: ["/acme"] },
  });
}

beforeEach(async () => {
  activitiesRef.current = [];
  await i18n.changeLanguage("en");
});

describe("ActivityTimeline — entity linking", () => {
  it("links a card-entity row to the card deep-link using entity_title as the label", () => {
    activitiesRef.current = [
      makeActivity({
        id: "a-card",
        entity_type: "card",
        entity_id: "card-42",
        board_id: "board-7",
        entity_title: "Ship the login flow",
        summary: "changed the priority",
      }),
    ];
    renderTimeline();

    const link = screen.getByRole("link", { name: "Ship the login flow" });
    expect(link).toHaveAttribute(
      "href",
      "/acme/boards/board-7/kanban?card=card-42",
    );
    // The descriptive prose stays alongside the linked title chip.
    expect(screen.getByText(/changed the priority/)).toBeInTheDocument();
  });

  it("links a note-entity row to the board notes page using entity_title", () => {
    activitiesRef.current = [
      makeActivity({
        id: "a-note",
        entity_type: "note",
        entity_id: "note-9",
        board_id: "board-7",
        entity_title: "Release checklist",
        summary: "edited the note",
      }),
    ];
    renderTimeline();

    const link = screen.getByRole("link", { name: "Release checklist" });
    // ?note=<id> is the notes page's deep-link contract (NoteList opens the
    // editor on arrival) — the link targets the note, not just the list.
    expect(link).toHaveAttribute("href", "/acme/boards/board-7/notes?note=note-9");
  });

  it("renders a non-linkable entity type as plain text with no anchor", () => {
    activitiesRef.current = [
      makeActivity({
        id: "a-ws",
        entity_type: "workspace",
        entity_id: "ws1",
        board_id: null,
        entity_title: null,
        summary: "renamed the workspace",
      }),
    ];
    renderTimeline();

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText(/renamed the workspace/)).toBeInTheDocument();
  });

  it("renders a card row without entity_title as plain summary (no chip, no link)", () => {
    activitiesRef.current = [
      makeActivity({
        id: "a-card-untitled",
        entity_type: "card",
        entity_id: "card-99",
        board_id: "board-7",
        entity_title: null,
        summary: "moved the card",
      }),
    ];
    renderTimeline();

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText(/moved the card/)).toBeInTheDocument();
  });

  it("renders a known structured message in the active locale", async () => {
    await i18n.changeLanguage("es");
    activitiesRef.current = [
      makeActivity({
        id: "a-localized",
        action: "moved",
        summary: "legacy moved summary",
        message_key: "activity.card.moved",
        message_params: {
          card_title: "Launch",
          from_column_name: "Backlog",
          from_column_known: true,
          to_column_name: "Review",
        },
      }),
    ];
    renderTimeline();

    expect(
      screen.getByText("movió 'Launch' de 'Backlog' a 'Review'"),
    ).toBeInTheDocument();
    expect(screen.queryByText("legacy moved summary")).not.toBeInTheDocument();
  });

  it("falls back exactly to summary for an unknown structured key", () => {
    const summary = "  unknown -- summary <raw>  ";
    activitiesRef.current = [
      makeActivity({
        id: "a-unknown",
        summary,
        message_key: "activity.card.future_operation",
        message_params: { card_title: "Launch" },
      }),
    ];
    const { container } = renderTimeline();

    expect(container.textContent).toContain(summary);
  });

  it("localizes both closedBy and expanded cycle entries", async () => {
    await i18n.changeLanguage("es");
    const churn = (
      id: string,
      summary: string,
      message_key: string | null,
      message_params: Record<string, unknown> | null,
    ) =>
      makeActivity({
        id,
        agent_id: "agent-1",
        summary,
        message_key,
        message_params,
      });

    activitiesRef.current = [
      makeActivity({
        id: "transition",
        action: "moved",
        summary: "legacy transition",
        message_key: "activity.card.moved",
        message_params: {
          card_title: "Launch",
          from_column_name: "Review",
          from_column_known: true,
          to_column_name: "Done",
        },
      }),
      churn("unassigned-2", "unassigned card 'Launch'", null, null),
      churn("claimed-2", "claimed card 'Launch'", "activity.card.claimed", {
        card_title: "Launch",
      }),
      churn("reserved-2", "reserved card 'Launch'", "activity.card.reserved", {
        card_title: "Launch",
        role: "implementer",
      }),
      churn("unassigned-1", "unassigned card 'Launch'", null, null),
      churn("claimed-1", "claimed card 'Launch'", "activity.card.claimed", {
        card_title: "Launch",
      }),
      churn("reserved-1", "reserved card 'Launch'", "activity.card.reserved", {
        card_title: "Launch",
        role: "implementer",
      }),
    ];
    renderTimeline();

    expect(
      screen.getByText(/cerrado por: movió 'Launch' de 'Review' a 'Done'/),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getAllByText("asumió la tarjeta 'Launch'")).toHaveLength(2);
    expect(
      screen.getAllByText("reservó la tarjeta 'Launch' para el rol implementer"),
    ).toHaveLength(2);
    expect(screen.getAllByText("unassigned card 'Launch'")).toHaveLength(2);
  });
});
