// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import type { BoardDetail, Card } from "../../src/types/kanban";
import type { LinkedSessionList } from "../../src/types/agent-session";
import { boardApi, installA04Fixture, workspaceApi } from "./a04-related-continuity";
import { boardId, cardId, session, slug, stamp, type RequestReceipt } from "./session-window-fixture";

export const firstCardId = cardId;
export const secondCardId = "10000000-0000-4000-8000-000000000004";
export const sectionCardHref = (id: string) => "/" + slug + "/boards/" + boardId + "/kanban?card=" + id + "&sort=priority";
export const sectionCardApi = (id: string) => boardApi + "/cards/" + id;
export const sectionCardTitle = (id: string) => id === firstCardId ? "Synthetic requested card A" : "Synthetic requested card B";
export const cardLinkLabel = (id: string) => id === firstCardId ? "Open synthetic card A" : "Open synthetic card B";

function cardDocument(other: string) {
  return JSON.stringify({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: cardLinkLabel(other),
      marks: [{ type: "link", attrs: { href: sectionCardHref(other), target: null } }] }] },
    // Real content keeps the lazy related section below the initial viewport.
    // Nothing changes browser geometry, React state, or IntersectionObserver.
    ...Array.from({ length: 32 }, (_, index) => ({ type: "paragraph", content: [{
      type: "text", text: "Synthetic saved card context " + (index + 1) + ". Review the current work before following related evidence.",
    }] })),
  ] });
}

const emptyRelated: LinkedSessionList = { items: [], summary: {
  session_count: 0, first_seen_at: null, last_seen_at: null, total_duration_seconds: 0, wall_duration_seconds: 0,
  input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: 0,
  cost_usd: null, cost_reported_usd: null, cost_estimated_usd: null, cost_source: null, cost_basis: null, cost_complete: false,
} };

/** Adds only exact synthetic two-card HTTP responses; the real AppShell owns navigation and retained state. */
export async function installSectionReturnFixture(page: Page, statusA: 200 | 403) {
  const state = await installA04Fixture(page, "en");
  state.card = { ...state.card, title: sectionCardTitle(firstCardId), description: cardDocument(secondCardId) };
  const second: Card = { ...state.card, id: secondCardId, title: sectionCardTitle(secondCardId),
    description: cardDocument(firstCardId), position: 2048 };
  const cards = [state.card, second];
  const summaries = cards.map((card) => ({ ...card, description: "Synthetic board preview; exact detail supplies the real rich-text link." }));
  const board: BoardDetail = { id: boardId, slug: "a04-synthetic", workspace_id: session.workspace_id, name: "Synthetic related work",
    description: "", tags: [], is_frozen: false, loop_configured: false, has_definition: false, created_at: stamp, updated_at: stamp,
    columns: [{ id: state.card.column_id, board_id: boardId, name: "In progress", column_type: "active", position: 1024,
      cards: summaries, created_at: stamp, updated_at: stamp }] };
  const controlled = new Set([boardApi, workspaceApi + "/boards", boardApi + "/cards", boardApi + "/notes",
    "/api/me/companion/installations", ...cards.flatMap((card) => {
      const path = sectionCardApi(card.id); return [path, path + "/dependencies", path + "/sessions"];
    })]);
  const origin = new URL(process.env.BACKPLANE_E2E_BASE_URL ?? "http://localhost:5173").origin;
  // Last registered exact paths take precedence; unknown requests still reach
  // the inherited strict allowlist and shared response-byte ledger.
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!controlled.has(path)) return route.fallback();
    const receipt: RequestReceipt = { path, query: url.search, method: request.method(), mode: null,
      callId: null, cursor: null, startedAt: Date.now() };
    state.requests.push(receipt); state.inflight += 1;
    try {
      assert.equal(url.origin, origin);
      assert.equal(request.method(), "GET", "This journey authorizes no writes");
      assert(!request.headers().authorization && !request.headers().cookie, "No fixture credentials");
      let value: unknown, status = 200;
      if (path === boardApi) value = board;
      else if (path === workspaceApi + "/boards") value = [board];
      else if (path === boardApi + "/cards") value = summaries;
      else if (path === "/api/me/companion/installations") value = [];
      else if (path === boardApi + "/notes") {
        assert(cards.some((card) => card.id === url.searchParams.get("card_id")), "Notes remain scoped to the selected card");
        value = [];
      } else {
        const card = cards.find((item) => path === sectionCardApi(item.id) || path.startsWith(sectionCardApi(item.id) + "/"));
        assert(card, "Only the two exact synthetic cards are available");
        if (path === sectionCardApi(card.id)) value = card;
        else if (path.endsWith("/dependencies")) value = { depends_on: [], blocks: [] };
        else {
          assert.equal(path, sectionCardApi(card.id) + "/sessions");
          status = card.id === firstCardId ? statusA : 200;
          value = status === 200 ? emptyRelated : { detail: "Synthetic current related-session access denied" };
        }
      }
      receipt.status = status; receipt.bytes = Buffer.byteLength(JSON.stringify(value));
      await route.fulfill({ status, json: value });
    } catch (error) {
      if (request.failure()?.errorText !== "net::ERR_ABORTED") {
        state.unexpected.push(String(error));
        await route.fulfill({ status: 500, json: { detail: "Synthetic section-return fixture contract failed" } }).catch(() => {});
      }
    } finally { state.inflight -= 1; }
  });
  return state;
}
