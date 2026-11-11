// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import type { AgentSessionEvent, SessionContent } from "../../src/types/agent-session";
import { installA04Fixture, type A04Fixture } from "./a04-related-continuity";
import { contentId, contentsPath, records, sessionPath, sha, stamp, type RequestReceipt } from "./session-window-fixture";

export const searchPath = `${sessionPath}/search`;
export const privateQuery = " Straße 🙂 ";
export const oldContentId = contentId(152);
export const originalContentId = contentId(9950);
export const groupedOriginId = contentId(41);
export const groupedLaterLabel = "SYNTHETIC ORIGIN LATER PAGE";
const groupedBody = "SYNTHETIC ORIGIN FIRST PAGE\n".padEnd(256 * 1024, ".") + groupedLaterLabel;
const groupedOrigin: SessionContent = { ...records[40]!, preview: { text: "Synthetic grouped original preview", truncated: true },
  byte_count: Buffer.byteLength(groupedBody), original_byte_count: Buffer.byteLength(groupedBody), sha256: sha(groupedBody) };
export const callKey = Buffer.from("c:synthetic-old-call").toString("base64url");
export const callEventId = "40000000-0000-4000-8000-000000000001";
export const oldMatchLabel = "SYNTHETIC OLD MATCH";
export const callMatchLabel = "SYNTHETIC NESTED FIELD";
export const beginningLabel = "SYNTHETIC BODY BEGINNING";
export const bodyOffset = 270_000;
const prefix = `${beginningLabel}\n`.padEnd(bodyOffset, ".");
export const bodySnippet = `${oldMatchLabel}:${privateQuery}${"retained context / ".repeat(75)}`;
export const bodyText = `${prefix}${bodySnippet}\nSYNTHETIC MATCH PAGE END`;
export const nestedField = `${callMatchLabel}:${privateQuery}This exact string lives inside a JSON-encoded argument, beyond the loaded calls.`;
const oldRecord: SessionContent = {
  ...records[151]!, preview: { text: prefix.slice(0, 240), truncated: true },
  media_type: "text/markdown", byte_count: Buffer.byteLength(bodyText), original_byte_count: Buffer.byteLength(bodyText), sha256: sha(bodyText),
};
const event: AgentSessionEvent = {
  id: callEventId, event_id: "synthetic-native-old-event", capture_id: "synthetic-capture", occurred_at: stamp,
  received_at: stamp, action: "tool_use", kind: "mcp", category: "tool", fidelity: "rich", collection_method: "synthetic",
  tool_name: "update_card", native_tool_call_id: "synthetic-old-call", mcp_server: "backplane", mcp_tool: "update_card", outcome: "failed",
  data: { tool: { arguments: JSON.stringify({ payload: [{ "private.field": nestedField }] }) } },
};
const commonHit = { occurred_at: stamp, source_state: "available" as const };
export const bodyHit = {
  ...commonHit, source_kind: "content" as const, source_id: oldContentId, content_id: oldContentId,
  event_id: null, call_key: null, channel: "reply", field: "body", snippet: bodySnippet, snippet_byte_start: bodyOffset,
  byte_start: bodyOffset + Buffer.byteLength(`${oldMatchLabel}:`),
  byte_end: bodyOffset + Buffer.byteLength(`${oldMatchLabel}:${privateQuery}`),
};
export const callHit = {
  ...commonHit, source_kind: "event" as const, source_id: callEventId, content_id: null,
  event_id: event.event_id, call_key: callKey, channel: null, field: "tool.arguments.payload.0.private~1field",
  snippet: nestedField, snippet_byte_start: 0,
  byte_start: Buffer.byteLength(`${callMatchLabel}:`), byte_end: Buffer.byteLength(`${callMatchLabel}:${privateQuery}`),
};
const count = (count = 0, bytes: number | null = 0) => ({ count, bytes });
const coverage = {
  indexed: count(2, 31 * 1024 * 1024), pending_index: count(), pending_upload: count(), withheld: count(), uncaptured: count(),
  unavailable: count(), nontext: count(), available: count(2, 31 * 1024 * 1024), eligible: count(2, 31 * 1024 * 1024),
  linked_child_metadata: { count: 0, searchable: false }, index_ready: true, extractor_version: "synthetic-b01-v1", verified_at: stamp,
};
export interface SearchRequest {
  q: string; types?: string[] | null; failures_only?: boolean; work_only?: boolean; cursor?: string | null; limit?: number;
}
export interface B02Fixture extends A04Fixture {
  searches: { request: SearchRequest; status: number; at: number }[];
  searchStatus: number;
  searchMode: "complete" | "partial" | "sparse" | "pending" | "empty";
  continueStatus: number;
  sourceStatus: number;
  callFieldPrefix: string;
  staleRestore: boolean;
  holdSearch: boolean;
  heldSearch: (() => void)[];
  releaseSearch: () => void;
}

