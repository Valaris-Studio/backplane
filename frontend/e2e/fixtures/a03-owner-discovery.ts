// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import type { OwnerSession, OwnerSessionOverviewData } from "../../src/types/owner-session";
import { installNavigationFixture, noteId, notePath, originalNoteTitle, type NavigationFixture } from "./uxc-navigation-fixture";
import { boardId, cardId, contentsPath, session, sessionId, sessionPath, sha, slug, stamp, type RequestReceipt } from "./session-window-fixture";

export const listPath = "/api/me/sessions";
export const overviewPath = `${listPath}/overview`;
export const discoveryPath = "/-/sessions";
export const workspaces = [
  { id: session.workspace_id, slug, name: "Synthetic reader review", created_by: "owner", created_at: stamp, updated_at: stamp },
  { id: "40000000-0000-4000-8000-000000000001", slug: "synthetic-orbit", name: "Synthetic Orbit tools", created_by: "owner", created_at: stamp, updated_at: stamp },
];
export const selectedIndex = 79;

export function retainedSessions(): OwnerSession[] {
  return Array.from({ length: 120 }, (_, index) => {
    const workspace = workspaces[index === selectedIndex ? 0 : index % 2]!;
    const started = new Date(Date.parse(stamp) + (selectedIndex - index) * 60_000).toISOString();
    const ended = new Date(Date.parse(started) + 18 * 60_000).toISOString();
    return {
      id: index === selectedIndex ? sessionId : `41000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      workspace_id: workspace.id, workspace_slug: workspace.slug, workspace_name: workspace.name,
      board_id: workspace.slug === slug ? boardId : null, board_name: workspace.slug === slug ? "Synthetic review work" : null,
      parent_session_id: null, harness: "claude_code", harness_display_name: "Claude Code",
      title: index === selectedIndex ? session.title : `Retained evidence ${String(index).padStart(3, "0")} café 🙂`,
      repository: "synthetic/backplane", branch: "review/reader", status: "ended", display_state: "ended",
      started_at: started, last_event_at: ended, ended_at: ended, ended_reason: "session_end_event", idle_since: null,
      event_count: 14, activity_event_count: 14, coverage: "activity", capture_gaps: 0, capture_levels: ["rich"],
      child_count: index === 0 ? 2 : 0, link_count: index === 1 ? 1 : 0,
      link_preview: index === 1 ? [{ entity_type: "note", entity_id: noteId, title: originalNoteTitle,
        workspace_id: workspaces[0]!.id, workspace_slug: slug, workspace_name: workspaces[0]!.name,
        board_id: null, board_name: null, relation: "changed", provenance: "exact" }] : [],
    };
  });
}

type DiscoveryRead = RequestReceipt & {
  generation: number; held: boolean; completedAt?: number; outcome?: "fulfilled" | "aborted";
  response?: unknown;
};
export interface OwnerDiscoveryFixture extends NavigationFixture {
  rows: OwnerSession[];
  generation: number;
  listStatus: number;
  holdQuery: string | null;
  holdNextList: boolean;
  discoveryReads: DiscoveryRead[];
  heldDiscovery: (() => void)[];
  releaseDiscovery(): void;
  apiResponses: { path: string; query: string; method: string; status: number; sha256?: string; value?: unknown; unreadable?: string }[];
  pendingResponses: Promise<void>[];
  consoleEntries: { text: string; url: string }[];
}

function overview(rows: OwnerSession[]): OwnerSessionOverviewData {
  return {
    active: rows.slice(0, 6).map((row, index) => ({ ...row, status: index % 2 ? "idle" : "active",
      display_state: index % 2 ? "idle" : "active", ended_at: null, ended_reason: null })),
    recent: rows.slice(6, 12), active_more: true, recent_more: true, generated_at: stamp,
  };
}

function scope(search: URLSearchParams) {
  const sorted = new URLSearchParams(search);
  sorted.delete("cursor"); sorted.sort();
  return sorted.toString();
}

/** HTTP-only synthetic owner metadata; the existing fixture supplies the real reader's APIs. */
export async function installOwnerDiscoveryFixture(page: Page, locale: string): Promise<OwnerDiscoveryFixture> {
  const inherited = await installNavigationFixture(page, locale);
  const state: OwnerDiscoveryFixture = Object.assign(inherited, {
    rows: retainedSessions(), generation: 1, listStatus: 200, holdQuery: null, holdNextList: false,
    discoveryReads: [] as DiscoveryRead[], heldDiscovery: [] as (() => void)[],
    apiResponses: [] as OwnerDiscoveryFixture["apiResponses"], pendingResponses: [] as Promise<void>[],
    consoleEntries: [] as OwnerDiscoveryFixture["consoleEntries"],
    releaseDiscovery() { state.heldDiscovery.splice(0).forEach((release) => release()); },
  });
  // Tokens are issued only by a successful preceding page and bind its exact
  // scope, generation and last row. An old generation is never an offset alias.
  const cursors = new Map<string, { scope: string; generation: number; afterId: string }>();
  let cursorSequence = 0;
  page.on("console", (message) => {
    if (message.type() === "error") state.consoleEntries.push({ text: message.text(), url: message.location().url });
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/")) return;
    const receipt: OwnerDiscoveryFixture["apiResponses"][number] = {
      path: url.pathname, query: url.search, method: response.request().method(), status: response.status(),
    };
    state.apiResponses.push(receipt);
    state.pendingResponses.push(response.body().then((body) => {
      receipt.sha256 = sha(body); receipt.value = JSON.parse(body.toString());
    }).catch((error: unknown) => { receipt.unreadable = String(error); }));
  });

  const inheritedGets = new Set([
    "/api/auth/modes", "/api/auth/setup-status", "/api/me", "/api/notifications", "/api/notifications/unread-count",
    "/api/me/companion/installations", `/api/workspaces/${slug}`, `/api/workspaces/${slug}/members`,
    `/api/workspaces/${slug}/boards`, `/api/workspaces/${slug}/boards/${boardId}`,
    `/api/workspaces/${slug}/boards/${boardId}/cards`, `/api/workspaces/${slug}/boards/${boardId}/cards/${cardId}`,
    `/api/workspaces/${slug}/approvals`, `/api/workspaces/${slug}/notifications`, `/api/workspaces/${slug}/notifications/unread-count`,
    `/api/workspaces/${slug}/sessions/summary`, sessionPath, `${sessionPath}/calls`, `${sessionPath}/links`,
    `${sessionPath}/children`, `${sessionPath}/usage`, `${sessionPath}/rhythm`, contentsPath, `${contentsPath}/window`, notePath,
  ]);
  const inheritedRequest = (path: string, method: string) => method === "GET" && (inheritedGets.has(path)
    || (path.startsWith(`${contentsPath}/`) && /^\/20000000-0000-4000-8000-\d{12}\/body$/.test(path.slice(contentsPath.length))))
    || method === "POST" && path === `${contentsPath}/metadata`;

  // This outer allowlist also constrains the older fixture's generic suffix
  // handlers. No unknown API or external URL can fall through to a live server.
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!path.startsWith("/api/")) return route.fallback();
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    const controlled = [listPath, overviewPath, "/api/workspaces"].includes(path);
    if (local && !controlled && inheritedRequest(path, request.method())) return route.fallback();
    const read: DiscoveryRead = { path, method: request.method(), query: url.search,
      mode: null, cursor: url.searchParams.get("cursor"), callId: null, startedAt: Date.now(), generation: state.generation, held: false };
    state.requests.push(read); state.discoveryReads.push(read); state.inflight += 1;
    try {
      assert(local && controlled, `Unknown API blocked: ${request.method()} ${url.origin}${path}`);
      assert.equal(request.method(), "GET", "Discovery cannot mutate data");
      assert(!request.headers().authorization && !request.headers().cookie, "Synthetic requests must have no credentials");
      let value: unknown, status = path === listPath ? state.listStatus : 200;
      if (path === "/api/workspaces") value = workspaces;
      else if (path === overviewPath) {
        assert.equal(url.searchParams.get("active_limit"), "6"); assert.equal(url.searchParams.get("recent_limit"), "6");
        assert.deepEqual([...url.searchParams.keys()].sort(), ["active_limit", "recent_limit"]);
        value = overview(state.rows);
      } else if (status !== 200) value = { detail: `Synthetic discovery response ${status}` };
      else {
        const params = url.searchParams;
        const supported = new Set(["root_only", "limit", "cursor", "q", "sort", "state", "workspace_id", "board_id", "harness", "status", "linked_only", "since"]);
        assert([...params.keys()].every((key) => supported.has(key)), "Only supported owner-list filters");
        assert.equal(params.get("limit"), "40"); assert(["true", "false"].includes(params.get("root_only") ?? ""));
        assert(["recent", "started"].includes(params.get("sort") ?? "recent"));
        const q = (params.get("q") ?? "").toLowerCase(), states = params.getAll("state");
        const matching = state.rows.filter((row) => (!q || [row.title, row.repository, row.branch].some((text) => text?.toLowerCase().includes(q)))
          && (!params.get("workspace_id") || row.workspace_id === params.get("workspace_id"))
          && (!params.get("board_id") || row.board_id === params.get("board_id"))
          && (!params.get("harness") || row.harness === params.get("harness"))
          && (!params.get("status") || row.status === params.get("status"))
          && (!states.length || states.includes(row.display_state))
          && (params.get("root_only") !== "true" || row.parent_session_id === null)
          && (params.get("linked_only") !== "true" || row.link_count > 0)
          && (!params.get("since") || row.started_at >= params.get("since")!));
        let start = 0;
        if (read.cursor) {
          const issued = cursors.get(read.cursor);
          if (!issued || issued.generation !== state.generation || issued.scope !== scope(params)
            || !matching.some((row) => row.id === issued.afterId)) {
            status = 422; value = { detail: "Stale or wrong-scope synthetic cursor" };
          } else start = matching.findIndex((row) => row.id === issued.afterId) + 1;
        }
        if (status === 200) {
          const items = matching.slice(start, start + 40);
          const nextCursor = start + items.length < matching.length ? `owner-keyset-${state.generation}-${++cursorSequence}` : null;
          if (nextCursor) cursors.set(nextCursor, { scope: scope(params), generation: state.generation, afterId: items.at(-1)!.id });
          value = { items: structuredClone(items), next_cursor: nextCursor };
          read.ids = items.map((item) => item.id); read.returned = items.length;
        }
        read.held = state.holdNextList || (state.holdQuery !== null && state.holdQuery === params.get("q"));
        state.holdNextList = false;
      }
      read.status = status; read.response = structuredClone(value); read.bytes = Buffer.byteLength(JSON.stringify(value));
      if (read.held) await new Promise<void>((resolve) => state.heldDiscovery.push(resolve));
      await route.fulfill({ status, json: value }); read.outcome = "fulfilled";
    } catch (error) {
      if (request.failure()?.errorText === "net::ERR_ABORTED") read.outcome = "aborted";
      else {
        state.unexpected.push(String(error));
        await route.fulfill({ status: 500, json: { detail: "Synthetic discovery fixture contract failed" } }).catch(() => {});
      }
    } finally { read.completedAt = Date.now(); state.inflight -= 1; }
  });
  return state;
}
