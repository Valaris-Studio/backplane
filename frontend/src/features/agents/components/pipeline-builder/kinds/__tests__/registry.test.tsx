// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/test-utils";
import { KIND_EDITORS, KindEditor } from "../registry";
import type { LifecycleKindName, LifecycleStep } from "../../../../api/pipelineConfig";

// Exhaustive list — must mirror `LifecycleKindName` in pipelineConfig.ts and
// `LIFECYCLE_KINDS` in backend/app/services/agents/lifecycle_kinds.py. The
// `satisfies` check below pins the union; the equality assertion below pins
// the registry. Together they enforce the closed-set invariant: no kind can
// exist without an editor.
const ALL_KINDS = [
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

describe("KIND_EDITORS registry", () => {
  it("covers every LifecycleKindName with no extras", () => {
    expect(Object.keys(KIND_EDITORS).sort()).toEqual([...ALL_KINDS].sort());
  });

  it("has an editor for every LifecycleKindName", () => {
    for (const kind of ALL_KINDS) {
      expect(KIND_EDITORS[kind], `missing editor for ${kind}`).toBeDefined();
    }
  });

  it("dispatches to the correct editor for each kind without throwing", () => {
    for (const kind of ALL_KINDS) {
      const step = {
        name: `step_${kind}`,
        kind,
        params: {},
      } as LifecycleStep;
      const { unmount } = renderWithProviders(
        <KindEditor step={step} onChange={vi.fn()} />,
      );
      unmount();
    }
  });
});
