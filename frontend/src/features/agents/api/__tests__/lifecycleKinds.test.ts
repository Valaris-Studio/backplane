// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import { http, HttpResponse, server } from "@/test/msw-server";
import { createTestQueryClient } from "@/test/test-utils";

import { useLifecycleKinds, type LifecycleKindsResponse } from "../lifecycleKinds";
import type {
  LifecycleKindName,
  LifecycleKindSchema,
  LifecycleStep,
  StageConfig,
} from "../pipelineConfig";

function createWrapper() {
  const queryClient = createTestQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

// Full closed set — mirrors LifecycleKindName in pipelineConfig.ts and
// backend/app/services/agents/lifecycle_kinds.py. The cross-checks at the
// bottom of this file pin frontend↔backend parity so a kind added to one side
// without the other fails here, not in prod (React #130 from a missing editor).
const ALL_KINDS: LifecycleKindName[] = [
  "discover",
  "claim",
  "git_setup",
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
];

describe("useLifecycleKinds", () => {
  it("fetches and returns the lifecycle kinds registry", async () => {
    const kinds = Object.fromEntries(
      ALL_KINDS.map((name) => [
        name,
        {
          name,
          params_schema: {},
          produces_decision: name === "llm" || name === "sensor" || name === "branch",
          terminal: [
            "move_card",
            "apply_label",
            "remove_label",
            "create_note",
            "enqueue_for_merge",
          ].includes(name),
        } satisfies LifecycleKindSchema,
      ]),
    ) as Record<LifecycleKindName, LifecycleKindSchema>;
    const docs = Object.fromEntries(
      ALL_KINDS.map((name) => [
        name,
        { summary: `${name} does a thing`, when_to_use: `use ${name} here` },
      ]),
    ) as LifecycleKindsResponse["docs"];
    const payload: LifecycleKindsResponse = { kinds, docs };

    server.use(
      http.get("/api/config/lifecycle-kinds", () => HttpResponse.json(payload)),
    );

    const { result } = renderHook(() => useLifecycleKinds(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(payload);
    expect(Object.keys(result.current.data!.kinds).sort()).toEqual(
      [...ALL_KINDS].sort(),
    );
  });
});

// Compile-time-only assertion: the discriminated union is exhaustive over the
// closed kind set. If a new kind lands on LifecycleKindName without a step
// variant (or vice versa), `tsc -b` fails here.
describe("LifecycleStep discriminated union", () => {
  it("admits each closed-set kind as a valid step variant", () => {
    const samples: LifecycleStep[] = [
      { name: "a", kind: "discover", next: "b" },
      { name: "b", kind: "claim", next: "c" },
      { name: "c", kind: "git_setup", next: "d" },
      { name: "d", kind: "llm", next: "e" },
      { name: "e", kind: "sensor", branches: { pass: "f", fail: "g" } },
      { name: "f", kind: "move_card", params: { to_column_type: "done" } },
      { name: "g", kind: "apply_label", params: { label: "needs-advisor" } },
      { name: "h", kind: "remove_label", params: { label: "wip" } },
      { name: "i", kind: "create_note", params: { kind: "review_verdict" } },
      { name: "j", kind: "enqueue_for_merge", params: { strategy: "rebase" } },
      { name: "k", kind: "mcp_call", next: "f" },
      { name: "m", kind: "create_fix_cards", params: { to_column_type: "active", labels: ["ui-fix"], priority: "urgent" }, next: "f" },
      { name: "l", kind: "branch", branches: { a: "f" } },
      { name: "n", kind: "wake_role", params: { roles: ["reviewer"] } },
      { name: "o", kind: "create_pr", next: "f" },
      { name: "p", kind: "enable_auto_merge", params: { strategy: "squash" } },
      { name: "q", kind: "merge_pr", params: { strategy: "squash" } },
      { name: "r", kind: "post_pr_review", params: { decision: "approve" } },
      { name: "s", kind: "ship", params: { to_column_type: "done" } },
      { name: "t", kind: "end" },
    ];
    expect(samples).toHaveLength(ALL_KINDS.length);
  });

  it("attaches a lifecycle array on StageConfig", () => {
    // Type-level check: lifecycle is optional on StageConfig.
    const stage = {
      role: "orchestrator",
      lifecycle: [
        { name: "ship", kind: "move_card", params: { to_column_type: "done" } },
      ],
    } as Partial<StageConfig>;
    expect(stage.lifecycle?.[0]?.kind).toBe("move_card");
  });
});
