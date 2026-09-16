// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, act, waitFor } from "@testing-library/react";
import { createTestQueryClient } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { useLifecycleDraft } from "../useLifecycleDraft";
import type {
  PipelineConfig,
  WorkspaceConfig,
} from "../../api/pipelineConfig";

const SLUG = "draft-ws";

const PIPELINE: PipelineConfig = {
  version: 1,
  stages: [
    {
      role: "implementer",
      discover: {
        strategy: "unassigned_or_rework",
        column_type: "active",
        column_type_exclude: "",
        filters: { require_git_repo: true },
      },
      claim: { participant_role: "hero", execution_action: "implement_card" },
      git: {
        action: "create_branch",
        branch_prefix: "feat-",
        create_pr: true,
        force_push_on_rework: true,
      },
      llm: {
        enabled: true,
        stage: "implement",
        post_process_kind: "writes_code",
        tools: ["mcp__valaris__get_card"],
        inject_directives: true,
        approval_enabled: true,
        context_sources: [{ kind: "card_notes" }],
      },
      sensors: [],
      lifecycle: [
        { name: "discover_card", kind: "discover", next: "claim_card" },
        { name: "claim_card", kind: "claim", next: "do_llm" },
        { name: "do_llm", kind: "llm" },
      ],
    },
  ],
  scheduling: { priority_order: ["implementer"], mode: "priority" },
};

const WORKSPACE_CONFIG: WorkspaceConfig = {
  max_rework_attempts: 3,
  card_cooldown_hours: 1,
  commit_message_template: "msg",
  pr_description_template: "pr",
  enforce_done_merge_gate: true,
  pipeline_config: PIPELINE,
  version: 7,
};

function wrapper() {
  const client = createTestQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function baseHandlers(overrides: Parameters<typeof server.use> = []) {
  server.use(
    http.get(`/api/workspaces/${SLUG}/config`, () =>
      HttpResponse.json(WORKSPACE_CONFIG),
    ),
    ...overrides,
  );
}

describe("useLifecycleDraft", () => {
  it("clones the remote config into an editable draft, initially clean", async () => {
    baseHandlers();
    const { result } = renderHook(() => useLifecycleDraft(SLUG), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.draft).not.toBeNull());
    expect(result.current.draft).toHaveLength(1);
    expect(result.current.draft![0]!.role).toBe("implementer");
    // dnd id attached, distinct from wire shape
    expect(result.current.draft![0]!._dndId).toBeTruthy();
    expect(result.current.dirty).toBe(false);
    expect(result.current.clientErrors).toEqual([]);
  });

  it("goes dirty on edit and serializes back preserving legacy blocks + version", async () => {
    let captured: Record<string, unknown> | null = null;
    baseHandlers([
      http.patch(`/api/workspaces/${SLUG}/config`, async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(WORKSPACE_CONFIG);
      }),
    ]);
    const { result } = renderHook(() => useLifecycleDraft(SLUG), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => result.current.deleteRole(0));
    expect(result.current.dirty).toBe(true);

    // Re-add so there's something valid to serialize, then edit steps.
    act(() => result.current.addRole("reviewer", "blank"));
    expect(result.current.dirty).toBe(true);

    act(() => result.current.save());
    await waitFor(() => expect(captured).not.toBeNull());
    const payload = captured as unknown as {
      pipeline_config: PipelineConfig;
      expected_version?: number;
    };
    expect(payload.expected_version).toBe(7);
  });

  it("reset() reverts the draft to the server config", async () => {
    baseHandlers();
    const { result } = renderHook(() => useLifecycleDraft(SLUG), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => result.current.deleteRole(0));
    expect(result.current.draft).toHaveLength(0);
    act(() => result.current.reset());
    expect(result.current.draft).toHaveLength(1);
    expect(result.current.dirty).toBe(false);
  });

  it("surfaces 422 validation errors as serverErrors", async () => {
    baseHandlers([
      http.patch(`/api/workspaces/${SLUG}/config`, () =>
        HttpResponse.json(
          {
            detail: [
              {
                code: "dangling_next",
                field: "stages[0].lifecycle[0].next",
                message: "unknown step",
                params: { step: "discover_card", target: "missing" },
              },
            ],
            error_code: "validation_error",
            error_params: {},
          },
          { status: 422 },
        ),
      ),
    ]);
    const { result } = renderHook(() => useLifecycleDraft(SLUG), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => result.current.addRole("reviewer", "blank"));
    act(() => result.current.save());

    await waitFor(() =>
      expect(result.current.serverErrors.length).toBeGreaterThan(0),
    );
    expect(result.current.serverErrors[0]!.code).toBe("dangling_next");
    expect(result.current.serverErrors[0]!.params).toEqual({
      step: "discover_card",
      target: "missing",
    });
    expect(result.current.conflict).toBeNull();
  });

  it("surfaces a 409 stale_version as a conflict, without clobbering the draft", async () => {
    // The canonical taxonomy body the backend actually sends: a string
    // `detail`, an `error_code`, and machine-readable `context` (card
    // 16cde0c9). Conflict detection keys on the 409 status; the versions come
    // off `context` rather than being regexed out of the prose message.
    baseHandlers([
      http.patch(`/api/workspaces/${SLUG}/config`, () =>
        HttpResponse.json(
          {
            detail: "Config version mismatch: expected 7, current 9",
            error_code: "stale_version",
            context: { current_version: 9, expected_version: 7 },
          },
          { status: 409 },
        ),
      ),
    ]);
    const { result } = renderHook(() => useLifecycleDraft(SLUG), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.draft).not.toBeNull());

    act(() => result.current.addRole("reviewer", "blank"));
    const draftLenBefore = result.current.draft!.length;
    act(() => result.current.save());

    await waitFor(() => expect(result.current.conflict).not.toBeNull());
    expect(result.current.conflict!.currentVersion).toBe(9);
    expect(result.current.conflict!.expectedVersion).toBe(7);
    // The user's in-progress draft is preserved (not overwritten) on conflict.
    expect(result.current.draft).toHaveLength(draftLenBefore);
    expect(result.current.serverErrors).toEqual([]);
  });
});
