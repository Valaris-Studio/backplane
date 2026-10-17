// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Page, Route, WebSocketRoute } from "@playwright/test";
import type { AgentSession, SessionContent } from "../../src/types/agent-session";

// Generated here, never copied from an operator's captured session.
export const stamp = "2026-10-17T03:00:00Z";
export const slug = "session-window-fixture";
export const sessionId = "10000000-0000-4000-8000-000000000001";
export const boardId = "10000000-0000-4000-8000-000000000002";
export const cardId = "10000000-0000-4000-8000-000000000003";
export const exactCallId = "literal|+/:=call";
export const sessionPath = `/api/workspaces/${slug}/sessions/${sessionId}`;
export const contentsPath = `${sessionPath}/contents`;
export const routePath = `/${slug}/sessions/${sessionId}`;
export const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const contentId = (order: number) => `20000000-0000-4000-8000-${String(order).padStart(12, "0")}`;
export const bodyText = (order: number) => `SYNTHETIC COMPLETE RECORD ${order}: inspect the durable evidence before sharing a handoff.`;
const workspace = { id: "workspace-synthetic", name: "Synthetic reader review", slug, created_by: "owner", created_at: stamp, updated_at: stamp };
const board = { id: boardId, workspace_id: workspace.id, name: "Synthetic review work", is_frozen: false };
const card = { id: cardId, board_id: boardId, title: "Review this bounded evidence" };
export const session: AgentSession = {
  id: sessionId, workspace_id: workspace.id, owner_id: "owner", installation_id: "device-synthetic", harness: "claude_code", harness_display_name: "Claude Code",
  native_session_id: "synthetic-only", parent_session_id: null, mapping_id: null, board_id: boardId, status: "ended",
  started_at: stamp, last_event_at: "2026-10-17T03:18:00Z", ended_at: "2026-10-17T03:18:00Z", cwd: "synthetic/project",
  repository: "synthetic/backplane", branch: "review/reader", model: null, harness_version: null, title: "Read recent evidence without draining history",
  input_tokens: 2400, output_tokens: 800, cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: 0,
  cost_usd: null, cost_reported_usd: null, cost_estimated_usd: null, cost_source: null, cost_basis: null, cost_complete: false,
  auth_kind: "unknown", provider: null, service_tier: null, event_count: 14, prompt_count: 1, tool_call_count: 3, error_count: 0,
  capture_gaps: 0, display_state: "ended", ended_reason: "session_end_event", idle_since: null, activity_event_count: 14,
  coverage: "activity", capture_levels: ["rich"], link_count: 2, child_count: 0, link_preview: [],
};
const work = (provenance: "exact" | "correlated", relation: "changed" | "consulted") => ({ entity_type: "card", entity_id: cardId, workspace_id: workspace.id, board_id: boardId, relation, provenance });
const calls = [
  { key: "exact", call_id: exactCallId, name: "update_card", mcp_tool: "update_card", work_refs: [work("exact", "changed")] },
  { key: "correlated", call_id: "correlated-call", name: "get_card", mcp_tool: "get_card", work_refs: [work("correlated", "consulted")] },
  { key: "unmatched", call_id: "unmatched-call", name: "Unmatched evidence", mcp_tool: null, work_refs: [] },
].map((call) => ({ kind: "mcp", turn_index: 1, mcp_server: "backplane", started_at: stamp, ended_at: stamp, duration_ms: 160, event_count: 2, outcome: "succeeded", exit_code: null, args_preview: "synthetic arguments", prompt_preview: null, output: "none", withheld: [], subagent: null, ...call }));

export const records: SessionContent[] = Array.from({ length: 10_001 }, (_, index) => {
  const order = index + 1;
  const text = bodyText(order);
  return {
    id: contentId(order), session_id: sessionId, event_id: null, call_id: order === 40 || order === 41 ? exactCallId : null,
    parent_call_id: null, turn_id: null, role: order === 40 || order === 41 ? "tool" : "assistant",
    channel: order === 40 ? "tool_input" : order === 41 ? "tool_output" : order === 9998 ? "attachment" : order === 9999 ? "native_record" : "reply",
    display_path: null, media_type: order === 9998 ? "image/png" : "text/plain", coverage: "captured", coverage_reason: null,
    byte_count: Buffer.byteLength(text), original_byte_count: Buffer.byteLength(text), sha256: sha(text),
    redaction: { filter_version: "synthetic", replacements: 0 }, source: { kind: "claude_transcript", order },
    occurred_at: stamp, render: order === 9998 ? "image" : "text",
    preview: order === 9998 ? null : { text: `SYNTHETIC PREVIEW ${order}`, truncated: true },
  };
});

export interface RequestReceipt {
  path: string; method: string; query: string; mode: string | null; callId: string | null;
  cursor: string | null; status?: number; returned?: number; bytes?: number; ids?: string[]; payload?: string;
}
export interface WindowFixture {
  requests: RequestReceipt[]; failures: string[]; unexpected: string[]; subscriptions: string[];
  authorityStatus: number; metadataStatus: number; unavailableIds: Set<string>;
  holdWindow: boolean; holdBody: boolean; held: (() => void)[]; inflight: number;
  socket?: WebSocketRoute; saveStatus: number;
  release: () => void; ownerBurst: (count: number) => void;
}

