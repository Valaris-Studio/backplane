// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import type { BoardDetail, Card } from "../../src/types/kanban";
import type { HistoryGeneration, HistoryOverview, HistoryWindow } from "../../src/features/timeline/types";
import { boardApi, boardId, cardId, columnId, currentTitle, historicalTitle, installTimelineFixture,
  sequence, sha, timelineApi, type TimelineFixture, type TimelineReceipt } from "./a05-timeline-navigation";

export const frameCount = 200;
export const gestureFrames = 80;
export const excludedTitle = "Excluded low-priority card";
export const localFlag = "PRIVATE scrub flag kept only in this tab";
export const summary = (offset: number) => `Settled scrub event ${offset}`;
const timestamp = (offset: number) => new Date(Date.UTC(2026, 9, 8) + offset * 1000).toISOString();
const coverage = { quality: "reconstructed" as const, unknown_origin: false, missing_structural_snapshots: "0", reasons: [] };
const snapshot = { id: cardId, title: historicalTitle, card_type: "task", priority: "medium", column_id: columnId,
  position: 1024, status: "todo", labels: [], participants: [] };
const columns = [{ id: columnId, name: "Recorded column", column_type: null, position: 1024 }];

function fullWindow(generationId: string): HistoryWindow {
  return {
    status: "ready", generation_id: generationId,
    anchor: { through_seq: null, state: { columns, cards: [snapshot] }, coverage },
    events: Array.from({ length: frameCount }, (_, offset) => ({
      id: `scrub-event-${offset}`, seq: sequence(offset), workspace_id: "workspace-synthetic", board_id: boardId,
      actor_id: "historical-actor-id", actor_name: "Synthetic historical actor", actor_email: null, agent_id: null,
      entity_type: "card", entity_id: cardId, entity_title: historicalTitle, action: "updated",
      summary: summary(offset), changes: null, via_api_key: null, created_at: timestamp(offset),
      before_state: snapshot, after_state: snapshot,
    })),
    window: { first_seq: sequence(0), last_seq: sequence(frameCount - 1), previous_cursor: null, next_cursor: null }, coverage,
  };
}

