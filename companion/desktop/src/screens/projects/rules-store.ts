// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { commands, type CompanionStatus, type SettingsUpdate_Deserialize } from "../../ipc/bindings";
import { callDaemon, type DaemonResult } from "../../ipc/daemon";
import { showToast } from "../../shell/layers";
import { connectionStore, statusStore } from "../../stores/daemon-stream";
import { createExternalStore, useStoreSelector } from "../../stores/external-store";

export interface Rules {
  auto_match_repos: boolean;
  exclude_globs: readonly string[];
}

/**
 * The rules one installation's policy holds. `exclude_globs` replaces the
 * server's whole list, so writes run one at a time and each builds on the
 * newest rules known when it starts (DK-8's settings-queue pattern).
 *
 * The rules Backplane answered the last write with stay authoritative until a
 * status reports those same rules: after a failed policy refresh, or from a
 * tick racing the write, the daemon keeps emitting statuses with the old
 * ones. A reconnect or another installation starts over from status. If no
 * status agrees within CONFIRM_TIMEOUT_MS, see confirmBySnapshot.
 */
interface SavedRules {
  rules: Rules;
  installationId: string;
  caughtUp: boolean;
  timedOut: boolean;
}

const CONFIRM_TIMEOUT_MS = 30_000;

const saved = createExternalStore<SavedRules | null>(null);
let queueTail: Promise<unknown> = Promise.resolve();
let confirmTimeoutMs = CONFIRM_TIMEOUT_MS;
let confirmTimer: ReturnType<typeof setTimeout> | undefined;

// Without a cached policy the daemon reports false and [], which are not the real rules.
function rulesFromStatus(status: CompanionStatus | null): Rules | null {
  if (!status?.capture.policy_cached) return null;
  const { auto_match_repos, exclude_globs } = status.capture;
  return typeof auto_match_repos === "boolean" && Array.isArray(exclude_globs) ? { auto_match_repos, exclude_globs } : null;
}

// Order-insensitive: the server may hand the list back in another order.
function sameRules(a: Rules | null, b: Rules): boolean {
  if (!a || a.auto_match_repos !== b.auto_match_repos) return false;
  const wanted = new Set(b.exclude_globs);
  const reported = new Set(a.exclude_globs);
  return wanted.size === reported.size && [...wanted].every((glob) => reported.has(glob));
}

function forget(): void {
  clearTimeout(confirmTimer);
  saved.set(null);
}

function markCaughtUp(): void {
  const current = saved.get();
  if (!current || current.caughtUp) return;
  clearTimeout(confirmTimer);
  saved.set({ ...current, caughtUp: true, timedOut: false });
}

statusStore.subscribe(() => {
  const current = saved.get();
  if (!current) return;
  const status = statusStore.get();
  if (status === null || status.installation_id !== current.installationId) forget();
  else if (sameRules(rulesFromStatus(status), current.rules)) markCaughtUp();
});

connectionStore.subscribe(() => {
  if (connectionStore.get().state === "unreachable") forget();
});

export const CHANGED_ELSEWHERE = "Your rules were changed elsewhere; showing the current ones.";

/**
 * The write went unconfirmed: edits wait while status is fetched directly.
 * That snapshot is the truth. It becomes the rules base (the stream may still
 * be stale) until a streamed status agrees, whether it confirms the write or
 * shows rules changed elsewhere.
 */
async function confirmBySnapshot(expected: SavedRules): Promise<void> {
  if (saved.get() !== expected) return;
  const waiting = expected.timedOut ? expected : { ...expected, timedOut: true };
  saved.set(waiting);
  const fetched = await callDaemon(commands.status);
  if (saved.get() !== waiting) return;
  const snapshot = fetched.ok ? fetched.value : null;
  if (snapshot && snapshot.installation_id !== waiting.installationId) {
    forget();
    return;
  }
  const snapshotRules = rulesFromStatus(snapshot);
  if (!snapshotRules) {
    confirmTimer = setTimeout(() => void confirmBySnapshot(waiting), confirmTimeoutMs);
    return;
  }
  if (sameRules(snapshotRules, waiting.rules)) {
    saved.set({ ...waiting, timedOut: false });
    return;
  }
  saved.set({ ...waiting, rules: snapshotRules, timedOut: false });
  showToast(CHANGED_ELSEWHERE, { tone: "info" });
}

