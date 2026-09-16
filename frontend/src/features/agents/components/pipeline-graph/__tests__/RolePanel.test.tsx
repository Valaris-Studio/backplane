// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen } from "@/test/test-utils";
import { RolePanel } from "../RolePanel";
import type { StageConfig } from "@/features/agents/api/pipelineConfig";

// RolePanel folds the former Roles glossary + Prompts editor into the graph's
// role drill-in. Mock the prompt hooks so RolePromptsPanel renders without a
// backend; assert the capability summary (derived from the lifecycle) and the
// tab switch to Prompts.
vi.mock("@/features/agents/hooks/usePromptConfigs", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    usePromptDefaults: () => ({
      data: [
        {
          slug: "reviewer-review_diff",
          role: "reviewer",
          stage: "review_diff",
          description: "Review the diff",
          template_variables: [],
          default_content: "Review this.",
        },
      ],
      isLoading: false,
    }),
    usePromptConfigs: () => ({ data: [], isLoading: false }),
    useCreatePromptConfig: () => ({ mutate: () => {}, isPending: false }),
    useUpdatePromptConfig: () => ({ mutate: () => {}, isPending: false }),
    useDeletePromptConfig: () => ({ mutate: () => {}, isPending: false }),
  };
});
vi.mock("@/features/agents/hooks/usePipelineConfig", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    usePipelineConfig: () => ({ roles: ["reviewer"], roleColorMap: {}, pipelineConfig: null }),
  };
});

const reviewerStage: StageConfig = {
  role: "reviewer",
  discover: { strategy: "column_scan", column_type: "review", filters: {} } as StageConfig["discover"],
  claim: {} as StageConfig["claim"],
  git: {} as StageConfig["git"],
  llm: {} as StageConfig["llm"],
  sensors: [],
  lifecycle: [
    { name: "review", kind: "llm", params: { stage: "review_diff", post_process_kind: "produces_decision" } },
    { name: "merge", kind: "merge_pr", params: { strategy: "squash" } },
    { name: "ship", kind: "ship", params: { to_column_type: "done" } },
  ],
};

describe("RolePanel", () => {
  it("shows derived capabilities on the overview tab", () => {
    renderWithProviders(<RolePanel slug="acme" stage={reviewerStage} />, {
      routerProps: { initialEntries: ["/acme/runner/pipeline"] },
    });
    expect(screen.getByText(/produces decisions/i)).toBeInTheDocument();
    expect(screen.getByText(/merges prs/i)).toBeInTheDocument();
    // Handoff fact: ships to the done column.
    expect(screen.getByText(/done/i)).toBeInTheDocument();
  });

  it("switches to the Prompts tab and renders the role's prompt stages", () => {
    renderWithProviders(<RolePanel slug="acme" stage={reviewerStage} />, {
      routerProps: { initialEntries: ["/acme/runner/pipeline"] },
    });
    fireEvent.click(screen.getByRole("button", { name: /^prompts$/i }));
    expect(screen.getByText("review_diff")).toBeInTheDocument();
  });
});
