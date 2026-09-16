// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from "node:fs";
import path from "node:path";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PromptHighlightPreview } from "../PromptHighlightPreview";

const RUNNER_VARS = [
  "Workspace",
  "BoardID",
  "AgentID",
  "ExecutionID",
  "Iteration",
];

function marks(container: HTMLElement) {
  return Array.from(container.querySelectorAll("mark"));
}

function kindOf(container: HTMLElement, token: string) {
  return marks(container)
    .find((m) => m.textContent === token)
    ?.getAttribute("data-kind");
}

describe("PromptHighlightPreview", () => {
  it("classifies each token by the backend grammar", () => {
    const { container } = render(
      <PromptHighlightPreview
        text="Run <<RUN_LABEL>> at {{.Iteration}} but not <<NOPE>>."
        slots={["RUN_LABEL"]}
        runnerVars={RUNNER_VARS}
      />,
    );

    expect(kindOf(container, "<<RUN_LABEL>>")).toBe("slot");
    expect(kindOf(container, "{{.Iteration}}")).toBe("runner");
    // In the catalog-less case a <<X>> is still a slot by grammar, but an
    // UNKNOWN one — the operator needs to see it will never be substituted.
    expect(kindOf(container, "<<NOPE>>")).toBe("unknown-slot");
  });

  it("does not mark strings the backend grammar rejects", () => {
    const { container } = render(
      <PromptHighlightPreview
        text="cat <<lowercase>> and {{ notvar }} and 2>>log and <<9BAD>>"
        slots={["RUN_LABEL"]}
        runnerVars={RUNNER_VARS}
      />,
    );

    // SLOT_PATTERN is uppercase-first-letter only, precisely so that shell
    // heredocs and redirections in a prompt are not eaten.
    expect(marks(container)).toHaveLength(0);
  });

  it("marks a runner var the server declares but flags an undeclared one", () => {
    const { container } = render(
      <PromptHighlightPreview
        text="{{.BoardID}} then {{.Bogus}}"
        slots={[]}
        runnerVars={RUNNER_VARS}
      />,
    );

    expect(kindOf(container, "{{.BoardID}}")).toBe("runner");
    // Same reasoning as unknown-slot: it LOOKS like a var, the runner will
    // render it empty. Do not silently paint it as valid.
    expect(kindOf(container, "{{.Bogus}}")).toBe("unknown-runner");
  });

  it("accepts the whitespace and trim-marker forms Go templates allow", () => {
    const { container } = render(
      <PromptHighlightPreview
        text="{{- .BoardID}} and {{ .Workspace }}"
        slots={[]}
        runnerVars={RUNNER_VARS}
      />,
    );

    // Backend RUNNER_VAR_PATTERN is `\{\{-?\s*\.([A-Za-z_][A-Za-z0-9_]*)`.
    // Matching only the bare `{{.X}}` form would leave these unhighlighted
    // while the runner happily substitutes them.
    expect(kindOf(container, "{{- .BoardID}}")).toBe("runner");
    expect(kindOf(container, "{{ .Workspace }}")).toBe("runner");
  });

  it("preserves the prompt text verbatim, including the untokenised parts", () => {
    const text = "line one\n  indented <<RUN_LABEL>> tail";
    const { container } = render(
      <PromptHighlightPreview
        text={text}
        slots={["RUN_LABEL"]}
        runnerVars={RUNNER_VARS}
      />,
    );

    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe(text);
  });

  it("renders read-only — no input, textarea or contenteditable", () => {
    const { container } = render(
      <PromptHighlightPreview
        text="<<RUN_LABEL>>"
        slots={["RUN_LABEL"]}
        runnerVars={RUNNER_VARS}
      />,
    );

    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("[contenteditable]")).toBeNull();
  });

  it("treats an omitted slot catalog as 'nothing is known', not 'everything is fine'", () => {
    const { container } = render(
      <PromptHighlightPreview text="<<RUN_LABEL>>" runnerVars={RUNNER_VARS} />,
    );

    expect(kindOf(container, "<<RUN_LABEL>>")).toBe("unknown-slot");
  });

  it("gives each kind its own token class, so the three never collapse into one", () => {
    const { container } = render(
      <PromptHighlightPreview
        text="{{.BoardID}} <<KNOWN>> <<MISSING>>"
        slots={["KNOWN"]}
        runnerVars={RUNNER_VARS}
      />,
    );

    const classOf = (token: string) =>
      marks(container).find((m) => m.textContent === token)?.className ?? "";

    // Asserting the class STRINGS (not just that some token utility appears
    // somewhere in the file) is what makes a kind→colour swap falsifiable.
    expect(classOf("{{.BoardID}}")).toContain("bg-primary");
    expect(classOf("<<KNOWN>>")).toContain("bg-muted");
    expect(classOf("<<MISSING>>")).toContain("bg-destructive");
    // A danger colour that also reads as "fine" would defeat the whole point.
    expect(classOf("<<MISSING>>")).not.toContain("bg-muted");
    expect(classOf("<<KNOWN>>")).not.toContain("bg-destructive");
    expect(classOf("{{.BoardID}}")).not.toContain("bg-destructive");
  });

  it("colours only through semantic tokens — no hex or rgb literals in the module", () => {
    // jsdom applies no stylesheet, so a computed-colour assertion would be
    // vacuous. Pin the SOURCE instead: the contract is that theming flows
    // through Tailwind token utilities and survives a theme swap.
    const source = fs.readFileSync(
      path.resolve(__dirname, "../PromptHighlightPreview.tsx"),
      "utf8",
    );

    expect(source).toMatch(/bg-primary/);
    expect(source).toMatch(/bg-muted/);
    expect(source).toMatch(/bg-destructive/);
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/\brgba?\(/);
  });

  it("renders nothing markable for empty text but still emits the pre", () => {
    const { container } = render(
      <PromptHighlightPreview text="" runnerVars={RUNNER_VARS} />,
    );

    expect(container.querySelector("pre")).not.toBeNull();
    expect(marks(container)).toHaveLength(0);
  });

  it("marks every occurrence, not just the first", () => {
    const { container } = render(
      <PromptHighlightPreview
        text="<<A>> mid <<A>> end"
        slots={["A"]}
        runnerVars={RUNNER_VARS}
      />,
    );

    expect(marks(container)).toHaveLength(2);
    expect(screen.getAllByText("<<A>>")).toHaveLength(2);
  });
});