function searchPage(state: B02Fixture, request: SearchRequest) {
  const restricted = request.types?.length || request.failures_only || request.work_only;
  const prefixBytes = Buffer.byteLength(state.callFieldPrefix);
  const eventHit = { ...callHit, snippet_byte_start: prefixBytes,
    byte_start: callHit.byte_start + prefixBytes, byte_end: callHit.byte_end + prefixBytes };
  const items = restricted ? [eventHit] : [bodyHit, eventHit];
  const incomplete = state.searchMode === "partial" || state.searchMode === "sparse";
  const pending = incomplete || state.searchMode === "pending";
  return {
    items: ["pending", "empty", "sparse"].includes(state.searchMode) ? [] : items,
    generation: 7, scanned_bytes: incomplete ? 8 * 1024 * 1024 : 31 * 1024 * 1024,
    eligible_bytes: 31 * 1024 * 1024, next_cursor: incomplete ? "synthetic-search-cursor-7" : null, complete: !incomplete,
    coverage: pending ? { ...coverage, pending_index: count(3, null), pending_upload: count(1, null),
      withheld: count(1, null), unavailable: count(1, 400), nontext: count(1, 300),
      linked_child_metadata: { count: 2, searchable: false }, index_ready: false } : coverage,
  };
}

export async function installB02Fixture(page: Page, locale: string): Promise<B02Fixture> {
  const inherited = await installA04Fixture(page, locale);
  const state: B02Fixture = Object.assign(inherited, {
    searches: [] as B02Fixture["searches"], searchStatus: 200, searchMode: "complete" as const, continueStatus: 200,
    sourceStatus: 200, callFieldPrefix: "", staleRestore: false, holdSearch: false, heldSearch: [] as (() => void)[],
    releaseSearch() { state.holdSearch = false; state.heldSearch.splice(0).forEach((release) => release()); },
  });
  state.sourceKind = "note";
  const origin = new URL(process.env.BACKPLANE_E2E_BASE_URL ?? "http://localhost:5173").origin;
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const body = path === `${contentsPath}/${oldContentId}/body`;
    const originBody = path === `${contentsPath}/${groupedOriginId}/body`;
    const exactCall = path === `${sessionPath}/calls/${callKey}`;
    const window = path === `${contentsPath}/window`;
    if (path !== searchPath && !body && !originBody && !exactCall && !window) return route.fallback();
    const receipt: RequestReceipt = { path, method: request.method(), query: url.search, mode: url.searchParams.get("mode"),
      cursor: url.searchParams.get("cursor"), callId: null, startedAt: Date.now() };
    state.requests.push(receipt); state.inflight += 1;
    try {
      assert.equal(url.origin, origin);
      assert(!request.headers().authorization && !request.headers().cookie, "Synthetic requests carry no credentials");
      let value: unknown, status = 200;
      if (path === searchPath) {
        assert.equal(request.method(), "POST");
        assert.equal(url.search, "", "Private search values travel only in the POST body");
        const input = request.postDataJSON() as SearchRequest;
        assert(Object.keys(input).every((key) => ["q", "types", "failures_only", "work_only", "cursor", "limit"].includes(key)));
        assert(typeof input.q === "string" && [...input.q].length > 0 && [...input.q].length <= 256);
        assert(!input.q.includes("\u0000") && !input.q.includes("\uFFFF"));
        assert((input.limit ?? 20) <= 20);
        if (input.cursor) assert.equal(input.cursor, "synthetic-search-cursor-7");
        status = input.cursor ? state.continueStatus : state.searchStatus;
        state.searches.push({ request: structuredClone(input), status, at: Date.now() });
        receipt.payload = request.postData() ?? "";
        value = status === 200 ? searchPage(state, input) : { detail: "Synthetic search unavailable", error_code: status === 409 ? "session_search_stale" : undefined };
        // Capture the old authorized response before the delay; denying a later
        // request must not magically change this already in-flight payload.
        if (state.holdSearch) await new Promise<void>((release) => state.heldSearch.push(release));
      } else {
        assert.equal(request.method(), "GET");
        status = body || exactCall || receipt.mode === "anchor" ? state.sourceStatus : 200;
        if (window && receipt.mode === "refresh" && state.staleRestore) {
          state.staleRestore = false; status = 409;
          value = { detail: "Synthetic original window changed", error_code: "content_window_changed" };
        } else if (status !== 200) value = { detail: "Synthetic source disappeared", error_code: "content_not_found" };
        else if (originBody) {
          const offset = Number(url.searchParams.get("offset") ?? 0);
          assert([0, 256 * 1024].includes(offset));
          const bytes = Buffer.from(groupedBody), end = Math.min(bytes.length, offset + 256 * 1024);
          value = { content_id: groupedOriginId, offset, next_offset: end < bytes.length ? end : null,
            total_bytes: bytes.length, text: bytes.subarray(offset, end).toString("utf8") };
        }
        else if (body) {
          const offset = Number(url.searchParams.get("offset") ?? 0);
          assert([0, bodyOffset].includes(offset), "An exact jump uses snippet_byte_start, never sequential body paging");
          const bytes = Buffer.from(bodyText), end = Math.min(bytes.length, offset + 256 * 1024);
          value = { content_id: oldContentId, offset, next_offset: end < bytes.length ? end : null,
            total_bytes: bytes.length, text: bytes.subarray(offset, end).toString("utf8") };
        } else if (exactCall) value = { key: callKey, events: [{ ...event,
          data: { tool: { arguments: JSON.stringify({ payload: [{ "private.field": state.callFieldPrefix + nestedField }] }) } },
        }] };
        else {
          let low = 9902, high = 10001;
          const mode = receipt.mode ?? "latest";
          if (mode === "anchor") {
            const anchor = url.searchParams.get("anchor_id");
            assert([oldContentId, groupedOriginId, originalContentId].includes(anchor ?? ""));
            if (anchor === originalContentId) { low = 9901; high = 10000; }
            else { low = anchor === groupedOriginId ? 1 : 103; high = anchor === groupedOriginId ? 91 : 202; }
          } else if (mode === "refresh") {
            assert(receipt.cursor && /^window:\d+:\d+$/.test(receipt.cursor));
            [, low, high] = receipt.cursor.split(":").map(Number);
          } else assert.equal(mode, "latest", "Find must not sequentially page the reader");
          const items = records.slice(low - 1, high).map((record) => record.id === oldContentId ? oldRecord : record.id === groupedOriginId ? groupedOrigin : record);
          assert(items.length <= 100);
          const cursor = `window:${low}:${high}`;
          value = { capability: "content-window-v1", mode, items, earlier_cursor: cursor, later_cursor: high < 10001 ? cursor : null,
            window_cursor: cursor, anchor_id: mode === "anchor" ? url.searchParams.get("anchor_id") : null };
          receipt.returned = items.length;
        }
      }
      receipt.status = status; receipt.bytes = Buffer.byteLength(JSON.stringify(value));
      await route.fulfill({ status, json: value });
    } catch (error) {
      if (request.failure()?.errorText !== "net::ERR_ABORTED") {
        state.unexpected.push(String(error));
        await route.fulfill({ status: 500, json: { detail: "Synthetic B02 contract failed" } }).catch(() => {});
      }
    } finally { state.inflight -= 1; }
  });
  return state;
}
