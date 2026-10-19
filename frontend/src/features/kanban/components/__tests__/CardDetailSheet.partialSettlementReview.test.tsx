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

interface MutationReceipt {
  path: string;
  kind: "fields" | "move";
  payload: Record<string, unknown>;
  status: number;
  before: Card;
  after: Card;
  detailReads: number;
  boardReads: number;
}

function mount(firstFieldsStatus = 200, firstMoveStatus = 200) {
  const state = {
    saved: structuredClone(card),
    receipts: [] as MutationReceipt[],
    writes: [] as Record<string, unknown>[],
    moves: [] as Record<string, unknown>[],
    detailReads: 0,
    boardReads: 0,
  };
  server.use(
    http.get(apiPath, () => {
      state.boardReads += 1;
      const board: BoardDetail = {
        id: "board-1", slug: "work", name: "Work", description: "", tags: [], workspace_id: "workspace-1",
        created_at: card.created_at, updated_at: card.updated_at,
        columns: columns.map((column) => ({ ...column, cards: column.id === state.saved.column_id ? [state.saved] : [] })),
      };
      return HttpResponse.json(board);
    }),
    http.get(`${apiPath}/cards/card-1`, () => {
      state.detailReads += 1;
      return HttpResponse.json(state.saved);
    }),
    http.patch(`${apiPath}/cards/card-1/move`, async ({ request }) => {
      const payload = await request.json() as Record<string, unknown>;
      const before = structuredClone(state.saved);
      state.moves.push(payload);
      const status = state.moves.length === 1 ? firstMoveStatus : 200;
      if (status === 200) {
        state.saved = { ...state.saved, column_id: String(payload.column_id), position: Number(payload.position) };
      }
      state.receipts.push({ path: new URL(request.url).pathname, kind: "move", payload, status,
        before, after: structuredClone(state.saved), detailReads: state.detailReads, boardReads: state.boardReads });
      return status === 200
        ? HttpResponse.json(state.saved)
        : HttpResponse.json({ detail: "Synthetic move rejected", error_code: "conflict" }, { status });
    }),
    http.patch(`${apiPath}/cards/card-1`, async ({ request }) => {
      const payload = await request.json() as Record<string, unknown>;
      const before = structuredClone(state.saved);
      state.writes.push(payload);
      const status = state.writes.length === 1 ? firstFieldsStatus : 200;
      // Match independent backend commits and CardUpdate(exclude_unset=True).
      if (status === 200) state.saved = { ...state.saved, ...payload, updated_at: "2026-10-18T04:03:00Z" };
      state.receipts.push({ path: new URL(request.url).pathname, kind: "fields", payload, status,
        before, after: structuredClone(state.saved), detailReads: state.detailReads, boardReads: state.boardReads });
      return status === 200
        ? HttpResponse.json(state.saved)
        : HttpResponse.json({ detail: "Synthetic field save unavailable", error_code: "unavailable" }, { status });
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
const editedDescription = "Human description committed once";

async function settled(fixture: Fixture) {
  await waitFor(() => expect(fixture.client.isMutating()).toBe(0));
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
}

async function editAndAttemptDeparture(fixture: Fixture) {
  const user = userEvent.setup();
  await screen.findByDisplayValue(card.title);
  await waitFor(() => expect(fixture.state.detailReads).toBe(1));
  await settled(fixture);
  expect(fixture.state.boardReads).toBe(1);
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: "Card description" }), { target: { value: editedDescription } });
  await user.click(document.querySelector<HTMLButtonElement>('button[id$="-column"]')!);
  await user.click(await screen.findByRole("option", { name: "Queued" }));
  await act(async () => { await fixture.router.navigate(-1); });
  expect(fixture.router.state.location.pathname + fixture.router.state.location.search).toBe(origin);
  expect(fixture.state.writes).toEqual([]);
  expect(fixture.state.moves).toEqual([]);
  await user.click(await screen.findByTestId("unsaved-changes-save"));
  await waitFor(() => expect(fixture.state.receipts).toHaveLength(2));
  await settled(fixture);
  return user;
}

function assertFailedAttemptRetainsDraft(fixture: Fixture) {
  expect(fixture.router.state.location.pathname + fixture.router.state.location.search).toBe(origin);
  expect(screen.getByRole("textbox", { name: "Card description" })).toHaveValue(editedDescription);
  expect(document.querySelector('button[id$="-column"]')).toHaveTextContent("Queued");
  expect(screen.getByTestId("unsaved-changes-save")).toBeEnabled();
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
}

async function retry(fixture: Fixture, user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("unsaved-changes-save"));
  await waitFor(() => expect(fixture.router.state.location.pathname + fixture.router.state.location.search).toBe(boardPath));
  await settled(fixture);
}

function receipt(name: string, fixture: Fixture) {
  if (process.env.A01_PARTIAL_SETTLEMENT_RECEIPTS === "1") {
    console.info("A01_PARTIAL_SETTLEMENT_RECEIPT", JSON.stringify({ name, ...fixture.state }));
  }
  fixture.client.clear();
}

