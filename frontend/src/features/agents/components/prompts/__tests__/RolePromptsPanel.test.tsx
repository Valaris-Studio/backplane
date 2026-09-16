// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, describe, expect, it, vi, beforeEach } from "vitest";
import { Routes, Route } from "react-router-dom";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import i18n from "@/i18n/config";
import { RolePromptsPanel } from "../RolePromptsPanel";
import type { PromptStageDefault, PromptConfig } from "../../../api/prompts";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const hookMocks = vi.hoisted(() => ({
  defaults: { data: [] as PromptStageDefault[], isLoading: false },
  configs: { data: [] as PromptConfig[], isLoading: false },
}));

vi.mock("../../../hooks/usePromptConfigs", () => {
  const noopMutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    usePromptDefaults: () => hookMocks.defaults,
    usePromptConfigs: () => hookMocks.configs,
    useCreatePromptConfig: noopMutation,
    useUpdatePromptConfig: noopMutation,
    useDeletePromptConfig: noopMutation,
  };
});

vi.mock("../../../hooks/usePipelineConfig", () => ({
  usePipelineConfig: () => ({
    pipelineConfig: {
      version: 1,
      stages: [
        {
          role: "reviewer",
          llm: { enabled: true, stage: "review", context_sources: [] },
          lifecycle: [],
        },
      ],
    },
  }),
}));

function stageDefault(
  over: Partial<PromptStageDefault> & Pick<PromptStageDefault, "slug" | "role" | "stage">,
): PromptStageDefault {
  return {
    description: "",
    template_variables: [],
    default_content: "default content",
    ...over,
  };
}

function renderPanel(role = "reviewer") {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/runner/pipeline"
        element={<RolePromptsPanel slug="test-ws" role={role} />}
      />
    </Routes>,
    { routerProps: { initialEntries: ["/test-ws/runner/pipeline"] } },
  );
}

describe("RolePromptsPanel", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    hookMocks.defaults = { data: [], isLoading: false };
    hookMocks.configs = { data: [], isLoading: false };
  });

  afterAll(async () => {
    await i18n.changeLanguage("en");
  });

  it("renders the stage card(s) for the given role", () => {
    hookMocks.defaults = {
      data: [
        stageDefault({ slug: "reviewer-review", role: "reviewer", stage: "review" }),
      ],
      isLoading: false,
    };
    renderPanel();

    expect(screen.getByText("review")).toBeInTheDocument();
    // Wiring badge proves it ran the same wiring logic as the page.
    expect(
      screen.getByTestId("prompt-wired-reviewer-review"),
    ).toBeInTheDocument();
  });

  it("does not render the role-filter tabs or Create New Stage button (page-level)", () => {
    hookMocks.defaults = {
      data: [
        stageDefault({ slug: "reviewer-review", role: "reviewer", stage: "review" }),
      ],
      isLoading: false,
    };
    renderPanel();

    expect(
      screen.queryByRole("button", { name: /Create New Stage/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^All$/i }),
    ).not.toBeInTheDocument();
  });

  it("shows an empty state when the role has no prompt stages", () => {
    hookMocks.defaults = { data: [], isLoading: false };
    renderPanel();

    expect(screen.getByTestId("role-prompts-empty")).toBeInTheDocument();
  });

  it("renders a loading skeleton while defaults are loading", () => {
    hookMocks.defaults = { data: undefined as unknown as PromptStageDefault[], isLoading: true };
    renderPanel();

    expect(screen.getByTestId("role-prompts-loading")).toBeInTheDocument();
  });

  it("localizes a built-in description by stable prompt slug", async () => {
    await i18n.changeLanguage("pt-BR");
    const descriptionKey = "prompts.catalog.review.description";
    const localizedDescription = i18n.t(descriptionKey);
    expect(localizedDescription).not.toBe(descriptionKey);
    hookMocks.defaults = {
      data: [
        stageDefault({
          slug: "review",
          role: "reviewer",
          stage: "review",
          description: "SERVER ENGLISH DESCRIPTION",
          default_content: "UNCHANGED DEFAULT PROMPT BODY",
        }),
      ],
      isLoading: false,
    };

    renderPanel();

    expect(screen.getByText(localizedDescription)).toBeInTheDocument();
    expect(
      screen.queryByText("SERVER ENGLISH DESCRIPTION"),
    ).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByText("review").closest("button")!);
    expect(
      screen.getByText("UNCHANGED DEFAULT PROMPT BODY"),
    ).toBeInTheDocument();
  });

  it("preserves the server description for an unknown custom slug", () => {
    hookMocks.defaults = {
      data: [
        stageDefault({
          slug: "custom-role-custom-stage",
          role: "custom_role",
          stage: "custom_stage",
          description: "Operator-authored custom stage",
        }),
      ],
      isLoading: false,
    };

    renderPanel("custom_role");

    expect(
      screen.getByText("Operator-authored custom stage"),
    ).toBeInTheDocument();
  });
});
