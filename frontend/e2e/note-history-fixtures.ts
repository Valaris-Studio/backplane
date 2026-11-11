// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import {
  installPublicationFixture, publicationBoard, publicationNotes, publicationOwner,
  publicationSlug, type PublicationFixture,
} from "./fixtures/uxc-publication-fixture";

export const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export const historyNote = publicationNotes.ui;
export const baselineNote = publicationNotes.mcp;
export const handoffNote = publicationNotes.matches;
export const draftTitle = "SYNTHETIC PRIVATE UNSAVED TITLE";
export const draftBody = "SYNTHETIC PRIVATE UNSAVED BODY café 🐙";
export const retainedMarker = "SYNTHETIC RETAINED HISTORY TEXT";
export const sourceLinkBefore = "https://example.test/evidence-before";
export const sourceLinkAfter = "https://example.test/evidence-after";
export const latestRevision = 54;
export const revisionPath = (noteId = historyNote.id) => `/api/workspaces/${publicationSlug}/notes/${noteId}/revisions`;
const revisionStamp = (revision: number) => new Date(Date.UTC(2026, 9, 23, 10, revision)).toISOString();

function richContent(revision: number) {
  const latest = revision === latestRevision;
  return JSON.stringify({ type: "doc", content: [
    { type: "heading", attrs: { level: latest ? 2 : 3 }, content: [{ type: "text", text: "Evidence structure" }] },
    { type: "paragraph", content: [
      { type: "text", text: retainedMarker, marks: [{ type: latest ? "italic" : "bold" }] },
      { type: "text", text: " Evidence source", marks: [{ type: "link", attrs: { href: latest ? sourceLinkAfter : sourceLinkBefore } }] },
    ] },
    { type: latest ? "orderedList" : "bulletList", content: [
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: latest ? "Revised structural item" : "Original structural item" }] }] },
    ] },
    ...Array.from({ length: 80 }, (_, index) => ({ type: "paragraph", content: [{ type: "text", text: `Synthetic long note paragraph ${index + 1}: revision ${revision}.` }] })),
  ] });
}

export function revisionDetail(revision: number) {
  const latest = revision === latestRevision;
  const content = richContent(revision);
  const snapshot = {
    content, title: latest ? historyNote.title : "Synthetic saved prior title",
    pinned: latest, card_id: null, kind: latest ? "review_verdict" : "user_note",
    failure_class: latest ? "quality" : null,
    findings: latest ? [{ severity: "SHOULD_FIX", message: "Synthetic metadata finding" }] : null,
    source_execution_id: null,
  };
  return {
    revision, recorded_at: revisionStamp(revision), capture_kind: revision === 1 ? "baseline" : "edit",
    operation: revision === 1 ? "capture" : revision >= 51 && revision <= 53 ? "append" : "replace",
    changed_fields: revision === 1 ? [] : latest ? ["content", "title", "pinned", "kind", "failure_class", "findings"] : ["content"],
    content_bytes: Buffer.byteLength(content), content_sha256: sha(content), revision_digest: sha(JSON.stringify(snapshot)),
    title: snapshot.title, pinned: snapshot.pinned, card_id: snapshot.card_id, kind: snapshot.kind,
    source_execution_id: snapshot.source_execution_id,
    actor: revision === 1 ? null : revision >= 51 && revision <= 53 ? {
      user_id: publicationOwner, user_name: "Synthetic operator", authentication_method: "api_key", principal_kind: "agent",
      agent_id: "71000000-0000-4000-8000-000000000011", agent_name: "Synthetic Sancho",
      api_key_id: "71000000-0000-4000-8000-000000000012", api_key_name: "Synthetic agent credential", installation_id: null,
    } : {
      user_id: "71000000-0000-4000-8000-000000000014", user_name: "Synthetic Elena", authentication_method: "session", principal_kind: "user",
      agent_id: null, agent_name: null, api_key_id: null, api_key_name: null, installation_id: null,
    },
    channel: revision >= 51 && revision <= 53 ? "mcp_reported" : "unconfirmed",
    snapshot,
  };
}

export interface HistoryRequest {
  path: string; query: string; method: string; kind: "list" | "detail" | "compare" | "note";
  noteId: string; status?: number; at: number; from?: number; to?: number; before?: number;
}
export interface HistoryFixture extends PublicationFixture {
  historyRequests: HistoryRequest[];
  historyStatus: number;
  currentDigestMismatch: boolean;
  pendingAssets: Promise<void>[];
  assets: { key: string; sha256: string; status: number }[];
  holdHistory: (kind: HistoryRequest["kind"]) => () => void;
  publishNote: (event: "updated" | "deleted", noteId?: string) => void;
}

