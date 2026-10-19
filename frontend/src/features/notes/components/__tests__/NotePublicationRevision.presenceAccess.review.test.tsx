// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import type { AxiosRequestConfig } from "axios";
import { act, renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { api } from "@/lib/api";
import { meKeys, memberKeys, noteKeys } from "@/lib/query-keys";
import { WebSocketProvider } from "@/providers/WebSocketProvider";
import type { WebSocketEvent } from "@/lib/websocket";
import type { Note } from "@/types/note";
import i18n from "@/i18n/config";
import { NoteEditorMeta } from "../NoteEditorMeta";

const SLUG = "presence-access-workspace";
const OWNER = { id: "publishing-owner", name: "Synthetic owner", email: "owner@example.test", avatar_url: null };
const DIGEST = "a".repeat(64);
const NOTE: Note = {
  id: "published-note", workspace_id: "workspace-id", board_id: "board-id", card_id: null,
  title: "Synthetic handoff", content: "Saved note body", pinned: false, kind: "user_note",
  failure_class: null, findings: null, source_execution_id: null, created_by: OWNER.id,
  created_at: "2026-10-18T15:00:00Z", updated_at: "2026-10-18T15:00:00Z",
};
const BASE = `/api/workspaces/${SLUG}/boards/${NOTE.board_id}/notes/${NOTE.id}/publication-revision`;
const presenceKey = noteKeys.publicationPresence(SLUG, NOTE.board_id!, NOTE.id, OWNER.id);
const clients: QueryClient[] = [];
const requestInterceptors: number[] = [];
const pending: Array<() => void> = [];
const message = (key: string) => String(i18n.t(`notes.publicationRevision.${key}`));

// Only the raw network transport is synthetic. Frames pass through the real
// provider, WebSocketService, domain subscription and query cancellation path.
class PresenceWireSocket {
  static instances: PresenceWireSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(public url: string) { PresenceWireSocket.instances.push(this); }
  send(data: string) { this.sent.push(data); }
  open() { this.readyState = PresenceWireSocket.OPEN; this.onopen?.(); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code } as CloseEvent); }
  noteUpdated(eventId: string) {
    const event: WebSocketEvent = {
      event: "activity.note.updated", event_id: eventId, timestamp: NOTE.updated_at,
      payload: { entity_id: NOTE.id, board_id: NOTE.board_id, action: "updated" },
    };
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
  }
}

function deferred() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => { release = resolve; });
  pending.push(release);
  return { ready, release };
}

type PresenceRead = { status: number; settled: boolean };
async function setup(presenceStatus = 200) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  clients.push(client);
  client.setQueryDefaults(meKeys.me(), { staleTime: Infinity });
  client.setQueryDefaults(memberKeys.list(SLUG), { staleTime: Infinity });
  client.setQueryData(meKeys.me(), OWNER);
  client.setQueryData(memberKeys.list(SLUG), [{ user_id: OWNER.id, name: OWNER.name, email: OWNER.email, role: "member" }]);
  const state = {
    presenceStatus,
    nextGate: null as ReturnType<typeof deferred> | null,
    presenceReads: [] as PresenceRead[],
    presenceSignals: [] as Array<NonNullable<AxiosRequestConfig["signal"]>>,
    comparisonReads: 0,
    unexpected: [] as string[],
  };
  // Axios uses XHR here; MSW reconstructs a Request whose signal does not
  // mirror XHR abort. Observe the actual query signal without replacing API behavior.
  requestInterceptors.push(api.interceptors.request.use((config) => {
    if (config.url?.endsWith("/publication-revision/presence") && config.signal) {
      state.presenceSignals.push(config.signal);
    }
    return config;
  }));
  server.use(http.all("/api/*", async ({ request }) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === `${BASE}/presence`) {
      // Capture status before waiting: releasing this request after revocation
      // must really return its old 200, rather than manufacture a newer denial.
      const read = { status: state.presenceStatus, settled: false };
      state.presenceReads.push(read);
      const gate = state.nextGate;
      state.nextGate = null;
      await gate?.ready;
      read.settled = true;
      return HttpResponse.json(read.status === 200
        ? { has_record: true, recorded_at: NOTE.created_at }
        : { detail: "Synthetic presence access denied" }, { status: read.status });
    }
    if (request.method === "GET" && path === BASE) {
      state.comparisonReads++;
      return HttpResponse.json({
        status: "recorded", recorded_at: NOTE.created_at, revision_version: 1,
        published_revision_sha256: DIGEST, current_revision_sha256: DIGEST,
        comparison: "matches", comparison_reason: null,
      });
    }
    if (request.method === "GET" && path === "/api/me") return HttpResponse.json(OWNER);
    if (request.method === "GET" && path === `/api/workspaces/${SLUG}/members`) {
      return HttpResponse.json([{ user_id: OWNER.id, name: OWNER.name, email: OWNER.email, role: "member" }]);
    }
    if (request.method === "GET" && path === `/api/workspaces/${SLUG}/boards/${NOTE.board_id}`) {
      return HttpResponse.json({ id: NOTE.board_id, name: "Synthetic board", columns: [] });
    }
    state.unexpected.push(`${request.method} ${path}`);
    return HttpResponse.json({ detail: "Unexpected presence fixture request" }, { status: 400 });
  }));
  renderWithProviders(<WebSocketProvider><NoteEditorMeta note={NOTE} slug={SLUG} /></WebSocketProvider>, {
    queryClient: client,
    routerProps: { initialEntries: [`/${SLUG}/boards/${NOTE.board_id}/notes?note=${NOTE.id}`] },
  });
  await waitFor(() => expect(PresenceWireSocket.instances).toHaveLength(1));
  const socket = PresenceWireSocket.instances[0]!;
  await act(async () => socket.open());
  await waitFor(() => {
    expect(state.presenceReads.length).toBeGreaterThan(0);
    expect(client.isFetching()).toBe(0);
    expect(socket.sent.map((frame) => JSON.parse(frame).subscribe).flat()).toContain("activity.note.*");
  });
  expect(socket.url).toContain(`/ws/workspaces/${SLUG}/events`);
  return { client, socket, state };
}