function range(low: number, high: number) { return records.slice(low - 1, high); }
function windowResponse(url: URL) {
  const mode = url.searchParams.get("mode") || "latest";
  const cursor = url.searchParams.get("cursor");
  let low: number, high: number;
  if (mode === "latest") { low = 9902; high = 10001; }
  else if (mode === "beginning") { low = 1; high = 100; }
  else if (mode === "anchor") {
    const anchor = records.findIndex((item) => item.id === url.searchParams.get("anchor_id"));
    if (anchor < 0) return { status: 404, value: { detail: "Synthetic missing anchor", error_code: "content_not_found" } };
    low = Math.max(1, anchor + 1 - 49); high = Math.min(10001, anchor + 1 + 50);
  } else {
    assert(cursor && /^window:\d+:\d+$/.test(cursor), "Navigation must use a returned opaque cursor");
    [, low, high] = cursor.split(":").map(Number);
    if (mode === "earlier") { high = low - 1; low = Math.max(1, high - 99); }
    else if (mode === "later") { low = high + 1; high = Math.min(10001, low + 99); }
    else assert.equal(mode, "refresh");
  }
  assert(low! >= 1 && high! <= 10001 && high! - low! < 100, "Every returned metadata window is bounded");
  const next = `window:${low!}:${high!}`;
  return { status: 200, value: { capability: "content-window-v1", mode, items: range(low!, high!), earlier_cursor: low! > 1 ? next : null, later_cursor: high! < 10001 ? next : null, window_cursor: next, anchor_id: mode === "anchor" ? url.searchParams.get("anchor_id") : null } };
}

