// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { mockDaemonIpc } from "../../test/daemon-ipc";
import { installFailure, updateCheckFailure } from "./copy";
import { checkForUpdate } from "./updater";

describe("updates off the Mac", () => {
  it("keeps the shell's unavailable-on-platform refusal instead of calling it unknown", async () => {
    mockDaemonIpc({
      check_for_update: () => {
        throw { kind: "updates_unavailable_on_platform" };
      },
    });
    await expect(checkForUpdate()).resolves.toEqual({ ok: false, error: { kind: "updates_unavailable_on_platform" } });
  });

  it("explains that this build updates through its installer, not a retry", () => {
    const refusal = { kind: "updates_unavailable_on_platform" } as const;
    expect(updateCheckFailure(refusal)).toBe("This version updates by installing the new release. Checking here isn’t available yet.");
    expect(installFailure(refusal, "0.3.0")).toBe("This version updates by installing the new release. Checking here isn’t available yet.");
    expect(updateCheckFailure(refusal)).not.toMatch(/Try again/);
  });
});

describe("updates in a build without an update key", () => {
  it("keeps the not-configured refusal instead of calling it unknown", async () => {
    mockDaemonIpc({
      check_for_update: () => {
        throw { kind: "updates_not_configured" };
      },
    });
    await expect(checkForUpdate()).resolves.toEqual({ ok: false, error: { kind: "updates_not_configured" } });
  });

  it("says updates are off in this build, without inviting a retry", () => {
    const refusal = { kind: "updates_not_configured" } as const;
    expect(updateCheckFailure(refusal)).toBe("Updates are off in this build. Install a newer release to update.");
    expect(installFailure(refusal, "0.3.0")).toBe("Updates are off in this build. Install a newer release to update.");
    expect(updateCheckFailure(refusal)).not.toMatch(/Try again/);
  });
});
