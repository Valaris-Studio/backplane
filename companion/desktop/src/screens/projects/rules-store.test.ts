// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CompanionStatus } from "../../ipc/bindings";
import { layersStore } from "../../shell/layers";
import { connectionStore, statusStore } from "../../stores/daemon-stream";
import { mockDaemonIpc } from "../../test/daemon-ipc";
import { baseStatus, withRules } from "./projects-fixtures";
import { knownRules, queueRulesWrite, resetRulesForTests, rulesAwaitingConfirmation, setConfirmTimeoutForTests } from "./rules-store";

const A = "~/a/**";
const B = "~/b/**";
const C = "~/c/**";
const D = "~/d/**";

const status = (globs: string[], patch: Partial<CompanionStatus> = {}): CompanionStatus => ({ ...withRules({ auto_match_repos: false, exclude_globs: globs }), ...patch });
const settings = (globs: readonly string[], autoMatch = false) => ({ paused: false, auto_match_repos: autoMatch, enabled_agents: [], exclude_globs: [...globs], retention_days: null });
const addRule = (rule: string) => queueRulesWrite((current) => ({ exclude_globs: [...current.exclude_globs, rule] }));
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function answeringWithWhatWasSent() {
  const sent: unknown[] = [];
  mockDaemonIpc({
    update_settings: (args) => {
      sent.push(args.update);
      const update = args.update as { exclude_globs?: string[]; auto_match_repos?: boolean };
      return settings(update.exclude_globs ?? knownRules()?.exclude_globs ?? [], update.auto_match_repos ?? false);
    },
    status: () => statusStore.get(),
  });
  return sent;
}

beforeEach(() => {
  resetRulesForTests();
  connectionStore.set({ state: "connected" });
  statusStore.set(status([A, B]));
});

afterEach(() => {
  resetRulesForTests();
  statusStore.set(null);
});

