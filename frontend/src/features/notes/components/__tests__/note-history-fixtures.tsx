// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QueryClient } from "@tanstack/react-query";
import { expect, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { meKeys } from "@/lib/query-keys";
import type { WebSocketEvent } from "@/lib/websocket";
import { WebSocketContext } from "@/providers/WebSocketProvider";
import type { Note } from "@/types/note";
import i18n from "@/i18n/config";
import { NoteEditor } from "../NoteEditor";

export const SLUG = "history-workspace";
export const BOARD = "history-board";
export const OWNER = { id: "history-owner", name: "Ana Torres", email: "ana@example.test", avatar_url: null };
export const CURRENT_DIGEST = "c".repeat(64);
export const clients: QueryClient[] = [];
const pending: Array<() => void> = [];

export interface Revision {
  revision: number;
  recorded_at: string;
  capture_kind: "creation" | "edit" | "baseline" | "gap_baseline";
  operation: string;
  changed_fields: string[];
  content_bytes: number;
  content_sha256: string;
  revision_digest: string;
  title: string;
  pinned: boolean;
  card_id: string | null;
  kind: string;
  source_execution_id: string | null;
  actor: null | { user_id: string | null; user_name: string | null; authentication_method: string | null;
    principal_kind: string | null; agent_id: string | null; agent_name: string | null; api_key_id: string | null;
    api_key_name: string | null; installation_id: string | null };
  channel: "unconfirmed" | "mcp_reported";
  snapshot: { content: string; title: string; pinned: boolean; card_id: string | null; kind: string;
    failure_class: string | null; findings: Note["findings"]; source_execution_id: string | null };
}

export function revision(sequence: number, overrides: Partial<Revision> = {}): Revision {
  const title = `Saved title ${sequence}`;
  return {
    revision: sequence, recorded_at: new Date(Date.UTC(2026, 9, 23, 10, sequence * 10)).toISOString(),
    capture_kind: sequence === 1 ? "creation" : "edit", operation: sequence === 1 ? "create" : "replace",
    changed_fields: ["content"], content_bytes: 48, content_sha256: String(sequence % 10).repeat(64),
    revision_digest: sequence === 3 ? CURRENT_DIGEST : String(sequence % 10).repeat(64),
    title, pinned: false, card_id: null, kind: "user_note", source_execution_id: null,
    actor: { user_id: OWNER.id, user_name: OWNER.name, authentication_method: "session", principal_kind: "user",
      agent_id: null, agent_name: null, api_key_id: null, api_key_name: null, installation_id: null },
    channel: "unconfirmed",
    snapshot: { content: `<p>Saved revision ${sequence} body</p>`, title, pinned: false, card_id: null,
      kind: "user_note", failure_class: null, findings: null, source_execution_id: null },
    ...overrides,
  };
}

export type HistoryNote = Note & { history_revision: number; revision_digest: string };
export function makeNote(overrides: Partial<HistoryNote> = {}): HistoryNote {
  return { id: "history-note", workspace_id: "workspace-1", board_id: BOARD, card_id: null,
    title: "Current saved title", content: "<p>Current saved body</p>", pinned: false, kind: "user_note",
    failure_class: null, findings: null, source_execution_id: null, created_by: OWNER.id,
    created_at: "2026-10-20T09:00:00Z", updated_at: "2026-10-23T10:03:00Z",
    history_revision: 3, revision_digest: CURRENT_DIGEST, ...overrides };
}

export function deferred() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => { release = resolve; });
  pending.push(release);
  return { ready, release };
}

export function clearHistoryFixtures() {
  pending.splice(0).forEach((release) => release());
  clients.splice(0).forEach((client) => client.clear());
}

function connection() {
  const subscriptions = new Set<{ pattern: string; handler: (event: WebSocketEvent) => void }>();
  return {
    status: "connected" as const,
    subscribe(pattern: string, handler: (event: WebSocketEvent) => void) {
      const subscription = { pattern, handler };
      subscriptions.add(subscription);
      return () => { subscriptions.delete(subscription); };
    },
    emit(event: string, entityId = "history-note") {
      const payload = { event, event_id: `fixture-${event}`, timestamp: "2026-10-23T12:00:00Z",
        payload: { entity_id: entityId, entity_type: event.startsWith("activity.member") ? "member" : "note",
          action: event.split(".").at(-1), board_id: event.startsWith("activity.member") ? null : BOARD,
          changes: { affected_user_id: entityId } } };
      subscriptions.forEach(({ pattern, handler }) => {
        if (pattern === event || (pattern.endsWith(".*") && event.startsWith(pattern.slice(0, -1)))) handler(payload);
      });
    },
  };
}

