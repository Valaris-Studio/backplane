// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import type { Page, WebSocketRoute } from "@playwright/test";
import type { Note, NoteSummary } from "../../src/types/note";
import type { SessionPeriodSummary } from "../../src/types/agent-session";
import type { NotePublicationRevision } from "../../src/features/notes/api/use-note-publication-revision";
import { ConsoleCollector } from "../console-collector";

export const publicationSlug = "publication-fixture";
export const publicationBoard = "71000000-0000-4000-8000-000000000001";
export const publicationOwner = "71000000-0000-4000-8000-000000000002";
export const publicationStamp = "2026-10-18T18:00:00Z";
export const publicationRoute = `/${publicationSlug}/notes`;
export const publicationDigest = "a".repeat(64);
export const changedDigest = "b".repeat(64);
const workspace = { id: "71000000-0000-4000-8000-000000000003", slug: publicationSlug, name: "Synthetic publication review", created_by: publicationOwner, created_at: publicationStamp, updated_at: publicationStamp };
const board = { id: publicationBoard, workspace_id: workspace.id, name: "Synthetic handoff board", is_frozen: false, columns: [] };
const owner = { id: publicationOwner, name: "Synthetic member", email: "member@example.test", avatar_url: null };

function note(id: number, title: string, createdBy = publicationOwner): Note {
  return {
    id: `72000000-0000-4000-8000-${String(id).padStart(12, "0")}`, workspace_id: workspace.id,
    board_id: publicationBoard, card_id: null, title, pinned: false, kind: "user_note", failure_class: null,
    findings: null, source_execution_id: null, created_by: createdBy, created_at: publicationStamp, updated_at: publicationStamp,
    content: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `SYNTHETIC SAVED BODY: ${title}` }] }] }),
  };
}

// UI and MCP are provenance of these synthetic saved rows, not invented note
// schema fields. A browser fixture cannot prove the backend mutation path.
export const publicationNotes = {
  ui: note(1, "Ordinary UI note"),
  mcp: note(2, "Ordinary MCP note"),
  matches: note(3, "Published handoff: unchanged"),
  differs: note(4, "Published handoff: edited"),
  legacy: note(5, "Legacy receipt without note fingerprint"),
  unsupported: note(6, "Unsupported handoff fingerprint"),
  otherAuthor: note(7, "Another author's published handoff", "71000000-0000-4000-8000-000000000004"),
};
const notes = Object.values(publicationNotes);
const ordinary = new Set([publicationNotes.ui.id, publicationNotes.mcp.id]);
const summaries: NoteSummary[] = notes.map(({ content: _content, ...entry }) => ({ ...entry, preview: "Synthetic browse preview; the editor requests its saved body separately." }));
export const publicationBase = (id: string) => `/api/workspaces/${publicationSlug}/boards/${publicationBoard}/notes/${id}/publication-revision`;

function comparison(id: string): NotePublicationRevision {
  const base: NotePublicationRevision = {
    status: "recorded", recorded_at: publicationStamp, revision_version: 1,
    published_revision_sha256: publicationDigest, current_revision_sha256: publicationDigest,
    comparison: "matches", comparison_reason: null,
  };
  if (id === publicationNotes.differs.id) return { ...base, current_revision_sha256: changedDigest, comparison: "differs" };
  if (id === publicationNotes.legacy.id) return { ...base, status: "revision_not_recorded", revision_version: null, published_revision_sha256: null, current_revision_sha256: null, comparison: null };
  if (id === publicationNotes.unsupported.id) return { ...base, status: "unsupported_version", revision_version: 99, current_revision_sha256: null, comparison: null };
  assert(!ordinary.has(id), "An ordinary note must never trigger a comparison read");
  return base;
}

