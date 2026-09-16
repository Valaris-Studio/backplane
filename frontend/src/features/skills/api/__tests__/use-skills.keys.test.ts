// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { skillKeys } from "@/lib/query-keys";

describe("skillKeys (lib/query-keys)", () => {
  it("exposes a stable, workspace-scoped array key", () => {
    const key = skillKeys.all("acme");
    expect(Array.isArray(key)).toBe(true);
    // Stable: two calls with the same slug are interchangeable cache keys.
    expect(skillKeys.all("acme")).toEqual(key);
    expect(key).toContain("acme");
    // Different workspaces must never share a cache entry.
    expect(skillKeys.all("other")).not.toEqual(key);
  });

  it("scopes board bindings separately from the workspace library", () => {
    const workspaceKey = skillKeys.all("acme");
    const boardKey = skillKeys.byBoard("acme", "board-1");
    expect(Array.isArray(boardKey)).toBe(true);
    expect(boardKey).toContain("board-1");
    expect(JSON.stringify(boardKey)).not.toBe(JSON.stringify(workspaceKey));
  });

  it("the hooks module exports the full skills API surface", async () => {
    const hooks = (await import("@/features/skills/api/use-skills")) as Record<
      string,
      unknown
    >;
    const expectedHooks = [
      "useSkills",
      "useSkill",
      "useSkillVersion",
      "useSkillCatalog",
      "useActivateCatalogSkill",
      "useBoardSkills",
      "useSetSkillBinding",
      "useUnbindSkill",
    ];
    for (const name of expectedHooks) {
      expect(typeof hooks[name], name + " should be an exported hook").toBe(
        "function",
      );
    }
  });
});
