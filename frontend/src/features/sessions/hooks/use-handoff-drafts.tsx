// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isApiError, type ApiError } from "@/lib/api-error";
import type { SessionContent } from "@/types/agent-session";
import type { ExcerptNoteRequest } from "../api/use-save-excerpt-note";
import type { ExcerptNoteDraft } from "../utils/excerpt-note";
import { canExcerpt, utf8Bytes } from "../utils/excerpt";

export interface ReviewedDestination {
  workspace: { id: string; slug: string; name: string };
  board: { id: string; name: string };
  card?: { id: string; title: string };
}

export interface HandoffForm {
  open: boolean;
  slug: string;
  boardId: string;
  cardId: string;
  title: string;
  content: string;
  request: ExcerptNoteRequest | null;
  reviewedDestination: ReviewedDestination | null;
  hadUnknownOutcome: boolean;
  hasSentRequest: boolean;
  pending: boolean;
  error: ApiError | null;
}

interface HandoffSession {
  selected: ReadonlyMap<string, SessionContent>;
  draft: ExcerptNoteDraft | null;
  form: HandoffForm | null;
}

const EMPTY: HandoffSession = { selected: new Map(), draft: null, form: null };
export const HANDOFF_MAX_DRAFTS = 5;
export const HANDOFF_MAX_BYTES = 32 * 1024 * 1024;
export const HANDOFF_MAX_SELECTIONS = 1024;
const MAX_SESSION_SELECTIONS = 20;

function retainedBytes(state: HandoffSession): number {
  // Strings are immutable. Equal draft/editor/request text has one logical
  // retained payload; original body copies are discarded when composing it.
  const text = new Set<string>();
  if (state.draft) {
    text.add(state.draft.document);
    for (const body of state.draft.bodies) text.add(body.text);
  }
  if (state.form) { text.add(state.form.content); text.add(state.form.title); }
  if (state.form?.request) text.add(String(state.form.request.payload.content ?? ""));
  return [...text].reduce((sum, value) => sum + utf8Bytes(value), 0);
}

export class HandoffDraftStore {
  private sessions = new Map<string, HandoffSession>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private active = true;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  version = () => this.revision;
  read = (key: string) => this.sessions.get(key) ?? EMPTY;
  current = (key: string, draft: ExcerptNoteDraft) => this.active && this.read(key).draft === draft;
  hasDrafts = () => [...this.sessions.values()].some((state) => state.draft !== null);
  bytes = () => [...this.sessions.values()].reduce((sum, state) => sum + retainedBytes(state), 0);
  private changed() { this.revision += 1; for (const listener of this.listeners) listener(); }

  write(key: string, state: HandoffSession): boolean {
    if (!this.active) return false;
    const others = [...this.sessions].filter(([identity]) => identity !== key).map(([, value]) => value);
    if (state.selected.size > HANDOFF_MAX_SELECTIONS) return false;
    if (!this.sessions.has(key) && others.length >= MAX_SESSION_SELECTIONS) return false;
    if (state.draft && others.filter((value) => value.draft).length >= HANDOFF_MAX_DRAFTS) return false;
    if (retainedBytes(state) + others.reduce((sum, value) => sum + retainedBytes(value), 0) > HANDOFF_MAX_BYTES) return false;
    if (!state.draft && !state.selected.size) this.sessions.delete(key);
    else this.sessions.set(key, state);
    this.changed();
    return true;
  }

  clear(key: string) { if (this.sessions.delete(key)) this.changed(); }
  dispose() { this.active = false; this.sessions.clear(); this.changed(); }
  activate() { this.active = true; }
}

const HandoffDraftContext = createContext<HandoffDraftStore | null>(null);

