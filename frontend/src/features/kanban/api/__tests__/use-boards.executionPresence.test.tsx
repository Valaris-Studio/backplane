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
const OTHER_BOARD_ID = "b2";
const EXEC_ID = "exec-1";
const queryKey = boardKeys.detail(SLUG, BOARD_ID);
const BOARD_URL = `/workspaces/${SLUG}/boards/${BOARD_ID}`;

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card-1",
    title: "Card under a runner",
    description: "",
    card_type: "feature",
    priority: "medium",
    position: 1024,
    column_id: "col-todo",
    board_id: BOARD_ID,
    participants: [],
    due_date: null,
    status: "todo",
    labels: null,
    agent_presence: "eligible",
    active_execution_id: null,
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

function executionEvent(
  event: "execution.started" | "execution.completed" | "execution.warning",
  payload: Record<string, unknown> = {},
): WebSocketEvent {
  return {
    event,
    timestamp: "t",
    event_id: `${event}-1`,
    payload: {
      board_id: BOARD_ID,
      card_id: "card-1",
      execution_id: EXEC_ID,
      agent_id: "agent-1",
      ...payload,
    },
  } as WebSocketEvent;
}

const cachedCard = (client: QueryClient): Card =>
  client.getQueryData<BoardDetail>(queryKey)!.columns[0]!.cards[0]!;

// Counts GETs of the FULL board — the payload this card exists to stop
// refetching on every runner tick.
const boardGets = () => apiGet.mock.calls.filter(([url]) => url === BOARD_URL).length;

async function mountWithBoard(client: QueryClient, board: BoardDetail) {
  apiGet.mockImplementation(async (url: string) => {
    if (url === BOARD_URL) return { data: board };
    throw new Error(`unexpected GET ${url}`);
  });
  renderHook(() => useBoard(SLUG, BOARD_ID), { wrapper: withClient(client) });
  await waitFor(() => expect(client.getQueryData(queryKey)).toBeTruthy());
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  subscriptions.length = 0;
  mockSubscribe.mockClear();
  apiGet.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useBoard execution presence patching", () => {
  it("flips the cached card to active on execution.started without a board GET", async () => {
    const client = newClient();
    await mountWithBoard(client, makeBoard([makeCard()]));
    const boardGetsAfterMount = boardGets();

    handlerFor("execution.*")(executionEvent("execution.started"));

    await waitFor(() => expect(cachedCard(client).agent_presence).toBe("active"));
    expect(cachedCard(client).active_execution_id).toBe(EXEC_ID);
    expect(boardGets()).toBe(boardGetsAfterMount);
  });

  it("clears the robot indicator on execution.completed without a board GET", async () => {
    const client = newClient();
    await mountWithBoard(
      client,
      makeBoard([
        makeCard({ agent_presence: "active", active_execution_id: EXEC_ID }),
      ]),
    );
    const boardGetsAfterMount = boardGets();

    handlerFor("execution.*")(
      executionEvent("execution.completed", { status: "completed" }),
    );

    await waitFor(() => expect(cachedCard(client).agent_presence).not.toBe("active"));
    // A finished run always leaves an agent activity row behind, so the state
    // the server would recompute is `touched`, not `none`.
    expect(cachedCard(client).agent_presence).toBe("touched");
    expect(cachedCard(client).active_execution_id).toBeNull();
    expect(boardGets()).toBe(boardGetsAfterMount);
  });

  it("keeps a budget-suspended card suspended when its execution finishes", async () => {
    const client = newClient();
    await mountWithBoard(
      client,
      makeBoard([
        makeCard({
          agent_presence: "active",
          active_execution_id: EXEC_ID,
          labels: ["budget-suspended"],
        }),
      ]),
    );

    handlerFor("execution.*")(
      executionEvent("execution.completed", { status: "failed" }),
    );

    await waitFor(() => expect(cachedCard(client).agent_presence).toBe("suspended"));
    expect(cachedCard(client).active_execution_id).toBeNull();
  });

  it("leaves presence untouched on execution.warning and still skips the board GET", async () => {
    const client = newClient();
    await mountWithBoard(
      client,
      makeBoard([
        makeCard({ agent_presence: "active", active_execution_id: EXEC_ID }),
      ]),
    );
    const boardGetsAfterMount = boardGets();

    // A warning is advisory: the run is still going. Presence must NOT change,
    // and it must not cost a board refetch either.
    handlerFor("execution.*")(
      executionEvent("execution.warning", { kind: "deadline", message: "slow" }),
    );

    await new Promise((r) => setTimeout(r, 400));
    expect(cachedCard(client).agent_presence).toBe("active");
    expect(cachedCard(client).active_execution_id).toBe(EXEC_ID);
    expect(boardGets()).toBe(boardGetsAfterMount);
  });

  it("only clears presence for the execution that is actually finishing", async () => {
    const client = newClient();
    await mountWithBoard(
      client,
      makeBoard([
        makeCard({ agent_presence: "active", active_execution_id: "exec-current" }),
      ]),
    );

    // A late terminal event from a PREVIOUS execution must not clear the
    // indicator for the run happening right now.
    handlerFor("execution.*")(
      executionEvent("execution.completed", {
        execution_id: "exec-stale",
        status: "completed",
      }),
    );

    await new Promise((r) => setTimeout(r, 400));
    expect(cachedCard(client).agent_presence).toBe("active");
    expect(cachedCard(client).active_execution_id).toBe("exec-current");
  });

  it("falls back to the board refetch when the event names a card the cache lacks", async () => {
    const client = newClient();
    await mountWithBoard(client, makeBoard([makeCard()]));
    const boardGetsAfterMount = boardGets();

    handlerFor("execution.*")(
      executionEvent("execution.started", { card_id: "card-unknown" }),
    );

    await waitFor(() => expect(boardGets()).toBeGreaterThan(boardGetsAfterMount));
  });

  it("falls back to the board refetch when the event carries no card_id", async () => {
    const client = newClient();
    await mountWithBoard(client, makeBoard([makeCard()]));
    const boardGetsAfterMount = boardGets();

    handlerFor("execution.*")(
      executionEvent("execution.started", { card_id: null }),
    );

    await waitFor(() => expect(boardGets()).toBeGreaterThan(boardGetsAfterMount));
  });

  it("ignores executions belonging to another board entirely", async () => {
    const client = newClient();
    await mountWithBoard(client, makeBoard([makeCard()]));
    const boardGetsAfterMount = boardGets();

    handlerFor("execution.*")(
      executionEvent("execution.started", { board_id: OTHER_BOARD_ID }),
    );

    await new Promise((r) => setTimeout(r, 400));
    expect(boardGets()).toBe(boardGetsAfterMount);
    expect(cachedCard(client).agent_presence).toBe("eligible");
  });

  it("ignores non-board executions (board_id null)", async () => {
    const client = newClient();
    await mountWithBoard(client, makeBoard([makeCard()]));
    const boardGetsAfterMount = boardGets();

    handlerFor("execution.*")(executionEvent("execution.started", { board_id: null }));

    await new Promise((r) => setTimeout(r, 400));
    expect(boardGets()).toBe(boardGetsAfterMount);
    expect(cachedCard(client).agent_presence).toBe("eligible");
  });
});
