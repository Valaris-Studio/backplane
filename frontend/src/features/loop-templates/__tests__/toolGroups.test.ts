// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { groupTools, TOOL_GROUP_ORDER } from "../lib/tool-groups";

// Card eb7d83ab — Direction: tool grouping (read / write / off-switch) is ONE
// client-side map keyed on tool name, because the profile endpoint returns a
// flat `tools: string[]`. `set_board_loop` is ALWAYS "off-switch".

describe("groupTools", () => {
  it("puts set_board_loop in off-switch, never in write", () => {
    const groups = groupTools(["set_board_loop"]);

    expect(groups.offSwitch).toEqual(["set_board_loop"]);
    expect(groups.write).toEqual([]);
    expect(groups.read).toEqual([]);
  });

  it("splits read tools from write tools", () => {
    const groups = groupTools([
      "search_cards",
      "update_card",
      "get_definition",
      "create_note",
    ]);

    expect(groups.read).toEqual(["search_cards", "get_definition"]);
    expect(groups.write).toEqual(["update_card", "create_note"]);
  });

  it("preserves the order the template listed its tools in", () => {
    const groups = groupTools(["get_card", "get_note", "get_board"]);

    expect(groups.read).toEqual(["get_card", "get_note", "get_board"]);
  });

  it("treats an unknown tool as write — an unrecognised grant is never shown as harmless read", () => {
    const groups = groupTools(["frobnicate_the_widget"]);

    expect(groups.write).toEqual(["frobnicate_the_widget"]);
    expect(groups.read).toEqual([]);
  });

  it("exposes a stable render order with off-switch last", () => {
    expect(TOOL_GROUP_ORDER).toEqual(["read", "write", "offSwitch"]);
  });
});
