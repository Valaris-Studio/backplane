// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import i18n from "@/i18n/config";
import { priorityLabel } from "../priority-label";

const t = i18n.t.bind(i18n) as typeof i18n.t;

describe("priorityLabel", () => {
  it.each([
    ["none", "None"],
    ["low", "Low"],
    ["medium", "Medium"],
    ["high", "High"],
    ["urgent", "Urgent"],
  ])("translates the catalogued priority %s", (priority, expected) => {
    expect(priorityLabel(t, priority)).toBe(expected);
  });

  it("never leaks the key prefix for an uncatalogued value", () => {
    expect(priorityLabel(t, "whatever")).not.toContain("cards.priorities.");
  });

  it("humanizes an uncatalogued value rather than showing a placeholder", () => {
    expect(priorityLabel(t, "very_high")).toBe("very high");
  });
});