/** Stub every API through the production AppShell; any unknown API is a test failure. */
export async function installWindowFixture(page: Page, locale = "en"): Promise<WindowFixture> {
  const state: WindowFixture = {
    requests: [], failures: [], unexpected: [], subscriptions: [], authorityStatus: 200, metadataStatus: 200,
    unavailableIds: new Set(), holdWindow: false, holdBody: false, held: [], inflight: 0, saveStatus: 503,
    release() { state.holdWindow = false; state.holdBody = false; state.held.splice(0).forEach((resolve) => resolve()); },
    ownerBurst(count) {
      assert(state.socket, "The real AppShell must subscribe before an event burst");
      for (let index = 0; index < count; index += 1) state.socket.send(JSON.stringify({ event: "agent_session.updated", timestamp: stamp, event_id: `synthetic-${index}`, payload: { owner_id: "owner", session_id: sessionId } }));
    },
  };
  await page.addInitScript((language) => {
    localStorage.setItem("i18n-lang", language);
    localStorage.setItem("valaris-theme", "light");
    localStorage.setItem("valaris-welcome-dismissed", "true");
  }, locale);
  page.on("pageerror", (error) => state.unexpected.push(error.message));
  page.on("requestfailed", (request) => state.failures.push(`${new URL(request.url()).pathname} ${request.failure()?.errorText}`));
  await page.routeWebSocket("**/ws/workspaces/**", (socket) => {
    assert.equal(new URL(socket.url()).pathname, `/ws/workspaces/${slug}/events`);
    state.socket = socket;
    socket.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (Array.isArray(frame.subscribe)) state.subscriptions = frame.subscribe;
    });
  });
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      state.unexpected.push(`External request blocked: ${url.origin}${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    // Vite also serves modules from src/features/*/api/. Those are source
    // assets, not application requests; the same fixture supports built HTML.
    if (!path.startsWith("/api/")) return route.fallback();
    const receipt: RequestReceipt = { path, method, query: url.search, mode: url.searchParams.get("mode"), cursor: url.searchParams.get("cursor"), callId: url.searchParams.get("call_id") };
    state.requests.push(receipt); state.inflight += 1;
    try {
      assert(!request.headers().authorization && !request.headers().cookie, "Synthetic requests must carry no credentials");
      let value: unknown, status = 200;
      if (path === `${contentsPath}/metadata` && method === "POST") {
        const { content_ids: ids } = request.postDataJSON() as { content_ids: string[] };
        assert(ids.length <= 1024 && new Set(ids).size === ids.length);
        receipt.ids = ids;
        status = state.metadataStatus;
        const available = records.filter((item) => ids.includes(item.id) && !state.unavailableIds.has(item.id));
        value = status === 200 ? { items: available.map((item) => ({ ...item, preview: null })), unavailable_ids: ids.filter((id) => !available.some((item) => item.id === id)) } : { detail: "Synthetic selected metadata unavailable" };
      } else if (path === `/api/workspaces/${slug}/boards/${boardId}/notes/from-excerpt` && method === "POST") {
        receipt.payload = request.postData() ?? "";
        status = state.saveStatus;
        value = { detail: "Synthetic unknown save outcome" };
      } else {
        assert.equal(method, "GET", `Unexpected mutation: ${method} ${path}`);
        if (path === "/api/auth/modes") value = { oidc_enabled: false, password_enabled: false, dev_mode: true, companion_enabled: true, rich_capture_enabled: true };
        else if (path === "/api/auth/setup-status") value = { needs_setup: false };
        else if (path === "/api/me") value = { id: "owner", name: "Synthetic operator", email: "operator@example.test", avatar_url: null };
        else if (path === "/api/workspaces") value = [workspace];
        else if (path === `/api/workspaces/${slug}`) value = workspace;
        else if (path === `/api/workspaces/${slug}/members`) value = [{ user_id: "owner", role: "owner", email: "operator@example.test", name: "Synthetic operator" }];
        else if (path === `/api/workspaces/${slug}/boards`) value = [board];
        else if (path === `/api/workspaces/${slug}/boards/${boardId}`) value = { ...board, columns: [{ id: "synthetic-todo", name: "Synthetic to do", cards: [card] }] };
        else if (path === `/api/workspaces/${slug}/boards/${boardId}/cards`) value = [card];
        else if (path === `/api/workspaces/${slug}/boards/${boardId}/cards/${cardId}`) value = card;
        else if (path === sessionPath) { status = state.authorityStatus; value = status === 200 ? session : { detail: "Synthetic session access denied" }; }
        else if (path === `${sessionPath}/calls`) value = { items: calls, turns: [{ turn_index: 1, started_at: stamp, ended_at: session.ended_at, call_count: calls.length, failure_count: 0, reasoning_count: 0 }], next_cursor: null };
        else if (path.startsWith(`${sessionPath}/calls/`)) {
          const call = calls.find((item) => item.key === decodeURIComponent(path.split("/").at(-1)!));
          assert(call, "Unknown call");
          value = { key: call.key, events: [] };
        } else if (path === `${sessionPath}/links`) value = { items: [work("exact", "changed"), work("correlated", "consulted")].map((item) => ({ ...item, first_seen_at: stamp, last_seen_at: stamp, invocation_count: 1 })) };
        else if (path === `${sessionPath}/children`) value = { items: [] };
        else if (path === `${contentsPath}/window`) {
          if (state.holdWindow) await new Promise<void>((resolve) => state.held.push(resolve));
          const result = windowResponse(url); status = result.status; value = result.value;
          receipt.returned = "items" in result.value ? result.value.items.length : 0;
        } else if (path === contentsPath) {
          // The baseline may load its first page. New code must leave this route
          // exclusively to the existing literal call inspector.
          assert.equal(url.searchParams.get("limit"), "100");
          assert(!url.searchParams.has("cursor"), "No sequential full-history scan is allowed");
          value = { items: receipt.callId ? records.filter((item) => item.call_id === receipt.callId) : range(1, 100), next_cursor: receipt.callId ? null : "legacy-unvisited-page" };
        } else if (path.startsWith(`${contentsPath}/`) && path.endsWith("/body")) {
          const item = records.find((record) => record.id === path.split("/").at(-2));
          assert(item, "Unknown synthetic body");
          if (state.holdBody) await new Promise<void>((resolve) => state.held.push(resolve));
          const text = bodyText(item.source.order);
          value = { content_id: item.id, offset: 0, next_offset: null, total_bytes: Buffer.byteLength(text), text };
        } else if (path.endsWith("/download")) assert.fail("No image/file request is authorized by these cases");
        else if (path === `${sessionPath}/usage`) value = { items: [], price_table_version: "synthetic" };
        else if (path === `${sessionPath}/rhythm`) value = { start: stamp, end: session.ended_at, live: false, bucket_seconds: 300, buckets: [{ t: stamp, prompt: 1, tool: 3, file: 0, work: 2, error: 0 }], idle_spans: [], children: [], capture_gaps: 0 };
        else if (path === `/api/workspaces/${slug}/sessions/summary`) value = { session_count: 1, live_count: 0, wall_duration_seconds: 1080, input_tokens: 2400, output_tokens: 800, cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: 0, cost_api_equivalent_usd: null, cost_spend_usd: null, cost_complete: false };
        else if (path.endsWith("/unread-count")) value = { count: 0 };
        else if (path.endsWith("/notifications") || path.endsWith("/approvals")) value = [];
        else assert.fail(`Unhandled synthetic API: ${method} ${path}`);
      }
      receipt.status = status; receipt.bytes = Buffer.byteLength(JSON.stringify(value));
      await route.fulfill({ status, json: value });
    } catch (error) {
      // A late response to an already cancelled private read must not revive UI.
      if (request.failure()?.errorText !== "net::ERR_ABORTED") {
        state.unexpected.push(String(error));
        await route.fulfill({ status: 500, json: { detail: "Synthetic fixture contract failed" } }).catch(() => {});
      }
    } finally { state.inflight -= 1; }
  });
  return state;
}

export const windowRequests = (state: WindowFixture, since = 0) => state.requests.slice(since).filter((item) => item.path === `${contentsPath}/window`);
export const contentRequests = (state: WindowFixture, since = 0) => state.requests.slice(since).filter((item) => item.path.startsWith(contentsPath));
export const byteRequests = (state: WindowFixture, since = 0) => contentRequests(state, since).filter((item) => /\/(body|download)$/.test(item.path));
