// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import i18n from "@/i18n/config";
import { statusLabel } from "../status-label";

const t = i18n.t.bind(i18n) as typeof i18n.t;

describe("statusLabel", () => {
  it.each([
    ["todo", "To Do"],
    ["in_progress", "In Progress"],
    ["in_review", "In Review"],
    ["done", "Done"],
    ["blocked", "Blocked"],
  ])("translates the catalogued enum status %s", (status, expected) => {
    expect(statusLabel(t, status)).toBe(expected);
  });

  it.each([
    "r14 forbid known-good",
    "shipped 0.2.0 all channels",
    "closed 2026-08-14: merged 257a8511",
    "shipped-pending-validation",
  ])("returns the free-form status %s verbatim", (status) => {
    expect(statusLabel(t, status)).toBe(status);
  });

  it("never leaks the key prefix for an uncatalogued value", () => {
    expect(statusLabel(t, "anything at all")).not.toContain("cards.statuses.");
  });
});
