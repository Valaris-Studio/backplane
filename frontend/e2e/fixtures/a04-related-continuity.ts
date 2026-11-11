// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import type { Page, Request } from "@playwright/test";
import type { Activity } from "../../src/types/activity";
import type { Card, BoardDetail } from "../../src/types/kanban";
import type { LinkedSessionList, SessionWorkLink } from "../../src/types/agent-session";
import type { ResourceDetail } from "../../src/types/resource";
import { installNavigationFixture, noteId, notePath, type NavigationFixture } from "./uxc-navigation-fixture";
import { boardId, cardId, contentsPath, session, sessionPath, sha, slug, stamp, type RequestReceipt } from "./session-window-fixture";

export const workspaceApi = `/api/workspaces/${slug}`;
export const boardApi = `${workspaceApi}/boards/${boardId}`;
export const cardApi = `${boardApi}/cards/${cardId}`;
export const cardHref = `/${slug}/boards/${boardId}/kanban?card=${cardId}`;
export const historyHref = `/${slug}/history`;
export const resourceId = "70000000-0000-4000-8000-000000000003";
export const folderId = "70000000-0000-4000-8000-000000000002";
export const rootFolderId = "70000000-0000-4000-8000-000000000001";
export const resourceApi = `${boardApi}/resources`;
export const resourceHref = `/${slug}/boards/${boardId}/resources?resource=${resourceId}`;
export const resourceTitle = "Synthetic nested evidence.txt";
export const resourceBody = "SYNTHETIC RESOURCE: exact authorized nested bytes opened deliberately from activity.";
export const cardTitle = "Synthetic card whose evidence matters";
export const cardSummary = "Updated the synthetic evidence card";
export const resourceSummary = "Uploaded the synthetic nested evidence";
export const historyQuery = "synthetic nested";
const bodyPath = "/__a04_synthetic_resource";
const document = (text: string, paragraphs = 1) => JSON.stringify({ type: "doc", content: Array.from({ length: paragraphs }, (_, i) => ({
  type: "paragraph", content: [{ type: "text", text: `${text} ${i + 1}. Review the retained context before following related evidence.` }],
})) });

const originalCard: Card = {
  id: cardId, title: cardTitle, description: document("Synthetic saved card context", 32), column_id: "synthetic-todo",
  card_type: "task", priority: "medium", position: 1024, participants: [], due_date: null, status: "ready", labels: ["synthetic"],
  created_at: stamp, updated_at: stamp,
};

function activity(id: string, type: Activity["entity_type"], entityId: string, summary: string): Activity {
  return { id, workspace_id: session.workspace_id, board_id: boardId, actor_id: "owner", actor_name: "Synthetic operator",
    actor_email: null, agent_id: null, entity_type: type, entity_id: entityId, action: type === "resource" ? "uploaded" : "updated",
    summary, message_key: null, message_params: null, via_api_key: null, entity_title: null, created_at: stamp };
}
const activities = [activity("activity-card", "card", cardId, cardSummary),
  activity("activity-resource", "resource", resourceId, resourceSummary)];

function folder(id: string, name: string, parent: string | null): ResourceDetail {
  return { id, name, workspace_id: session.workspace_id, board_id: boardId, parent_id: parent, resource_type: "folder",
    gcs_path: null, mime_type: null, size_bytes: null, uploaded_by: "owner", metadata: { tags: [] }, description: null,
    created_at: stamp, updated_at: stamp, ancestors: [], ancestors_complete: true };
}
const rootFolder = folder(rootFolderId, "Synthetic evidence", null);
const nestedFolder = folder(folderId, "Nested", rootFolderId);
const ancestor = ({ id, name, workspace_id, board_id, resource_type }: ResourceDetail) => ({ id, name, workspace_id, board_id, resource_type });
nestedFolder.ancestors = [ancestor(rootFolder)];
const targetResource: ResourceDetail = { ...folder(resourceId, resourceTitle, folderId), resource_type: "file",
  gcs_path: "synthetic/a04/evidence", mime_type: "text/plain", size_bytes: Buffer.byteLength(resourceBody),
  ancestors: [ancestor(rootFolder), ancestor(nestedFolder)], ancestors_complete: true };

