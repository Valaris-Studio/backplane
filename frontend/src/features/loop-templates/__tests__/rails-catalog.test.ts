// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  applyRail,
  parseRailInput,
  hasOffSwitch,
  railValue,
  readRailsDefaults,
  readSetupContract,
  writeSetupContract,
  readTools,
} from "../lib/rails-catalog";

describe("applyRail", () => {
  it("sets a rail without touching its siblings", () => {
    const next = applyRail({ max_iterations: 25, budget_usd: 20 }, "budget_usd", 5);
    expect(next).toEqual({ max_iterations: 25, budget_usd: 5 });
  });

  it("DELETES the key when the value is undefined rather than storing undefined", () => {
    const next = applyRail({ max_iterations: 25, budget_usd: 20 }, "budget_usd", undefined);
    // `toEqual` treats a present-but-undefined key as absent, and JSON drops
    // it on the wire — so the only assertion that can tell the two apart is
    // an own-property check.
    expect(Object.prototype.hasOwnProperty.call(next, "budget_usd")).toBe(false);
    expect(Object.keys(next)).toEqual(["max_iterations"]);
  });

  it("does not mutate the input map", () => {
    const before = { max_iterations: 25 };
    applyRail(before, "max_iterations", 99);
    expect(before.max_iterations).toBe(25);
  });

  it("keeps an explicit 0, which is a real value and not an unset", () => {
    const next = applyRail({}, "max_blocked_on_human", 0);
    expect(Object.prototype.hasOwnProperty.call(next, "max_blocked_on_human")).toBe(true);
    expect(next.max_blocked_on_human).toBe(0);
  });
});

describe("parseRailInput", () => {
  it("parses an integer rail as an integer", () => {
    expect(parseRailInput("max_iterations", "40")).toBe(40);
    // A fractional iteration count is meaningless — truncate, never store 40.5.
    expect(parseRailInput("max_iterations", "40.9")).toBe(40);
  });

  it("parses budget_usd as a decimal", () => {
    expect(parseRailInput("budget_usd", "12.50")).toBe(12.5);
  });

  it("returns undefined for blank, whitespace and unparseable input", () => {
    expect(parseRailInput("max_iterations", "")).toBeUndefined();
    expect(parseRailInput("max_iterations", "   ")).toBeUndefined();
    expect(parseRailInput("max_iterations", "abc")).toBeUndefined();
  });

  it("returns 0 for an explicit zero rather than treating it as unset", () => {
    expect(parseRailInput("max_blocked_on_human", "0")).toBe(0);
  });
});

describe("hasOffSwitch", () => {
  it("accepts the bare MCP name", () => {
    expect(hasOffSwitch(["search_cards", "set_board_loop"])).toBe(true);
  });

  it("accepts the mcp__valaris__ prefixed id", () => {
    expect(hasOffSwitch(["mcp__valaris__set_board_loop"])).toBe(true);
  });

  it("is false when neither spelling is granted", () => {
    expect(hasOffSwitch(["search_cards", "update_card"])).toBe(false);
    expect(hasOffSwitch([])).toBe(false);
  });

  it("does not match a merely similar tool name", () => {
    expect(hasOffSwitch(["get_board_loop", "set_board_loop_extra"])).toBe(false);
  });
});

describe("railValue", () => {
  it("renders an absent rail as the empty string", () => {
    expect(railValue({}, "max_iterations")).toBe("");
    expect(railValue({ max_iterations: null }, "max_iterations")).toBe("");
  });

  it("renders an explicit 0 as \"0\", not as absent", () => {
    expect(railValue({ max_blocked_on_human: 0 }, "max_blocked_on_human")).toBe("0");
  });
});

describe("readRailsDefaults / readTools", () => {
  it("tolerates a missing or malformed bag", () => {
    expect(readRailsDefaults(undefined)).toEqual({});
    expect(readRailsDefaults({ rails_defaults: "nope" })).toEqual({});
    expect(readRailsDefaults({ rails_defaults: [1, 2] })).toEqual({});
  });

  it("drops non-string entries from the tool grant", () => {
    expect(readTools({ tools: ["a", 3, null, "b"] })).toEqual(["a", "b"]);
    expect(readTools({ tools: "nope" })).toEqual([]);
  });
});

describe("setup contract round-trip", () => {
  it("preserves keys this UI does not model", () => {
    const contract = readSetupContract({
      setup_contract: {
        required_column_types: ["backlog"],
        future_backend_key: { nested: true },
      },
    });
    expect(contract.extra).toEqual({ future_backend_key: { nested: true } });

    const wire = writeSetupContract(contract);
    expect(wire.future_backend_key).toEqual({ nested: true });
    expect(wire.required_column_types).toEqual(["backlog"]);
    // `extra` is a client-side bucket and must never reach the wire as a key.
    expect(wire).not.toHaveProperty("extra");
  });

  it("coerces absent booleans to false rather than undefined", () => {
    const contract = readSetupContract({ setup_contract: {} });
    expect(contract.requires_run_label).toBe(false);
    expect(contract.git_repo_bound).toBe(false);
    expect(contract.required_column_types).toEqual([]);
  });

  it("treats a non-boolean truthy value as false", () => {
    const contract = readSetupContract({
      setup_contract: { requires_run_label: "yes" },
    });
    expect(contract.requires_run_label).toBe(false);
  });

  it("drops non-string entries from the chip lists", () => {
    const contract = readSetupContract({
      setup_contract: { definition_keys: ["ok", 5, null] },
    });
    expect(contract.definition_keys).toEqual(["ok"]);
  });
});
