// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { useBoard } from "../use-boards";
import { boardKeys } from "@/lib/query-keys";
import type { BoardDetail, Card } from "@/types/kanban";
import type { WebSocketEvent } from "@/lib/websocket";

type Subscriber = (evt: WebSocketEvent) => void;
const subscriptions: { pattern: string; handler: Subscriber }[] = [];

const mockSubscribe = vi.fn((pattern: string, handler: Subscriber) => {
  subscriptions.push({ pattern, handler });
  return () => {
    const idx = subscriptions.findIndex((s) => s.handler === handler);
    if (idx >= 0) subscriptions.splice(idx, 1);
  };
});

vi.mock("@/providers/WebSocketProvider", () => ({
  useWebSocketContext: () => ({
    status: "connected" as const,
    subscribe: mockSubscribe,
  }),
}));

// Keep useQuery from firing a real HTTP request; we only assert on cache +
// invalidation behaviour driven by WS events.
const apiGet = vi.fn().mockResolvedValue({ data: { id: "b1", columns: [] } });
vi.mock("@/lib/api", () => ({
  api: { get: (...args: unknown[]) => apiGet(...args) },
}));

beforeEach(() => {
  subscriptions.length = 0;
  mockSubscribe.mockClear();
  apiGet.mockClear();
});

function withClient(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card-1",
    title: "Original title",
    description: "Original description",
    card_type: "feature",
    priority: "medium",
    position: 1024,
    column_id: "col-todo",
    participants: [],
    due_date: null,
    status: "todo",
    labels: null,
    created_at: "2026-06-06T00:00:00Z",
    updated_at: "2026-06-06T00:00:00Z",
    ...overrides,
  } as Card;
}

function seedBoard(client: QueryClient, queryKey: readonly unknown[], card: Card) {
  const board: BoardDetail = {
    id: "b1",
    columns: [
      {
        id: "col-todo",
        cards: [card],
      },
    ],
  } as unknown as BoardDetail;
  client.setQueryData(queryKey, board);
}

function cardHandler(): Subscriber {
  // useBoard registers several card.*/activity.card.*/column.*/activity.board.*
  // subscribers. The bridge card.* channel (card.updated / card.moved) is the
  // one under test for the diff-corruption fix.
  const sub = subscriptions.find((s) => s.pattern === "card.*");
  if (!sub) throw new Error("no card.* subscription registered");
  return sub.handler;
}

describe("useBoard card.* domain sync", () => {
  const SLUG = "ws";
  const BOARD_ID = "b1";
  const queryKey = boardKeys.detail(SLUG, BOARD_ID);

  it("does NOT mutate the cached card with diff-shape data on card.updated", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const original = makeCard({ title: "Original title" });
    seedBoard(client, queryKey, original);

    renderHook(() => useBoard(SLUG, BOARD_ID), { wrapper: withClient(client) });

    // REAL backend card.updated payload: changes is a DIFF of field NAMES only.
    cardHandler()({
      event: "card.updated",
      timestamp: "t",
      event_id: "e1",
      payload: {
        board_id: BOARD_ID,
        entity_id: "card-1",
        changes: { fields: ["title", "status"] },
      },
    });

    // The cache must be left untouched (no `{fields:[...]}` junk merged in,
    // and the actual title is NOT applied since the diff carries no values).
    const cached = client.getQueryData<BoardDetail>(queryKey)!;
    const cachedCard = cached.columns[0]!.cards[0]! as Card & {
      fields?: unknown;
    };
    expect(cachedCard.fields).toBeUndefined();
    expect(cachedCard.title).toBe("Original title");

    // The UI now self-corrects from the SINGLE-card GET rather than a full
    // board refetch, so the 250 ms debounced invalidation must never be armed.
    // (The merge itself is covered in use-boards.singleCardPatch.test.tsx,
    // which drives real timers and a per-URL api.get mock.)
    expect(apiGet).toHaveBeenCalledWith(
      `/workspaces/${SLUG}/boards/${BOARD_ID}/cards/card-1`,
    );
    vi.advanceTimersByTime(250);
    expect(invalidateSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does NOT write the column_id OBJECT over the cached card on card.moved, and refetches instead", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const original = makeCard({ column_id: "col-todo" });
    seedBoard(client, queryKey, original);

    renderHook(() => useBoard(SLUG, BOARD_ID), { wrapper: withClient(client) });

    // REAL backend card.moved payload: column_id is an OBJECT {old,new}.
    cardHandler()({
      event: "card.moved",
      timestamp: "t",
      event_id: "e2",
      payload: {
        board_id: BOARD_ID,
        entity_id: "card-1",
        changes: {
          column_id: { old: "col-todo", new: "col-doing" },
          from_column: "col-todo",
          to_column: "col-doing",
        },
      },
    });

    // column_id must stay a string — never overwritten with the {old,new} object.
    const cached = client.getQueryData<BoardDetail>(queryKey)!;
    const cachedCard = cached.columns[0]!.cards[0]! as Card;
    expect(typeof cachedCard.column_id).toBe("string");
    expect(cachedCard.column_id).toBe("col-todo");

    expect(invalidateSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey });
    vi.useRealTimers();
  });
});

