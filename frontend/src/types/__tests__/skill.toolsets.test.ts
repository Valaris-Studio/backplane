// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  hasToolsets,
  type BoardSkillBinding,
  type BoardSkillBindingRow,
  type Skill,
  type SkillCatalogEntry,
  type SkillDetail,
  type SkillVersionDetail,
} from "@/types/skill";

// MCP #3: a skill declares the toolset(s) it plays in. The backend derives
// `toolsets` from the resolving version's SKILL.md frontmatter and surfaces it
// on every read shape; board binding rows add `uncovered_toolsets` (declared
// toolsets the board's loop grant cannot cover) and the detail adds
// `lint_warnings` (tools the playbook names outside its declared hand).
//
// The `satisfies` assignments are the compile-level contract — `tsc -b`
// rejects an object literal with unknown keys — and `hasToolsets` is the
// runtime probe so a plain `vitest run` (which does not typecheck) goes red
// until the helper exists.

const BASE_SKILL = {
  id: "skill-1",
  slug: "release-checklist",
  name: "Release Checklist",
  description: "Steps for tagging and shipping a release",
  latest_published_version: 2,
  origin: null,
  updated_at: "2026-08-20T10:00:00Z",
  archived_at: null,
};

describe("skill types — toolset declarations (MCP #3)", () => {
  it("Skill carries toolsets", () => {
    const skill = {
      ...BASE_SKILL,
      toolsets: ["cards", "notes"],
    } satisfies Skill;
    expect(skill.toolsets).toEqual(["cards", "notes"]);
  });

  it("SkillDetail carries toolsets and lint_warnings", () => {
    const detail = {
      ...BASE_SKILL,
      toolsets: ["cards"],
      lint_warnings: ["delete_workspace"],
      versions: [
        {
          version: 2,
          status: "published",
          content_hash: "hash-rc-2",
          created_at: "2026-08-20T10:00:00Z",
        },
      ],
    } satisfies SkillDetail;
    expect(detail.lint_warnings).toEqual(["delete_workspace"]);
  });

  it("SkillVersionDetail carries that version's own toolsets", () => {
    const version = {
      version: 2,
      status: "published",
      content_hash: "hash-rc-2",
      files: [{ path: "SKILL.md", content: "---\nname: x\n---\n" }],
      toolsets: ["work-management"],
    } satisfies SkillVersionDetail;
    expect(version.toolsets).toEqual(["work-management"]);
  });

  it("SkillCatalogEntry carries toolsets", () => {
    const entry = {
      catalog_id: "commit-messages",
      catalog_version: 1,
      name: "Commit Messages",
      description: "How to write a commit message agents can act on",
      toolsets: ["cards", "notes"],
    } satisfies SkillCatalogEntry;
    expect(entry.toolsets).toContain("notes");
  });

  it("BoardSkillBinding carries toolsets and uncovered_toolsets", () => {
    const binding = {
      skill_id: "skill-1",
      slug: "release-checklist",
      name: "Release Checklist",
      description: "Steps for tagging and shipping a release",
      version: 2,
      content_hash: "hash-rc-2",
      enabled: true,
      pinned_version: null,
      role: null,
      toolsets: ["cards"],
      uncovered_toolsets: [],
    } satisfies BoardSkillBinding;
    expect(binding.uncovered_toolsets).toEqual([]);
  });

  it("BoardSkillBindingRow carries toolsets and uncovered_toolsets", () => {
    const row = {
      skill_id: "skill-1",
      slug: "release-checklist",
      name: "Release Checklist",
      enabled: true,
      pinned_version: null,
      role: null,
      resolved_version: 2,
      toolsets: ["cards"],
      uncovered_toolsets: ["cards"],
    } satisfies BoardSkillBindingRow;
    expect(row.uncovered_toolsets).toEqual(["cards"]);
  });

  it("hasToolsets is true for a declared hand and false for an empty one", () => {
    expect(hasToolsets({ ...BASE_SKILL, toolsets: ["cards"] })).toBe(true);
    expect(hasToolsets({ ...BASE_SKILL, toolsets: [] })).toBe(false);
  });

  it("hasToolsets is false for a payload that predates the field", () => {
    // An older backend omits `toolsets` entirely; the guard must not throw.
    expect(hasToolsets({})).toBe(false);
  });
});