describe("rules store", () => {
  it("is unknown without a cached policy", () => {
    statusStore.set({ ...baseStatus, capture: { ...baseStatus.capture, policy_cached: false } });
    expect(knownRules()).toBeNull();
  });

  it("keeps the written list when a newer status still carries the old one (the lost update)", async () => {
    const sent = answeringWithWhatWasSent();
    await addRule(C);
    // A failed policy refresh, or a tick racing the write: a new status, old globs.
    statusStore.set(status([A, B]));
    expect(knownRules()?.exclude_globs).toEqual([A, B, C]);
    await addRule(D);
    expect(sent).toEqual([{ exclude_globs: [A, B, C] }, { exclude_globs: [A, B, C, D] }]);
  });

  it("hands back to status once a status reports the written list, in any order", async () => {
    answeringWithWhatWasSent();
    await addRule(C);
    statusStore.set(status([C, A, B]));
    statusStore.set(status(["~/elsewhere/**"]));
    expect(knownRules()?.exclude_globs).toEqual(["~/elsewhere/**"]);
  });

  it("does not treat a status with the right globs but the old auto-bind as caught up", async () => {
    answeringWithWhatWasSent();
    await queueRulesWrite(() => ({ auto_match_repos: true }));
    statusStore.set(status([A, B]));
    expect(knownRules()?.auto_match_repos).toBe(true);
  });

  it("runs writes one at a time, each on the newest list", async () => {
    const sent = answeringWithWhatWasSent();
    await Promise.all([addRule(C), addRule(D)]);
    expect(sent).toEqual([{ exclude_globs: [A, B, C] }, { exclude_globs: [A, B, C, D] }]);
  });

  it("keeps going after a failed write", async () => {
    const sent: unknown[] = [];
    let fail = true;
    mockDaemonIpc({
      update_settings: (args) => {
        sent.push(args.update);
        if (fail) {
          fail = false;
          throw { kind: "api", status: 502, code: "server_unreachable", message: "", detail: null };
        }
        return settings((args.update as { exclude_globs: string[] }).exclude_globs);
      },
    });
    const [first, second] = await Promise.all([addRule(C), addRule(D)]);
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(true);
    expect(sent).toEqual([{ exclude_globs: [A, B, C] }, { exclude_globs: [A, B, D] }]);
  });

  it("refuses to write while the rules are unknown", async () => {
    const sent = answeringWithWhatWasSent();
    statusStore.set({ ...baseStatus, capture: { ...baseStatus.capture, policy_cached: false } });
    const result = await addRule(C);
    expect(result.ok).toBe(false);
    expect(sent).toEqual([]);
  });

  it("starts over from status after a reconnect", async () => {
    answeringWithWhatWasSent();
    await addRule(C);
    connectionStore.set({ state: "unreachable", reason: "gone" });
    connectionStore.set({ state: "connected" });
    statusStore.set(status([A, B]));
    expect(knownRules()?.exclude_globs).toEqual([A, B]);
  });

  it("starts over from status for another installation", async () => {
    answeringWithWhatWasSent();
    await addRule(C);
    statusStore.set(status([A], { installation_id: "inst_other" }));
    expect(knownRules()?.exclude_globs).toEqual([A]);
  });

  it("after the confirm timeout, blocks edits while it refetches status", async () => {
    setConfirmTimeoutForTests(30);
    let answerSnapshot: (value: CompanionStatus) => void = () => {};
    const sent: unknown[] = [];
    mockDaemonIpc({
      update_settings: (args) => {
        sent.push(args.update);
        return settings((args.update as { exclude_globs: string[] }).exclude_globs);
      },
      status: () =>
        new Promise((resolve) => {
          answerSnapshot = resolve;
        }),
    });
    await addRule(C);
    expect(rulesAwaitingConfirmation()).toBe(false);
    await tick(80);
    expect(rulesAwaitingConfirmation()).toBe(true);
    const blocked = await addRule(D);
    expect(blocked.ok).toBe(false);
    expect(sent).toHaveLength(1);

    answerSnapshot(status([A, B, C]));
    await tick();
    expect(rulesAwaitingConfirmation()).toBe(false);
  });

  it("the refetch itself can confirm the write", async () => {
    setConfirmTimeoutForTests(30);
    mockDaemonIpc({
      update_settings: (args) => settings((args.update as { exclude_globs: string[] }).exclude_globs),
      status: () => status([A, B, C]),
    });
    await addRule(C);
    await tick(80);
    expect(rulesAwaitingConfirmation()).toBe(false);
  });

  it("after a snapshot confirms the write, the next write still builds on it while the stream stays stale", async () => {
    setConfirmTimeoutForTests(30);
    const sent: unknown[] = [];
    mockDaemonIpc({
      update_settings: (args) => {
        sent.push(args.update);
        return settings((args.update as { exclude_globs: string[] }).exclude_globs);
      },
      status: () => status([A, B, C]),
    });
    await addRule(C);
    statusStore.set(status([A, B]));
    await tick(80);
    expect(rulesAwaitingConfirmation()).toBe(false);
    expect(knownRules()?.exclude_globs).toEqual([A, B, C]);
    await addRule(D);
    expect(sent).toEqual([{ exclude_globs: [A, B, C] }, { exclude_globs: [A, B, C, D] }]);
  });

  it("when the snapshot shows other rules, trusts it, unlocks and says the rules changed elsewhere", async () => {
    setConfirmTimeoutForTests(30);
    const sent: unknown[] = [];
    mockDaemonIpc({
      update_settings: (args) => {
        sent.push(args.update);
        return settings((args.update as { exclude_globs: string[] }).exclude_globs);
      },
      status: () => status(["~/x/**"]),
    });
    await addRule(C);
    statusStore.set(status([A, B]));
    await tick(80);
    expect(rulesAwaitingConfirmation()).toBe(false);
    expect(knownRules()?.exclude_globs).toEqual(["~/x/**"]);
    expect(layersStore.get().toast?.message).toBe("Your rules were changed elsewhere; showing the current ones.");
    await addRule(D);
    expect(sent).toEqual([{ exclude_globs: [A, B, C] }, { exclude_globs: ["~/x/**", D] }]);
  });

  it("tries the snapshot again when fetching it fails", async () => {
    setConfirmTimeoutForTests(30);
    let reachable = false;
    mockDaemonIpc({
      update_settings: (args) => settings((args.update as { exclude_globs: string[] }).exclude_globs),
      status: () => {
        if (!reachable) throw { kind: "unreachable", reason: "down" };
        return status([A, B, C]);
      },
    });
    await addRule(C);
    await tick(60);
    expect(rulesAwaitingConfirmation()).toBe(true);
    reachable = true;
    await tick(80);
    expect(rulesAwaitingConfirmation()).toBe(false);
  });
});
