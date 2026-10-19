// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import type { BoardDetail, Card } from "../../src/types/kanban";
import { installNavigationFixture, type NavigationFixture } from "./uxc-navigation-fixture";
import { boardId, slug, stamp, type RequestReceipt } from "./session-window-fixture";

export { boardId, slug };
export const boardPath = `/${slug}/boards/${boardId}/kanban`;
export const cardA = "40000000-0000-4000-8000-000000000001";
export const cardB = "40000000-0000-4000-8000-000000000002";
export const cardNames = { [cardA]: "Synthetic card A", [cardB]: "Synthetic card B" };
export const cardHref = (id: string) => `${boardPath}?card=${id}`;
const apiPath = `/api/workspaces/${slug}/boards/${boardId}`;
const document = (text: string) => JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
export const originalCards: Card[] = [cardA, cardB].map((id, index) => ({
  id, title: cardNames[id]!, description: document(`Saved browser description ${index === 0 ? "A" : "B"}`),
  card_type: "task", priority: "medium", column_id: "column-synthetic", position: (index + 1) * 1024,
  participants: [], status: "todo", due_date: null, labels: ["synthetic"], created_at: stamp, updated_at: stamp,
}));

export interface CardWrite {
  cardId: string;
  payload: Record<string, unknown>;
  before: Card;
  after?: Card;
  status?: number;
}

export interface CardNavigationFixture extends NavigationFixture {
  cards: Map<string, Card>;
  cardWrites: CardWrite[];
  holdA: boolean;
  outcomeA: 200 | 503;
  heldA: (() => void)[];
  releaseA: () => void;
}

/** Add card routes to the existing strict synthetic AppShell fixture. */
export async function installCardNavigationFixture(page: Page): Promise<CardNavigationFixture> {
  const inherited = await installNavigationFixture(page, "en");
  const state: CardNavigationFixture = Object.assign(inherited, {
    cards: new Map(originalCards.map((card) => [card.id, structuredClone(card)])),
    cardWrites: [], holdA: false, outcomeA: 200 as const, heldA: [] as (() => void)[],
    releaseA() { state.holdA = false; state.heldA.splice(0).forEach((resolve) => resolve()); },
  });
  const paths = new Set([
    "/api/auth/modes", `/api/workspaces/${slug}/boards`, `/api/workspaces/${slug}/config`,
    `/api/workspaces/${slug}/metrics/agents`, `/api/workspaces/${slug}/executions`,
    `/api/workspaces/${slug}/executions/skipped-card-ids`,
    apiPath, `${apiPath}/cards`, `${apiPath}/notes`, `${apiPath}/health`, `${apiPath}/loop/status`,
    `${apiPath}/completion/policy`,
    ...[cardA, cardB].flatMap((id) => [
      `${apiPath}/cards/${id}`, `${apiPath}/cards/${id}/dependencies`, `${apiPath}/completion/cards/${id}`,
    ]),
  ]);
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!paths.has(path)) return route.fallback();
    const receipt: RequestReceipt = {
      path, method: request.method(), query: url.search, mode: null, callId: null, cursor: null, startedAt: Date.now(),
    };
    state.requests.push(receipt);
    state.inflight += 1;
    try {
      assert(!request.headers().authorization && !request.headers().cookie, "Synthetic requests must carry no credentials");
      let value: unknown;
      let status = 200;
      const id = [cardA, cardB].find((candidate) => path === `${apiPath}/cards/${candidate}`);
      if (id && request.method() === "PATCH") {
        const payload = request.postDataJSON() as Record<string, unknown>;
        receipt.payload = request.postData() ?? "";
        assert.deepEqual(Object.keys(payload), ["description"], "Only the deliberately edited description may be written");
        assert.equal(typeof payload.description, "string");
        const write: CardWrite = { cardId: id, payload: structuredClone(payload), before: structuredClone(state.cards.get(id)!) };
        state.cardWrites.push(write);
        if (id === cardA && state.holdA) await new Promise<void>((resolve) => state.heldA.push(resolve));
        status = id === cardA ? state.outcomeA : 200;
        if (status === 200) state.cards.set(id, { ...state.cards.get(id)!, ...payload, updated_at: "2026-10-18T23:00:00Z" });
        write.after = structuredClone(state.cards.get(id)!);
        write.status = status;
        value = status === 200 ? write.after : { detail: "Synthetic delayed A save failure", error_code: "unavailable" };
      } else {
        assert.equal(request.method(), "GET", `Unexpected mutation: ${request.method()} ${path}`);
        const board: BoardDetail = {
          id: boardId, slug: "synthetic-card-navigation", workspace_id: "workspace-synthetic", name: "Synthetic card navigation",
          description: "", tags: [], is_frozen: false, loop_configured: false, created_at: stamp, updated_at: stamp,
          columns: [{ id: "column-synthetic", board_id: boardId, name: "In progress", column_type: "active", position: 1024,
            cards: [...state.cards.values()], created_at: stamp, updated_at: stamp }],
        };
        if (path === apiPath) value = board;
        else if (path === `/api/workspaces/${slug}/boards`) value = [board];
        else if (path === `${apiPath}/cards`) value = [...state.cards.values()];
        else if (id) value = state.cards.get(id);
        else if (path.endsWith("/dependencies")) {
          const source = path.includes(cardA) ? cardA : cardB;
          const target = source === cardA ? cardB : cardA;
          // Each chip's destination is a real retained card. The fixture is a
          // navigational relation, not evidence of dependency graph validity.
          value = source === cardA
            ? { depends_on: [{ card_id: source, depends_on_card_id: target, depends_on_title: cardNames[target], depends_on_column_type: "active", satisfied: false }], blocks: [] }
            : { depends_on: [], blocks: [{ card_id: target, depends_on_card_id: source, depends_on_title: cardNames[target], depends_on_column_type: "active", satisfied: false }] };
        } else if (path === "/api/auth/modes") value = { oidc_enabled: false, password_enabled: false, dev_mode: true, companion_enabled: false };
        else if (path === `/api/workspaces/${slug}/config`) value = { pipeline_config: null };
        else if (path === `/api/workspaces/${slug}/metrics/agents`) value = { agents: [] };
        else if (path === `${apiPath}/health`) value = { health_score: 100 };
        else if (path === `${apiPath}/loop/status`) value = { state: "off", enabled: false, disabled_reason: null, actionable: false,
          has_inflight_iteration: false, last_iteration_at: null, last_iteration_status: null, bound_agent_count: 0, alive_agent_count: 0, spent_usd: 0, budget_usd: null };
        else if (path === `${apiPath}/completion/policy`) value = {
          override: null, workspace_policy: null, effective_policy: null, origin: "legacy",
          policy_hash: null, capabilities: {}, incompatibilities: [],
        };
        else if (path.includes("/completion/cards/")) value = { completion_mode: "source", candidate: null, attempts: [] };
        else value = [];
      }
      receipt.status = status;
      receipt.bytes = Buffer.byteLength(JSON.stringify(value));
      await route.fulfill({ status, json: value });
    } catch (error) {
      if (request.failure()?.errorText !== "net::ERR_ABORTED") {
        state.unexpected.push(String(error));
        await route.fulfill({ status: 500, json: { detail: "Synthetic card fixture contract failed" } }).catch(() => {});
      }
    } finally { state.inflight -= 1; }
  });
  return state;
}
