// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import type { BoardDetail, Card } from "../../src/types/kanban";
import type { HistoryWindow } from "../../src/features/timeline/types";
import { stamp } from "./session-window-fixture";
import { boardApi, boardId, cardId, columnId, currentTitle, historicalTitle, installTimelineFixture, noteId,
  sequence, sha, targetOffset, targetSeq, targetSummary, timelineApi, type TimelineFixture, type TimelineReceipt } from "./a05-timeline-navigation";

export type DeletedScenario = "card-detail-404" | "card-omitted" | "note-detail-404" | "card-deletion-event" | "note-deletion-event";
export interface DeletedReceipt extends TimelineReceipt { responseSha256?: string; ids?: string[] }
export interface DeletedFixture extends TimelineFixture { scenario: DeletedScenario; deletedRequests: DeletedReceipt[] }

function deletedWindow(generationId: string, kind: "card" | "note"): HistoryWindow {
  const before = { id: cardId, title: historicalTitle, card_type: "task", priority: "medium", column_id: columnId,
    position: 1024, status: "todo", labels: [], participants: [] };
  const coverage = { quality: "reconstructed" as const, unknown_origin: false, missing_structural_snapshots: "0", reasons: [] };
  return { status: "ready", generation_id: generationId,
    anchor: { through_seq: sequence(targetOffset - 1), state: { columns: [{ id: columnId, name: "Recorded column", column_type: null, position: 1024 }],
      cards: kind === "card" ? [before] : [] }, coverage },
    events: [{ id: `timeline-browser-event-${targetOffset}`, seq: targetSeq, workspace_id: "workspace-synthetic", board_id: boardId,
      actor_id: "historical-actor-id", actor_name: "Synthetic historical actor", actor_email: null, agent_id: null,
      entity_type: kind, entity_id: kind === "card" ? cardId : noteId, entity_title: kind === "card" ? historicalTitle : "Historical deleted note",
      action: "deleted", summary: targetSummary, changes: null, via_api_key: null, created_at: "2026-10-08T00:07:30Z",
      before_state: kind === "card" ? before : null, after_state: null }],
    window: { first_seq: targetSeq, last_seq: targetSeq, previous_cursor: `window-before-${targetOffset}`, next_cursor: `window-after-${targetOffset}` }, coverage };
}

/** Compose real shell routing; deletion affects only exact current reads and the stated list shape. */
export async function installDeletedFixture(page: Page, locale: string, scenario: DeletedScenario): Promise<DeletedFixture> {
  const kind = scenario.startsWith("card") ? "card" : "note";
  const inherited = await installTimelineFixture(page, locale, { kind });
  const fixture: DeletedFixture = Object.assign(inherited, { scenario, deletedRequests: [] as DeletedReceipt[] });
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const windowMatch = path.match(new RegExp(`^${timelineApi}/generations/([0-9a-f-]{36})/window$`, "i"));
    const isDeletionEvent = scenario.endsWith("deletion-event");
    const exactPath = `${boardApi}/${kind === "card" ? "cards" : "notes"}/${kind === "card" ? cardId : noteId}`;
    const currentBoard = ["card-omitted", "card-detail-404"].includes(scenario) && [boardApi, `${boardApi}/cards`].includes(path);
    const omittedNoteList = scenario === "note-detail-404" && path === `${boardApi}/notes`;
    if (!(isDeletionEvent && windowMatch) && !(path === exactPath && !isDeletionEvent) && !currentBoard && !omittedNoteList) return route.fallback();
    const receipt: DeletedReceipt = { path, query: url.search, method: request.method(), owner: fixture.owner,
      kind: windowMatch ? "window" : path === boardApi ? "shell" : "current", generationId: windowMatch?.[1],
      mode: null, callId: null, cursor: url.searchParams.get("cursor"), startedAt: Date.now() };
    fixture.deletedRequests.push(receipt); fixture.timelineRequests.push(receipt); fixture.requests.push(receipt); fixture.inflight += 1;
    try {
      assert.equal(url.origin, new URL(page.url()).origin); assert.equal(request.method(), "GET");
      assert(!request.headers().authorization && !request.headers().cookie, "No synthetic credentials");
      let value: unknown, status = 200;
      if (windowMatch) {
        const generationId = windowMatch[1]!;
        assert([...fixture.store.byRequest.values()].some((generation) => generation.id === generationId));
        assert.equal(url.searchParams.get("at_seq"), targetSeq); assert.equal(url.searchParams.get("exact"), "true");
        value = deletedWindow(generationId, kind);
      } else if (path === exactPath) {
        // card-detail-404 deliberately retains the prior board summary: a real
        // delete can commit between that summary read and the exact body read.
        status = 404; value = { detail: "The requested current entity is unavailable", error_code: "not_found" };
      } else if (currentBoard) {
        const staleCard: Card = { id: cardId, title: currentTitle, description: "Stale metadata excerpt for the requested deleted card", card_type: "task",
          priority: "medium", column_id: columnId, position: 1024, participants: [], status: "todo", due_date: null,
          labels: [], created_at: stamp, updated_at: stamp };
        const cards = scenario === "card-omitted" ? [] : [staleCard];
        const board: BoardDetail = { id: boardId, slug: "synthetic-timeline-board", workspace_id: "workspace-synthetic", name: "Synthetic timeline board",
          description: "The requested current card has been deleted", tags: [], is_frozen: false, loop_configured: false, created_at: stamp, updated_at: stamp,
          columns: [{ id: columnId, board_id: boardId, name: "Current column", column_type: "active", position: 1024, cards, created_at: stamp, updated_at: stamp }] };
        value = path === boardApi ? board : cards; receipt.ids = cards.map((card) => card.id);
      } else { value = []; receipt.ids = []; }
      const body = JSON.stringify(value);
      receipt.status = status; receipt.intentionalError = status >= 400; receipt.bytes = Buffer.byteLength(body); receipt.responseSha256 = sha(Buffer.from(body));
      await route.fulfill({ status, contentType: "application/json", body, headers: { "X-Total-Count": "0" } });
    } catch (error) {
      if (request.failure()?.errorText !== "net::ERR_ABORTED") {
        fixture.unexpected.push(`Deleted-target fixture: ${String(error)}`);
        await route.fulfill({ status: 500, json: { detail: "Synthetic deleted-target contract failed" } }).catch(() => {});
      }
    } finally { receipt.completedAt = Date.now(); fixture.inflight -= 1; }
  });
  return fixture;
}
