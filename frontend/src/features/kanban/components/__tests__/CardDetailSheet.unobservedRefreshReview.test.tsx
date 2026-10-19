// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { useSearchParams } from "react-router-dom";
import { act, screen, stubReducedMotion, userEvent, waitFor } from "@/test/test-utils";
import { renderNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import { WebSocketContext } from "@/providers/WebSocketProvider";
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
  position: 1024, column_id: "column-1", participants: [], due_date: "2026-10-29", status: "todo", labels: ["original"],
  created_at: "2026-10-18T04:00:00Z", updated_at: "2026-10-18T04:00:00Z",
};
const columns: Column[] = [
  { id: "column-1", name: "In progress", position: 1024, board_id: "board-1", column_type: "active", cards: [], created_at: card.created_at, updated_at: card.updated_at },
  { id: "column-2", name: "Queued", position: 2048, board_id: "board-1", column_type: "backlog", cards: [], created_at: card.created_at, updated_at: card.updated_at },
];
const boardPath = "/acme/boards/board-1/kanban?filter=mine&sort=priority";
const origin = `${boardPath}&card=card-1`;
const apiPath = "/api/workspaces/acme/boards/board-1";
const socket = { status: "connected" as const, subscribe: () => () => {} };

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

function mount(rejectFields = false) {
  const state = { saved: structuredClone(card), receipts: [] as { endpoint: string; payload: Record<string, unknown>; before: Card; after: Card; status: number; detailReads: number; boardReads: number }[], moves: [] as Record<string, unknown>[], writes: [] as Record<string, unknown>[], boardReads: 0, detailReads: 0 };
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
      const payload = await request.json() as Record<string, unknown>;
      const before = structuredClone(state.saved);
      state.moves.push(payload);
      state.saved = { ...state.saved, column_id: String(payload.column_id), position: Number(payload.position) };
      state.receipts.push({ endpoint: "move", payload, before, after: structuredClone(state.saved), status: 200, detailReads: state.detailReads, boardReads: state.boardReads });
      return HttpResponse.json(state.saved);
    }),
    http.patch(`${apiPath}/cards/card-1`, async ({ request }) => {
      const payload = await request.json() as Record<string, unknown>;
      const before = structuredClone(state.saved);
      state.writes.push(payload);
      // Match CardUpdate(exclude_unset=True): omitted fields retain their current server value.
      if (!rejectFields) state.saved = { ...state.saved, ...payload, updated_at: "2026-10-18T04:03:00Z" };
      state.receipts.push({ endpoint: "fields", payload, before, after: structuredClone(state.saved), status: rejectFields ? 503 : 200, detailReads: state.detailReads, boardReads: state.boardReads });
      if (rejectFields) return HttpResponse.json({ detail: "Synthetic temporary save failure", error_code: "unavailable" }, { status: 503 });
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

type Fixture = ReturnType<typeof mount>;

async function hydrated(fixture: Fixture) {
  await screen.findByDisplayValue(card.title);
  await waitFor(() => expect(fixture.state.detailReads).toBe(1));
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  expect(fixture.state.boardReads).toBe(1);
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
}

async function guardedSave(fixture: Fixture, user: ReturnType<typeof userEvent.setup>) {
  await act(async () => { await fixture.router.navigate(-1); });
  expect(fixture.router.state.location.pathname + fixture.router.state.location.search).toBe(origin);
  const save = await screen.findByTestId("unsaved-changes-save");
  expect(fixture.state.writes).toEqual([]);
  expect(fixture.state.moves).toEqual([]);
  await user.click(save);
}

async function settled(fixture: Fixture) {
  await waitFor(() => expect(fixture.client.isMutating()).toBe(0));
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
}

function receipt(name: string, fixture: Fixture) {
  if (process.env.A01_CARD_REQUEST_RECEIPTS === "1") {
    console.info("A01_UNOBSERVED_CARD_RECEIPT", JSON.stringify({ name, ...fixture.state }));
  }
  fixture.client.clear();
}

beforeEach(() => { stubReducedMotion(true); });
afterEach(() => { stubReducedMotion(false); });

describe("guarded card Save preserves unobserved changes by other actors", () => {
  it("patches only the local description and preserves all untouched server fields without a move", async () => {
    const fixture = mount();
    const { state, router } = fixture;
    const user = userEvent.setup();
    try {
      await hydrated(fixture);
      fireEvent.change(screen.getByRole("textbox", { name: "Card description" }), { target: { value: "Human description edit" } });
      const remote = { title: "Unseen runner title", card_type: "feature" as const, priority: "high" as const,
        status: "Runner finished verification", labels: ["remote-approved"], due_date: "2026-11-03",
        column_id: "column-2", position: 3072 };
      state.saved = { ...state.saved, ...remote, updated_at: "2026-10-18T04:02:00Z" };
      expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(card.title);
      expect(state.detailReads).toBe(1);
      expect(state.boardReads).toBe(1);
      await guardedSave(fixture, user);
      await waitFor(() => expect(state.writes).toHaveLength(1));
      await settled(fixture);
      await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe(boardPath));
      expect.soft(state.writes).toEqual([{ description: "Human description edit" }]);
      expect.soft(state.saved).toMatchObject({ ...remote, description: "Human description edit" });
      expect(state.moves).toEqual([]);
      expect(state.receipts[0]).toMatchObject({ before: remote, boardReads: 1, detailReads: 1 });
    } finally { receipt("unobserved-remote-fields", fixture); }
  });

  it("sends explicit empty description and null clears without writing untouched fields", async () => {
    const fixture = mount();
    const { state } = fixture;
    const user = userEvent.setup();
    try {
      await hydrated(fixture);
      fireEvent.change(screen.getByRole("textbox", { name: "Card description" }), { target: { value: "" } });
      fireEvent.change(document.querySelector<HTMLInputElement>('input[id$="-dueDate"]')!, { target: { value: "" } });
      fireEvent.change(document.querySelector<HTMLInputElement>('input[id$="-labels"]')!, { target: { value: "" } });
      state.saved = { ...state.saved, title: "Unseen title before clear", status: "Unseen runner status" };
      await guardedSave(fixture, user);
      await waitFor(() => expect(state.writes).toHaveLength(1));
      await settled(fixture);
      expect.soft(state.writes).toEqual([{ description: "", due_date: null, labels: null }]);
      expect.soft(state.saved).toMatchObject({ description: "", due_date: null, labels: null,
        title: "Unseen title before clear", status: "Unseen runner status" });
      expect(state.moves).toEqual([]);
    } finally { receipt("explicit-clears", fixture); }
  });

  it("uses only the move endpoint for a column-only edit and preserves unseen field values", async () => {
    const fixture = mount();
    const { state, router } = fixture;
    const user = userEvent.setup();
    try {
      await hydrated(fixture);
      await user.click(document.querySelector<HTMLButtonElement>('button[id$="-column"]')!);
      await user.click(await screen.findByRole("option", { name: "Queued" }));
      state.saved = { ...state.saved, title: "Unseen title before move", status: "Unseen runner status before move" };
      await guardedSave(fixture, user);
      await waitFor(() => expect(state.moves).toHaveLength(1));
      await settled(fixture);
      await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe(boardPath));
      expect(state.moves).toEqual([{ column_id: "column-2", position: 1024 }]);
      expect.soft(state.writes).toEqual([]);
      expect(state.saved).toMatchObject({ column_id: "column-2", title: "Unseen title before move", status: "Unseen runner status before move" });
    } finally { receipt("column-only", fixture); }
  });

  it("positive control: unchanged normalized fields leave Save disabled and issue no writes on departure", async () => {
    const fixture = mount();
    const { state, router } = fixture;
    const user = userEvent.setup();
    try {
      await hydrated(fixture);
      fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: `  ${card.title}  ` } });
      fireEvent.change(document.querySelector<HTMLInputElement>('input[id$="-labels"]')!, { target: { value: " original,  " } });
      state.saved = { ...state.saved, title: "Unseen title without local changes", status: "Unseen status without local changes" };
      const save = screen.getByRole("button", { name: "Save" });
      expect(save).toBeDisabled();
      await user.click(save);
      await act(async () => { await router.navigate(-1); });
      await settled(fixture);
      expect(router.state.location.pathname + router.state.location.search).toBe(boardPath);
      expect(screen.queryByTestId("unsaved-changes-save")).not.toBeInTheDocument();
      expect(state.writes).toEqual([]);
      expect(state.moves).toEqual([]);
      expect(state.saved).toMatchObject({ title: "Unseen title without local changes", status: "Unseen status without local changes" });
    } finally { receipt("unchanged-save", fixture); }
  });

  it("positive control: a failed field save keeps the draft, blocked destination and unchanged server values", async () => {
    const fixture = mount(true);
    const { state, router } = fixture;
    const user = userEvent.setup();
    try {
      await hydrated(fixture);
      fireEvent.change(screen.getByRole("textbox", { name: "Card description" }), { target: { value: "Draft retained after failed Save" } });
      state.saved = { ...state.saved, title: "Unseen title during failure", status: "Runner state during failure" };
      const serverBefore = structuredClone(state.saved);
      await guardedSave(fixture, user);
      await waitFor(() => expect(state.writes).toHaveLength(1));
      await settled(fixture);
      expect(router.state.location.pathname + router.state.location.search).toBe(origin);
      expect(screen.getByRole("textbox", { name: "Card description" })).toHaveValue("Draft retained after failed Save");
      expect(screen.getByTestId("unsaved-changes-save")).toBeEnabled();
      const reload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(reload);
      expect(reload.defaultPrevented).toBe(true);
      expect(state.saved).toEqual(serverBefore);
      expect(state.moves).toEqual([]);
      expect(state.receipts).toHaveLength(1);
      expect(state.receipts[0]!.status).toBe(503);
      await user.click(screen.getByTestId("unsaved-changes-keep-editing"));
      expect(router.state.location.pathname + router.state.location.search).toBe(origin);
      expect(screen.getByRole("textbox", { name: "Card description" })).toHaveValue("Draft retained after failed Save");
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    } finally { receipt("failed-save-retention", fixture); }
  });
});