export interface A04Fixture extends NavigationFixture {
  sourceKind: "card" | "note";
  card: Card;
  relatedStatus: number;
  relatedEmpty: boolean;
  holdRelated: boolean;
  heldRelated: (() => void)[];
  releaseRelated: () => void;
  builtAssets: { path: string; manifestKey: string; status: number; bytes: number; sha256: string; observedAt: number; afterCutoff: boolean }[];
  browserRequests: { path: string; query: string; method: string; resourceType: string; startedAt: number; afterCutoff: boolean; finishedAt?: number; failure?: string }[];
  pendingBrowserRequests: Map<Request, A04Fixture["browserRequests"][number]>;
  pendingProofs: number;
  proofsStarted: number;
  observationCutoff: number | null;
  afterCutoffEvents: { event: string; path: string; at: number }[];
  responseReceipts: { path: string; query: string; status: number; observedAt: number; afterCutoff: boolean; bytes?: number; sha256?: string; unreadable?: string }[];
  consoleReceipts: { text: string; url: string; type: string }[];
  resourceTickets: Set<string>;
}

export function linksFor(state: A04Fixture): SessionWorkLink[] {
  const entity_type = state.sourceKind;
  const entity_id = entity_type === "card" ? cardId : noteId;
  const relations = entity_type === "card" ? ["consulted", "changed"] as const : ["consulted"] as const;
  return relations.map((relation) => ({ workspace_id: session.workspace_id, board_id: entity_type === "card" ? boardId : null,
    entity_type, entity_id, relation, provenance: "exact", first_seen_at: stamp, last_seen_at: stamp, invocation_count: 1 }));
}

function related(state: A04Fixture): LinkedSessionList {
  return { items: state.relatedEmpty ? [] : [{ session: { ...session, link_count: linksFor(state).length }, relations: state.sourceKind === "card" ? ["consulted", "changed"] : ["consulted"],
    provenance: "exact", first_seen_at: stamp, last_seen_at: stamp }],
  summary: { session_count: state.relatedEmpty ? 0 : 1, first_seen_at: stamp, last_seen_at: stamp, total_duration_seconds: 1080,
    wall_duration_seconds: 1080, input_tokens: 2400, output_tokens: 800, cache_read_tokens: 0, cache_creation_tokens: 0,
    reasoning_tokens: 0, cost_usd: null, cost_reported_usd: null, cost_estimated_usd: null, cost_source: null, cost_basis: null,
    cost_complete: false } };
}

