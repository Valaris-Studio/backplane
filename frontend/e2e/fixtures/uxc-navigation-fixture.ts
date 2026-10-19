// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import type { Note, NoteUpdate } from "../../src/types/note";
import {
  installWindowFixture, session, sessionPath, sha, slug, stamp,
  type RequestReceipt, type WindowFixture,
} from "./session-window-fixture";

export const noteId = "30000000-0000-4000-8000-000000000001";
export const notePath = `/api/workspaces/${slug}/notes/${noteId}`;
export const noteHref = `/${slug}/notes?note=${noteId}`;
export const originalNoteTitle = "Synthetic navigation handoff";
export const privateDraftTitle = "SYNTHETIC PRIVATE REVIEW TITLE";
export const privateDraftBody = "SYNTHETIC PRIVATE CURATION: preserve this exact reviewed text and request.";

const initialNote: Note = {
  id: noteId, workspace_id: session.workspace_id, board_id: null, card_id: null,
  title: originalNoteTitle,
  content: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Synthetic shared note; no operator data." }] }] }),
  pinned: false, kind: "user_note", failure_class: null, findings: null,
  source_execution_id: null, created_by: "owner", created_at: stamp, updated_at: stamp,
};

export interface NavigationFixture extends WindowFixture {
  note: Note;
  noteSaveStatus: number;
  noteWrites: NoteUpdate[];
  consoleErrors: string[];
  assets: { path: string; sha256: string; status: number }[];
  pendingAssets: Promise<void>[];
}

/** Adds real note-route responses to the existing bounded-reader AppShell fixture. */
export async function installNavigationFixture(page: Page, locale = "en"): Promise<NavigationFixture> {
  const reader = await installWindowFixture(page, locale);
  const state: NavigationFixture = Object.assign(reader, {
    note: structuredClone(initialNote), noteSaveStatus: 200, noteWrites: [],
    consoleErrors: [], assets: [], pendingAssets: [],
  });
  state.links = state.links.slice(0, 1);
  await page.routeWebSocket(new RegExp(`^(?!wss?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::\\d+)?/ws/workspaces/${slug}/events(?:\\?|$)).*$`), async (socket) => {
    state.unexpected.push(`Unexpected WebSocket blocked: ${socket.url()}`);
    await socket.close({ code: 1008, reason: "Outside synthetic navigation fixture" });
  });
  page.on("console", (message) => {
    if (message.type() === "error") state.consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (!/^\/assets\/.*\.(js|css)$/.test(path)) return;
    state.pendingAssets.push(response.body().then((bytes) => {
      state.assets.push({ path, status: response.status(), sha256: sha(bytes) });
    }).catch((error: unknown) => { state.unexpected.push(`Built asset unreadable: ${path}: ${String(error)}`); }));
  });

  // Later registrations run first. Everything outside these exact paths falls
  // through to the original fixture's strict synthetic API allowlist.
  const paths = new Set([
    `/api/workspaces/${slug}/notes`, notePath, `${notePath}/sessions`,
    `${sessionPath}/links`, "/api/me/companion/installations",
    `/api/workspaces/${slug}/config/completion-context-impact`,
  ]);
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (!paths.has(url.pathname)) return route.fallback();
    const receipt: RequestReceipt = {
      path: url.pathname, method: request.method(), query: url.search,
      mode: null, callId: null, cursor: null, startedAt: Date.now(),
    };
    state.requests.push(receipt);
    state.inflight += 1;
    try {
      assert(!request.headers().authorization && !request.headers().cookie, "Synthetic requests must carry no credentials");
      let value: unknown;
      let status = 200;
      if (url.pathname === notePath && request.method() === "PUT") {
        const patch = request.postDataJSON() as NoteUpdate;
        assert(Object.keys(patch).every((key) => ["title", "content"].includes(key)), "Only deliberate editor saves are authorized");
        assert(typeof patch.title === "string" && typeof patch.content === "string");
        receipt.payload = request.postData() ?? "";
        state.noteWrites.push(structuredClone(patch));
        status = state.noteSaveStatus;
        if (status === 200) state.note = { ...state.note, ...patch };
        value = status === 200 ? state.note : { detail: "Synthetic save failure; original note remains unchanged" };
      } else {
        assert.equal(request.method(), "GET", `Unexpected mutation: ${request.method()} ${url.pathname}`);
        if (url.pathname === notePath) value = state.note;
        else if (url.pathname === `/api/workspaces/${slug}/notes`) {
          assert.equal(url.searchParams.get("summary_only"), "true");
          value = [{ ...state.note, content: undefined, preview: "Synthetic shared note" }];
        } else if (url.pathname === `${sessionPath}/links`) value = { items: [{
          entity_type: "note", entity_id: noteId, workspace_id: session.workspace_id, board_id: null,
          relation: "changed", provenance: "exact", first_seen_at: stamp, last_seen_at: stamp, invocation_count: 1,
        }] };
        else if (url.pathname === `${notePath}/sessions`) value = {
          items: [{ session, relations: ["changed"], provenance: "exact", first_seen_at: stamp, last_seen_at: stamp, invocation_count: 1 }],
          summary: { session_count: 1, wall_duration_seconds: 1080, input_tokens: 2400, output_tokens: 800,
            cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: 0, cost_complete: false },
        };
        else if (url.pathname === "/api/me/companion/installations") value = [{ id: "device-synthetic", name: "Synthetic device" }];
        else {
          assert.equal(url.searchParams.get("source_kind"), "note");
          assert.equal(url.searchParams.get("source_id"), noteId);
          value = { attempts: [] };
        }
      }
      receipt.status = status;
      receipt.bytes = Buffer.byteLength(JSON.stringify(value));
      await route.fulfill({ status, json: value, headers: { "X-Total-Count": "1" } });
    } catch (error) {
      if (request.failure()?.errorText !== "net::ERR_ABORTED") {
        state.unexpected.push(String(error));
        await route.fulfill({ status: 500, json: { detail: "Synthetic navigation fixture contract failed" } }).catch(() => {});
      }
    } finally { state.inflight -= 1; }
  });
  return state;
}