export function HandoffDraftProvider({ ownerId, children }: { ownerId: string | null; children: ReactNode }) {
  const [scope, setScope] = useState(() => ({ ownerId, generation: 0, store: new HandoffDraftStore() }));
  if (scope.ownerId !== ownerId) {
    // Initial profile hydration identifies an already editable application.
    // Later principal changes must also discard its local editor state.
    // Both replace private memory; cleanup permanently revokes old writers.
    const initialHydration = scope.ownerId === null && scope.generation === 0;
    setScope({ ownerId, generation: scope.generation + (initialHydration ? 0 : 1), store: new HandoffDraftStore() });
  }
  return <OwnedHandoffDrafts key={scope.generation} ownerId={scope.ownerId} store={scope.store}>{children}</OwnedHandoffDrafts>;
}

function OwnedHandoffDrafts({ ownerId, store, children }: { ownerId: string | null; store: HandoffDraftStore; children: ReactNode }) {
  const client = useQueryClient();
  useSyncExternalStore(store.subscribe, store.version, store.version);
  useEffect(() => {
    if (ownerId) store.activate();
    else store.dispose();
    return () => store.dispose();
  }, [ownerId, store]);
  useEffect(() => client.getQueryCache().subscribe(({ query, type }) => {
    if (type !== "updated") return;
    const key = query.queryKey;
    if (key[0] !== "sessions" || key[2] !== "detail" || typeof key[1] !== "string" || typeof key[3] !== "string") return;
    const sessionDetail = key.length === 4;
    const selectedMetadata = key[4] === "contents" && key[5] === "selected-metadata";
    if (!sessionDetail && !selectedMetadata) return;
    const error = query.state.error;
    const denied = isApiError(error) && [401, 403, 404].includes(error.status);
    const removed = sessionDetail && query.state.status === "success" && query.state.data === null;
    const identity = `${key[1]}/${key[3]}`;
    const retained = store.read(identity);
    const sourceIds = new Set([
      ...retained.selected.keys(), ...(retained.draft?.bodies.map(({ item }) => item.id) ?? []),
    ]);
    const metadata = selectedMetadata ? query.state.data as { unavailable_ids?: string[]; items?: SessionContent[] } | undefined : undefined;
    const withdrawn = metadata?.unavailable_ids?.some((id) => sourceIds.has(id))
      || metadata?.items?.some((item) => sourceIds.has(item.id) && !canExcerpt(item));
    if (denied || removed || withdrawn) store.clear(identity);
  }), [client, store]);
  const hasDrafts = store.hasDrafts();
  useEffect(() => {
    if (!hasDrafts) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasDrafts]);
  return <HandoffDraftContext.Provider value={store}>{children}</HandoffDraftContext.Provider>;
}

export function useHandoffDraft(slug: string, sessionId: string) {
  const shared = useContext(HandoffDraftContext);
  const [local] = useState(() => new HandoffDraftStore());
  const store = shared ?? local;
  const key = `${slug}/${sessionId}`;
  const read = useCallback(() => store.read(key), [store, key]);
  const state = useSyncExternalStore(store.subscribe, read, read);
  useEffect(() => {
    if (shared || !state.draft) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [shared, state.draft]);
  const actions = useMemo(() => ({
    select(selected: ReadonlyMap<string, SessionContent>) {
      const metadata = new Map([...selected].map(([id, item]) => [id, { ...item, preview: null }]));
      return store.write(key, { ...store.read(key), selected: metadata });
    },
    setDraft(draft: ExcerptNoteDraft | null) {
      const current = store.read(key);
      if (draft === current.draft) return true;
      return store.write(key, { ...current, draft, form: null });
    },
    setForm(draft: ExcerptNoteDraft, form: HandoffForm) {
      return store.current(key, draft) && store.write(key, { ...store.read(key), form });
    },
    getForm: (draft: ExcerptNoteDraft) => store.current(key, draft) ? store.read(key).form : null,
    isCurrent: (draft: ExcerptNoteDraft) => store.current(key, draft),
    clear: () => store.clear(key),
  }), [store, key]);
  return { state, ...actions };
}

export type HandoffDraftController = ReturnType<typeof useHandoffDraft>;
