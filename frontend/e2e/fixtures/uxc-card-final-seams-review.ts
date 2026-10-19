// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import type { BoardDetail, Card } from "../../src/types/kanban";
import { boardId, cardA, cardB, installCardNavigationFixture, slug, type CardNavigationFixture, type CardWrite } from "./uxc-card-navigation-review";
import { stamp, type RequestReceipt } from "./session-window-fixture";

export { boardPath, cardA, cardB, cardHref, cardNames, originalCards } from "./uxc-card-navigation-review";
export const reviewedText = "Reviewed café 🙂 description";
export const submittedDescription = '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Reviewed café 🙂 description"}]}]}';
// Exact output of CardUpdate validation plus strip_unsafe_media_text recorded
// in a01-description-real-canonicalization.json; this fixture does not run HTTP backend code.
export const canonicalDescription = '{"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Reviewed caf\\u00e9 \\ud83d\\ude42 description"}]}]}';
export const remoteDescription = JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "A later remote description must survive the move retry" }] }] });
export const targetColumn = "column-final-seams-target";
export const targetColumnName = "Review target";
const apiPath = `/api/workspaces/${slug}/boards/${boardId}`;

export interface FinalSeamsFixture extends CardNavigationFixture {
  descriptionResponse: "canonical" | "echo";
  moveStatus: 200 | 409;
  moves: CardWrite[];
  remoteEdits: { before: Card; after: Card }[];
  applyRemoteDescription: () => void;
}

export async function installFinalSeamsFixture(page: Page): Promise<FinalSeamsFixture> {
  const inherited = await installCardNavigationFixture(page);
  const state: FinalSeamsFixture = Object.assign(inherited, {
    descriptionResponse: "canonical" as const, moveStatus: 409 as const,
    moves: [] as CardWrite[], remoteEdits: [] as { before: Card; after: Card }[],
    applyRemoteDescription() {
      const before = structuredClone(state.cards.get(cardA)!);
      const after = { ...before, description: remoteDescription, updated_at: "2026-10-19T01:00:00Z" };
      state.cards.set(cardA, after);
      state.remoteEdits.push({ before, after: structuredClone(after) });
    },
  });
  const cardPaths = new Map([cardA, cardB].map((id) => [`${apiPath}/cards/${id}`, id]));
  const movePaths = new Map([cardA, cardB].map((id) => [`${apiPath}/cards/${id}/move`, id]));
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const cardId = cardPaths.get(path), moveId = movePaths.get(path);
    if (!cardId && !moveId && path !== apiPath && path !== `/api/workspaces/${slug}/boards`) return route.fallback();
    const receipt: RequestReceipt = { path, method: request.method(), query: url.search, mode: null, callId: null, cursor: null, startedAt: Date.now() };
    state.requests.push(receipt);
    state.inflight += 1;
    try {
      assert(!request.headers().authorization && !request.headers().cookie, "Synthetic requests carry no credentials");
      let value: unknown, status = 200;
      if (request.method() === "PATCH" && (cardId || moveId)) {
        const id = (cardId || moveId)!;
        const payload = request.postDataJSON() as Record<string, unknown>;
        receipt.payload = request.postData() ?? "";
        const write: CardWrite = { cardId: id, payload: structuredClone(payload), before: structuredClone(state.cards.get(id)!) };
        if (moveId) {
          assert.deepEqual(Object.keys(payload).sort(), ["column_id", "position"]);
          assert.equal(payload.column_id, targetColumn);
          state.moves.push(write);
          status = state.moveStatus;
          if (status === 200) state.cards.set(id, { ...state.cards.get(id)!, column_id: targetColumn, position: payload.position as number });
        } else {
          assert(Object.keys(payload).length > 0 && Object.keys(payload).every((key) => ["title", "description"].includes(key)));
          state.cardWrites.push(write);
          if (id === cardA && state.holdA) await new Promise<void>((resolve) => state.heldA.push(resolve));
          status = id === cardA ? state.outcomeA : 200;
          const saved = { ...payload };
          if (typeof payload.description === "string" && state.descriptionResponse === "canonical") {
            assert.equal(payload.description, submittedDescription, "The real editor emits the injected compact PM fixture");
            assert.deepEqual(JSON.parse(payload.description), JSON.parse(canonicalDescription));
            assert.notEqual(payload.description, canonicalDescription);
            saved.description = canonicalDescription;
          }
          if (status === 200) state.cards.set(id, { ...state.cards.get(id)!, ...saved, updated_at: "2026-10-19T00:30:00Z" });
        }
        write.status = status;
        write.after = structuredClone(state.cards.get(id)!);
        value = status === 200 ? write.after : { detail: "Synthetic rejected move; field PATCH commits independently", error_code: "conflict" };
      } else {
        assert.equal(request.method(), "GET");
        const board: BoardDetail = {
          id: boardId, slug: "synthetic-card-navigation", workspace_id: "workspace-synthetic", name: "Synthetic card navigation",
          description: "", tags: [], is_frozen: false, loop_configured: false, created_at: stamp, updated_at: stamp,
          columns: [
            { id: "column-synthetic", name: "In progress", column_type: "active" as const, position: 1024 },
            { id: targetColumn, name: targetColumnName, column_type: "review" as const, position: 2048 },
          ].map((column) => ({ ...column, board_id: boardId, cards: [...state.cards.values()].filter((card) => card.column_id === column.id), created_at: stamp, updated_at: stamp })),
        };
        value = cardId ? state.cards.get(cardId) : path === apiPath ? board : [board];
      }
      receipt.status = status;
      receipt.bytes = Buffer.byteLength(JSON.stringify(value));
      await route.fulfill({ status, json: value });
    } catch (error) {
      if (request.failure()?.errorText !== "net::ERR_ABORTED") {
        state.unexpected.push(String(error));
        await route.fulfill({ status: 500, json: { detail: "Final-seams fixture contract failed" } }).catch(() => {});
      }
    } finally { state.inflight -= 1; }
  });
  return state;
}
