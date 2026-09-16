// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import {
  TREE_NODE_KINDS,
  stepAccentFor,
  treeNodeAccentFor,
  type TreeNodeKind,
} from "../treeTaxonomy";
import type { LifecycleKindName } from "../../../api/pipelineConfig";

// Mirrors the FALLBACK_KINDS drift guard in LifecycleBuilder.test.tsx: the
// expected list is re-declared with `satisfies` so tsc flags a value-side
// typo, the AssertExhaustive line flags a new union member missing here, and
// vitest asserts the runtime mapping actually covers every kind.
const EXPECTED_KINDS = [
  "discover",
  "claim",
  "git_setup",
  "skills_setup",
  "llm",
  "sensor",
  "move_card",
  "apply_label",
  "remove_label",
  "create_note",
  "enqueue_for_merge",
  "mcp_call",
  "create_fix_cards",
  "branch",
  "wake_role",
  "create_pr",
  "enable_auto_merge",
  "merge_pr",
  "post_pr_review",
  "ship",
  "end",
] as const satisfies readonly LifecycleKindName[];

type _AssertExhaustive = Exclude<
  LifecycleKindName,
  (typeof EXPECTED_KINDS)[number]
> extends never
  ? true
  : never;
const _assertExhaustive: _AssertExhaustive = true;
void _assertExhaustive;

describe("treeTaxonomy", () => {
  it("maps every LifecycleKindName to a defined step accent — guards against union drift", () => {
    for (const kind of EXPECTED_KINDS) {
      const accent = stepAccentFor(kind);
      expect(accent, `no accent for kind "${kind}"`).toBeDefined();
      expect(accent.className.length).toBeGreaterThan(0);
    }
  });

  it("maps every tree node kind to a defined accent", () => {
    const kinds: TreeNodeKind[] = [...TREE_NODE_KINDS];
    expect(kinds).toEqual([
      "config",
      "scheduling",
      "role",
      "step",
      "propertyGroup",
    ]);
    for (const kind of kinds) {
      const accent = treeNodeAccentFor(kind);
      expect(accent, `no accent for node kind "${kind}"`).toBeDefined();
      expect(accent.className.length).toBeGreaterThan(0);
    }
  });

  it("expresses colour as semantic tokens, never raw hex — dark mode is by construction", () => {
    const all = [
      ...TREE_NODE_KINDS.map(treeNodeAccentFor),
      ...EXPECTED_KINDS.map(stepAccentFor),
    ];
    for (const accent of all) {
      expect(accent.className).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });

  it("falls back to the neutral step accent for an unknown kind rather than throwing", () => {
    const accent = stepAccentFor("not_a_real_kind" as LifecycleKindName);
    expect(accent).toEqual(treeNodeAccentFor("step"));
  });

  it("every accent labelKey resolves in BOTH shipped locales", () => {
    const keys = new Set(
      [
        ...TREE_NODE_KINDS.map(treeNodeAccentFor),
        ...EXPECTED_KINDS.map(stepAccentFor),
      ].map((a) => a.labelKey),
    );

    const resolve = (catalog: Record<string, unknown>, dotted: string) =>
      dotted
        .split(".")
        .reduce<unknown>(
          (node, part) =>
            node && typeof node === "object"
              ? (node as Record<string, unknown>)[part]
              : undefined,
          catalog,
        );

    for (const key of keys) {
      for (const [name, catalog] of [
        ["en", en],
        ["es", es],
      ] as const) {
        const value = resolve(catalog as Record<string, unknown>, key);
        expect(typeof value, `${name} missing "${key}"`).toBe("string");
        expect((value as string).length).toBeGreaterThan(0);
      }
    }
  });
});