function remember(rules: Rules, status: CompanionStatus): void {
  clearTimeout(confirmTimer);
  const caughtUp = sameRules(rulesFromStatus(status), rules);
  const written: SavedRules = { rules, installationId: status.installation_id, caughtUp, timedOut: false };
  saved.set(written);
  if (!caughtUp) confirmTimer = setTimeout(() => void confirmBySnapshot(written), confirmTimeoutMs);
}

/** The rules capture really runs with, as far as this app knows; null while unknown. */
export function knownRules(): Rules | null {
  const current = saved.get();
  if (current && !current.caughtUp) return current.rules;
  return rulesFromStatus(statusStore.get());
}

/** True once a write has gone unconfirmed past the timeout: edits wait until status agrees. */
export function rulesAwaitingConfirmation(): boolean {
  const current = saved.get();
  return current !== null && !current.caughtUp && current.timedOut;
}

function answeredRules(value: unknown, sent: Rules): Rules {
  if (typeof value !== "object" || value === null) return sent;
  const { auto_match_repos: autoMatch, exclude_globs: globs } = value as Record<string, unknown>;
  return {
    auto_match_repos: typeof autoMatch === "boolean" ? autoMatch : sent.auto_match_repos,
    exclude_globs: Array.isArray(globs) && globs.every((glob) => typeof glob === "string") ? globs : sent.exclude_globs,
  };
}

const NOT_WRITABLE = { kind: "local", message: "rules not known" } as const;

/**
 * Queues one write; `build` gets the newest known rules when the write starts
 * and returns the update. Refused (never sent) while the rules are unknown or
 * awaiting confirmation.
 */
export function queueRulesWrite(build: (current: Rules) => SettingsUpdate_Deserialize): Promise<DaemonResult<Rules>> {
  const write = async (): Promise<DaemonResult<Rules>> => {
    const current = knownRules();
    const status = statusStore.get();
    if (!current || !status || rulesAwaitingConfirmation()) return { ok: false, error: NOT_WRITABLE };
    const update = build(current);
    const expected: Rules = {
      auto_match_repos: update.auto_match_repos ?? current.auto_match_repos,
      exclude_globs: update.exclude_globs ?? current.exclude_globs,
    };
    const result = await callDaemon(() => commands.updateSettings(update));
    if (!result.ok) return result;
    const rules = answeredRules(result.value, expected);
    const latest = statusStore.get();
    if (latest && latest.installation_id === status.installation_id) remember(rules, latest);
    return { ok: true, value: rules };
  };
  const queued = queueTail.then(write, write);
  queueTail = queued;
  return queued;
}

export interface RulesView {
  rules: Rules | null;
  awaitingConfirmation: boolean;
}

// Memoized per (status, saved) pair so the selector returns a stable value.
let view: { status: CompanionStatus | null; saved: SavedRules | null; value: RulesView } = {
  status: null,
  saved: null,
  value: { rules: null, awaitingConfirmation: false },
};

function currentView(status: CompanionStatus | null): RulesView {
  const current = saved.get();
  if (view.status !== status || view.saved !== current) {
    view = { status, saved: current, value: { rules: knownRules(), awaitingConfirmation: rulesAwaitingConfirmation() } };
  }
  return view.value;
}

export function useRules(): RulesView {
  useStoreSelector(saved, (current) => current);
  return useStoreSelector(statusStore, currentView);
}

export function setConfirmTimeoutForTests(ms: number): void {
  confirmTimeoutMs = ms;
}

export function resetRulesForTests(): void {
  forget();
  queueTail = Promise.resolve();
  confirmTimeoutMs = CONFIRM_TIMEOUT_MS;
  view = { status: null, saved: null, value: { rules: null, awaitingConfirmation: false } };
}
