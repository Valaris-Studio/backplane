// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { http, HttpResponse, server } from "@/test/msw-server";
import { BOARD_UUID, card, coverage, generation, historyEvent, overview, readyWindow, sequence } from "./history-fixtures";
import type { HistoryGeneration, HistoryWindow } from "../types";

export const SLUG = "test-ws";
export const BOARD = BOARD_UUID;
export const TIMELINE_PATH = `/${SLUG}/boards/${BOARD}/timeline`;
export const API_BASE = `/api/workspaces/${SLUG}/boards/${BOARD}/timeline`;
export const RELATED_PATH = "/continuity-related-work";
export const TARGET_OFFSET = 450;
export const TARGET_SEQ = sequence(TARGET_OFFSET);
export const CARD_ID = "32db1511-e506-4411-8f0a-2af5377fcb78";
export const OTHER_CARD_ID = "3797247f-9a1e-45c1-b14b-3ae197347774";
export const NOTE_ID = "2820f065-6f1b-4470-9bbd-5eef87198d53";
export const RESOURCE_ID = "48c25cc0-e9e7-436a-8e41-73507619711e";
export const TARGET_TITLE = "Historical exact card";
export const OTHER_TITLE = "Separate historical card";
export const TARGET_SUMMARY = "Exact retained continuity event";
export const SEARCH_MATCH = "Exact historical search match";
export type TargetKind = "card" | "note" | "resource";
export type MissingTarget = "gap" | "after-head";
export interface HistoryReceipt {
  viewer: string; method: string; path: string; search: string;
  generationId?: string; requestId?: string; status: number;
}