export interface PublicationRequest {
  method: string; path: string; query: string; at: number; status?: number; responseBytes?: number;
  kind?: "presence" | "comparison" | "note-body" | "shell"; noteId?: string; aborted?: boolean;
}
export interface PublicationFixture {
  requests: PublicationRequest[]; unexpected: string[]; failures: { path: string; reason: string }[];
  sockets: Set<WebSocketRoute>; socketLedger: { kind: string; at: number; payload?: unknown }[];
  identityStatus: number; presenceStatus: Map<string, number>; comparisonStatus: Map<string, number>;
  comparisonGates: Map<string, Promise<void>>; releases: (() => void)[]; inflight: number;
  console: ConsoleCollector;
  holdComparison: (noteId: string) => () => void;
  closeSockets: () => Promise<void>;
  release: () => void;
  consoleViolations: () => ReturnType<ConsoleCollector["violations"]>;
}

/** Strict synthetic HTTP/WS around the real entry point, router and AppShell. */
export async function installPublicationFixture(page: Page, language: string): Promise<PublicationFixture> {
  const state: PublicationFixture = {
    requests: [], unexpected: [], failures: [], sockets: new Set(), socketLedger: [], identityStatus: 200,
    presenceStatus: new Map(), comparisonStatus: new Map(), comparisonGates: new Map(), releases: [], inflight: 0,
    console: ConsoleCollector.attach(page),
    holdComparison(noteId) {
      let release = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      state.comparisonGates.set(noteId, gate);
      const finish = () => { state.comparisonGates.delete(noteId); release(); };
      state.releases.push(finish);
      return finish;
    },
    async closeSockets() {
      for (const socket of state.sockets) await socket.close({ code: 1000, reason: "Synthetic diagnostic disconnect" });
      state.socketLedger.push({ kind: "closed-for-identity-check", at: Date.now() });
      state.sockets.clear();
    },
    release() { state.releases.splice(0).forEach((release) => release()); },
    consoleViolations() {
      // Deliberate HTTP failures remain in the attached raw console/ledger.
      // Only their exact resource path and status are expected by fault cases.
      return state.console.violations().filter((message) => !state.requests.some((request) =>
        request.status !== undefined && request.status >= 400 && request.status < 600
        && message.source === "console.error" && message.text.includes("Failed to load resource")
        && message.text.includes(String(request.status)) && message.origin.includes(request.path),
      ));
    },
  };
  await page.addInitScript((locale) => {
    localStorage.setItem("i18n-lang", locale);
    localStorage.setItem("valaris-theme", "light");
    localStorage.setItem("valaris-welcome-dismissed", "true");
  }, language);
  page.on("requestfailed", (request) => state.failures.push({ path: new URL(request.url()).pathname, reason: request.failure()?.errorText ?? "Unknown failure" }));
  await page.routeWebSocket("**/ws/workspaces/**", (socket) => {
    assert.equal(new URL(socket.url()).pathname, `/ws/workspaces/${publicationSlug}/events`);
    state.sockets.add(socket);
    state.socketLedger.push({ kind: "connected", at: Date.now() });
    socket.onMessage((message) => {
      const value: unknown = JSON.parse(String(message));
      assert(value && typeof value === "object" && "subscribe" in value && Array.isArray(value.subscribe));
      state.socketLedger.push({ kind: "subscribe", at: Date.now(), payload: value.subscribe });
    });
    socket.onClose(() => state.sockets.delete(socket));
  });
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      state.unexpected.push(`External request blocked: ${url.origin}${url.pathname}`);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    // Vite source modules also contain /api/ in their path.
    if (!path.startsWith("/api/")) return route.fallback();
    const receipt: PublicationRequest = { method: request.method(), path, query: url.search, at: Date.now(), kind: "shell" };
    state.requests.push(receipt); state.inflight++;
    try {
      assert.equal(request.method(), "GET", `Unexpected mutation ${request.method()} ${path}`);
      assert(!request.headers().authorization && !request.headers().cookie, "Synthetic fixture must not carry credentials");
      let value: unknown, status = 200;
      const entry = notes.find((item) => path === publicationBase(item.id) || path === `${publicationBase(item.id)}/presence`);
      const detail = notes.find((item) => path === `/api/workspaces/${publicationSlug}/notes/${item.id}`);
      if (entry) {
        assert.equal(entry.created_by, publicationOwner, "Another author's receipt must never be requested");
        receipt.noteId = entry.id;
        if (path.endsWith("/presence")) {
          receipt.kind = "presence";
          status = state.presenceStatus.get(entry.id) ?? 200;
          value = { has_record: !ordinary.has(entry.id), recorded_at: ordinary.has(entry.id) ? null : publicationStamp };
        } else {
          receipt.kind = "comparison";
          status = state.comparisonStatus.get(entry.id) ?? 200;
          value = comparison(entry.id);
          await state.comparisonGates.get(entry.id);
        }
      } else if (detail) { receipt.kind = "note-body"; receipt.noteId = detail.id; value = detail; }
      else if (path === "/api/auth/modes") value = { oidc_enabled: false, password_enabled: false, dev_mode: false, companion_enabled: true, rich_capture_enabled: true };
      else if (path === "/api/auth/setup-status") value = { needs_setup: false };
      else if (path === "/api/me") { status = state.identityStatus; value = owner; }
      else if (path === "/api/workspaces") value = [workspace];
      else if (path === `/api/workspaces/${publicationSlug}`) value = workspace;
      else if (path === `/api/workspaces/${publicationSlug}/members`) value = [
        { user_id: publicationOwner, name: owner.name, email: owner.email, role: "member" },
        { user_id: publicationNotes.otherAuthor.created_by, name: "Other member", email: "other@example.test", role: "member" },
      ];
      else if (path === `/api/workspaces/${publicationSlug}/boards`) value = [board];
      else if (path === `/api/workspaces/${publicationSlug}/boards/${publicationBoard}`) value = board;
      else if (path === `/api/workspaces/${publicationSlug}/notes`) {
        assert.equal(url.searchParams.get("summary_only"), "true");
        value = summaries;
      } else if (path === `/api/workspaces/${publicationSlug}/config/completion-context-impact`) value = { attempts: [] };
      else if (path === "/api/me/companion/installations" || path === "/api/me/api-keys") value = [];
      else if (path === `/api/workspaces/${publicationSlug}/sessions/summary`) value = {
        session_count: 0, live_count: 0, wall_duration_seconds: 0,
        input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, reasoning_tokens: 0,
        cost_api_equivalent_usd: null, cost_spend_usd: null, cost_complete: true,
      } satisfies SessionPeriodSummary;
      else if (notes.some((item) => path === `/api/workspaces/${publicationSlug}/notes/${item.id}/sessions`)) value = { items: [], next_cursor: null };
      else if (path === "/api/notifications/unread-count" || path === `/api/workspaces/${publicationSlug}/notifications/unread-count`) value = { count: 0 };
      else if (path === "/api/notifications" || path === `/api/workspaces/${publicationSlug}/notifications` || path === `/api/workspaces/${publicationSlug}/approvals`) value = [];
      else assert.fail(`Unhandled synthetic API ${request.method()} ${path}`);
      if (status >= 400) value = { detail: "Synthetic publication fixture response" };
      receipt.status = status; receipt.responseBytes = Buffer.byteLength(JSON.stringify(value));
      await route.fulfill({ status, json: value, headers: { "Cache-Control": "private, no-store", "X-Total-Count": String(notes.length) } });
    } catch (error) {
      if (request.failure()?.errorText === "net::ERR_ABORTED") receipt.aborted = true;
      else {
        state.unexpected.push(String(error));
        await route.fulfill({ status: 500, json: { detail: "Synthetic fixture contract failed" } }).catch(() => {});
      }
    } finally { state.inflight--; }
  });
  return state;
}

export function publicationReads(state: PublicationFixture, kind: PublicationRequest["kind"], noteId?: string) {
  return state.requests.filter((request) => request.kind === kind && (!noteId || request.noteId === noteId));
}
