// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
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

const apiGet = vi.fn();
vi.mock("@/lib/api", () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
  },
}));

const SLUG = "ws";
const BOARD_ID = "b1";
const queryKey = boardKeys.detail(SLUG, BOARD_ID);
const BOARD_URL = `/workspaces/${SLUG}/boards/${BOARD_ID}`;
const cardUrl = (cardId: string) => `${BOARD_URL}/cards/${cardId}`;

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card-1",
    title: "Original title",
    description: "Original description",
    card_type: "feature",
    priority: "medium",
    position: 1024,
    column_id: "col-todo",
    board_id: BOARD_ID,
    participants: [],
    due_date: null,
    status: "todo",
    labels: null,
    created_at: "2026-06-06T00:00:00Z",
    updated_at: "2026-06-06T00:00:00Z",
    ...overrides,
  } as Card;
}

function makeBoard(cards: Card[]): BoardDetail {
  return {
    id: BOARD_ID,
    columns: [
      { id: "col-todo", cards: cards.filter((c) => c.column_id === "col-todo") },
      { id: "col-done", cards: cards.filter((c) => c.column_id === "col-done") },
    ],
  } as unknown as BoardDetail;
}

function withClient(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

function handlerFor(pattern: string): Subscriber {
  const sub = subscriptions.find((s) => s.pattern === pattern);
  if (!sub) throw new Error(`no ${pattern} subscription registered`);
  return sub.handler;
}

function cardEvent(
  action: "created" | "updated",
  cardId: string,
  event = `card.${action}`,
): WebSocketEvent {
  return {
    event,
    timestamp: "t",
    event_id: `${event}-${cardId}`,
    payload: {
      board_id: BOARD_ID,
      entity_id: cardId,
      action,
      changes: { fields: ["title"] },
    },
  } as WebSocketEvent;
}

// Counts GETs of the FULL board — the payload this card exists to stop
// refetching. The initial mount fetch is excluded by the caller's baseline.
const boardGets = () => apiGet.mock.calls.filter(([url]) => url === BOARD_URL).length;
const cardGets = (cardId: string) =>
  apiGet.mock.calls.filter(([url]) => url === cardUrl(cardId)).length;

beforeEach(() => {
  subscriptions.length = 0;
  mockSubscribe.mockClear();
  apiGet.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useBoard single-card patch on card.created / card.updated", () => {
  it("fetches ONLY the changed card on card.updated and merges it into the cached board", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const seeded = makeBoard([makeCard()]);
    apiGet.mockImplementation(async (url: string) => {
      if (url === BOARD_URL) return { data: seeded };
      if (url === cardUrl("card-1")) {
        return { data: makeCard({ title: "Renamed by the runner" }) };
      }
      throw new Error(`unexpected GET ${url}`);
    });

    renderHook(() => useBoard(SLUG, BOARD_ID), { wrapper: withClient(client) });
    await waitFor(() => expect(client.getQueryData(queryKey)).toBeTruthy());
    const boardGetsAfterMount = boardGets();

    handlerFor("card.*")(cardEvent("updated", "card-1"));

    await waitFor(() => {
      const cached = client.getQueryData<BoardDetail>(queryKey)!;
      expect(cached.columns[0]!.cards[0]!.title).toBe("Renamed by the runner");
    });
    expect(cardGets("card-1")).toBe(1);
    expect(boardGets()).toBe(boardGetsAfterMount);
  });

  it("inserts a newly created card into its column ordered by position", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const first = makeCard({ id: "card-1", position: 1024 });
    const third = makeCard({ id: "card-3", position: 3072 });
    apiGet.mockImplementation(async (url: string) => {
      if (url === BOARD_URL) return { data: makeBoard([first, third]) };
      if (url === cardUrl("card-2")) {
        return { data: makeCard({ id: "card-2", position: 2048 }) };
      }
      throw new Error(`unexpected GET ${url}`);
    });

    renderHook(() => useBoard(SLUG, BOARD_ID), { wrapper: withClient(client) });
    await waitFor(() => expect(client.getQueryData(queryKey)).toBeTruthy());
    const boardGetsAfterMount = boardGets();

    handlerFor("card.*")(cardEvent("created", "card-2"));

    await waitFor(() => {
      const cached = client.getQueryData<BoardDetail>(queryKey)!;
      expect(cached.columns[0]!.cards.map((c) => c.id)).toEqual([
        "card-1",
        "card-2",
        "card-3",
      ]);
    });
    expect(boardGets()).toBe(boardGetsAfterMount);
  });

  it("relocates an updated card when its column_id changed", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    apiGet.mockImplementation(async (url: string) => {
      if (url === BOARD_URL) return { data: makeBoard([makeCard()]) };
      if (url === cardUrl("card-1")) {
        return { data: makeCard({ column_id: "col-done", position: 512 }) };
      }
      throw new Error(`unexpected GET ${url}`);
    });

    renderHook(() => useBoard(SLUG, BOARD_ID), { wrapper: withClient(client) });
    await waitFor(() => expect(client.getQueryData(queryKey)).toBeTruthy());

    handlerFor("card.*")(cardEvent("updated", "card-1"));

    await waitFor(() => {
      const cached = client.getQueryData<BoardDetail>(queryKey)!;
      expect(cached.columns[0]!.cards).toHaveLength(0);
      expect(cached.columns[1]!.cards.map((c) => c.id)).toEqual(["card-1"]);
    });
  });

  it("coalesces the bridge event and its activity twin into ONE card GET", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let resolveCard: ((value: { data: Card }) => void) | undefined;
    apiGet.mockImplementation(async (url: string) => {
      if (url === BOARD_URL) return { data: makeBoard([makeCard()]) };
      if (url === cardUrl("card-1")) {
        return new Promise<{ data: Card }>((resolve) => {
          resolveCard = resolve;
        });
      }
      throw new Error(`unexpected GET ${url}`);
    });

    renderHook(() => useBoard(SLUG, BOARD_ID), { wrapper: withClient(client) });
    await waitFor(() => expect(client.getQueryData(queryKey)).toBeTruthy());
    const boardGetsAfterMount = boardGets();

    // Both channels deliver the same mutation, back to back and in flight.
    handlerFor("card.*")(cardEvent("updated", "card-1"));
    handlerFor("activity.card.*")(
      cardEvent("updated", "card-1", "activity.card.updated"),
    );

    await waitFor(() => expect(resolveCard).toBeDefined());
    resolveCard!({ data: makeCard({ title: "Renamed once" }) });

    await waitFor(() => {
      const cached = client.getQueryData<BoardDetail>(queryKey)!;
      expect(cached.columns[0]!.cards[0]!.title).toBe("Renamed once");
    });
    expect(cardGets("card-1")).toBe(1);
    expect(boardGets()).toBe(boardGetsAfterMount);
  });

  it("falls back to the full board refetch when the single-card GET fails", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    apiGet.mockImplementation(async (url: string) => {
      if (url === BOARD_URL) return { data: makeBoard([makeCard()]) };
      if (url === cardUrl("card-1")) throw new Error("404 deleted mid-flight");
      throw new Error(`unexpected GET ${url}`);
    });
    renderHook(() => useBoard(SLUG, BOARD_ID), { wrapper: withClient(client) });
    await waitFor(() => expect(client.getQueryData(queryKey)).toBeTruthy());
    const boardGetsAfterMount = boardGets();

    handlerFor("card.*")(cardEvent("updated", "card-1"));

    await waitFor(() => expect(boardGets()).toBeGreaterThan(boardGetsAfterMount));
  });

  it("leaves dependency events on the debounced full-board refetch path", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    apiGet.mockImplementation(async (url: string) => {
      if (url === BOARD_URL) return { data: makeBoard([makeCard()]) };
      throw new Error(`unexpected GET ${url}`);
    });
    renderHook(() => useBoard(SLUG, BOARD_ID), { wrapper: withClient(client) });
    await waitFor(() => expect(client.getQueryData(queryKey)).toBeTruthy());
    const boardGetsAfterMount = boardGets();

    handlerFor("activity.card.*")({
      event: "activity.card.dependency_added",
      timestamp: "t",
      event_id: "dep-1",
      payload: {
        board_id: BOARD_ID,
        entity_id: "card-1",
        action: "dependency_added",
      },
    } as WebSocketEvent);

    await waitFor(() => expect(boardGets()).toBeGreaterThan(boardGetsAfterMount));
    expect(cardGets("card-1")).toBe(0);
  });
});
