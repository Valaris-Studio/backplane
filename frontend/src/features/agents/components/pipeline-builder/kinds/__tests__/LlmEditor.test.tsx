// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { LlmEditor } from "../LlmEditor";

describe("LlmEditor", () => {
  it("renders stage, provider, model and toggles", () => {
    renderWithProviders(
      <LlmEditor
        params={{
          stage: "implement",
          provider: "claude-cli",
          model: "claude-opus-4",
          tools: [],
          post_process_kind: "writes_code",
          inject_directives: true,
          approval_enabled: false,
          use_minimal_prompt_when_unauthored: false,
        }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/^stage$/i)).toHaveValue("implement");
    // Provider is now a Select; its trigger surfaces the localized label.
    expect(screen.getByTestId("llm-provider-trigger")).toHaveTextContent(
      /claude-cli/i,
    );
    // Model is now a tier Select; an unknown persisted value (a concrete
    // model id) surfaces verbatim in the trigger so it isn't lost.
    expect(screen.getByTestId("llm-model-trigger")).toHaveTextContent(
      /claude-opus-4/,
    );
    expect(screen.getByLabelText(/inject project directives/i)).toBeChecked();
    expect(screen.getByLabelText(/approval enabled/i)).not.toBeChecked();
    expect(screen.getByLabelText(/post-process kind/i)).toBeInTheDocument();
  });

  it("emits onChange when stage input changes", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <LlmEditor params={{ stage: "" }} onChange={onChange} />,
    );
    await userEvent.type(screen.getByLabelText(/^stage$/i), "i");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ stage: "i" }),
    );
  });

  it("renders RichTooltip Info icons next to LLM field labels", () => {
    // Phase 8 brought back the legacy tooltip affordance. Each field carries
    // an `llm-tooltip-<i18nKey>` test marker so this test stays robust
    // against label-text wording changes.
    renderWithProviders(
      <LlmEditor params={{ stage: "implement" }} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId("llm-tooltip-pipelineBuilderLlmStage")).toBeInTheDocument();
    expect(screen.getByTestId("llm-tooltip-pipelineBuilderLlmProvider")).toBeInTheDocument();
    expect(screen.getByTestId("llm-tooltip-pipelineBuilderLlmModel")).toBeInTheDocument();
    expect(screen.getByTestId("llm-tooltip-pipelineLLMPostProcessKind")).toBeInTheDocument();
    expect(screen.getByTestId("llm-tooltip-pipelineBuilderLlmTools")).toBeInTheDocument();
  });

  describe("provider dropdown", () => {
    it("renders all 5 known provider options with planned providers disabled", async () => {
      renderWithProviders(
        <LlmEditor
          params={{ stage: "implement", provider: "claude-cli" }}
          onChange={vi.fn()}
        />,
      );
      await userEvent.click(screen.getByTestId("llm-provider-trigger"));

      // Radix Select forwards aria-disabled on disabled options. Walking by
      // role keeps the test robust against data-testid plumbing changes.
      const options = await screen.findAllByRole("option");
      const byLabel = new Map(options.map((el) => [el.textContent ?? "", el]));

      const claudeCli = [...byLabel.entries()].find(([label]) =>
        /claude-cli/i.test(label),
      )?.[1];
      expect(claudeCli).toBeDefined();
      // claude-cli must be selectable.
      expect(claudeCli!.getAttribute("aria-disabled")).not.toBe("true");

      for (const value of ["anthropic-api", "openai", "gemini", "local"]) {
        const opt = [...byLabel.entries()].find(([label]) =>
          new RegExp(value, "i").test(label),
        )?.[1];
        expect(opt, `option ${value} should render`).toBeDefined();
        // Radix marks disabled options with aria-disabled="true".
        expect(opt!.getAttribute("aria-disabled")).toBe("true");
        expect(opt!.textContent).toMatch(/planned/i);
      }
    });

    it("renders a warning + 'keep' button when persisted provider is unknown", () => {
      renderWithProviders(
        <LlmEditor
          params={{ stage: "implement", provider: "vertex-ai-experimental" }}
          onChange={vi.fn()}
        />,
      );
      const warning = screen.getByTestId("llm-provider-unknown-warning");
      expect(warning).toBeInTheDocument();
      expect(warning).toHaveTextContent(/vertex-ai-experimental/);
      expect(screen.getByTestId("llm-provider-unknown-keep")).toBeInTheDocument();
    });

    it("surfaces the unknown persisted value as a one-off Select option so it isn't lost", async () => {
      renderWithProviders(
        <LlmEditor
          params={{ stage: "implement", provider: "vertex-ai-experimental" }}
          onChange={vi.fn()}
        />,
      );
      // The trigger shows the "Other: <value>" formatted label.
      expect(screen.getByTestId("llm-provider-trigger")).toHaveTextContent(
        /vertex-ai-experimental/,
      );
      await userEvent.click(screen.getByTestId("llm-provider-trigger"));
      // The persisted-but-unknown value ships as an extra option in the
      // dropdown so the user can re-select it without losing the value.
      const options = await screen.findAllByRole("option");
      const unknownOption = options.find((el) =>
        /vertex-ai-experimental/.test(el.textContent ?? ""),
      );
      expect(unknownOption).toBeDefined();
    });

    it("does NOT render the unknown-warning for known providers", () => {
      renderWithProviders(
        <LlmEditor
          params={{ stage: "implement", provider: "anthropic-api" }}
          onChange={vi.fn()}
        />,
      );
      expect(
        screen.queryByTestId("llm-provider-unknown-warning"),
      ).not.toBeInTheDocument();
    });

    it("treats blank provider as claude-cli (the default) without warning", () => {
      renderWithProviders(
        <LlmEditor
          params={{ stage: "implement", provider: "" }}
          onChange={vi.fn()}
        />,
      );
      expect(
        screen.queryByTestId("llm-provider-unknown-warning"),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("llm-provider-trigger")).toHaveTextContent(
        /claude-cli/i,
      );
    });

    it("treats missing provider (undefined) as claude-cli without warning", () => {
      renderWithProviders(
        <LlmEditor params={{ stage: "implement" }} onChange={vi.fn()} />,
      );
      expect(
        screen.queryByTestId("llm-provider-unknown-warning"),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("llm-provider-trigger")).toHaveTextContent(
        /claude-cli/i,
      );
    });

    it("does NOT fire onChange on mount when provider is empty — opening the editor must not bump OCC version", () => {
      const onChange = vi.fn();
      renderWithProviders(
        <LlmEditor
          params={{ stage: "implement", provider: "" }}
          onChange={onChange}
        />,
      );
      expect(onChange).not.toHaveBeenCalled();
    });

    it("does NOT fire onChange on mount when provider is missing (undefined)", () => {
      const onChange = vi.fn();
      renderWithProviders(
        <LlmEditor params={{ stage: "implement" }} onChange={onChange} />,
      );
      expect(onChange).not.toHaveBeenCalled();
    });

    it("fires onChange with provider:'claude-cli' when the user explicitly picks it after an empty default", async () => {
      const onChange = vi.fn();
      renderWithProviders(
        <LlmEditor
          params={{ stage: "implement", provider: "" }}
          onChange={onChange}
        />,
      );
      await userEvent.click(screen.getByTestId("llm-provider-trigger"));
      const options = await screen.findAllByRole("option");
      const claudeCli = options.find((el) =>
        /claude-cli/i.test(el.textContent ?? ""),
      );
      expect(claudeCli).toBeDefined();
      await userEvent.click(claudeCli!);
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "claude-cli" }),
      );
    });
  });

  describe("model tier dropdown", () => {
    // Mirrors backend/app/services/llm_tiers.py — the backend tier resolver
    // only knows premium/mid/low; "high" was an invalid option an operator
    // could pick and silently break dispatch (card e019244b).
    it("offers exactly the backend tier vocabulary — premium/mid/low, no 'high'", async () => {
      renderWithProviders(
        <LlmEditor
          params={{ stage: "implement", model: "premium" }}
          onChange={vi.fn()}
        />,
      );
      await userEvent.click(screen.getByTestId("llm-model-trigger"));
      const options = await screen.findAllByRole("option");
      for (const tier of ["premium", "mid", "low"]) {
        expect(
          screen.getByTestId(`llm-model-option-${tier}`),
          `tier option ${tier} should render`,
        ).toBeInTheDocument();
      }
      const high = options.find((el) => /\bhigh\b/i.test(el.textContent ?? ""));
      expect(high, "the invalid 'high' tier must not be offered").toBeUndefined();
    });

    it("emits onChange with the selected tier", async () => {
      const onChange = vi.fn();
      renderWithProviders(
        <LlmEditor
          params={{ stage: "implement", model: "premium" }}
          onChange={onChange}
        />,
      );
      await userEvent.click(screen.getByTestId("llm-model-trigger"));
      await userEvent.click(screen.getByTestId("llm-model-option-mid"));
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ model: "mid" }),
      );
    });

    it("renders a warning + one-off option when the persisted model is not a known tier", async () => {
      renderWithProviders(
        <LlmEditor
          params={{ stage: "implement", model: "high" }}
          onChange={vi.fn()}
        />,
      );
      const warning = screen.getByTestId("llm-model-unknown-warning");
      expect(warning).toHaveTextContent(/high/);
      // The persisted value stays selectable so it isn't silently lost.
      expect(screen.getByTestId("llm-model-trigger")).toHaveTextContent(/high/);
      await userEvent.click(screen.getByTestId("llm-model-trigger"));
      expect(
        screen.getByTestId("llm-model-option-unknown"),
      ).toHaveTextContent(/high/);
    });

    it("does NOT warn for known tiers", () => {
      renderWithProviders(
        <LlmEditor
          params={{ stage: "implement", model: "low" }}
          onChange={vi.fn()}
        />,
      );
      expect(
        screen.queryByTestId("llm-model-unknown-warning"),
      ).not.toBeInTheDocument();
    });

    it("treats an empty model as platform default without warning", () => {
      renderWithProviders(
        <LlmEditor
          params={{ stage: "implement", model: "" }}
          onChange={vi.fn()}
        />,
      );
      expect(
        screen.queryByTestId("llm-model-unknown-warning"),
      ).not.toBeInTheDocument();
      expect(screen.getByTestId("llm-model-trigger")).toHaveTextContent(
        /default/i,
      );
    });

    it("does NOT fire onChange on mount when model is empty — opening the editor must not bump OCC version", () => {
      const onChange = vi.fn();
      renderWithProviders(
        <LlmEditor
          params={{ stage: "implement", model: "" }}
          onChange={onChange}
        />,
      );
      expect(onChange).not.toHaveBeenCalled();
    });
  });
});
