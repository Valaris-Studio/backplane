// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { server, http, HttpResponse } from "@/test/msw-server";
import { useCreateCard } from "../use-cards";

vi.mock("@/providers/WebSocketProvider", () => ({
  useWebSocketContext: () => ({
    status: "connected" as const,
    subscribe: () => () => {},
  }),
}));

const SLUG = "ws";
const BOARD_ID = "b1";
const CARDS_URL = `/api/workspaces/${SLUG}/boards/${BOARD_ID}/cards`;

// The backend's CardCreate schema forbids unknown keys, so anything this hook
// sends beyond the accepted set is a 422 rather than a silently ignored extra.
const ACCEPTED_BY_CARD_CREATE = new Set([
  "title",
  "description",
  "card_type",
  "priority",
  "column_id",
  "due_date",
  "status",
  "labels",
  "git_repo_slug",
]);

function withClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

let postedBody: Record<string, unknown>;

beforeEach(() => {
  postedBody = {};
  server.use(
    http.post(CARDS_URL, async ({ request }) => {
      postedBody = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(
        { id: "c1", ...postedBody, position: 1024 },
        { status: 201 },
      );
    }),
  );
});

describe("useCreateCard request body", () => {
  it("sends no field the backend's CardCreate schema would reject", async () => {
    const wrapper = withClient();
    const { result } = renderHook(() => useCreateCard(SLUG, BOARD_ID), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        title: "New Card",
        column_id: "col1",
        card_type: "task",
        priority: "medium",
        position: 2048,
        description: "body",
        labels: ["loop-4"],
      });
    });

    const rejected = Object.keys(postedBody).filter(
      (key) => !ACCEPTED_BY_CARD_CREATE.has(key),
    );
    expect(rejected).toEqual([]);
  });

  it("still forwards every field the caller supplied that the backend accepts", async () => {
    const wrapper = withClient();
    const { result } = renderHook(() => useCreateCard(SLUG, BOARD_ID), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        title: "New Card",
        column_id: "col1",
        card_type: "bug",
        priority: "urgent",
        position: 2048,
        description: "body",
        due_date: "2026-09-01",
        status: "in progress",
        labels: ["loop-4"],
      });
    });

    expect(postedBody).toMatchObject({
      title: "New Card",
      column_id: "col1",
      card_type: "bug",
      priority: "urgent",
      description: "body",
      due_date: "2026-09-01",
      status: "in progress",
      labels: ["loop-4"],
    });
  });
});
