// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { commands, type LocalSession, type SessionEvent, type SessionTokens } from "../ipc/bindings";
import { popoverVisibleStore, trackPopoverVisibility } from "../shell/popover-visibility";
import { createExternalStore, useStoreSelector } from "./external-store";

/** What the server knows about one of this device's sessions (contract v1.6). */
interface ServerSessionFacts {
  server_id: string;
  cost_estimated_usd: number | null;
  cost_reported_usd: number | null;
  cost_basis: string | null;
  tokens: SessionTokens | null;
  workspace_id: string | null;
  board_id: string | null;
  mapping_id: string | null;
}

/**
 * A local session plus what the server added. The store always sets both
 * (null until a poll has seen the session); they are optional so a plain
 * LocalSession still fits.
 */
export interface TrackedSession extends LocalSession {
  server_id?: string | null;
  cost_reported_usd?: number | null;
  /** The tokens came from a server poll, not the stream, so the next poll may replace them. */
  tokens_from_server?: boolean;
  /** Where the server filed the session, which outranks any local guess at its board. */
  server_workspace_id?: string | null;
  server_board_id?: string | null;
  server_mapping_id?: string | null;
}

export interface EndedSession extends TrackedSession {
  ended_at: string;
}

export interface SessionsState {
  /** Newest first, keyed by native_session_id. */
  live: readonly TrackedSession[];
  liveCount: number;
  /** Sessions that ended today (local time), newest first. */
  endedToday: readonly EndedSession[];
  /** Server facts by native_session_id, for the sessions held above. */
  server: ReadonlyMap<string, ServerSessionFacts>;
}

const EMPTY: SessionsState = { live: [], liveCount: 0, endedToday: [], server: new Map() };
export const sessionsStore = createExternalStore<SessionsState>(EMPTY);

