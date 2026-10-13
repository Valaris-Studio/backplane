// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  isValidWorkspaceSlug,
  toWorkspaceSlug,
  WORKSPACE_SLUG_MAX_LENGTH,
} from "../workspace-slug";

describe("toWorkspaceSlug", () => {
  it.each([
    ["My Workspace", "my-workspace"],
    ["  --Acme__Corp!!  ", "acme-corp"],
    ["Café Ñandú", "caf-and"],
    ["Team 42", "team-42"],
    ["line\nbreak \"quoted\"", "line-break-quoted"],
  ])("derives a valid slug from %j", (name, expected) => {
    const slug = toWorkspaceSlug(name);
    expect(slug).toBe(expected);
    expect(isValidWorkspaceSlug(slug)).toBe(true);
  });

  it("returns an empty slug when the name has no ASCII alphanumerics", () => {
    expect(toWorkspaceSlug("日本語")).toBe("");
    expect(toWorkspaceSlug("!!!")).toBe("");
  });

  it("caps long names at the max length without leaving a trailing hyphen", () => {
    const name = `${"a".repeat(WORKSPACE_SLUG_MAX_LENGTH - 1)} b`;
    const slug = toWorkspaceSlug(name);
    expect(slug.length).toBeLessThanOrEqual(WORKSPACE_SLUG_MAX_LENGTH);
    expect(isValidWorkspaceSlug(slug)).toBe(true);
  });
});

describe("isValidWorkspaceSlug", () => {
  it.each(["acme", "acme-corp", "a1-b2-c3", "2026", "a".repeat(255)])(
    "accepts %j",
    (slug) => {
      expect(isValidWorkspaceSlug(slug)).toBe(true);
    },
  );

  it.each([
    "evil\nslug",
    'quo"te',
    "has space",
    "UpperCase",
    "-leading",
    "trailing-",
    "double--hyphen",
    "under_score",
    "",
    "a".repeat(256),
  ])("rejects %j", (slug) => {
    expect(isValidWorkspaceSlug(slug)).toBe(false);
  });
});