describe("useBoard execution.* domain sync", () => {
  const SLUG = "ws";
  const BOARD_ID = "b1";
  const queryKey = boardKeys.detail(SLUG, BOARD_ID);

  function executionHandler(): Subscriber {
    const sub = subscriptions.find((s) => s.pattern === "execution.*");
    if (!sub) throw new Error("no execution.* subscription registered");
    return sub.handler;
  }

  it("refetches the board on execution.started for THIS board (so agent_presence flips to active live)", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    seedBoard(client, queryKey, makeCard());

    renderHook(() => useBoard(SLUG, BOARD_ID), { wrapper: withClient(client) });

    executionHandler()({
      event: "execution.started",
      timestamp: "t",
      event_id: "e3",
      payload: { board_id: BOARD_ID, card_id: "card-1", agent_id: "agent-1" },
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey });
    vi.useRealTimers();
  });

  it("clears the robot indicator on execution.completed carrying board_id, without a refetch", () => {
    // Pins the contract the backend fix restores: terminal execution events
    // carry board_id, so a finished run clears agent presence WITHOUT waiting
    // for an unrelated card.*/activity.* event. The convergence is what matters
    // and is asserted here; the MECHANISM changed from a debounced full-board
    // invalidation to an in-cache presence patch (the board GET was 0.5-3 MB
    // per runner tick), so the indicator must now clear with no refetch at all.
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    seedBoard(client, queryKey, makeCard({ agent_presence: "active" }));

    renderHook(() => useBoard(SLUG, BOARD_ID), { wrapper: withClient(client) });

    executionHandler()({
      event: "execution.completed",
      timestamp: "t",
      event_id: "e6",
      payload: {
        board_id: BOARD_ID,
        card_id: "card-1",
        agent_id: "agent-1",
        status: "completed",
      },
    });

    const patched = client.getQueryData<BoardDetail>(queryKey)!;
    expect(patched.columns[0]!.cards[0]!.agent_presence).not.toBe("active");
    vi.advanceTimersByTime(250);
    expect(invalidateSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("ignores execution.started with a null board_id (non-board stage — no refetch storm)", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    seedBoard(client, queryKey, makeCard());

    renderHook(() => useBoard(SLUG, BOARD_ID), { wrapper: withClient(client) });

    // A planning/triage execution carries board_id=null; the shared isThisBoard
    // would pass-through null and refetch EVERY board. The execution filter must
    // be stricter and ignore it.
    executionHandler()({
      event: "execution.started",
      timestamp: "t",
      event_id: "e5",
      payload: { board_id: null, card_id: null, agent_id: "agent-1" },
    });

    vi.advanceTimersByTime(250);
    expect(invalidateSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("ignores execution.started for a DIFFERENT board", () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    seedBoard(client, queryKey, makeCard());

    renderHook(() => useBoard(SLUG, BOARD_ID), { wrapper: withClient(client) });

    executionHandler()({
      event: "execution.started",
      timestamp: "t",
      event_id: "e4",
      payload: { board_id: "other-board", card_id: "card-9", agent_id: "agent-1" },
    });

    vi.advanceTimersByTime(250);
    expect(invalidateSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("useBoard — event scoping by board UUID when the route param is a slug", () => {
  // Regression for the cross-tab bug: the route param is the board SLUG, but
  // WS events carry the board UUID. The event must still be recognised as
  // "this board" so the reconciler runs (otherwise the filter drops it and the
  // card never moves on the observing tab).
  const SLUG = "development-tasks"; // route param (NOT a uuid)
  const BOARD_UUID = "20b7524b-50bb-42b7-88a5-fd24d15828c4";
  const queryKey = boardKeys.detail("ws", SLUG);

  function seedTwoColumnBoard(client: QueryClient) {
    const card = makeCard({ id: "card-1", column_id: "col-todo", position: 1024 });
    const board: BoardDetail = {
      id: BOARD_UUID, // the board's REAL id, distinct from the slug param
      columns: [
        { id: "col-todo", cards: [card] },
        { id: "col-doing", cards: [] },
      ],
    } as unknown as BoardDetail;
    client.setQueryData(queryKey, board);
  }

  it("moves the card across columns when the event's board_id is the UUID and the param is a slug", () => {
    const client = new QueryClient();
    seedTwoColumnBoard(client);

    // We seed the cache directly with the real UUID board, so query.data.id is
    // BOARD_UUID on the render that matters — even though the route param is a
    // slug. The handler fires synchronously before any refetch can overwrite.
    renderHook(() => useBoard("ws", SLUG), { wrapper: withClient(client) });

    cardHandler()({
      event: "card.moved",
      timestamp: "t",
      event_id: "e-move",
      payload: {
        board_id: BOARD_UUID, // UUID, NOT the slug route param
        entity_id: "card-1",
        action: "moved",
        changes: { column_id: { old: "col-todo", new: "col-doing" } },
      },
    });

    const cached = client.getQueryData<BoardDetail>(queryKey)!;
    const todo = cached.columns.find((c) => c.id === "col-todo")!;
    const doing = cached.columns.find((c) => c.id === "col-doing")!;
    // The card actually moved — proving the event was NOT dropped by the filter.
    expect(todo.cards.map((c) => c.id)).toEqual([]);
    expect(doing.cards.map((c) => c.id)).toEqual(["card-1"]);
  });
});