export function installContinuityHistory(options: { kind?: TargetKind; missing?: MissingTarget; denyWindow?: boolean } = {}) {
  let viewer = "viewer-a";
  let serial = 0;
  const kind = options.kind ?? "card";
  const requestedSequence = options.missing === "after-head" ? sequence(10_001) : TARGET_SEQ;
  const requests: HistoryReceipt[] = [];
  const unexpected: string[] = [];
  const created: Array<{ viewer: string; requestId: string; generation: HistoryGeneration }> = [];
  const expired = new Set<string>();
  const requestIds = new Map<string, HistoryGeneration>();
  const targetId = kind === "card" ? CARD_ID : kind === "note" ? NOTE_ID : RESOURCE_ID;

  function record(request: Request, status: number, fields: Partial<HistoryReceipt> = {}) {
    const url = new URL(request.url);
    requests.push({ viewer, method: request.method, path: url.pathname, search: url.search, status, ...fields });
  }
  function denied(request: Request, id: string) {
    const existing = created.find((entry) => entry.generation.id === id);
    // The current service authorizes the board, not a generation-owner column.
    // Fresh-viewer isolation is asserted on client requests, not invented wire ACLs.
    const status = !existing ? 404 : expired.has(id) ? 410 : 0;
    if (!status) return null;
    record(request, status, { generationId: id });
    return HttpResponse.json({ detail: status === 410 ? "Historical generation expired" : "Generation not found", error_code: status === 410 ? "timeline_generation_expired" : "not_found" }, { status });
  }
  function windowFor(id: string, params: URLSearchParams): HistoryWindow {
    const at = params.get("at_seq");
    // Match the real repository's seek rule: the first >= target, or the
    // generation head when target is later. The UI must enforce exactness.
    const offset = options.missing === "after-head" && at ? 10_000
      : options.missing === "gap" && at === TARGET_SEQ ? TARGET_OFFSET + 1
      : at ? Number(BigInt(at) - BigInt(sequence(0)))
      : params.get("cursor") === "before-initial" ? 9995 : 9998;
    const result: HistoryWindow = readyWindow(offset, id);
    result.events = result.events.filter((event) => BigInt(event.seq) <= BigInt(sequence(10_000)));
    result.anchor.state.cards = [card({ id: CARD_ID, title: "Historical before exact event" }), card({ id: OTHER_CARD_ID, title: OTHER_TITLE, position: 2048 })];
    result.events = result.events.map((event) => event.seq === TARGET_SEQ ? historyEvent(TARGET_OFFSET, {
      entity_type: kind, entity_id: targetId, entity_title: kind === "card" ? TARGET_TITLE : `Historical ${kind} label`,
      action: "updated", summary: TARGET_SUMMARY,
      before_state: kind === "card" ? card({ id: CARD_ID, title: "Historical before exact event" }) : null,
      after_state: kind === "card" ? card({ id: CARD_ID, title: TARGET_TITLE }) : null,
    }) : event);
    result.window = {
      first_seq: result.events[0]?.seq ?? null, last_seq: result.events.at(-1)?.seq ?? null,
      previous_cursor: offset > 0 ? "before-initial" : null, next_cursor: offset < 9998 ? "after-target" : null,
    };
    result.coverage = coverage();
    return result;
  }
  server.use(
    http.get("/api/me", ({ request }) => {
      record(request, 200); return HttpResponse.json({ id: viewer, name: viewer, email: `${viewer}@example.test`, avatar_url: null });
    }),
    http.post(`${API_BASE}/generations`, async ({ request }) => {
      const body = await request.json() as { request_id?: unknown };
      if (typeof body.request_id !== "string" || !body.request_id) {
        unexpected.push("Generation request lacks its real idempotency identity");
        record(request, 422); return HttpResponse.json({ detail: "Missing request_id" }, { status: 422 });
      }
      const key = `${viewer}:${body.request_id}`;
      let item = requestIds.get(key);
      if (!item) {
        serial += 1;
        item = generation(`00000000-0000-4000-8000-${String(serial).padStart(12, "0")}`);
        requestIds.set(key, item); created.push({ viewer, requestId: body.request_id, generation: item });
      }
      if (expired.has(item.id)) {
        record(request, 410, { generationId: item.id, requestId: body.request_id });
        return HttpResponse.json({ detail: "Historical generation expired", error_code: "timeline_generation_expired" }, { status: 410 });
      }
      record(request, 201, { generationId: item.id, requestId: body.request_id });
      return HttpResponse.json(item, { status: 201 });
    }),
    http.get(`${API_BASE}/generations/:id/overview`, ({ request, params }) => {
      const id = String(params.id); const error = denied(request, id); if (error) return error;
      record(request, 200, { generationId: id }); return HttpResponse.json(overview(id));
    }),
    http.get(`${API_BASE}/generations/:id/window`, ({ request, params }) => {
      const id = String(params.id); const error = denied(request, id); if (error) return error;
      if (options.denyWindow) {
        record(request, 403, { generationId: id }); return HttpResponse.json({ detail: "Board access withdrawn", error_code: "forbidden" }, { status: 403 });
      }
      const search = new URL(request.url).searchParams;
      const at = search.get("at_seq");
      if (at !== null && (!/^\d{1,19}$/.test(at) || BigInt(at) > 9223372036854775807n)) {
        unexpected.push(`Unsafe sequence reached HTTP: ${at}`);
        record(request, 422, { generationId: id }); return HttpResponse.json({ detail: "Invalid sequence" }, { status: 422 });
      }
      record(request, 200, { generationId: id }); return HttpResponse.json(windowFor(id, search));
    }),
    http.get(`${API_BASE}/generations/:id/search`, ({ request, params }) => {
      const id = String(params.id); const error = denied(request, id); if (error) return error;
      record(request, 200, { generationId: id });
      return HttpResponse.json({ generation_id: id, scope: "generation", matches: [{ id: "historical-exact-result", seq: requestedSequence, created_at: "2026-10-08T12:00:00Z", summary: SEARCH_MATCH }], next_cursor: null });
    }),
    http.all("*", ({ request }) => {
      const url = new URL(request.url); unexpected.push(`${request.method} ${url.pathname}`);
      record(request, 500); return HttpResponse.json({ detail: "Unexpected timeline continuity request" }, { status: 500 });
    }),
  );
  return {
    requests, unexpected, created, requestedSequence, targetId, kind,
    get viewer() { return viewer; }, setViewer: (next: string) => { viewer = next; },
    expire: (id: string) => { expired.add(id); },
  };
}
