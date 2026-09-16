// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { formatScope, formatScopeList } from "../format-scope";

describe("formatScope", () => {
  it("maps known github scopes to human labels", () => {
    expect(formatScope("repo")).toBe("Repositories");
    expect(formatScope("workflow")).toBe("Workflow actions");
    expect(formatScope("user")).toBe("User profile");
  });

  it("strips read:/write:/admin: qualifiers before lookup", () => {
    expect(formatScope("read:org")).toBe("Organizations");
    expect(formatScope("write:org")).toBe("Organizations");
    expect(formatScope("admin:org")).toBe("Organizations");
  });

  it("title-cases unknown scopes instead of dropping them", () => {
    expect(formatScope("custom_scope")).toBe("Custom Scope");
    expect(formatScope("read:custom-thing")).toBe("Custom Thing");
  });

  it("returns empty string for empty input", () => {
    expect(formatScope("")).toBe("");
    expect(formatScope("   ")).toBe("");
  });
});

describe("formatScopeList", () => {
  it("joins labels with a + separator", () => {
    expect(formatScopeList(["repo", "workflow"])).toBe(
      "Repositories + Workflow actions",
    );
  });

  it("dedupes labels that collapse to the same human form", () => {
    // both qualifiers map to "Organizations"; only one should appear
    expect(formatScopeList(["read:org", "admin:org"])).toBe("Organizations");
  });

  it("returns an empty string for an empty list", () => {
    expect(formatScopeList([])).toBe("");
  });

  it("filters out blank entries before joining", () => {
    expect(formatScopeList(["", "repo", "  "])).toBe("Repositories");
  });
});
