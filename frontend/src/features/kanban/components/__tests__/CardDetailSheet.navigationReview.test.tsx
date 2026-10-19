// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { useSearchParams } from "react-router-dom";
import { act, screen, stubReducedMotion, userEvent, waitFor } from "@/test/test-utils";
import { renderNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import { WebSocketContext } from "@/providers/WebSocketProvider";
import type { WebSocketEvent } from "@/lib/websocket";
import type { BoardDetail, Card, Column } from "@/types/kanban";

vi.mock("@/features/members/api/use-members", () => ({ useMembers: () => ({ data: [] }) }));
vi.mock("@/features/agents/hooks/useAgentMetrics", () => ({ useCardExecutions: () => ({ data: [] }) }));
vi.mock("@/features/agents/hooks/usePipelineConfig", () => ({ usePipelineConfig: () => ({ pipelineConfig: null }) }));
vi.mock("@/features/notes/api/use-notes", () => ({ useNotes: () => ({ data: [] }), useUpdateNote: () => ({ mutate: vi.fn() }) }));
vi.mock("@/hooks/useWorkspaceAdmin", () => ({ useWorkspaceAdmin: () => ({ isAdmin: false }) }));
vi.mock("../DependenciesSection", () => ({ DependenciesSection: () => null }));
vi.mock("@/features/sessions/components/LinkedSessionsSection", () => ({ CardSessionsSection: () => null }));
vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: ({ content, onChange }: { content: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Card description" value={content} onChange={(event) => onChange(event.target.value)} />
  ),
}));
import { useBoard } from "../../api/use-boards";
import { useCardDetail } from "../../api/use-card-detail";
import { CardDetailSheet } from "../CardDetailSheet";

const card: Card = {
  id: "card-1", title: "Saved card", description: "Saved description", card_type: "task", priority: "medium",
  position: 1024, column_id: "column-1", participants: [], due_date: null, status: null, labels: null,
  created_at: "2026-10-18T04:00:00Z", updated_at: "2026-10-18T04:00:00Z",
};
const columns: Column[] = [
  { id: "column-1", name: "In progress", position: 1024, board_id: "board-1", column_type: "active", cards: [], created_at: card.created_at, updated_at: card.updated_at },
  { id: "column-2", name: "Queued", position: 2048, board_id: "board-1", column_type: "backlog", cards: [], created_at: card.created_at, updated_at: card.updated_at },
];
const boardPath = "/acme/boards/board-1/kanban?filter=mine&sort=priority";
const origin = `${boardPath}&card=card-1`;
const apiPath = "/api/workspaces/acme/boards/board-1";
type Handler = (event: WebSocketEvent) => void;
const subscriptions = new Map<string, Set<Handler>>();
const socket = {
  status: "connected" as const,
  subscribe(pattern: string, handler: Handler) {
    const handlers = subscriptions.get(pattern) ?? new Set<Handler>();
    handlers.add(handler); subscriptions.set(pattern, handlers);
    return () => { handlers.delete(handler); };
  },
};

function BoardRoute() {
  const [params, setParams] = useSearchParams();
  const { data: board } = useBoard("acme", "board-1");
  const open = params.has("card");
  const selected = board?.columns.flatMap((column) => column.cards).find((item) => item.id === "card-1") ?? null;
  const detail = useCardDetail("acme", "board-1", selected, open);
  return <><h1>Filtered board</h1><CardDetailSheet card={detail.card} columns={board?.columns ?? []}
    slug="acme" boardId="board-1" open={open} isDetailLoaded={detail.isDetailLoaded}
    onOpenChange={(next) => { if (!next) setParams((current) => { current.delete("card"); return current; }); }} /></>;
}

