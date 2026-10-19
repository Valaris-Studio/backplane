// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { act, screen, stubReducedMotion, userEvent, waitFor } from "@/test/test-utils";
import { renderNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import { WebSocketContext } from "@/providers/WebSocketProvider";
import type { BoardDetail, Card, Column } from "@/types/kanban";

// Only the heavy editor renderer is replaced. The same-board anchor comes
// from the real DependenciesSection, inside the real sheet's capture handler.
vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: ({ content, onChange }: { content: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Card description" value={content} onChange={(event) => onChange(event.target.value)} />
  ),
}));

import { BoardView } from "../BoardView";

const timestamp = "2026-10-18T22:00:00Z";
const boardPath = "/acme/boards/board-1/kanban?filter=mine&sort=priority";
const origin = `${boardPath}&card=card-a`;
const destination = `${boardPath}&card=card-b`;
const apiPath = "/api/workspaces/acme/boards/board-1";
const socket = { status: "connected" as const, subscribe: () => () => {} };
const originalCards: Card[] = ["a", "b"].map((suffix, index) => ({
  id: `card-${suffix}`, title: `Card ${suffix.toUpperCase()}`, description: `Saved description ${suffix.toUpperCase()}`,
  card_type: "task", priority: "medium", position: 1024 * (index + 1), column_id: "column-1",
  participants: [], due_date: null, status: "todo", labels: ["original"], created_at: timestamp, updated_at: timestamp,
}));
const column: Column = {
  id: "column-1", board_id: "board-1", name: "In progress", column_type: "active", position: 1024,
  cards: [], created_at: timestamp, updated_at: timestamp,
};