beforeEach(() => { stubReducedMotion(true); });
afterEach(() => { stubReducedMotion(false); });

describe("card Save retries only writes that did not commit", () => {
  it("does not repeat a successful move when the field PATCH fails and is retried", async () => {
    const fixture = mount(503, 200);
    try {
      const user = await editAndAttemptDeparture(fixture);
      assertFailedAttemptRetainsDraft(fixture);
      expect(fixture.state.saved).toMatchObject({ column_id: "column-2", position: 1024, description: card.description });
      expect(fixture.state.moves).toEqual([{ column_id: "column-2", position: 1024 }]);
      expect(fixture.state.writes).toEqual([{ description: editedDescription }]);
      await retry(fixture, user);
      expect.soft(fixture.state.moves).toEqual([{ column_id: "column-2", position: 1024 }]);
      expect.soft(fixture.state.saved).toMatchObject({ ...card, column_id: "column-2", position: 1024, description: editedDescription, updated_at: "2026-10-18T04:03:00Z" });
      expect(fixture.state.writes).toEqual([{ description: editedDescription }, { description: editedDescription }]);
      expect(fixture.state.receipts.filter((entry) => entry.kind === "fields").map((entry) => entry.status)).toEqual([503, 200]);
      expect(fixture.state.receipts.every((entry) => entry.path === `${apiPath}/cards/card-1${entry.kind === "move" ? "/move" : ""}`)).toBe(true);
    } finally { receipt("move-committed-fields-retry", fixture); }
  });

  it("retries only a rejected move after a successful PATCH and preserves a later unobserved remote description", async () => {
    const fixture = mount(200, 409);
    try {
      const user = await editAndAttemptDeparture(fixture);
      assertFailedAttemptRetainsDraft(fixture);
      expect(fixture.state.saved).toMatchObject({ column_id: "column-1", position: 1024, description: editedDescription });
      const reads = { detail: fixture.state.detailReads, board: fixture.state.boardReads };
      // No event or forced query refresh: another actor changes the already committed field.
      fixture.state.saved = { ...fixture.state.saved, description: "Later remote description must survive retry", status: "Runner verification complete" };
      expect(screen.getByRole("textbox", { name: "Card description" })).toHaveValue(editedDescription);
      expect({ detail: fixture.state.detailReads, board: fixture.state.boardReads }).toEqual(reads);
      await retry(fixture, user);
      expect.soft(fixture.state.writes).toEqual([{ description: editedDescription }]);
      expect.soft(fixture.state.saved).toMatchObject({ ...card, column_id: "column-2", position: 1024,
        description: "Later remote description must survive retry", status: "Runner verification complete", updated_at: "2026-10-18T04:03:00Z" });
      expect(fixture.state.moves).toEqual([{ column_id: "column-2", position: 1024 }, { column_id: "column-2", position: 1024 }]);
      expect(fixture.state.receipts.filter((entry) => entry.kind === "move").map((entry) => entry.status)).toEqual([409, 200]);
      expect(fixture.state.receipts.find((entry) => entry.kind === "move" && entry.status === 200)?.before.description).toBe("Later remote description must survive retry");
    } finally { receipt("fields-committed-move-retry-remote-change", fixture); }
  });

  it("positive control: retries both writes when neither committed, retaining the draft and blocked route", async () => {
    const fixture = mount(503, 409);
    try {
      const user = await editAndAttemptDeparture(fixture);
      assertFailedAttemptRetainsDraft(fixture);
      expect(fixture.state.saved).toEqual(card);
      await retry(fixture, user);
      expect(fixture.state.moves).toEqual([{ column_id: "column-2", position: 1024 }, { column_id: "column-2", position: 1024 }]);
      expect(fixture.state.writes).toEqual([{ description: editedDescription }, { description: editedDescription }]);
      expect(fixture.state.saved).toEqual({ ...card, column_id: "column-2", position: 1024, description: editedDescription, updated_at: "2026-10-18T04:03:00Z" });
    } finally { receipt("both-failed-both-retry", fixture); }
  });

  it("positive control: one successful field update and move complete the pending departure", async () => {
    const fixture = mount();
    try {
      await editAndAttemptDeparture(fixture);
      await waitFor(() => expect(fixture.router.state.location.pathname + fixture.router.state.location.search).toBe(boardPath));
      expect(fixture.state.moves).toEqual([{ column_id: "column-2", position: 1024 }]);
      expect(fixture.state.writes).toEqual([{ description: editedDescription }]);
      expect(fixture.state.saved).toEqual({ ...card, column_id: "column-2", position: 1024, description: editedDescription, updated_at: "2026-10-18T04:03:00Z" });
      expect(fixture.state.receipts.every((entry) => entry.status === 200)).toBe(true);
    } finally { receipt("both-committed-once", fixture); }
  });
});