function isOlder(incoming: LocalSession, held: LocalSession): boolean {
  if (!incoming.last_event_at || !held.last_event_at) return false;
  return Date.parse(incoming.last_event_at) < Date.parse(held.last_event_at);
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Server values fill what the stream lacks and carry the costs, but local
 * token counts are fresher than the server's ingest and always win.
 */
function withServerFacts(session: TrackedSession, facts: ServerSessionFacts | undefined): TrackedSession {
  const streamTokens = session.tokens_from_server ? null : session.tokens;
  const tokens = streamTokens ?? facts?.tokens ?? null;
  return {
    ...session,
    server_id: facts?.server_id ?? null,
    cost_estimated_usd: facts?.cost_estimated_usd ?? session.cost_estimated_usd,
    cost_reported_usd: facts?.cost_reported_usd ?? null,
    cost_basis: facts?.cost_basis ?? session.cost_basis,
    tokens,
    tokens_from_server: streamTokens === null && tokens !== null,
    server_workspace_id: facts?.workspace_id ?? null,
    server_board_id: facts?.board_id ?? null,
    server_mapping_id: facts?.mapping_id ?? null,
  };
}

function withLive(state: SessionsState, live: readonly TrackedSession[]): SessionsState {
  return { ...state, live, liveCount: live.length };
}

/**
 * Folds one SSE `session` event in. Events can arrive out of order or be
 * replayed after a reconnect, so every write is keyed and idempotent: an older
 * update never overwrites a newer one, and an ended session never comes back.
 */
export function applySessionEvent(event: SessionEvent, now: Date = new Date()): void {
  const state = sessionsStore.get();
  const incoming = event.session;
  const id = incoming.native_session_id;
  const held = state.live.find((session) => session.native_session_id === id);
  const alreadyEnded = state.endedToday.some((session) => session.native_session_id === id);
  const tracked = withServerFacts(incoming, state.server.get(id));

  switch (event.kind) {
    case "started":
    case "updated": {
      if (alreadyEnded) return;
      if (held && isOlder(incoming, held)) return;
      const live = held ? state.live.map((session) => (session === held ? tracked : session)) : [tracked, ...state.live];
      sessionsStore.set(withLive(state, live));
      return;
    }
    case "ended": {
      const live = held ? state.live.filter((session) => session !== held) : state.live;
      const endedToday = alreadyEnded
        ? state.endedToday
        : [{ ...tracked, ended_at: now.toISOString() }, ...state.endedToday.filter((session) => sameLocalDay(new Date(session.ended_at), now))];
      activeEnrichment?.sessionEnded();
      if (live === state.live && endedToday === state.endedToday) return;
      sessionsStore.set({ ...withLive(state, live), endedToday });
      return;
    }
    default:
      return;
  }
}

/** The daemon went away: nothing is known to be live any more. */
export function clearLiveSessions(): void {
  const state = sessionsStore.get();
  if (state.live.length > 0) sessionsStore.set(withLive(state, []));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const numberOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const stringOrNull = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

function serverTokens(item: Record<string, unknown>): SessionTokens | null {
  const input = numberOrNull(item.input_tokens);
  const output = numberOrNull(item.output_tokens);
  const cacheRead = numberOrNull(item.cache_read_tokens);
  const cacheWrite = numberOrNull(item.cache_creation_tokens);
  if (input === null || output === null || cacheRead === null || cacheWrite === null) return null;
  return { input, output, cache_read: cacheRead, cache_write: cacheWrite };
}

function serverFacts(item: unknown): [string, ServerSessionFacts] | null {
  if (!isRecord(item) || typeof item.id !== "string" || typeof item.native_session_id !== "string") return null;
  return [
    item.native_session_id,
    {
      server_id: item.id,
      cost_estimated_usd: numberOrNull(item.cost_estimated_usd),
      cost_reported_usd: numberOrNull(item.cost_reported_usd),
      cost_basis: typeof item.cost_basis === "string" ? item.cost_basis : null,
      tokens: serverTokens(item),
      workspace_id: stringOrNull(item.workspace_id),
      board_id: stringOrNull(item.board_id),
      mapping_id: stringOrNull(item.mapping_id),
    },
  ];
}

/**
 * Folds a `GET /v1/sessions` page (the server's own-device sessions) in by
 * native_session_id. Facts are kept only for sessions this store holds, so
 * the map never outgrows live plus today's ended sessions.
 */
export function mergeServerSessions(page: unknown): void {
  if (!isRecord(page) || !Array.isArray(page.items)) return;
  const state = sessionsStore.get();
  const held = new Set([...state.live, ...state.endedToday].map((session) => session.native_session_id));
  const fresh = page.items
    .map(serverFacts)
    .filter((entry): entry is [string, ServerSessionFacts] => entry !== null && held.has(entry[0]));
  if (fresh.length === 0) return;
  const server = new Map([...state.server].filter(([id]) => held.has(id)));
  for (const [id, facts] of fresh) server.set(id, facts);
  const live = state.live.map((session) => withServerFacts(session, server.get(session.native_session_id)));
  const endedToday = state.endedToday.map((session) => ({ ...withServerFacts(session, server.get(session.native_session_id)), ended_at: session.ended_at }));
  sessionsStore.set({ ...withLive(state, live), endedToday, server });
}

/** The server's id for a local session, for deep links; null until a poll has seen it. */
export function serverSessionId(nativeSessionId: string): string | null {
  return sessionsStore.get().server.get(nativeSessionId)?.server_id ?? null;
}

export function useServerSessionId(nativeSessionId: string): string | null {
  return useStoreSelector(sessionsStore, (state) => state.server.get(nativeSessionId)?.server_id ?? null);
}

export const SERVER_SESSIONS_REFRESH_MS = 20_000;
const SERVER_SESSIONS_QUERY = { status: null, limit: 100, cursor: null };

interface Enrichment {
  sessionEnded(): void;
  stop(): void;
}

let activeEnrichment: Enrichment | null = null;

/**
 * Polls the server's own-device sessions about every 20 s while the popover
 * is visible, and after every ended session, never more often than that.
 * A failed poll is ignored: the last known values stay.
 */
export function startSessionEnrichment(): () => void {
  if (activeEnrichment) return activeEnrichment.stop;

  let lastFetchAt = Number.NEGATIVE_INFINITY;
  let trailingTimer: ReturnType<typeof setTimeout> | undefined;
  // A trailing fetch owed to an ended session survives the popover hiding.
  let owedToEndedSession = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const fetchNow = () => {
    lastFetchAt = Date.now();
    owedToEndedSession = false;
    commands.sessions(SERVER_SESSIONS_QUERY).then(
      (page) => {
        if (!stopped) mergeServerSessions(page);
      },
      () => {},
    );
  };

  const requestRefresh = () => {
    if (stopped) return;
    const wait = lastFetchAt + SERVER_SESSIONS_REFRESH_MS - Date.now();
    if (wait <= 0) {
      clearTimeout(trailingTimer);
      trailingTimer = undefined;
      fetchNow();
      return;
    }
    trailingTimer ??= setTimeout(() => {
      trailingTimer = undefined;
      requestRefresh();
    }, wait);
  };

  const followVisibility = (visible: boolean) => {
    if (visible && pollTimer === undefined) {
      requestRefresh();
      pollTimer = setInterval(requestRefresh, SERVER_SESSIONS_REFRESH_MS);
    } else if (!visible) {
      clearInterval(pollTimer);
      pollTimer = undefined;
      if (!owedToEndedSession) {
        clearTimeout(trailingTimer);
        trailingTimer = undefined;
      }
    }
  };

  const stopTracking = trackPopoverVisibility();
  const unsubscribe = popoverVisibleStore.subscribe(() => followVisibility(popoverVisibleStore.get()));
  followVisibility(popoverVisibleStore.get());

  const enrichment: Enrichment = {
    sessionEnded() {
      owedToEndedSession = true;
      requestRefresh();
    },
    stop() {
      stopped = true;
      clearTimeout(trailingTimer);
      clearInterval(pollTimer);
      unsubscribe();
      stopTracking();
      if (activeEnrichment === enrichment) activeEnrichment = null;
    },
  };
  activeEnrichment = enrichment;
  return enrichment.stop;
}

export function useLiveSessions(): readonly TrackedSession[] {
  return useStoreSelector(sessionsStore, (state) => state.live);
}

export function useLiveSessionCount(): number {
  return useStoreSelector(sessionsStore, (state) => state.liveCount);
}

export function useEndedSessionsToday(): readonly EndedSession[] {
  return useStoreSelector(sessionsStore, (state) => state.endedToday);
}

export function resetSessionsForTests(): void {
  activeEnrichment?.stop();
  sessionsStore.set(EMPTY);
}
