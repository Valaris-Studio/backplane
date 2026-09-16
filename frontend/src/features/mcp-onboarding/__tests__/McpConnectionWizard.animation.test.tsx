// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@/test/test-utils";

// Every OTHER test in this feature forces reduced motion so entrance tweens are
// skipped — which left the PRODUCTION animation path (motion allowed) with zero
// coverage, and hid a real defect: overriding `autoAlpha` in fadeInUp's TO vars
// does nothing, because the preset hardcodes `autoAlpha: 0` in its FROM vars.
// The pane settled at visibility:hidden for every user without reduced motion.
// This file is the positive control for the animated path — it must run with
// stubMatchMedia(false).
import { mockApiKeys, mockMe, renderWizard, stubMatchMedia } from "./wizard-harness";

beforeEach(() => {
  stubMatchMedia(false);
  mockMe();
  mockApiKeys([]);
});

afterEach(() => stubMatchMedia(false));

// NOTE: real timers only. GSAP drives its ticker off requestAnimationFrame, so
// vi.advanceTimersByTime does NOT advance a tween — under fake timers the pane
// stays frozen at its FROM state (visibility:hidden) and these assertions would
// fail against correct code. waitFor's real-time polling is what lets the
// tween actually run.
describe("McpConnectionWizard — animated entrance leaves content visible", () => {
  it("settles the step pane visible after the tween, not visibility:hidden", async () => {
    renderWizard();

    const pane = await screen.findByTestId("wizard-pane");

    // GSAP flips visibility early in the tween while opacity is still ramping,
    // so both must settle inside the same poll.
    await waitFor(() => {
      expect(pane.style.visibility).not.toBe("hidden");
      expect(Number(pane.style.opacity || "1")).toBe(1);
    });
  });

  it("keeps the intro copy reachable once the entrance completes", async () => {
    renderWizard();

    await screen.findByTestId("wizard-step-intro");
    const pane = screen.getByTestId("wizard-pane");

    await waitFor(() => expect(pane.style.visibility).not.toBe("hidden"));
    expect(screen.getByTestId("wizard-step-intro")).toHaveTextContent(
      /dozens of platform tools/,
    );
  });
});
