// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";

import { autoStartCompanionServiceOnce, removalStore, removeCompanion, resetServiceStartForTests, startCompanionService } from "./companion-service";

afterEach(() => resetServiceStartForTests());

describe("service start during Remove Companion", () => {
  it.each([
    ["removing", { state: "removing" }],
    ["removed", { state: "removed", serverRevoked: true }],
    ["removal_incomplete", { state: "removal_incomplete", failure: "purge" }],
  ] as const)("never starts the service while removal is %s", async (_label, removal) => {
    const invoked: string[] = [];
    mockIPC((command) => {
      invoked.push(command);
      return command === "app_location" ? { in_applications: true, path: "/Applications/Backplane Companion.app" } : {};
    });
    removalStore.set(removal);
    await autoStartCompanionServiceOnce();
    await startCompanionService();
    expect(invoked).toEqual([]);
  });

  it("still auto-starts once removal is back to idle", async () => {
    const invoked: string[] = [];
    mockIPC((command) => {
      invoked.push(command);
      return command === "app_location" ? { in_applications: true, path: "/Applications/Backplane Companion.app" } : {};
    });
    await autoStartCompanionServiceOnce();
    expect(invoked).toEqual(["app_location", "start_companion_service"]);
  });
});

describe("removeCompanion re-entrancy", () => {
  it("runs companion_uninstall once for overlapping calls, and both see its outcome", async () => {
    let finish: (report: unknown) => void = () => {};
    let invokes = 0;
    mockIPC((command) => {
      if (command !== "companion_uninstall") throw `unexpected ${command}`;
      invokes += 1;
      return new Promise((resolve) => (finish = resolve));
    });
    const first = removeCompanion();
    const second = removeCompanion();
    await Promise.resolve();
    finish({ uninstalled: true, server_revoked: true });
    const results = await Promise.all([first, second]);
    expect(invokes).toBe(1);
    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect(removalStore.get()).toEqual({ state: "removed", serverRevoked: true });
  });

  it("runs again for a retry once the earlier run has settled", async () => {
    let invokes = 0;
    mockIPC(() => {
      invokes += 1;
      if (invokes === 1) throw { kind: "companion_failed", step: "uninstall --purge" };
      return { uninstalled: true, server_revoked: false };
    });
    expect(await removeCompanion()).toEqual({ ok: false, failure: "purge" });
    expect(removalStore.get()).toEqual({ state: "removal_incomplete", failure: "purge" });
    expect((await removeCompanion()).ok).toBe(true);
    expect(invokes).toBe(2);
    expect(removalStore.get()).toEqual({ state: "removed", serverRevoked: false });
  });
});

describe("removeCompanion when launch at login can't be turned off", () => {
  it.each([true, false])("reports removal as incomplete with the login_item failure, keeping serverRevoked=%s", async (serverRevoked) => {
    mockIPC(() => {
      throw { kind: "login_item_failed", message: "Operation not permitted", report: { uninstalled: true, server_revoked: serverRevoked } };
    });
    expect(await removeCompanion()).toStrictEqual({ ok: false, failure: "login_item", serverRevoked });
    expect(removalStore.get()).toStrictEqual({ state: "removal_incomplete", failure: "login_item", serverRevoked });
  });

  it("claims no server outcome for a step failure", async () => {
    mockIPC(() => {
      throw { kind: "companion_failed", step: "service uninstall", exit_code: 1, message: "" };
    });
    expect(await removeCompanion()).toStrictEqual({ ok: false, failure: "service" });
    expect(removalStore.get()).toStrictEqual({ state: "removal_incomplete", failure: "service" });
  });

  it("still treats an unknown error kind as unconfirmed", async () => {
    mockIPC(() => {
      throw { kind: "something_new", message: "?" };
    });
    expect(await removeCompanion()).toEqual({ ok: false, failure: "unconfirmed" });
  });
});