function mount() {
  const state = { saved: { ...card }, moves: [] as Record<string, unknown>[], writes: [] as Record<string, unknown>[], boardReads: 0, detailReads: 0 };
  server.use(
    http.get(apiPath, () => {
      state.boardReads += 1;
      const board: BoardDetail = { id: "board-1", slug: "work", name: "Work", description: "", tags: [], workspace_id: "workspace-1",
        created_at: card.created_at, updated_at: card.updated_at,
        columns: columns.map((column) => ({ ...column, cards: column.id === state.saved.column_id ? [state.saved] : [] })) };
      return HttpResponse.json(board);
    }),
    http.get(`${apiPath}/cards/card-1`, () => { state.detailReads += 1; return HttpResponse.json(state.saved); }),
    http.patch(`${apiPath}/cards/card-1/move`, async ({ request }) => {
      state.moves.push(await request.json() as Record<string, unknown>);
      return HttpResponse.json({ detail: "Move rejected", error_code: "conflict" }, { status: 409 });
    }),
    http.patch(`${apiPath}/cards/card-1`, async ({ request }) => {
      const payload = await request.json() as Record<string, unknown>;
      state.writes.push(payload);
      state.saved = { ...state.saved, ...payload, updated_at: "2026-10-18T04:01:00Z" };
      return HttpResponse.json(state.saved);
    }),
    http.get(`${apiPath}/completion/policy`, () => HttpResponse.json({ effective_policy: { evidence_only: { enabled: false } } })),
    http.get(`${apiPath}/completion/cards/card-1`, () => HttpResponse.json({ completion_mode: "source", candidate: null, attempts: [] })),
  );
  const rendered = renderNavigationRouter([
    { path: "/acme/boards/board-1/kanban", element: <WebSocketContext.Provider value={socket}><BoardRoute /></WebSocketContext.Provider> },
  ], { initialEntries: [boardPath, origin], initialIndex: 1 });
  return { ...rendered, state };
}

beforeEach(() => { subscriptions.clear(); stubReducedMotion(true); });
afterEach(() => { stubReducedMotion(false); });

describe("CardDetailSheet draft after a partially failed save", () => {
  it("keeps the rejected column choice through a real completion-event detail refresh", async () => {
    const { router, client, state } = mount();
    const user = userEvent.setup();
    try {
      await screen.findByDisplayValue("Saved card");
      await waitFor(() => expect(state.detailReads).toBe(1));
      await waitFor(() => expect(client.isFetching()).toBe(0));
      fireEvent.change(screen.getByDisplayValue("Saved card"), { target: { value: "Reviewed card" } });
      fireEvent.change(screen.getByRole("textbox", { name: "Card description" }), { target: { value: "Reviewed description" } });
      await user.click(document.querySelector<HTMLButtonElement>('button[id$="-column"]')!);
      await user.click(await screen.findByRole("option", { name: "Queued" }));
      await act(async () => { await router.navigate(-1); });
      await user.click(screen.getByTestId("unsaved-changes-save"));
      await waitFor(() => expect(state.moves).toHaveLength(1));
      await waitFor(() => expect(state.writes).toHaveLength(1));
      await waitFor(() => expect(client.isMutating()).toBe(0));
      await waitFor(() => expect(client.isFetching()).toBe(0));
      expect(state.saved).toMatchObject({ title: "Reviewed card", description: "Reviewed description", column_id: "column-1" });
      expect(state.boardReads).toBeGreaterThan(1);
      expect(state.detailReads).toBe(1);
      expect(document.querySelector('button[id$="-column"]')).toHaveTextContent("Queued");
      expect(router.state.location.pathname + router.state.location.search).toBe(origin);

      // Mutation settlement refreshes the board only. This existing consumer
      // of authorized completion events is the real card-detail refresh seam.
      const handlers = subscriptions.get("completion.*");
      expect(handlers?.size).toBeGreaterThan(0);
      act(() => { handlers!.forEach((handler) => handler({ event: "completion.updated", event_id: "completion-refresh",
        timestamp: "2026-10-18T04:02:00Z", payload: { board_id: "board-1", card_id: "card-1", status: "accepted" } })); });
      await waitFor(() => expect(state.detailReads).toBe(2));
      await waitFor(() => expect(client.isFetching()).toBe(0));
      await user.click(screen.getByTestId("unsaved-changes-keep-editing"));
      expect(router.state.location.pathname + router.state.location.search).toBe(origin);
      expect(screen.getByDisplayValue("Reviewed card")).toBeVisible();
      expect(screen.getByRole("textbox", { name: "Card description" })).toHaveValue("Reviewed description");
      expect(document.querySelector('button[id$="-column"]')).toHaveTextContent("Queued");
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
      expect(state.moves).toHaveLength(1);
      expect(state.writes).toHaveLength(1);
    } finally { client.clear(); }
  });
});
