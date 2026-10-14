// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import type { PipelineConfig } from "../../api/pipelineConfig";
import { cloneToDraft, serializePipeline } from "../useLifecycleDraft";

describe("pipeline policy round trip", () => {
  it("preserves every top-level key while serializing an edited stage", () => {
    const remote = {
      version: 1,
      scheduling: { priority_order: ["operator_role_47"], mode: "priority" },
      stages: [{
        role: "operator_role_47",
        discover: { strategy: "column_scan", column_type: "backlog" },
        claim: { participant_role: "helper" },
        git: { action: "none" },
        llm: { enabled: false },
        lifecycle: [{ name: "finish", kind: "end", params: {} }],
      }],
      context_dispatch: { version: 1, required_agent_ids: ["00000000-0000-4000-8000-000000000047"] },
      context_budget: { version: 1, max_invocation_bytes: 262144 },
      lock_roles: true,
      operator_extension_47: { nested: ["retain", "verbatim"] },
    };
    const original = JSON.parse(JSON.stringify(remote));
    // Unknown future server-owned keys deliberately travel through today's type.
    const draft = cloneToDraft(remote as unknown as PipelineConfig);
    draft[0]!.role = "renamed_operator_role_47";
    const wire = serializePipeline(draft, remote as unknown as PipelineConfig);
    expect(wire).toEqual({
      ...original,
      stages: [{ ...original.stages[0], role: "renamed_operator_role_47" }],
    });
    expect(remote).toEqual(original);
    expect(JSON.stringify(wire)).not.toContain("_dndId");
  });

  it("keeps absent legacy policies absent", () => {
    const remote: PipelineConfig = {
      version: 1, stages: [],
      scheduling: { priority_order: [], mode: "priority" },
    };
    expect(serializePipeline(cloneToDraft(remote), remote)).toEqual(remote);
  });
});
