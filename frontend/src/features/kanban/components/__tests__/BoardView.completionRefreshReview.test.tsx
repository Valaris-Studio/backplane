// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { act, screen, stubReducedMotion, userEvent, waitFor } from "@/test/test-utils";
import { renderNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import { cardKeys } from "@/lib/query-keys";
import { WebSocketContext, type WebSocketContextValue } from "@/providers/WebSocketProvider";
import type { WebSocketEvent } from "@/lib/websocket";
import type { BoardDetail, Card, Column } from "@/types/kanban";
import type { CompletionPolicy, CompletionPolicyResolution } from "@/types/completion";

// Keep the real sheet, router, query hooks and event invalidation. Only the
// heavy rich-editor renderer is substituted, as in the prior ordering suite.
vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: ({ content, onChange }: { content: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Card description" value={content} onChange={(event) => onChange(event.target.value)} />
  ),
}));

import { BoardView } from "@/features/kanban/components/BoardView";

const timestamp = "2026-10-19T02:00:00Z";
const apiPath = "/api/workspaces/acme/boards/board-1";
const origin = "/acme/boards/board-1/kanban?card=card-a";
const detailKey = cardKeys.detail("acme", "board-1", "card-a");
const original: Card = {
  id: "card-a", title: "Card A", description: "Saved description", card_type: "task",
  priority: "medium", position: 1024, column_id: "column-active", participants: [],
  due_date: null, status: "in_progress", labels: [], created_at: timestamp, updated_at: timestamp,
};
const columns: Column[] = [
  { id: "column-active", name: "In progress", column_type: "active", position: 1024 },
  { id: "column-done", name: "Done", column_type: "done", position: 2048 },
].map((column) => ({ ...column, board_id: "board-1", cards: [], created_at: timestamp, updated_at: timestamp })) as Column[];
const policy: CompletionPolicy = {
  version: 1, landing_actor: "human", landing_methods: ["external"], source_review: "none",
  review_role: null, require_forge_checks: false, postmerge_validation: null,
  evidence_only: { enabled: false, approval: "none", review_role: null },
  dependency_release: "done", auto_complete: true,
};
const resolution: CompletionPolicyResolution = {
  override: policy, workspace_policy: null, effective_policy: policy, origin: "board",
  policy_hash: "synthetic-policy", capabilities: {}, incompatibilities: [],
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function mount() {
  const patch = deferred(), heldRead = deferred();
  const subscribers = new Map<string, Set<(event: WebSocketEvent) => void>>();
  const state = {
    saved: structuredClone(original), accepted: false, holdNextDetail: false,
    reads: [] as { snapshot: Card; held: boolean; completed: boolean }[],
    writes: [] as { payload: Record<string, unknown>; committed: boolean; response?: Card }[],
    frames: [] as WebSocketEvent[], unexpected: [] as string[],
  };
  const socket: WebSocketContextValue = {
    status: "connected",
    subscribe(pattern, handler) {
      let handlers = subscribers.get(pattern);
      if (!handlers) { handlers = new Set(); subscribers.set(pattern, handlers); }
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
  };
  const emit = (event: string, payload: Record<string, unknown>) => {
    const frame: WebSocketEvent = { event, payload, timestamp, event_id: `synthetic-${state.frames.length}` };
    state.frames.push(frame);
    for (const [pattern, handlers] of subscribers) {
      if (pattern === event || (pattern.endsWith("*") && event.startsWith(pattern.slice(0, -1)))) {
        for (const handler of handlers) handler(frame);
      }
    }
  };
  const activity = (action: string, changes: Record<string, unknown>) => {
    const payload = { entity_type: "card", entity_id: "card-a", action, actor_id: "user-me", board_id: "board-1", changes };
    emit(`activity.card.${action}`, payload);
    emit(`card.${action}`, payload);
  };
  const get = (path: string, body: Parameters<typeof HttpResponse.json>[0]) => http.get(path, () => HttpResponse.json(body));
  server.use(
    http.get(apiPath, () => {
      const board: BoardDetail = {
        id: "board-1", slug: "work", name: "Work", description: "", tags: [], workspace_id: "workspace-1",
        created_at: timestamp, updated_at: timestamp,
        columns: columns.map((column) => ({ ...column, cards: state.saved.column_id === column.id ? [structuredClone(state.saved)] : [] })),
      };
      return HttpResponse.json(board);
    }),
    http.get(`${apiPath}/cards/card-a`, async () => {
      const read = { snapshot: structuredClone(state.saved), held: state.holdNextDetail, completed: false };
      state.holdNextDetail = false;
      state.reads.push(read);
      if (read.held) await heldRead.promise;
      read.completed = true;
      return HttpResponse.json(read.snapshot);
    }),
    http.get(`${apiPath}/cards/card-a/dependencies`, () => HttpResponse.json({ depends_on: [], blocks: [] })),
    http.patch(`${apiPath}/cards/card-a`, async ({ request }) => {
      const write = { payload: await request.json() as Record<string, unknown>, committed: false, response: undefined as Card | undefined };
      state.writes.push(write);
      if (state.writes.length === 1) await patch.promise;
      state.saved = { ...state.saved, ...write.payload };
      write.committed = true;
      write.response = structuredClone(state.saved);
      // Priority is not a completion-contract field. Its normal card activity
      // twins still publish; neither is a fabricated completion refresh.
      activity("updated", { fields: Object.keys(write.payload) });
      return HttpResponse.json(write.response);
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
    get(`${apiPath}/completion/policy`, resolution),
    http.get(`${apiPath}/completion/cards/card-a`, () => HttpResponse.json({
      completion_mode: "source", attempts: [], candidate: state.accepted ? {
        id: "candidate-1", status: "accepted", source_sha: "a".repeat(40), merge_sha: "b".repeat(40),
        pr_url: null, policy_hash: "synthetic-policy", contract_hash: "synthetic-contract", summary: null,
      } : null,
    })),
    http.all("/api/*", ({ request }) => {
      state.unexpected.push(`${request.method} ${request.url}`);
      return HttpResponse.json({ detail: "Unexpected fixture request" }, { status: 500 });
    }),
  );
  const rendered = renderNavigationRouter([
    { path: "/:slug/boards/:boardId/kanban", element: <WebSocketContext.Provider value={socket}><BoardView /></WebSocketContext.Provider> },
  ], { initialEntries: [origin] });
  // Match the real shell's freshness contract before the async board read
  // mounts the detail observer. No cache value or observer result is injected.
  rendered.client.setQueryDefaults(detailKey, { staleTime: 30_000, refetchOnWindowFocus: false });
  function acceptCompletion(hold: boolean) {
    state.saved = { ...state.saved, column_id: "column-done" };
    state.accepted = true;
    state.holdNextDetail = hold;
    activity("moved", { column_id: { old: "column-active", new: "column-done" }, from_column: "In progress", to_column: "Done" });
    emit("completion.updated", { board_id: "board-1", card_id: "card-a", candidate_id: "candidate-1", status: "accepted" });
  }
  return { ...rendered, state, subscribers, acceptCompletion, releasePatch: patch.resolve, releaseRead: heldRead.resolve };
}

type Fixture = ReturnType<typeof mount>;
function unloadWarns() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
function columnControl() { return document.querySelector<HTMLButtonElement>('button[id$="-column"]')!; }
function record(phase: string, fixture: Fixture) {
  console.info("A01_COMPLETION_REFRESH", JSON.stringify({
    phase, saved: fixture.state.saved, reads: fixture.state.reads, writes: fixture.state.writes,
    frames: fixture.state.frames, unexpected: fixture.state.unexpected,
    cache: fixture.client.getQueryData<Card>(detailKey), fetching: fixture.client.isFetching({ queryKey: detailKey, exact: true }),
    invalidated: fixture.client.getQueryState(detailKey)?.isInvalidated,
    visibleColumn: columnControl()?.textContent,
    visibleTitle: document.querySelector<HTMLInputElement>('input[id$="-title"]')?.value,
    unloadWarns: unloadWarns(),
  }));
}
async function ready(fixture: Fixture) {
  const title = await screen.findByDisplayValue("Card A");
  await screen.findByText("No completion evidence submitted yet.");
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  expect(fixture.state.reads).toHaveLength(1);
  expect(fixture.subscribers.get("completion.*")?.size).toBeGreaterThan(0);
  expect(columnControl()).toHaveTextContent("In progress");
  expect(unloadWarns()).toBe(false);
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  return title;
}
async function cleanUp(fixture: Fixture) {
  fixture.releaseRead(); fixture.releasePatch();
  await waitFor(() => expect(fixture.client.isMutating()).toBe(0));
  await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
  record("cleanup", fixture);
  fixture.unmount(); fixture.client.clear();
}

beforeEach(() => stubReducedMotion(true));
afterEach(() => stubReducedMotion(false));

for (const timing of ["before-save", "during-write"] as const) {
  it(`${timing}: a completion refresh survives cancellation and adopts an untouched remote column`, async () => {
    const fixture = mount(), user = userEvent.setup();
    try {
      const title = await ready(fixture);
      await user.click(document.querySelector<HTMLButtonElement>('button[id$="-priority"]')!);
      await user.click(await screen.findByRole("option", { name: "High" }));
      if (timing === "before-save") {
        act(() => fixture.acceptCompletion(true));
        await waitFor(() => expect(fixture.state.reads.some((read) => read.held)).toBe(true));
        expect(fixture.client.isFetching({ queryKey: detailKey, exact: true })).toBe(1);
      }
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(fixture.state.writes).toHaveLength(1));
      expect(fixture.state.writes[0]!.payload).toEqual({ priority: "high" });
      await screen.findByRole("button", { name: "Saving..." });
      if (timing === "during-write") {
        act(() => fixture.acceptCompletion(true));
        await waitFor(() => expect(fixture.state.reads.some((read) => read.held)).toBe(true));
        expect(fixture.client.isFetching({ queryKey: detailKey, exact: true })).toBe(1);
      }
      const held = fixture.state.reads.find((read) => read.held)!;
      expect(held.snapshot).toMatchObject({ column_id: "column-done", priority: "medium", title: "Card A" });
      expect(held.completed).toBe(false);
      expect(fixture.state.writes[0]!.committed).toBe(false);
      await user.clear(title); await user.type(title, "Later unsaved title");
      expect(unloadWarns()).toBe(true);
      record(`${timing}: actual completion GET held across pending priority PATCH`, fixture);
      fixture.releasePatch();
      await waitFor(() => expect(fixture.client.isMutating()).toBe(0));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Saving..." })).not.toBeInTheDocument());
      fixture.releaseRead();
      await waitFor(() => expect(held.completed).toBe(true));
      await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
      await screen.findByText("Completion accepted");
      expect(fixture.state.saved).toMatchObject({ column_id: "column-done", priority: "high", title: "Card A" });
      expect(title).toHaveValue("Later unsaved title");
      expect(unloadWarns()).toBe(true);
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
      expect(fixture.state.unexpected).toEqual([]);
      record(`${timing}: completion visible and writes settled; untouched column must converge`, fixture);
      // No manual invalidation, refetch, reopen, timer advance or second event
      // repairs the dropped signal for the implementation under test.
      await waitFor(() => expect(columnControl()).toHaveTextContent("Done"));
      expect(fixture.client.getQueryData<Card>(detailKey)).toMatchObject({ column_id: "column-done", priority: "high" });
      expect(title).toHaveValue("Later unsaved title");
      expect(unloadWarns()).toBe(true);
      expect(fixture.state.writes).toHaveLength(1);
      expect(fixture.router.state.location.search).toBe("?card=card-a");
    } finally { await cleanUp(fixture); }
  });
}

it("without a save, completion adopts the remote column and preserves a local title draft", async () => {
  const fixture = mount(), user = userEvent.setup();
  try {
    const title = await ready(fixture);
    await user.clear(title); await user.type(title, "Later unsaved title");
    act(() => fixture.acceptCompletion(false));
    await screen.findByText("Completion accepted");
    await waitFor(() => expect(columnControl()).toHaveTextContent("Done"));
    await waitFor(() => expect(fixture.client.isFetching()).toBe(0));
    expect(fixture.client.getQueryData<Card>(detailKey)).toMatchObject({ column_id: "column-done", priority: "medium" });
    expect(title).toHaveValue("Later unsaved title");
    expect(unloadWarns()).toBe(true);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(fixture.state.writes).toEqual([]);
    expect(fixture.state.unexpected).toEqual([]);
    record("unaffected control: actual event refresh adopted remote column", fixture);
  } finally { await cleanUp(fixture); }
});

const sourceFiles = [
  "src/features/kanban/components/__tests__/BoardView.completionRefreshReview.test.tsx",
  "src/features/kanban/components/BoardView.tsx", "src/features/kanban/components/CardDetailSheet.tsx",
  "src/features/kanban/api/use-cards.ts", "src/features/kanban/hooks/use-optimistic-card-move.ts",
  "src/features/kanban/api/use-card-detail.ts", "src/features/kanban/api/use-completion.ts", "src/hooks/useDomainSync.ts",
];
const hashes = () => Object.fromEntries(sourceFiles.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
const inputsBefore = hashes();
afterAll(() => console.info("A01_COMPLETION_REFRESH_INPUTS", JSON.stringify({ inputsBefore, inputsAfter: hashes() })));
