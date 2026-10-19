// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { screen, stubReducedMotion, userEvent, waitFor } from "@/test/test-utils";
import { renderNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import { WebSocketContext } from "@/providers/WebSocketProvider";
import type { BoardDetail, Card, Column } from "@/types/kanban";

// Only the heavy editor renderer is replaced. Footer Cancel, BoardView, the
// sheet lifecycle, router, guards, mutations and HTTP cache behavior are real.
vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: ({ content, onChange }: { content: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Card description" value={content} onChange={(event) => onChange(event.target.value)} />
  ),
}));

import { BoardView } from "../BoardView";

const timestamp = "2026-10-18T22:00:00Z";
const boardPath = "/acme/boards/board-1/kanban?filter=mine&sort=priority";
const origin = `${boardPath}&card=card-a`;
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

function mount(firstMoveStatus = 409) {
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
        columns: [column, { ...column, id: "column-2", name: "Queued", column_type: "backlog" as const, position: 2048 }].map((item) => ({ ...item, cards: [...state.saved.values()].filter((card) => card.column_id === item.id) })),
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
      const cardId = String(params.cardId);
      const payload = await request.json() as { column_id: string; position: number };
      state.moves.push({ cardId, payload });
      if (state.moves.length === 1 && firstMoveStatus !== 200) return HttpResponse.json({ detail: "Synthetic move rejected" }, { status: firstMoveStatus });
      const saved = { ...state.saved.get(cardId)!, ...payload };
      state.saved.set(cardId, saved);
      return HttpResponse.json(saved);
    }),
    http.patch(`${apiPath}/cards/:cardId`, async ({ params, request }) => {
      const cardId = String(params.cardId);
      const payload = await request.json() as Record<string, unknown>;
      const before = structuredClone(state.saved.get(cardId)!);
      const receipt: WriteReceipt = { cardId, payload, before };
      state.writes.push(receipt);
      // The API applies only fields supplied by CardUpdate(exclude_unset=True).
      const acknowledged = payload.description === submitted ? { ...payload, description: canonicalDescription } : payload;
      const saved = { ...state.saved.get(cardId)!, ...acknowledged, updated_at: "2026-10-18T22:01:00Z" };
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
  console.info("A01_FINAL_SEAMS_UNIT_RECEIPT", JSON.stringify({
    name, location: location(fixture), saved: [...fixture.state.saved.values()],
    writes: fixture.state.writes, moves: fixture.state.moves, detailReads: fixture.state.detailReads,
    unexpected: fixture.state.unexpected,
    visibleDescription: screen.queryByLabelText("Card description")?.getAttribute("value")
      ?? (screen.queryByLabelText("Card description") as HTMLTextAreaElement | null)?.value,
    alerts: screen.queryAllByRole("alert").map((element) => element.textContent), unloadWarns: unloadWarns(),
    prompts: screen.queryAllByTestId("unsaved-changes-prompt").length,
    title: (document.querySelector('input[id$="-title"]') as HTMLInputElement | null)?.value,
    focus: document.activeElement?.outerHTML,
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


const submitted = "{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Reviewed café 🙂 description\"}]}]}";
const canonicalDescription = "{\"type\": \"doc\", \"content\": [{\"type\": \"paragraph\", \"content\": [{\"type\": \"text\", \"text\": \"Reviewed caf\\u00e9 \\ud83d\\ude42 description\"}]}]}";
const remoteDescription = JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Later remote description" }] }] });

async function chooseMoveAndSave(fixture: Fixture, user: ReturnType<typeof userEvent.setup>) {
  await user.click(document.querySelector<HTMLButtonElement>('button[id$="-column"]')!);
  await user.click(await screen.findByRole("option", { name: "Queued" }));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(await screen.findByTestId("unsaved-changes-save"));
  await waitFor(() => expect(fixture.state.writes).toHaveLength(1));
  await waitFor(() => expect(fixture.state.moves).toHaveLength(1));
  await idle(fixture);
}

describe("backend-canonical description acknowledgments survive partial retry", () => {
  it("does not replay canonicalized description PATCH or overwrite a later remote description when retrying only the rejected move", async () => {
    const fixture = mount();
    const user = userEvent.setup();
    try {
      expect(JSON.parse(submitted)).toEqual(JSON.parse(canonicalDescription));
      expect(submitted).not.toBe(canonicalDescription);
      await loaded(fixture, "a");
      editDescription(submitted);
      await chooseMoveAndSave(fixture, user);
      expect(fixture.state.writes[0]).toMatchObject({ cardId: "card-a", payload: { description: submitted }, status: 200, after: { description: canonicalDescription } });
      expect(fixture.state.saved.get("card-a")?.description).toBe(canonicalDescription);
      expect(location(fixture)).toBe(origin);
      expect(screen.getByLabelText("Card description")).toHaveValue(submitted);
      expect(screen.getByTestId("unsaved-changes-save")).toBeEnabled();
      expect(unloadWarns()).toBe(true);
      const reads = [...fixture.state.reads];
      const details = [...fixture.state.detailReads];
      fixture.state.saved.set("card-a", { ...fixture.state.saved.get("card-a")!, description: remoteDescription });
      expect(fixture.state.reads).toEqual(reads);
      expect(fixture.state.detailReads).toEqual(details);
      record("canonical partial before retry with unobserved remote description", fixture);
      await user.click(screen.getByTestId("unsaved-changes-save"));
      await waitFor(() => expect(location(fixture)).toBe(boardPath));
      await idle(fixture);
      expect.soft(fixture.state.writes.map((item) => item.payload)).toEqual([{ description: submitted }]);
      expect.soft(fixture.state.saved.get("card-a")?.description).toBe(remoteDescription);
      expect(fixture.state.moves).toHaveLength(2);
      expect(fixture.state.saved.get("card-a")?.column_id).toBe("column-2");
      expect(fixture.state.saved.get("card-b")).toEqual(originalCards[1]);
    } finally { await finish("canonical partial after retry", fixture); }
  });

  it("control: a successful title PATCH is not replayed when only the move needs retry", async () => {
    const fixture = mount();
    const user = userEvent.setup();
    try {
      await loaded(fixture, "a");
      fireEvent.change(screen.getByDisplayValue("Card A"), { target: { value: "Committed title A" } });
      await chooseMoveAndSave(fixture, user);
      fixture.state.saved.set("card-a", { ...fixture.state.saved.get("card-a")!, title: "Later remote title A" });
      await user.click(screen.getByTestId("unsaved-changes-save"));
      await waitFor(() => expect(location(fixture)).toBe(boardPath));
      await idle(fixture);
      expect(fixture.state.writes.map((item) => item.payload)).toEqual([{ title: "Committed title A" }]);
      expect(fixture.state.saved.get("card-a")?.title).toBe("Later remote title A");
      expect(fixture.state.moves).toHaveLength(2);
    } finally { await finish("title partial control", fixture); }
  });

  it("control: canonical field response and successful move complete the approved departure", async () => {
    const fixture = mount(200);
    const user = userEvent.setup();
    try {
      await loaded(fixture, "a");
      editDescription(submitted);
      await chooseMoveAndSave(fixture, user);
      await waitFor(() => expect(screen.queryByLabelText("Card description")).not.toBeInTheDocument());
      expect(location(fixture)).toBe(boardPath);
      expect(fixture.state.writes.map((item) => item.payload)).toEqual([{ description: submitted }]);
      expect(fixture.state.saved.get("card-a")?.description).toBe(canonicalDescription);
      expect(fixture.state.moves).toHaveLength(1);
      expect(unloadWarns()).toBe(false);
    } finally { await finish("canonical successful control", fixture); }
  });
});
