// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  insertAtCaret,
  referencedRunnerVars,
  referencedSlots,
  validatePrompts,
} from "../lib/prompt-validation";

// Card 199bf1ec — the client mirror of the publish validator (AC2, AC3).
//
// The grammar these share with the backend is the whole point: a chip that
// disagreed with `app/services/loop_config_validation.py` would train authors
// to ignore it, so the uppercase-only slot rule and the `{{.Name}}` runner
// rule are pinned here rather than assumed.

const RUNNER_VARS = [
  "Workspace",
  "BoardID",
  "AgentID",
  "ExecutionID",
  "Iteration",
];

function validate(over: Partial<Parameters<typeof validatePrompts>[0]> = {}) {
  return validatePrompts({
    systemPrompt: "",
    loopPrompt: "",
    slotNames: [],
    runnerVars: RUNNER_VARS,
    ...over,
  });
}

describe("referencedSlots", () => {
  it("finds uppercase slot tokens across every prompt", () => {
    expect([...referencedSlots(["a <<ONE>> b", "c <<TWO_2>>"])]).toEqual([
      "ONE",
      "TWO_2",
    ]);
  });

  it("ignores shell heredocs and redirects", () => {
    // The uppercase-first rule is what keeps `cat <<eof` and `2>>log` unpainted;
    // a looser pattern would flag every shell snippet in a kernel prompt.
    expect([...referencedSlots(["cat <<eof", "run 2>>log", "<<lower>>"])]).toEqual(
      [],
    );
  });
});

describe("referencedRunnerVars", () => {
  it("reads the name out of Go template syntax including trim markers", () => {
    expect([...referencedRunnerVars(["{{.BoardID}} {{- .Iteration }}"])]).toEqual([
      "BoardID",
      "Iteration",
    ]);
  });
});

describe("validatePrompts", () => {
  it("flags a slot referenced but absent from the catalog", () => {
    const issues = validate({ loopPrompt: "go <<FOO>>" });
    expect(issues).toEqual([{ kind: "unknown-slot", name: "FOO" }]);
  });

  it("clears the unknown chip once the token is removed", () => {
    expect(validate({ loopPrompt: "go", slotNames: [] })).toEqual([]);
  });

  it("flags a catalogued slot no prompt references", () => {
    const issues = validate({ loopPrompt: "nothing", slotNames: ["RUN_LABEL"] });
    expect(issues).toEqual([{ kind: "unused-slot", name: "RUN_LABEL" }]);
  });

  it("counts a slot used only by a variant fill as used", () => {
    // A slot whose only consumer is another slot's variant text is live; the
    // backend's used_in scan sees it, so the chip must not contradict it.
    const issues = validate({
      loopPrompt: "plain",
      slotNames: ["NESTED"],
      variantFills: ["fill referencing <<NESTED>>"],
    });
    expect(issues).toEqual([]);
  });

  it("flags a template var the runner does not provide", () => {
    const issues = validate({ systemPrompt: "{{.Foo}}" });
    expect(issues).toEqual([{ kind: "non-runner-var", name: "Foo" }]);
  });

  it("accepts the five real runner vars", () => {
    const issues = validate({
      systemPrompt: "{{.Workspace}} {{.BoardID}} {{.AgentID}}",
      loopPrompt: "{{.ExecutionID}} {{.Iteration}}",
    });
    expect(issues).toEqual([]);
  });

  it("reads slots from BOTH prompts, not just the loop prompt", () => {
    const issues = validate({
      systemPrompt: "<<IN_SYSTEM>>",
      slotNames: ["IN_SYSTEM"],
    });
    expect(issues).toEqual([]);
  });
});

describe("insertAtCaret", () => {
  it("splices the token at the caret and reports the new caret", () => {
    expect(insertAtCaret("ab", "<<X>>", 1, 1)).toEqual({
      text: "a<<X>>b",
      caret: 6,
    });
  });

  it("replaces the current selection", () => {
    expect(insertAtCaret("abcd", "{{.BoardID}}", 1, 3)).toEqual({
      text: "a{{.BoardID}}d",
      caret: 13,
    });
  });
});
