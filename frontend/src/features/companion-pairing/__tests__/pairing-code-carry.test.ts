// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  carryPairingCode,
  forgetCarriedPairingCode,
  readCarriedPairingCode,
} from "../pairing-code-carry";

describe("carrying a pairing code through sign-in", () => {
  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => vi.useRealTimers());

  it("hands the code back until it is forgotten", () => {
    carryPairingCode("BCDF-GHJK");
    expect(readCarriedPairingCode()).toBe("BCDF-GHJK");
    expect(readCarriedPairingCode()).toBe("BCDF-GHJK");
    forgetCarriedPairingCode();
    expect(readCarriedPairingCode()).toBeNull();
  });

  it("drops a code older than the 15-minute return window", () => {
    vi.useFakeTimers();
    carryPairingCode("BCDF-GHJK");
    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(readCarriedPairingCode()).toBeNull();
  });

  it("counts the 15 minutes from the first carry, not from every re-carry", () => {
    vi.useFakeTimers();
    carryPairingCode("BCDF-GHJK");
    vi.advanceTimersByTime(10 * 60 * 1000);
    carryPairingCode("BCDF-GHJK");
    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(readCarriedPairingCode()).toBeNull();
  });

  it("starts a new 15-minute window for a different code", () => {
    vi.useFakeTimers();
    carryPairingCode("BCDF-GHJK");
    vi.advanceTimersByTime(10 * 60 * 1000);
    carryPairingCode("CDFG-HJKL");
    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(readCarriedPairingCode()).toBe("CDFG-HJKL");
  });

  it("drops a code once the person is done with it", () => {
    carryPairingCode("BCDF-GHJK");
    forgetCarriedPairingCode();
    expect(readCarriedPairingCode()).toBeNull();
  });

  it("refuses anything that is not a code", () => {
    window.sessionStorage.setItem(
      "backplane.pairingCodeAfterSignIn",
      JSON.stringify({ code: "<script>", savedAt: Date.now() }),
    );
    expect(readCarriedPairingCode()).toBeNull();
  });
});