export async function installHistoryFixture(page: Page, locale: string): Promise<HistoryFixture> {
  const base = await installPublicationFixture(page, locale);
  const gates = new Map<HistoryRequest["kind"], Promise<void>>();
  const state: HistoryFixture = Object.assign(base, {
    historyRequests: [], historyStatus: 200, currentDigestMismatch: false, pendingAssets: [], assets: [],
    holdHistory(kind: HistoryRequest["kind"]) {
      let release = () => {};
      gates.set(kind, new Promise<void>((resolve) => { release = resolve; }));
      const finish = () => { gates.delete(kind); release(); };
      state.releases.push(finish);
      return finish;
    },
    publishNote(event: "updated" | "deleted", noteId = historyNote.id) {
      for (const socket of state.sockets) socket.send(JSON.stringify({
        event: `activity.note.${event}`, event_id: `synthetic-history-${Date.now()}`,
        timestamp: revisionStamp(latestRevision),
        payload: { entity_id: noteId, entity_type: "note", board_id: publicationBoard },
      }));
    },
  } satisfies Partial<HistoryFixture>);
  const shellConsoleViolations = state.consoleViolations;
  state.consoleViolations = () => shellConsoleViolations().filter((message) => !state.historyRequests.some((request) =>
    request.status !== undefined && request.status >= 400 && request.status < 600
    && message.source === "console.error" && message.text.includes("Failed to load resource")
    && message.text.includes(String(request.status)) && message.origin.includes(request.path),
  ));
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    const key = path.startsWith("/assets/") ? path.slice(1) : response.request().resourceType() === "document" ? "index.html" : null;
    if (!key) return;
    state.pendingAssets.push(response.body().then((body) => {
      state.assets.push({ key, sha256: sha(body), status: response.status() });
    }).catch((error) => state.unexpected.push(`Asset read failed: ${String(error)}`)));
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url());
    const match = new RegExp(`^/api/workspaces/${publicationSlug}/(?:boards/${publicationBoard}/)?notes/([^/]+)(/revisions(?:/(compare|[0-9]+))?)?$`).exec(url.pathname);
    if (!match || ![historyNote.id, baselineNote.id, handoffNote.id].includes(match[1]!)) return route.fallback();
    const noteId = match[1]!;
    const kind = !match[2] ? "note" : match[3] === "compare" ? "compare" : match[3] ? "detail" : "list";
    const receipt: HistoryRequest = { path: url.pathname, query: url.search, method: request.method(), noteId, kind, at: Date.now() };
    state.historyRequests.push(receipt); state.inflight++;
    try {
      assert.equal(request.method(), "GET", `History must not save or mutate: ${request.method()} ${url.pathname}`);
      assert(!request.headers().authorization && !request.headers().cookie, "Synthetic fixture must carry no real credentials");
      const maximum = noteId === baselineNote.id ? 1 : latestRevision;
      const detail = (revision: number) => {
        const retained = revisionDetail(revision);
        if (noteId === baselineNote.id) {
          retained.title = baselineNote.title;
          retained.snapshot.title = baselineNote.title;
          retained.revision_digest = sha(JSON.stringify(retained.snapshot));
        } else if (noteId === handoffNote.id && revision === latestRevision) {
          retained.title = handoffNote.title;
          retained.snapshot.title = handoffNote.title;
          retained.revision_digest = sha(JSON.stringify(retained.snapshot));
        }
        return retained;
      };
      let value: unknown;
      if (kind === "note") {
        const original = Object.values(publicationNotes).find((note) => note.id === noteId)!;
        value = { ...original, ...detail(maximum).snapshot, history_revision: maximum,
          revision_digest: state.currentDigestMismatch ? "d".repeat(64) : detail(maximum).revision_digest };
      } else if (kind === "list") {
        const limit = Number(url.searchParams.get("limit") ?? 50);
        assert(limit >= 1 && limit <= 100);
        const before = Number(url.searchParams.get("before_revision") ?? maximum + 1);
        receipt.before = before;
        const revisions = Array.from({ length: maximum }, (_, index) => maximum - index).filter((revision) => revision < before);
        const selected = revisions.slice(0, limit);
        value = { items: selected.map((revision) => Object.fromEntries(
          Object.entries(detail(revision)).filter(([field]) => field !== "snapshot"),
        )), next_before_revision: selected.length < revisions.length ? selected.at(-1) : null,
        latest_recorded_revision: maximum, capture_boundary: { first_revision: 1, capture_kind: "baseline" } };
      } else if (kind === "detail") {
        const revision = Number(match[3]);
        assert(revision >= 1 && revision <= maximum);
        value = detail(revision);
      } else {
        const from = Number(url.searchParams.get("from_revision")), to = Number(url.searchParams.get("to_revision"));
        assert(from >= 1 && from <= maximum && to >= 1 && to <= maximum);
        receipt.from = from; receipt.to = to;
        const before = detail(from), after = detail(to);
        value = { before, after, changed_fields: Object.keys(before.snapshot).filter((key) =>
          JSON.stringify(before.snapshot[key as keyof typeof before.snapshot]) !== JSON.stringify(after.snapshot[key as keyof typeof after.snapshot])) };
      }
      const status = kind === "note" ? 200 : state.historyStatus;
      await gates.get(kind);
      receipt.status = status;
      await route.fulfill({ status, json: status >= 400 ? { detail: "Synthetic history unavailable" } : value,
        headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      if (request.failure()?.errorText !== "net::ERR_ABORTED") {
        state.unexpected.push(String(error));
        await route.fulfill({ status: 500, json: { detail: "Synthetic history fixture failed" } }).catch(() => {});
      }
    } finally { state.inflight--; }
  });
  return state;
}