/** HTTP-only composition. The application owns its real routing, cache, drafts and IntersectionObserver. */
export async function installA04Fixture(page: Page, locale: string): Promise<A04Fixture> {
  const inherited = await installNavigationFixture(page, locale);
  const state: A04Fixture = Object.assign(inherited, {
    sourceKind: "card" as const, card: structuredClone(originalCard), relatedStatus: 200, relatedEmpty: false, holdRelated: false,
    heldRelated: [] as (() => void)[], builtAssets: [] as A04Fixture["builtAssets"],
    browserRequests: [] as A04Fixture["browserRequests"], pendingBrowserRequests: new Map<Request, A04Fixture["browserRequests"][number]>(),
    pendingProofs: 0, proofsStarted: 0, observationCutoff: null as number | null, afterCutoffEvents: [] as A04Fixture["afterCutoffEvents"],
    responseReceipts: [] as A04Fixture["responseReceipts"], consoleReceipts: [] as A04Fixture["consoleReceipts"], resourceTickets: new Set<string>(),
    releaseRelated() { state.holdRelated = false; state.heldRelated.splice(0).forEach((release) => release()); },
  });
  // Real editor content puts the existing lazy section below the viewport;
  // no mocked geometry or private React/provider state is involved.
  state.note.content = document("Synthetic saved note context", 32);
  const origin = new URL(process.env.BACKPLANE_E2E_BASE_URL ?? "http://localhost:5173").origin;
  const afterCutoff = (event: string, path: string) => {
    if (state.observationCutoff !== null) state.afterCutoffEvents.push({ event, path, at: Date.now() });
  };
  const trackProof = (proof: Promise<void>) => {
    state.proofsStarted += 1; state.pendingProofs += 1;
    void proof.then(() => { state.pendingProofs -= 1; }, (error: unknown) => {
      state.pendingProofs -= 1; state.unexpected.push(`Response proof failed: ${String(error)}`);
    });
  };
  let inheritedProofs = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    const receipt = { path: url.pathname, query: url.search, method: request.method(), resourceType: request.resourceType(),
      startedAt: Date.now(), afterCutoff: state.observationCutoff !== null };
    state.browserRequests.push(receipt); state.pendingBrowserRequests.set(request, receipt);
    afterCutoff("request", url.pathname);
  });
  const finishRequest = (request: Request) => {
    const receipt = state.pendingBrowserRequests.get(request);
    if (receipt) { receipt.finishedAt = Date.now(); receipt.failure = request.failure()?.errorText; }
    else state.unexpected.push(`Unobserved request completed: ${request.url()}`);
    state.pendingBrowserRequests.delete(request);
    afterCutoff(request.failure() ? "requestfailed" : "requestfinished", new URL(request.url()).pathname);
  };
  page.on("requestfinished", finishRequest);
  page.on("requestfailed", finishRequest);
  page.on("pageerror", () => afterCutoff("pageerror", page.url()));
  page.on("console", (message) => {
    state.consoleReceipts.push({ type: message.type(), text: message.text(), url: message.location().url });
    afterCutoff("console", message.location().url);
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    const observedAt = Date.now();
    const afterObservation = state.observationCutoff !== null;
    afterCutoff("response", url.pathname);
    // The inherited response listener runs first; include each proof it created.
    while (inheritedProofs < state.pendingAssets.length) trackProof(state.pendingAssets[inheritedProofs++]!);
    if (url.origin !== origin) { state.unexpected.push(`Foreign response: ${url.origin}${url.pathname}`); return; }
    if (url.pathname.startsWith("/api/") || url.pathname === bodyPath) {
      const receipt: A04Fixture["responseReceipts"][number] = { path: url.pathname, query: url.search,
        status: response.status(), observedAt, afterCutoff: afterObservation };
      state.responseReceipts.push(receipt);
      trackProof(response.body().then((body) => { receipt.bytes = body.length; receipt.sha256 = sha(body); })
        .catch((error: unknown) => { receipt.unreadable = String(error); }));
      return;
    }
    // Bind every static response, including the SPA document and fonts/images,
    // to the supplied preserved dist, not just a build label or JS filename.
    trackProof(response.body().then((body) => {
      const html = response.request().isNavigationRequest() && (response.headers()["content-type"] ?? "").includes("text/html");
      state.builtAssets.push({ path: url.pathname, manifestKey: html ? "index.html" : decodeURIComponent(url.pathname).replace(/^\//, ""),
        status: response.status(), bytes: body.length, sha256: sha(body), observedAt, afterCutoff: afterObservation });
    }).catch((error: unknown) => { state.unexpected.push(`Static response unreadable: ${url.pathname} ${String(error)}`); }));
  });
  await page.route(`**${bodyPath}*`, async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin);
    assert(state.resourceTickets.has(url.search), "A body requires a deliberately issued resource ticket");
    const receipt: RequestReceipt = { path: bodyPath, method: route.request().method(), query: url.search, mode: null, callId: null, cursor: null,
      startedAt: Date.now(), status: 200, bytes: Buffer.byteLength(resourceBody) };
    state.requests.push(receipt);
    await route.fulfill({ contentType: "text/plain", body: resourceBody });
  });

  const controlled = new Set([boardApi, `${workspaceApi}/boards`, `${boardApi}/cards`, cardApi, `${cardApi}/sessions`,
    `${cardApi}/dependencies`, `${boardApi}/notes`, `${boardApi}/health`, `${boardApi}/loop/status`, `${boardApi}/completion/policy`,
    `${workspaceApi}/config`, `${workspaceApi}/metrics/agents`, `${workspaceApi}/executions`, `${workspaceApi}/executions/skipped-card-ids`,
    `${workspaceApi}/summary`, `${workspaceApi}/history`, `${workspaceApi}/resources`, `${boardApi}/git-repos`,
    "/api/me/api-keys", "/api/me/sessions", `${notePath}/sessions`, sessionPath, `${sessionPath}/links`, `${sessionPath}/calls`,
    resourceApi, `${resourceApi}/tags`, ...[rootFolderId, folderId, resourceId].map((id) => `${resourceApi}/${id}`),
    `${resourceApi}/${resourceId}/download-url`]);
  const inheritedGets = new Set(["/api/auth/modes", "/api/auth/setup-status", "/api/me", "/api/workspaces", "/api/me/companion/installations",
    "/api/notifications", "/api/notifications/unread-count", workspaceApi, `${workspaceApi}/members`, `${workspaceApi}/notes`, notePath,
    `${workspaceApi}/config/completion-context-impact`, `${workspaceApi}/notifications`, `${workspaceApi}/notifications/unread-count`,
    `${workspaceApi}/approvals`, `${workspaceApi}/approvals/unread-count`, `${workspaceApi}/sessions/summary`, sessionPath,
    `${sessionPath}/children`, `${sessionPath}/usage`, `${sessionPath}/rhythm`, contentsPath, `${contentsPath}/window`]);
  const inheritedRequest = (path: string, method: string) => method === "GET" && (inheritedGets.has(path)
    || path.startsWith(`${sessionPath}/calls/`) || new RegExp(`^${contentsPath}/20000000-0000-4000-8000-\\d{12}/body$`).test(path))
    || method === "PUT" && path === notePath
    || method === "POST" && [ `${contentsPath}/metadata`, `${boardApi}/notes/from-excerpt` ].includes(path);

  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!path.startsWith("/api/")) return route.fallback();
    if (url.origin === origin && !controlled.has(path) && inheritedRequest(path, request.method())) return route.fallback();
    const receipt: RequestReceipt = { path, method: request.method(), query: url.search, mode: null, callId: null, cursor: null, startedAt: Date.now() };
    state.requests.push(receipt); state.inflight += 1;
    try {
      assert.equal(url.origin, origin, "Synthetic APIs stay on the preserved app origin");
      assert(controlled.has(path), `Unknown A04 API: ${request.method()} ${path}${url.search}`);
      assert.equal(request.method(), "GET", "Only the explicit inherited note/handoff mutations are allowed");
      assert(!request.headers().authorization && !request.headers().cookie, "No fixture credentials");
      const board: BoardDetail = { id: boardId, slug: "a04-synthetic", workspace_id: session.workspace_id, name: "Synthetic related work",
        description: "", tags: [], is_frozen: false, loop_configured: false, has_definition: false, created_at: stamp, updated_at: stamp,
        columns: [{ id: state.card.column_id, board_id: boardId, name: "In progress", column_type: "active", position: 1024,
          cards: [state.card], created_at: stamp, updated_at: stamp }] };
      let value: unknown, status = 200;
      if (path === boardApi) value = board;
      else if (path === `${workspaceApi}/boards`) value = [board];
      else if (path === `${boardApi}/cards`) value = [state.card];
      else if (path === cardApi) value = state.card;
      else if ([`${cardApi}/sessions`, `${notePath}/sessions`].includes(path)) {
        status = state.relatedStatus;
        value = status === 200 ? related(state) : { detail: "Synthetic requested related sessions unavailable" };
        if (state.holdRelated) await new Promise<void>((release) => state.heldRelated.push(release));
      } else if (path === sessionPath) {
        status = state.authorityStatus;
        value = status === 200 ? { ...session, link_count: linksFor(state).length } : { detail: "Synthetic session access denied" };
      } else if (path === `${sessionPath}/links`) value = { items: linksFor(state) };
      else if (path === `${sessionPath}/calls`) {
        const links = linksFor(state);
        const changed = links.find((link) => link.relation === "changed");
        const consulted = links.find((link) => link.relation === "consulted");
        const calls = state.calls.map((call, index) => {
          const ref = index === 0 ? changed ?? consulted : index === 1 && changed ? consulted : undefined;
          const tool = ref ? `${ref.relation === "changed" ? "update" : "get"}_${state.sourceKind}` : call.mcp_tool;
          return { ...call, name: tool ?? call.name, mcp_tool: tool, work_refs: ref ? [ref] : [] };
        });
        const rows = url.searchParams.get("filter") === "work" ? calls.filter((call) => call.work_refs.length) : calls;
        value = { items: rows, turns: [{ turn_index: 1, started_at: stamp, ended_at: session.ended_at, call_count: rows.length, failure_count: 0, reasoning_count: 0 }], next_cursor: null };
      } else if (path === `${cardApi}/dependencies`) value = { depends_on: [], blocks: [] };
      else if (path === `${boardApi}/notes`) { assert.equal(url.searchParams.get("card_id"), cardId, "Do not read unrelated board-note bodies"); value = []; }
      else if (path === `${workspaceApi}/summary`) value = { board_count: 1, card_count: 1, note_count: 1, channel_count: 1,
        recent_activity: activities, board_stats: [], activity_trend: [] };
      else if (path === `${workspaceApi}/history`) {
        assert.equal(url.searchParams.get("summary"), "true", "Activity labels use authorized summaries, not snapshots");
        const search = url.searchParams.get("search")?.toLowerCase();
        value = activities.filter((item) => (!search || item.summary.toLowerCase().includes(search))
          && (!url.searchParams.get("entity_type") || item.entity_type === url.searchParams.get("entity_type")));
      } else if (path === "/api/me/sessions") {
        assert.equal(url.searchParams.get("workspace_id"), session.workspace_id);
        value = { items: [], next_cursor: null };
      } else if (path === `${workspaceApi}/config`) value = { pipeline_config: null };
      else if (path === `${workspaceApi}/metrics/agents`) value = { agents: [] };
      else if (path === `${boardApi}/health`) value = { health_score: 100 };
      else if (path === `${boardApi}/loop/status`) value = { state: "off", enabled: false, disabled_reason: null, actionable: false,
        has_inflight_iteration: false, last_iteration_at: null, last_iteration_status: null, bound_agent_count: 0, alive_agent_count: 0, spent_usd: 0, budget_usd: null };
      else if (path === `${boardApi}/completion/policy`) value = { override: null, workspace_policy: null, effective_policy: null,
        origin: "legacy", policy_hash: null, capabilities: {}, incompatibilities: [] };
      else if (path === resourceApi) {
        // Whole-folder API: the target is absent from the initial root list,
        // then appears only after exact detail has established its real folder.
        const parent = url.searchParams.get("parent_id");
        const rows = parent === folderId ? [targetResource] : parent === rootFolderId ? [nestedFolder] : [rootFolder];
        receipt.ids = rows.map((row) => row.id); value = rows;
      } else if (path === `${resourceApi}/tags`) value = [];
      else if (path === `${resourceApi}/${resourceId}/download-url`) {
        const ticket = `?ticket=${state.resourceTickets.size + 1}`;
        state.resourceTickets.add(ticket); value = { download_url: `${origin}${bodyPath}${ticket}` };
      } else if (path === `${resourceApi}/${resourceId}`) value = targetResource;
      else if (path === `${resourceApi}/${folderId}`) value = nestedFolder;
      else if (path === `${resourceApi}/${rootFolderId}`) value = rootFolder;
      else value = [];
      receipt.status = status; receipt.bytes = Buffer.byteLength(JSON.stringify(value));
      await route.fulfill({ status, json: value });
    } catch (error) {
      if (request.failure()?.errorText !== "net::ERR_ABORTED") {
        state.unexpected.push(String(error));
        await route.fulfill({ status: 500, json: { detail: "Synthetic A04 fixture contract failed" } }).catch(() => {});
      }
    } finally { state.inflight -= 1; }
  });
  return state;
}

export const relatedReads = (state: A04Fixture) => state.requests.filter((request) => [ `${cardApi}/sessions`, `${notePath}/sessions` ].includes(request.path));
export const privateBodyReads = (state: A04Fixture) => state.requests.filter((request) =>
  request.path.startsWith(contentsPath) && /\/(body|download)$/.test(request.path) || request.path.startsWith(`${sessionPath}/calls/`));
export function unexpectedConsole(state: A04Fixture) {
  return state.consoleReceipts.filter((entry) => {
    if (entry.type !== "error") return false;
    const status = /^Failed to load resource: the server responded with a status of (\d{3})\b/.exec(entry.text)?.[1];
    if (!status || !entry.url) return true;
    const url = new URL(entry.url);
    return !state.responseReceipts.some((response) => response.path === url.pathname && response.query === url.search && response.status === Number(status)
      && [403, 503].includes(response.status));
  });
}