/** Own only the finite historical corpus and the two-card filter control. */
export async function installScrubFixture(page: Page, locale: string): Promise<TimelineFixture> {
  const fixture = await installTimelineFixture(page, locale, { kind: "card" });
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const match = path.match(new RegExp(`^${timelineApi}/generations(?:/([0-9a-f-]{36})/(window|overview))?$`, "i"));
    if (!match && path !== boardApi) return route.fallback();
    const generationId = match?.[1], action = match?.[2];
    const receipt: TimelineReceipt = {
      path, query: url.search, method: request.method(), mode: null, callId: null,
      cursor: url.searchParams.get("cursor"), owner: fixture.owner, startedAt: Date.now(), generationId,
      kind: path === boardApi ? "shell" : action === "window" ? "window" : action === "overview" ? "overview" : "generation",
    };
    fixture.requests.push(receipt); fixture.timelineRequests.push(receipt); fixture.inflight += 1;
    try {
      assert.equal(url.origin, new URL(page.url()).origin);
      assert(!request.headers().authorization && !request.headers().cookie, "Synthetic requests carry no credentials");
      let value: BoardDetail | HistoryGeneration | HistoryOverview | HistoryWindow, status = 200;
      if (path === boardApi) {
        assert.equal(request.method(), "GET");
        const card: Card = { id: cardId, title: currentTitle, description: "Metadata excerpt only", card_type: "task",
          priority: "medium", column_id: columnId, position: 1024, participants: [], status: "todo", due_date: null,
          labels: [], created_at: timestamp(0), updated_at: timestamp(0) };
        value = { id: boardId, slug: "synthetic-timeline-board", workspace_id: "workspace-synthetic", name: "Synthetic timeline board",
          description: "Finite synthetic scrub and filter fixture", tags: [], is_frozen: false, loop_configured: false,
          created_at: timestamp(0), updated_at: timestamp(0), columns: [{ id: columnId, board_id: boardId, name: "Current column",
            column_type: "active", position: 1024, created_at: timestamp(0), updated_at: timestamp(0), cards: [card,
              { ...card, id: "70000000-0000-4000-8000-000000000099", title: excludedTitle, priority: "low", position: 2048 }] }] };
      } else if (!action) {
        assert.equal(request.method(), "POST");
        const body = request.postDataJSON() as { request_id: string };
        assert.deepEqual(Object.keys(body), ["request_id"]);
        assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.request_id));
        receipt.requestId = body.request_id; receipt.payload = request.postData() ?? "";
        receipt.historyState = await page.evaluate(() => history.state);
        const key = `${boardId}:${body.request_id}`;
        let generation = fixture.store.byRequest.get(key);
        if (!generation) {
          status = 201;
          generation = { id: `71000000-0000-4000-8000-${String(fixture.store.created.length + 1).padStart(12, "0")}`,
            board_id: boardId, created_at: timestamp(0), expires_at: "2099-10-09T12:00:00Z",
            first_seq: sequence(0), head_seq: sequence(frameCount - 1), event_count: String(frameCount) };
          fixture.store.byRequest.set(key, generation);
          fixture.store.created.push({ owner: fixture.owner, requestId: body.request_id, generationId: generation.id });
        }
        receipt.generationId = generation.id; value = generation;
      } else {
        assert.equal(request.method(), "GET");
        assert([...fixture.store.byRequest.values()].some((item) => item.id === generationId), "Only established generations may be read");
        assert(!fixture.store.expired.has(generationId!), "Expiration is covered by the unchanged timeline fixture");
        if (action === "window") {
          const at = url.searchParams.get("at_seq");
          assert(!url.searchParams.has("cursor") && !url.searchParams.has("at_time"));
          assert(Number(url.searchParams.get("limit")) >= frameCount && Number(url.searchParams.get("limit")) <= 500);
          if (at !== null) {
            assert(/^\d+$/.test(at));
            assert(BigInt(at) >= BigInt(sequence(0)) && BigInt(at) <= BigInt(sequence(frameCount - 1)));
            assert.equal(url.searchParams.get("exact"), "true");
          }
          value = fullWindow(generationId!);
        } else {
          assert.equal(url.searchParams.get("buckets"), "128");
          value = { generation_id: generationId!, first_seq: sequence(0), head_seq: sequence(frameCount - 1), event_count: String(frameCount),
            first_at: timestamp(0), last_at: timestamp(frameCount - 1),
            buckets: [{ start_at: timestamp(0), end_at: timestamp(frameCount), count: String(frameCount), first_seq: sequence(0), last_seq: sequence(frameCount - 1) }] };
        }
      }
      const body = JSON.stringify(value);
      receipt.status = status; receipt.bytes = Buffer.byteLength(body);
      await route.fulfill({ status, contentType: "application/json", body, headers: { "X-Synthetic-Body-Sha256": sha(body) } });
    } catch (error) {
      if (request.failure()?.errorText !== "net::ERR_ABORTED") {
        fixture.unexpected.push(`Settled scrub fixture: ${String(error)}`);
        await route.fulfill({ status: 500, json: { detail: "Synthetic scrub fixture failed" } }).catch(() => {});
      }
    } finally { receipt.completedAt = Date.now(); fixture.inflight -= 1; }
  });
  return fixture;
}

export interface BrowserScrubLedger {
  phase: string;
  history: { phase: string; method: "pushState" | "replaceState"; href: string; state: unknown; at: number }[];
  input: { phase: string; type: string; trusted: boolean; key?: string; repeat?: boolean; pointerType?: string; value?: string; at: number }[];
}
type InstrumentedWindow = Window & { __a05ScrubLedger: BrowserScrubLedger };

/** Passthrough observation only: never set a slider value or router state. */
export async function installScrubObserver(page: Page) {
  await page.addInitScript(() => {
    const ledger: BrowserScrubLedger = { phase: "boot", history: [], input: [] };
    (window as InstrumentedWindow).__a05ScrubLedger = ledger;
    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method].bind(history);
      history[method] = (data, unused, url) => {
        original(data, unused, url);
        ledger.history.push({ phase: ledger.phase, method, href: location.href, state: structuredClone(data), at: performance.now() });
      };
    }
    for (const type of ["input", "pointerdown", "pointerup", "pointercancel", "keydown", "keyup"]) {
      window.addEventListener(type, (event) => {
        const node = event.target;
        if (!(node instanceof HTMLInputElement) || node.type !== "range") return;
        ledger.input.push({ phase: ledger.phase, type, trusted: event.isTrusted,
          key: event instanceof KeyboardEvent ? event.key : undefined,
          repeat: event instanceof KeyboardEvent ? event.repeat : undefined,
          pointerType: event instanceof PointerEvent ? event.pointerType : undefined,
          value: node.value, at: performance.now() });
      }, true);
    }
  });
}
export const browserLedger = (page: Page) => page.evaluate(() => (window as InstrumentedWindow).__a05ScrubLedger);
export const setPhase = (page: Page, phase: string) => page.evaluate((value) => { (window as InstrumentedWindow).__a05ScrubLedger.phase = value; }, phase);