function expectPresenceDenied(client: QueryClient, state: Awaited<ReturnType<typeof setup>>["state"]) {
  expect(screen.getByText(message("accessLost"))).toBeVisible();
  expect(screen.queryByRole("button", { name: message("action") })).toBeNull();
  expect(screen.queryByText(message("noRecord"))).toBeNull();
  expect(screen.queryByText(message("matches"))).toBeNull();
  expect(screen.queryAllByText(DIGEST)).toHaveLength(0);
  expect(state.comparisonReads).toBe(0);
  expect(client.getQueryData(presenceKey)).toEqual({ status: "access_lost" });
  expect(state.unexpected).toEqual([]);
}

beforeEach(async () => {
  PresenceWireSocket.instances = [];
  vi.stubGlobal("WebSocket", PresenceWireSocket);
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  pending.splice(0).forEach((release) => release());
  clients.splice(0).forEach((client) => client.clear());
  requestInterceptors.splice(0).forEach((id) => api.interceptors.request.eject(id));
  vi.unstubAllGlobals();
});

describe("Original-handoff presence access through the real socket/query path", () => {
  it("offers an authorized owner the action and waits for a deliberate click before comparison", async () => {
    const { client, state } = await setup();
    const action = await screen.findByRole("button", { name: message("action") });
    expect(state.comparisonReads).toBe(0);
    expect(client.getQueryData(presenceKey)).toEqual({ has_record: true, recorded_at: NOTE.created_at });
    fireEvent.click(action);
    expect(await screen.findByText(message("matches"))).toBeVisible();
    expect(state.comparisonReads).toBe(1);
    expect(state.unexpected).toEqual([]);
  });

  it.each([403, 404])("reports initial presence HTTP %i as access loss, without claiming absence or fetching comparison", async (status) => {
    const { client, state } = await setup(status);
    await screen.findByText(message("accessLost"));
    expectPresenceDenied(client, state);
    expect(state.presenceReads.every((read) => read.status === status)).toBe(true);
  });

  it.each([403, 404])("does not restore the action when an older presence 200 settles after HTTP %i", async (status) => {
    const { client, socket, state } = await setup();
    expect(await screen.findByRole("button", { name: message("action") })).toBeVisible();
    const initialReads = state.presenceReads.length;
    const oldSuccess = deferred();
    state.nextGate = oldSuccess;
    await act(async () => socket.noteUpdated("start-old-presence"));
    await waitFor(() => expect(state.presenceReads).toHaveLength(initialReads + 1));
    const oldRead = state.presenceReads[initialReads]!;
    const oldSignal = state.presenceSignals.at(-1)!;
    expect(oldSignal).toBeDefined();
    expect(oldRead.status).toBe(200);
    expect(oldRead.settled).toBe(false);
    expect(oldSignal.aborted).toBe(false);

    state.presenceStatus = status;
    await act(async () => socket.noteUpdated("deny-current-presence"));
    await waitFor(() => expect(oldSignal.aborted).toBe(true));
    await screen.findByText(message("accessLost"));
    expect(state.presenceReads).toHaveLength(initialReads + 2);
    expect(state.presenceReads.at(-1)?.status).toBe(status);
    expectPresenceDenied(client, state);

    await act(async () => { oldSuccess.release(); await oldSuccess.ready; });
    await waitFor(() => {
      expect(oldRead.settled).toBe(true);
      expect(client.isFetching()).toBe(0);
    });
    expectPresenceDenied(client, state);
  });
});
