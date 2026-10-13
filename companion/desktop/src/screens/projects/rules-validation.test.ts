// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { MAX_RULE_LENGTH, MAX_RULES, validateNewRule } from "./rules-validation";

describe("validateNewRule", () => {
  it("accepts a trimmed pattern", () => {
    expect(validateNewRule("  ~/clients/**  ", [])).toEqual({ ok: true, rule: "~/clients/**" });
  });

  it("rejects an empty or blank pattern", () => {
    expect(validateNewRule("", [])).toEqual({ ok: false, message: "Type a folder pattern, like ~/clients/**." });
    expect(validateNewRule(" \t ", [])).toMatchObject({ ok: false });
  });

  it("rejects a line break anywhere, including a carriage return", () => {
    expect(validateNewRule("~/a/**\n~/b/**", [])).toEqual({ ok: false, message: "Keep the pattern on one line." });
    expect(validateNewRule("~/a/**\r", [])).toMatchObject({ ok: false, message: "Keep the pattern on one line." });
  });

  it("accepts exactly the length limit and rejects one more", () => {
    expect(validateNewRule("a".repeat(MAX_RULE_LENGTH), [])).toMatchObject({ ok: true });
    expect(validateNewRule("a".repeat(MAX_RULE_LENGTH + 1), [])).toEqual({ ok: false, message: "Keep the pattern to 256 characters or fewer." });
  });

  it("rejects a rule already in the list", () => {
    expect(validateNewRule("~/x/**", ["~/x/**"])).toEqual({ ok: false, message: "That rule is already in the list." });
  });

  it("stops at the rule limit", () => {
    const full = Array.from({ length: MAX_RULES }, (_, index) => `~/r${index}`);
    expect(validateNewRule("~/new", full)).toEqual({ ok: false, message: "You can have up to 50 rules. Remove one first." });
    expect(validateNewRule("~/new", full.slice(1))).toMatchObject({ ok: true });
  });
});