type WriteReceipt = {
  cardId: string;
  payload: Record<string, unknown>;
  before: Card;
  after?: Card;
  status?: number;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function mount(heldOutcome?: "success" | "failure") {
  const held = deferred();
  const state = {
    saved: new Map(originalCards.map((card) => [card.id, structuredClone(card)])),
    writes: [] as WriteReceipt[], moves: [] as { cardId: string; payload: unknown }[],
    detailReads: [] as string[], reads: [] as string[], unexpected: [] as string[],
  };
  const get = (path: string, value: Parameters<typeof HttpResponse.json>[0]) => http.get(path, ({ request }) => {
    state.reads.push(new URL(request.url).pathname + new URL(request.url).search);
    return HttpResponse.json(value);
  });
  server.use(
    http.get(apiPath, ({ request }) => {
      state.reads.push(new URL(request.url).pathname + new URL(request.url).search);
      const board: BoardDetail = {
        id: "board-1", slug: "work", name: "Work", description: "", tags: [], workspace_id: "workspace-1",
        created_at: timestamp, updated_at: timestamp,
        columns: [{ ...column, cards: [...state.saved.values()] }],
      };
      return HttpResponse.json(board);
    }),
    http.get(`${apiPath}/cards/:cardId`, ({ params }) => {
      const cardId = String(params.cardId);
      state.detailReads.push(cardId);
      return HttpResponse.json(state.saved.get(cardId));
    }),
    http.get(`${apiPath}/cards/:cardId/dependencies`, ({ params }) => HttpResponse.json({
      depends_on: params.cardId === "card-a" ? [{
        card_id: "card-a", depends_on_card_id: "card-b", depends_on_title: "Open related card B",
        depends_on_column_type: "active", satisfied: false,
      }] : [], blocks: [],
    })),
    http.patch(`${apiPath}/cards/:cardId/move`, async ({ params, request }) => {
      state.moves.push({ cardId: String(params.cardId), payload: await request.json() });
      return HttpResponse.json({ detail: "No move belongs to these field-only scenarios" }, { status: 409 });
    }),
    http.patch(`${apiPath}/cards/:cardId`, async ({ params, request }) => {
      const cardId = String(params.cardId);
      const payload = await request.json() as Record<string, unknown>;
      const before = structuredClone(state.saved.get(cardId)!);
      const receipt: WriteReceipt = { cardId, payload, before };
      state.writes.push(receipt);
      if (cardId === "card-a" && heldOutcome) await held.promise;
      if (cardId === "card-a" && heldOutcome === "failure") {
        receipt.after = structuredClone(before);
        receipt.status = 503;
        return HttpResponse.json({ detail: "Synthetic late failure for card A", error_code: "unavailable" }, { status: 503 });
      }
      // The API applies only fields supplied by CardUpdate(exclude_unset=True).
      const saved = { ...state.saved.get(cardId)!, ...payload, updated_at: "2026-10-18T22:01:00Z" };
      state.saved.set(cardId, saved);
      receipt.after = structuredClone(saved);
      receipt.status = 200;
      return HttpResponse.json(saved);
    }),
    get("/api/me", { id: "user-me", email: "fixture@example.invalid", display_name: "Fixture operator" }),
    get("/api/auth/modes", { password_enabled: true, oidc_enabled: false, companion_enabled: false }),
    get("/api/workspaces/acme/members", []),
    get("/api/workspaces/acme/config", { pipeline_config: null }),
    get("/api/workspaces/acme/metrics/agents", { agents: [] }),
    get("/api/workspaces/acme/executions", []),
    get("/api/workspaces/acme/executions/skipped-card-ids", []),
    get(`${apiPath}/notes`, []),
    get(`${apiPath}/loop/status`, { state: "off", enabled: false, bound_agent_count: 0, alive_agent_count: 0 }),
    get(`${apiPath}/completion/policy`, { effective_policy: { evidence_only: { enabled: false } } }),
    http.get(`${apiPath}/completion/cards/:cardId`, () => HttpResponse.json({ completion_mode: "source", candidate: null, attempts: [] })),
    http.all("/api/*", ({ request }) => {
      state.unexpected.push(`${request.method} ${request.url}`);
      return HttpResponse.json({ detail: "Unexpected synthetic fixture request" }, { status: 500 });
    }),
  );
  const rendered = renderNavigationRouter([
    { path: "/:slug/boards/:boardId/kanban", element: <WebSocketContext.Provider value={socket}><BoardView /></WebSocketContext.Provider> },
  ], { initialEntries: [origin] });
  return { ...rendered, state, release: held.resolve };
}

type Fixture = ReturnType<typeof mount>;

function location(fixture: Fixture) {
  return fixture.router.state.location.pathname + fixture.router.state.location.search;
}

async function loaded(fixture: Fixture, suffix: "a" | "b") {
  await screen.findByDisplayValue(`Card ${suffix.toUpperCase()}`);
  await waitFor(() => expect(fixture.state.detailReads).toContain(`card-${suffix}`));
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  expect(fixture.state.unexpected).toEqual([]);
  expect(screen.getByLabelText("Card description")).toHaveValue(`Saved description ${suffix.toUpperCase()}`);
}

function editDescription(value: string) {
  fireEvent.change(screen.getByLabelText("Card description"), { target: { value } });
}

function unloadWarns() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

async function idle(fixture: Fixture) {
  await waitFor(() => expect(fixture.client.isMutating()).toBe(0));
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
}

function record(name: string, fixture: Fixture) {
  console.info("A01_BOARD_NAVIGATION_RECEIPT", JSON.stringify({
    name, location: location(fixture), saved: [...fixture.state.saved.values()],
    writes: fixture.state.writes, moves: fixture.state.moves, detailReads: fixture.state.detailReads,
    unexpected: fixture.state.unexpected,
    visibleDescription: screen.queryByLabelText("Card description")?.getAttribute("value")
      ?? (screen.queryByLabelText("Card description") as HTMLTextAreaElement | null)?.value,
    alerts: screen.queryAllByRole("alert").map((element) => element.textContent), unloadWarns: unloadWarns(),
  }));
}

async function finish(name: string, fixture: Fixture) {
  // Release even when an earlier assertion fails, so this test owns no pending
  // request after cleanup and a later fixture cannot settle its mutation.
  fixture.release();
  await idle(fixture);
  record(name, fixture);
  fixture.unmount();
  fixture.client.clear();
}

beforeEach(() => { stubReducedMotion(true); });
afterEach(() => { stubReducedMotion(false); });

describe("real BoardView card-reference navigation preserves the guarded draft", () => {
  it("clean control: the real dependency link switches the sheet and canonical card selection without writes", async () => {
    const fixture = mount();
    const user = userEvent.setup();
    try {
      await loaded(fixture, "a");
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
      await user.click(await screen.findByRole("link", { name: "Open related card B" }));
      await loaded(fixture, "b");
      expect(location(fixture)).toBe(destination);
      expect(screen.queryByTestId("unsaved-changes-prompt")).not.toBeInTheDocument();
      expect(fixture.state.writes).toEqual([]);
      expect(fixture.state.moves).toEqual([]);
      expect(unloadWarns()).toBe(false);
    } finally { await finish("clean switch", fixture); }
  });

  it("keeps card A and its draft while a same-board card link is blocked, including Keep editing", async () => {
    const fixture = mount();
    const user = userEvent.setup();
    try {
      await loaded(fixture, "a");
      editDescription("Unsaved local A");
      expect(unloadWarns()).toBe(true);
      await user.click(await screen.findByRole("link", { name: "Open related card B" }));
      await screen.findByTestId("unsaved-changes-prompt");
      expect(location(fixture)).toBe(origin);
      expect(fixture.state.writes).toEqual([]);
      expect(fixture.state.moves).toEqual([]);
      expect.soft(screen.getByLabelText("Card description")).toHaveValue("Unsaved local A");
      expect.soft(screen.queryByDisplayValue("Card A")).toBeInTheDocument();
      expect.soft(screen.queryByTestId("unsaved-changes-save")).toBeInTheDocument();
      await user.click(screen.getByTestId("unsaved-changes-keep-editing"));
      expect(location(fixture)).toBe(origin);
      expect.soft(screen.getByLabelText("Card description")).toHaveValue("Unsaved local A");
      expect.soft(screen.queryByDisplayValue("Card A")).toBeInTheDocument();
      expect.soft(unloadWarns()).toBe(true);
      expect(fixture.state.writes).toEqual([]);
    } finally { await finish("same-board Keep editing", fixture); }
  });

  it("Save on the same-board departure prompt commits only A's draft before opening B", async () => {
    const fixture = mount();
    const user = userEvent.setup();
    try {
      await loaded(fixture, "a");
      editDescription("Save A before opening B");
      await user.click(await screen.findByRole("link", { name: "Open related card B" }));
      await screen.findByTestId("unsaved-changes-prompt");
      expect(location(fixture)).toBe(origin);
      expect(fixture.state.writes).toEqual([]);
      expect.soft(screen.getByLabelText("Card description")).toHaveValue("Save A before opening B");
      await user.click(screen.getByTestId("unsaved-changes-save"));
      await loaded(fixture, "b");
      await idle(fixture);
      expect(location(fixture)).toBe(destination);
      expect(fixture.state.writes.map(({ cardId, payload }) => ({ cardId, payload }))).toEqual([
        { cardId: "card-a", payload: { description: "Save A before opening B" } },
      ]);
      expect(fixture.state.saved.get("card-a")?.description).toBe("Save A before opening B");
      expect(fixture.state.saved.get("card-b")).toEqual(originalCards[1]);
      expect(fixture.state.moves).toEqual([]);
      expect(unloadWarns()).toBe(false);
    } finally { await finish("same-board Save", fixture); }
  });

  it("Discard retains A until consent, then opens B without a write", async () => {
    const fixture = mount();
    const user = userEvent.setup();
    try {
      await loaded(fixture, "a");
      editDescription("Discard only after consent");
      await user.click(await screen.findByRole("link", { name: "Open related card B" }));
      await screen.findByTestId("unsaved-changes-prompt");
      expect(location(fixture)).toBe(origin);
      expect.soft(screen.getByLabelText("Card description")).toHaveValue("Discard only after consent");
      expect(fixture.state.writes).toEqual([]);
      await user.click(screen.getByTestId("unsaved-changes-discard"));
      await loaded(fixture, "b");
      expect(location(fixture)).toBe(destination);
      expect([...fixture.state.saved.values()]).toEqual(originalCards);
      expect(fixture.state.writes).toEqual([]);
      expect(fixture.state.moves).toEqual([]);
      expect(unloadWarns()).toBe(false);
    } finally { await finish("same-board Discard", fixture); }
  });

  it.each(["success", "failure"] as const)("late manual Save A %s cannot close, contaminate, or discard an edited B", async (outcome) => {
    const fixture = mount(outcome);
    const user = userEvent.setup();
    try {
      await loaded(fixture, "a");
      editDescription("A submitted before departure");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(fixture.state.writes).toHaveLength(1));
      expect(fixture.state.writes[0]).toMatchObject({ cardId: "card-a", payload: { description: "A submitted before departure" } });
      expect(fixture.state.writes[0]?.status).toBeUndefined();
      expect(fixture.state.saved.get("card-a")?.description).toBe("Saved description A");

      // Use the router's actual dirty-departure path while keeping BoardView
      // mounted. This isolates late settlement from the separate link-order
      // failure above; it does not replace the sheet or onOpenCard callback.
      await act(async () => { await fixture.router.navigate(destination); });
      await screen.findByTestId("unsaved-changes-prompt");
      expect(location(fixture)).toBe(origin);
      expect(screen.getByTestId("unsaved-changes-discard")).toBeEnabled();
      await user.click(screen.getByTestId("unsaved-changes-discard"));
      await loaded(fixture, "b");
      expect(location(fixture)).toBe(destination);
      editDescription("New unsaved draft B");
      expect(unloadWarns()).toBe(true);

      await act(async () => { fixture.release(); });
      await idle(fixture);
      expect(fixture.state.writes[0]?.status).toBe(outcome === "success" ? 200 : 503);
      expect.soft(location(fixture)).toBe(destination);
      expect.soft(screen.queryByDisplayValue("Card B")).toBeInTheDocument();
      expect.soft(screen.queryByLabelText("Card description")).toHaveValue("New unsaved draft B");
      expect.soft(screen.queryAllByRole("alert")).toEqual([]);
      expect.soft(unloadWarns()).toBe(true);
      expect.soft(screen.queryByRole("button", { name: "Save" })).toBeEnabled();
      expect(fixture.state.saved.get("card-b")).toEqual(originalCards[1]);
      expect(fixture.state.moves).toEqual([]);
      record(`late A ${outcome} before B save`, fixture);

      await user.click(screen.getByRole("button", { name: "Save" }));
      await idle(fixture);
      expect(fixture.state.writes.map(({ cardId, payload }) => ({ cardId, payload }))).toEqual([
        { cardId: "card-a", payload: { description: "A submitted before departure" } },
        { cardId: "card-b", payload: { description: "New unsaved draft B" } },
      ]);
      expect(fixture.state.saved.get("card-b")?.description).toBe("New unsaved draft B");
      expect(location(fixture)).toBe(boardPath);
      expect(unloadWarns()).toBe(false);
    } finally { await finish(`late A ${outcome}`, fixture); }
  });
});
