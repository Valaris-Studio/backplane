// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { boardKeys, cardKeys, completionKeys } from "@/lib/query-keys";
import type { WebSocketEvent } from "@/lib/websocket";
const subscriptions: { pattern: string; handler: (event: WebSocketEvent) => void }[] = [];
vi.mock("@/providers/WebSocketProvider", () => ({ useWebSocketContext: () => ({ status: "connected", subscribe: (pattern: string, handler: (event: WebSocketEvent) => void) => { const sub = { pattern, handler }; subscriptions.push(sub); return () => { subscriptions.splice(subscriptions.indexOf(sub), 1); }; } }) }));
vi.mock("@/lib/api", () => ({ api: { get: vi.fn().mockResolvedValue({ data: { completion_mode: "source", candidate: null, attempts: [] } }) } }));
import { useCardCompletion } from "../use-completion";
describe("completion event convergence", () => {
  it.each(["activity.note", "activity.definition"])("refreshes context measurements on %s changes", async (domain) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const policyKey = completionKeys.policy("ws", "b1");
    client.setQueryData(policyKey, {});
    renderHook(() => useCardCompletion("ws", "b1", "c1"), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
    await waitFor(() => expect(client.getQueryData(completionKeys.card("ws", "b1", "c1"))).toBeDefined());
    act(() => { subscriptions.filter((sub) => sub.pattern === `${domain}.*`).forEach((sub) => sub.handler({ event_id: "context-edit", timestamp: "2026-09-16T15:00:00Z", event: `${domain}.updated`, payload: { board_id: null } })); });
    await waitFor(() => expect(client.getQueryState(policyKey)?.isInvalidated).toBe(true));
  });
  it("refreshes dependency readiness and the card when completion becomes accepted, scoped to its board", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const watched = [boardKeys.detail("ws", "b1"), cardKeys.dependencies("ws", "b1", "c1")];
    for (const key of watched) client.setQueryData(key, {});
    renderHook(() => useCardCompletion("ws", "b1", "c1"), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
    await waitFor(() => expect(client.getQueryData(completionKeys.card("ws", "b1", "c1"))).toBeDefined());
    act(() => { subscriptions.filter((sub) => sub.pattern === "completion.*").forEach((sub) => sub.handler({ event_id: "event-1", timestamp: "2026-09-13T15:00:00Z", event: "completion.updated", payload: { board_id: "other", card_id: "c1", status: "accepted" } })); });
    expect(watched.map((key) => client.getQueryState(key)?.isInvalidated)).toEqual([false, false]);
    act(() => { subscriptions.filter((sub) => sub.pattern === "completion.*").forEach((sub) => sub.handler({ event_id: "event-1", timestamp: "2026-09-13T15:00:00Z", event: "completion.updated", payload: { board_id: "b1", card_id: "c1", status: "accepted" } })); });
    await waitFor(() => expect(watched.map((key) => client.getQueryState(key)?.isInvalidated)).toEqual([true, true]));
  });
});
