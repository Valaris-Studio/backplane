// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse, server } from "@/test/msw-server";
import { createTestQueryClient } from "@/test/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { usePipelineConfig } from "../usePipelineConfig";
import type { PipelineConfig, WorkspaceConfig } from "../../api/pipelineConfig";

const SLUG = "test-workspace";
const BASE = `/api/workspaces/${SLUG}`;

function createWrapper() {
  const queryClient = createTestQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

function makePipeline(roles: string[]): PipelineConfig {
  return {
    version: 1,
    stages: roles.map((role) => ({
      role,
      discover: {
        strategy: "column_scan",
        column_type: "todo",
        column_type_exclude: "",
        filters: {},
      },
      claim: { participant_role: role, execution_action: "claim" },
      git: {
        action: "none",
        branch_prefix: "",
        create_pr: false,
        force_push_on_rework: false,
      },
      llm: {
        enabled: true,
        stage: "implement",
        tools: [],
        inject_directives: false,
        approval_enabled: false,
      },
      sensors: [],
      on_success: {},
      on_failure: {},
    })),
    scheduling: {
      priority_order: roles,
      mode: "priority",
    },
  };
}

function makeWorkspaceConfig(roles: string[]): WorkspaceConfig {
  return {
    max_rework_attempts: 3,
    card_cooldown_hours: 1,
    commit_message_template: "",
    pr_description_template: "",
    enforce_done_merge_gate: true,
    pipeline_config: makePipeline(roles),
    version: 1,
  };
}

describe("usePipelineConfig", () => {
  it("exposes roleHexColorMap mapping each role to a hex color", async () => {
    const roles = ["orchestrator", "reviewer", "documentator"];
    server.use(
      http.get(`${BASE}/config`, () =>
        HttpResponse.json(makeWorkspaceConfig(roles)),
      ),
    );

    const { result } = renderHook(() => usePipelineConfig(SLUG), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const hexMap = result.current.roleHexColorMap;
    expect(Object.keys(hexMap)).toHaveLength(3);
    for (const role of roles) {
      expect(hexMap[role]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("cycles colors when roles exceed palette length", async () => {
    // Palette has 7 entries; 8 roles must wrap: index 0 and index 7 share a color.
    const roles = ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7"];
    server.use(
      http.get(`${BASE}/config`, () =>
        HttpResponse.json(makeWorkspaceConfig(roles)),
      ),
    );

    const { result } = renderHook(() => usePipelineConfig(SLUG), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const hexMap = result.current.roleHexColorMap;
    expect(hexMap.r0).toBeDefined();
    expect(hexMap.r7).toBe(hexMap.r0);
  });
});
