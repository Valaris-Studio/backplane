// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import type { BoardDetail, Card } from "../../src/types/kanban";
import type { Note } from "../../src/types/note";
import type { HistoryGeneration, HistoryWindow } from "../../src/features/timeline/types";
import { installResourceFixture, ids, resourceApi, type ResourceFixture } from "./a06-resource-destination";
import { boardId, slug, stamp, type RequestReceipt } from "./session-window-fixture";

export { boardId, slug, bodyFor } from "./a06-resource-destination";
export { sha } from "./session-window-fixture";
export type Kind = "card" | "note" | "resource";
export const ownerA = "timeline-owner-a";
export const ownerB = "timeline-owner-b";
export const cardId = "70000000-0000-4000-8000-000000000001";
export const noteId = "70000000-0000-4000-8000-000000000002";
export const resourceId = ids("board").hidden;
export const columnId = "70000000-0000-4000-8000-000000000003";
export const timelinePath = `/${slug}/boards/${boardId}/timeline`;
export const boardApi = `/api/workspaces/${slug}/boards/${boardId}`;
export const timelineApi = `${boardApi}/timeline`;
export const sequence = (offset: number) => (9007199254740993n + BigInt(offset)).toString();
export const targetOffset = 450;
export const targetSeq = sequence(targetOffset);
export const momentURL = `${timelinePath}?at=${targetSeq}`;
export const targetSummary = "Exact retained browser moment";
export const historicalTitle = "Historical card title at this event";
export const currentTitle = "Current card title after the event";
export const currentNoteTitle = "Current shared note after the event";
export const privateFlag = "PRIVATE local timeline flag";
export const privateSearch = "PRIVATE history lookup";
export const actorName = "Synthetic historical actor";
export const searchMatch = "Exact retained browser search result";
export const currentHref = (kind: Kind) => kind === "card" ? `/${slug}/boards/${boardId}/kanban?card=${cardId}`
  : kind === "note" ? `/${slug}/boards/${boardId}/notes?note=${noteId}`
    : `/${slug}/boards/${boardId}/resources?resource=${resourceId}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const doc = (text: string) => JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const currentCard: Card = { id: cardId, title: currentTitle, description: doc("Current authorized card body"), card_type: "task",
  priority: "medium", column_id: columnId, position: 1024, participants: [], status: "todo", due_date: null,
  labels: [], created_at: stamp, updated_at: stamp };
const currentNote: Note = { id: noteId, workspace_id: "workspace-synthetic", board_id: boardId, card_id: null,
  title: currentNoteTitle, content: doc("Current authorized shared note body"), pinned: false, kind: "user_note",
  failure_class: null, findings: null, source_execution_id: null, created_by: ownerA, created_at: stamp, updated_at: stamp };
const snapshot = (title = historicalTitle) => ({ id: cardId, title, card_type: "task", priority: "medium", column_id: columnId,
  position: 1024, status: "todo", labels: [], participants: [] });
const columns = [{ id: columnId, name: "Recorded column", column_type: null, position: 1024 }];
const coverage = { quality: "reconstructed" as const, unknown_origin: false, missing_structural_snapshots: "0", reasons: [] };

export function generationStore() {
  return { byRequest: new Map<string, HistoryGeneration>(), expired: new Set<string>(),
    created: [] as { owner: string; requestId: string; generationId: string }[] };
}
export type GenerationStore = ReturnType<typeof generationStore>;
export interface TimelineReceipt extends RequestReceipt {
  owner: string; generationId?: string; requestId?: string; kind: "owner" | "generation" | "window" | "overview" | "search" | "live" | "current" | "shell";
  historyState?: unknown; intentionalError?: boolean; completedAt?: number;
}
export interface TimelineFixture extends ResourceFixture {
  timelineRequests: TimelineReceipt[];
  store: GenerationStore;
  owner: string;
  ownerStatus: number;
  windowStatus: number;
  missing: "none" | "server" | "legacy";
  holdOwner: boolean;
  holdGeneration: boolean;
  ownerWaiters: (() => void)[];
  generationWaiters: (() => void)[];
  kind: Kind;
  releaseOwner: () => void;
  releaseGeneration: () => void;
  releaseTimeline: () => void;
  emitActivity: () => void;
}

function event(offset: number, kind: Kind): HistoryWindow["events"][number] {
  const target = offset === targetOffset;
  return { id: `timeline-browser-event-${offset}`, seq: sequence(offset), workspace_id: "workspace-synthetic", board_id: boardId,
    actor_id: "historical-actor-id", actor_name: actorName, actor_email: null, agent_id: null,
    entity_type: target ? kind : "note", entity_id: target ? kind === "card" ? cardId : kind === "note" ? noteId : resourceId : noteId,
    entity_title: target ? kind === "card" ? historicalTitle : `Historical ${kind} title` : "Another recorded event", action: "updated",
    summary: target ? targetSummary : `Retained event ${offset}`, changes: null, via_api_key: null,
    created_at: new Date(Date.UTC(2026, 9, 8) + offset * 1000).toISOString(),
    before_state: target && kind === "card" ? snapshot("Before exact event") : null,
    after_state: target && kind === "card" ? snapshot() : null };
}

function windowAt(id: string, offset: number, kind: Kind): HistoryWindow {
  const offsets = [offset, offset + 1, offset + 2].filter((value) => value <= 10000);
  return { status: "ready", generation_id: id, anchor: { through_seq: sequence(offset - 1),
    state: { columns, cards: [snapshot(kind === "card" && offset === targetOffset ? "Before exact event" : historicalTitle)] }, coverage },
    events: offsets.map((value) => event(value, kind)), window: { first_seq: sequence(offset), last_seq: sequence(offsets.at(-1)!),
      previous_cursor: offset > 0 ? `window-before-${offset}` : null, next_cursor: offsets.at(-1)! < 10000 ? `window-after-${offsets.at(-1)}` : null }, coverage };
}

/** Extend the preserved actual-shell fixture; never replace the application UI. */
export async function installTimelineFixture(page: Page, locale = "en", options: { kind?: Kind; owner?: string; store?: GenerationStore } = {}): Promise<TimelineFixture> {
  const inherited = await installResourceFixture(page, locale);
  const state: TimelineFixture = Object.assign(inherited, {
    timelineRequests: [], store: options.store ?? generationStore(), owner: options.owner ?? ownerA, ownerStatus: 200,
    windowStatus: 200, missing: "none" as const, kind: options.kind ?? "card", holdOwner: false, holdGeneration: false,
    ownerWaiters: [] as (() => void)[], generationWaiters: [] as (() => void)[],
    releaseOwner() { state.holdOwner = false; state.ownerWaiters.splice(0).forEach((resolve) => resolve()); },
    releaseGeneration() { state.holdGeneration = false; state.generationWaiters.splice(0).forEach((resolve) => resolve()); },
    releaseTimeline() { state.releaseOwner(); state.releaseGeneration(); state.releaseResources(); state.release(); },
    emitActivity() {
      assert(state.socket && state.subscriptions.includes("activity.*"));
      const frame = { event: "activity.card.updated", event_id: `timeline-live-${state.socketLedger.length}`, timestamp: stamp,
        payload: { board_id: boardId, entity_id: cardId } };
      state.socketLedger.push({ kind: "event", at: Date.now(), connection: state.socketsOpened, payload: frame });
      state.socket.send(JSON.stringify(frame));
    },
  });
  const inheritedPaths = new Set(["/api/auth/modes", "/api/auth/setup-status", "/api/workspaces", "/api/notifications", "/api/notifications/unread-count",
    `/api/workspaces/${slug}`, `/api/workspaces/${slug}/members`, `/api/workspaces/${slug}/sessions/summary`,
    `/api/workspaces/${slug}/notifications`, `/api/workspaces/${slug}/notifications/unread-count`,
    `/api/workspaces/${slug}/approvals`, `/api/workspaces/${slug}/approvals/unread-count`,
    `${boardApi}/health`, `${boardApi}/loop/status`, `/api/workspaces/${slug}/executions`, `/api/workspaces/${slug}/metrics/agents`,
    `/api/workspaces/${slug}/config`]);
  const ownedPaths = new Set(["/api/me", "/api/me/companion/installations", `/api/workspaces/${slug}/members`, boardApi, `/api/workspaces/${slug}/boards`, `${boardApi}/cards`, `${boardApi}/cards/${cardId}`,
    `${boardApi}/cards/${cardId}/dependencies`, `${boardApi}/cards/${cardId}/sessions`, `${boardApi}/completion/policy`, `${boardApi}/completion/cards/${cardId}`,
    `/api/workspaces/${slug}/executions/skipped-card-ids`, `${boardApi}/notes`, `${boardApi}/notes/${noteId}`,
    `/api/workspaces/${slug}/notes/${noteId}/sessions`, `${boardApi}/notes/${noteId}/publication-revision/presence`,
    `/api/workspaces/${slug}/config/completion-context-impact`]);
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!path.startsWith("/api/")) return route.fallback();
    if (url.origin !== new URL(page.url()).origin) {
      state.unexpected.push(`External A05 API refused: ${url.origin}${path}`); return route.abort("blockedbyclient");
    }
    const timelineMatch = path.match(new RegExp(`^${timelineApi}/generations(?:/([0-9a-f-]{36})/(overview|window|search|live-head))?$`, "i"));
    if (!timelineMatch && !ownedPaths.has(path)) {
      if (inheritedPaths.has(path) || (["board", "workspace"] as const).some((scope) => path === resourceApi(scope) || path.startsWith(`${resourceApi(scope)}/`))) return route.fallback();
      state.unexpected.push(`Unexpected A05 API: ${request.method()} ${path}${url.search}`);
      return route.fulfill({ status: 418, json: { detail: "Outside the A05 synthetic allowlist" } });
    }
    const genId = timelineMatch?.[1], action = timelineMatch?.[2];
    const receipt: TimelineReceipt = { path, method: request.method(), query: url.search, mode: null, callId: null, cursor: url.searchParams.get("cursor"),
      startedAt: Date.now(), owner: state.owner, generationId: genId, kind: !timelineMatch ? path === "/api/me" ? "owner" : path === boardApi || path.endsWith("/boards") ? "shell" : "current"
        : action === "live-head" ? "live" : (action ?? "generation") as TimelineReceipt["kind"] };
    state.requests.push(receipt); state.timelineRequests.push(receipt); state.inflight += 1;
    try {
      assert(!request.headers().authorization && !request.headers().cookie, "No synthetic credentials");
      let value: unknown, status = 200;
      if (timelineMatch && !action) {
        assert.equal(request.method(), "POST");
        const payload = request.postDataJSON() as { request_id: string };
        assert.deepEqual(Object.keys(payload), ["request_id"]);
        assert(uuid.test(payload.request_id));
        receipt.requestId = payload.request_id; receipt.payload = request.postData() ?? "";
        receipt.historyState = await page.evaluate(() => history.state);
        // Actual backend uniqueness is board + request_id, never owner + request_id.
        const key = `${boardId}:${payload.request_id}`;
        let generation = state.store.byRequest.get(key);
        status = generation ? state.store.expired.has(generation.id) ? 410 : 200 : 201;
        if (!generation) {
          const id = `71000000-0000-4000-8000-${String(state.store.created.length + 1).padStart(12, "0")}`;
          generation = { id, board_id: boardId, created_at: stamp, expires_at: "2099-10-09T12:00:00Z", first_seq: sequence(0), head_seq: sequence(10000), event_count: "10001" };
          state.store.byRequest.set(key, generation);
          state.store.created.push({ owner: receipt.owner, requestId: payload.request_id, generationId: id });
        }
        receipt.generationId = generation.id;
        value = generation;
        receipt.status = status;
        // Commit before holding delivery so actual reload can exercise response-loss idempotency.
        if (state.holdGeneration) await new Promise<void>((resolve) => state.generationWaiters.push(resolve));
      } else if (timelineMatch) {
        assert.equal(request.method(), "GET");
        const generation = [...state.store.byRequest.values()].find((item) => item.id === genId);
        assert(generation, "Generation reads require an actually established identity");
        status = state.store.expired.has(genId!) ? 410 : action === "window" ? state.windowStatus : 200;
        if (action === "overview") value = { generation_id: genId, first_seq: sequence(0), head_seq: sequence(10000), event_count: "10001",
          first_at: "2026-10-08T00:00:00Z", last_at: "2026-10-08T02:46:40Z", buckets: [{ start_at: "2026-10-08T00:00:00Z", end_at: "2026-10-08T02:46:41Z", count: "10001", first_seq: sequence(0), last_seq: sequence(10000) }] };
        else if (action === "search") {
          assert.equal(url.searchParams.get("q"), privateSearch);
          value = { generation_id: genId, scope: "generation", matches: [{ id: "target-match", seq: targetSeq, created_at: "2026-10-08T00:07:30Z", summary: searchMatch }], next_cursor: null };
        } else if (action === "live-head") value = { generation_id: genId, observed_at: stamp, head_seq: sequence(10000), state: { columns, cards: [snapshot(currentTitle)] }, coverage };
        else {
          const at = url.searchParams.get("at_seq"), cursor = url.searchParams.get("cursor");
          assert(Number(url.searchParams.get("limit")) > 0 && Number(url.searchParams.get("limit")) <= 500);
          let offset = at ? Number(BigInt(at) - BigInt(sequence(0))) : 9998;
          if (cursor) { const match = /^window-(before|after)-(\d+)$/.exec(cursor); assert(match); offset = Number(match[2]) + (match[1] === "before" ? -3 : 1); }
          if (url.searchParams.has("at_time")) offset = targetOffset;
          if (at === targetSeq && state.missing === "server") status = 404;
          if (at === targetSeq && state.missing === "legacy") offset = targetOffset + 1;
          assert(offset >= 0 && offset <= 10000, "This fixture admits only its retained sequence range");
          value = windowAt(genId!, offset, state.kind);
        }
      } else {
        assert.equal(request.method(), "GET", "Current destinations are read-only in this lane");
        const board: BoardDetail = { id: boardId, slug: "synthetic-timeline-board", workspace_id: "workspace-synthetic", name: "Synthetic timeline board",
          description: "Historical and current evidence differ deliberately", tags: [], is_frozen: false, loop_configured: false, created_at: stamp, updated_at: stamp,
          columns: [{ id: columnId, board_id: boardId, name: "Current column", column_type: "active", position: 1024, cards: [currentCard], created_at: stamp, updated_at: stamp }] };
        if (path === "/api/me") { status = state.ownerStatus; value = { id: receipt.owner, name: receipt.owner, email: `${receipt.owner}@example.test`, avatar_url: null };
          if (state.holdOwner) await new Promise<void>((resolve) => state.ownerWaiters.push(resolve)); }
        else if (path === "/api/me/companion/installations") value = [{ id: "device-synthetic", name: "Synthetic device" }];
        else if (path === `/api/workspaces/${slug}/members`) value = [ownerA, ownerB].map((id) => ({ user_id: id, role: "owner", email: `${id}@example.test`, name: id }));
        else if (path === boardApi) value = board;
        else if (path.endsWith("/boards")) value = [board];
        else if (path === `${boardApi}/cards`) value = [currentCard];
        else if (path === `${boardApi}/cards/${cardId}`) value = currentCard;
        else if (path.endsWith("/dependencies")) value = { depends_on: [], blocks: [] };
        else if (path.endsWith("/completion/policy")) value = { override: null, workspace_policy: null, effective_policy: null, origin: "legacy", policy_hash: null, capabilities: {}, incompatibilities: [] };
        else if (path.includes("/completion/cards/")) value = { completion_mode: "source", candidate: null, attempts: [] };
        else if (path === `${boardApi}/notes/${noteId}`) value = currentNote;
        else if (path === `${boardApi}/notes`) value = url.searchParams.has("card_id") ? [] : [{ ...currentNote, content: undefined, preview: "Current shared note metadata" }];
        else if (path.endsWith("/sessions")) value = { items: [], summary: { session_count: 0, wall_duration_seconds: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: 0, cost_complete: true } };
        else if (path.endsWith("/publication-revision/presence")) value = { has_record: false, recorded_at: null };
        else if (path.endsWith("/completion-context-impact")) value = { attempts: [] };
        else value = [];
      }
      if (status !== 200 && status !== 201) value = { detail: status === 410 ? "Historical generation expired" : "Synthetic authorized destination unavailable",
        error_code: status === 410 ? "timeline_generation_expired" : status === 404 && receipt.kind === "window" ? "timeline_event_not_found" : "forbidden" };
      receipt.status = status; receipt.intentionalError = status >= 400; receipt.bytes = Buffer.byteLength(JSON.stringify(value));
      await route.fulfill({ status, json: value, headers: { "X-Total-Count": "1" } });
    } catch (error) {
      if (request.failure()?.errorText !== "net::ERR_ABORTED") {
        state.unexpected.push(`Timeline fixture: ${String(error)}`);
        await route.fulfill({ status: 500, json: { detail: "Synthetic A05 fixture contract failed" } }).catch(() => {});
      }
    } finally { receipt.completedAt = Date.now(); state.inflight -= 1; }
  });
  return state;
}

export function unexpectedConsole(state: TimelineFixture) {
  return state.consoleReceipts.filter((entry) => {
    if (entry.type !== "error") return false;
    const status = /^Failed to load resource: the server responded with a status of (\d{3})\b/.exec(entry.text)?.[1];
    if (!status || !entry.url) return true;
    const url = new URL(entry.url);
    return ![...state.timelineRequests, ...state.resourceRequests].some((receipt) => receipt.intentionalError && receipt.status === Number(status)
      && receipt.path === url.pathname && receipt.query === url.search);
  });
}