export function mountHistory(options: { note?: HistoryNote; revisions?: Revision[]; listStatus?: number } = {}) {
  const note = options.note ?? makeNote();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false } } });
  clients.push(client);
  client.setQueryData(meKeys.me(), OWNER);
  const state = {
    revisions: options.revisions ?? [revision(3), revision(2), revision(1)],
    savedNote: note, listStatus: options.listStatus ?? 200, detailStatus: 200, compareStatus: 200, currentStatus: 200,
    membersStatus: 200, historyRequests: [] as URL[], routineRequests: [] as string[], writes: [] as string[],
    currentRequests: [] as URL[],
    unexpected: [] as string[], listGate: null as ReturnType<typeof deferred> | null,
    detailGate: null as ReturnType<typeof deferred> | null,
  };
  const noteBase = `/api/workspaces/${SLUG}${note.board_id ? `/boards/${note.board_id}` : ""}/notes/${note.id}`;
  const historyBase = `${noteBase}/revisions`;
  server.use(http.all("/api/*", async ({ request }) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method !== "GET") {
      state.writes.push(`${request.method} ${path}`);
      return HttpResponse.json({ detail: "History inspection must not write" }, { status: 400 });
    }
    if (path === historyBase) {
      state.historyRequests.push(url);
      const status = state.listStatus;
      const before = Number(url.searchParams.get("before_revision") ?? Infinity);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const eligible = state.revisions.filter((item) => item.revision < before);
      const items = eligible.slice(0, limit).map(({ snapshot, ...summary }) => {
        void snapshot;
        return summary;
      });
      const first = state.revisions.at(-1);
      const response = { items, next_before_revision: eligible.length > limit ? items.at(-1)!.revision : null,
        latest_recorded_revision: state.revisions[0]?.revision ?? 0,
        capture_boundary: first ? { first_revision: first.revision, capture_kind: first.capture_kind } : null };
      const gate = state.listGate;
      state.listGate = null;
      await gate?.ready;
      return HttpResponse.json(status === 200 ? response : { detail: "Synthetic history unavailable" }, { status });
    }
    if (path.startsWith(`${historyBase}/`)) {
      state.historyRequests.push(url);
      const isComparison = path.endsWith("/compare");
      const status = isComparison ? state.compareStatus : state.detailStatus;
      const from = state.revisions.find((item) => item.revision === Number(url.searchParams.get("from_revision")));
      const to = state.revisions.find((item) => item.revision === Number(url.searchParams.get("to_revision")));
      const detail = state.revisions.find((item) => item.revision === Number(path.split("/").at(-1)));
      const response = structuredClone(isComparison ? { before: from, after: to, changed_fields: to?.changed_fields ?? [] } : detail);
      const gate = state.detailGate;
      state.detailGate = null;
      await gate?.ready;
      return HttpResponse.json(status === 200 ? response : { detail: "Synthetic history unavailable" }, { status });
    }
    state.routineRequests.push(path);
    if (path === noteBase || path === `/api/workspaces/${SLUG}/notes/${note.id}`) {
      state.currentRequests.push(url);
      return HttpResponse.json(state.currentStatus === 200 ? state.savedNote : { detail: "Synthetic current-note denial" }, { status: state.currentStatus });
    }
    if (path === "/api/me") return HttpResponse.json(OWNER);
    if (path === "/api/auth/modes") return HttpResponse.json({ companion_enabled: false, password_enabled: false, dev_mode: false });
    if (path.endsWith("/members")) return HttpResponse.json(state.membersStatus === 200
      ? [{ user_id: OWNER.id, name: OWNER.name, email: OWNER.email, role: "member" }]
      : { detail: "Synthetic membership denied" }, { status: state.membersStatus });
    if (path.endsWith(`/boards/${BOARD}`)) return HttpResponse.json({ id: BOARD, name: "History board", columns: [] });
    if (path.endsWith("/publication-revision/presence")) return HttpResponse.json({ has_record: false, recorded_at: null });
    if (path.endsWith("/config/completion-context-impact")) return HttpResponse.json({ attempts: [] });
    if (path.endsWith("/sessions")) return HttpResponse.json({ items: [], has_more: false, next_cursor: null });
    state.unexpected.push(path);
    return HttpResponse.json({ detail: "Unexpected fixture request" }, { status: 400 });
  }));
  const socket = connection();
  const onOpenChange = vi.fn();
  const view = (next = note) => <WebSocketContext.Provider value={socket}>
    <NoteEditor note={next} slug={SLUG} boardId={next.board_id ?? undefined} open onOpenChange={onOpenChange} />
  </WebSocketContext.Provider>;
  const rendered = renderWithProviders(view(), { queryClient: client });
  return { ...rendered, state, client, socket, onOpenChange, historyBase,
    refresh: (next: HistoryNote) => rendered.rerender(view(next)) };
}

export function historyName() {
  return String(i18n.t("notes.history.action", { defaultValue: "History" }));
}

export async function openHistory() {
  const action = await screen.findByRole("button", { name: historyName() });
  fireEvent.click(action);
  return { action, dialog: await screen.findByRole("dialog", { name: /history|historial|histórico/i }) };
}

export async function selectRevision(dialog: HTMLElement, sequence: number) {
  const revisionName = new RegExp(`^(?:View |Select )?Revision ${sequence}(?:\\D|$)`, "i");
  fireEvent.click(await within(dialog).findByRole("button", { name: revisionName }));
}

export async function settled(client: QueryClient) {
  await waitFor(() => expect(client.isFetching()).toBe(0));
}

export function expectReadOnly(state: ReturnType<typeof mountHistory>["state"]) {
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
}
