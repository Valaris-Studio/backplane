// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, stubReducedMotion, userEvent, waitFor } from "@/test/test-utils";
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

describe("current editable draft survives an earlier pending Save", () => {
  for (const entry of ["footer", "modal"] as const) {
    it(`${entry} Save keeps additional title edits available after the submitted snapshot succeeds`, async () => {
      const fixture = mount("success");
      const user = userEvent.setup();
      try {
        await loaded(fixture, "a");
        const title = screen.getByDisplayValue("Card A");
        await user.clear(title);
        await user.type(title, "Submitted title A");
        if (entry === "modal") {
          await user.keyboard("{Escape}");
          await user.click(await screen.findByTestId("unsaved-changes-save"));
        } else await user.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(fixture.state.writes).toHaveLength(1));
        expect(fixture.state.writes[0]!.payload).toEqual({ title: "Submitted title A" });
        expect(title).toBeEnabled();
        await user.clear(title);
        await user.type(title, "Additional unsent title A");
        expect(title).toHaveValue("Additional unsent title A");
        expect(unloadWarns()).toBe(true);
        record(`pending ${entry} before response`, fixture);
        await act(async () => {
          fixture.release();
          await waitFor(() => expect(fixture.client.isMutating()).toBe(0));
        });
        await idle(fixture);
        expect(fixture.state.saved.get("card-a")?.title).toBe("Submitted title A");
        expect(fixture.state.writes).toHaveLength(1);
        expect(fixture.state.moves).toEqual([]);
        await waitFor(() => expect(screen.queryByDisplayValue("Additional unsent title A")).toBeVisible());
        expect(location(fixture)).toBe(origin);
        expect(unloadWarns()).toBe(true);
        expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
      } finally { await finish(`pending ${entry} after response`, fixture); }
    });
  }

  it("control: pending footer Save with no later edits commits its snapshot and closes", async () => {
    const fixture = mount("success");
    const user = userEvent.setup();
    try {
      await loaded(fixture, "a");
      const title = screen.getByDisplayValue("Card A");
      await user.clear(title);
      await user.type(title, "Submitted title A");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(fixture.state.writes).toHaveLength(1));
      fixture.release();
      await waitFor(() => expect(screen.queryByLabelText("Card description")).not.toBeInTheDocument());
      await idle(fixture);
      expect(location(fixture)).toBe(boardPath);
      expect(fixture.state.saved.get("card-a")?.title).toBe("Submitted title A");
      expect(fixture.state.writes).toHaveLength(1);
      expect(fixture.state.moves).toEqual([]);
      expect(unloadWarns()).toBe(false);
    } finally { await finish("pending Save unchanged control", fixture); }
  });
});


describe("later edits back to the original value survive pending Save", () => {
  for (const entry of ["footer", "modal"] as const) {
    for (const field of ["title", "description"] as const) {
      it(`${entry} Save preserves a later ${field} undo and an explicit second Save commits it`, async () => {
        const fixture = mount("success");
        const user = userEvent.setup();
        const original = field === "title" ? "Card A" : "Saved description A";
        const submitted = field === "title" ? "Submitted title A" : "Submitted description A";
        try {
          await loaded(fixture, "a");
          const control = field === "title"
            ? screen.getByDisplayValue(original)
            : screen.getByLabelText("Card description");
          await user.clear(control);
          await user.type(control, submitted);
          if (entry === "modal") {
            await user.keyboard("{Escape}");
            await user.click(await screen.findByTestId("unsaved-changes-save"));
          } else await user.click(screen.getByRole("button", { name: "Save" }));
          await waitFor(() => expect(fixture.state.writes).toHaveLength(1));
          expect(fixture.state.writes[0]!.payload).toEqual({ [field]: submitted });
          expect(fixture.state.saved.get("card-a")?.[field]).toBe(original);
          expect(control).toBeEnabled();
          await user.clear(control);
          await user.type(control, original);
          expect(control).toHaveValue(original);
          record(`pending ${entry} ${field} undo before response`, fixture);

          // The old saved value is now a later edit relative to the submitted
          // request. Its acknowledgement must not mistake that edit for an
          // untouched field merely because it matches the pre-save baseline.
          await act(async () => {
            fixture.release();
            await waitFor(() => expect(fixture.client.isMutating()).toBe(0));
          });
          await idle(fixture);
          expect(fixture.state.saved.get("card-a")?.[field]).toBe(submitted);
          expect(fixture.state.writes).toHaveLength(1);
          expect(fixture.state.moves).toEqual([]);
          expect(fixture.state.unexpected).toEqual([]);
          expect(fixture.state.saved.get("card-b")).toEqual(originalCards[1]);
          expect(location(fixture)).toBe(origin);
          record(`pending ${entry} ${field} undo after response`, fixture);
          expect.soft(control).toBeVisible();
          expect.soft(control).toHaveValue(original);
          expect.soft(unloadWarns()).toBe(true);
          const secondSave = screen.getByRole("button", { name: "Save" });
          expect(secondSave).toBeEnabled();

          // Only this explicit new action may persist the edit made after the
          // first request; the held request has already settled exactly once.
          await user.click(secondSave);
          await waitFor(() => expect(fixture.state.writes).toHaveLength(2));
          await idle(fixture);
          expect(fixture.state.writes.map((write) => write.payload)).toEqual([
            { [field]: submitted }, { [field]: original },
          ]);
          expect(fixture.state.saved.get("card-a")?.[field]).toBe(original);
          expect(fixture.state.saved.get("card-b")).toEqual(originalCards[1]);
          expect(fixture.state.moves).toEqual([]);
          expect(fixture.state.unexpected).toEqual([]);
          await waitFor(() => expect(screen.queryByLabelText("Card description")).not.toBeInTheDocument());
          expect(location(fixture)).toBe(boardPath);
          expect(unloadWarns()).toBe(false);
        } finally { await finish(`pending ${entry} ${field} undo complete`, fixture); }
      });
    }
  }
});
