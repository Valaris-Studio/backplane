// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getMissingDocumentationStrings,
  getUnexpectedDocumentationStrings,
} from "../section-registry";

const HONEST_REMARKS_SLUGS = [
  "what-works-well",
  "known-rough-edges",
  "actively-working-on",
  "the-north-star",
] as const;

function source(name: string): string {
  return readFileSync(
    resolve(
      process.cwd(),
      `src/pages/documentation/sections/honest-remarks-${name}.tsx`,
    ),
    "utf8",
  );
}

describe("honest remarks describe current main instead of the 2026-04 roadmap", () => {
  it("does not present shipped dependencies and forge abstraction as future work", () => {
    const text = source("actively-working-on");
    expect(text).toContain("forge.Provider");
    expect(text).toContain("GitHub and Gitea/Forgejo");
    expect(text).toContain("card_dependencies");
    expect(text).not.toContain("Structured card dependencies (T1.2)");
    expect(text).not.toContain("Git host provider abstraction (T1.4)");
  });

  it("does not repeat schema, provider, event-bus, or code-hygiene claims that main disproves", () => {
    const text = source("known-rough-edges");
    for (const currentToken of [
      "<code>slug</code>",
      "team_roles",
      "model_pricing",
      "claude-cli",
      "codex-cli",
      "EVENT_BUS_BACKEND",
      "memory",
      "postgres",
      "<code>TODO</code>",
      "<code>as any</code>",
    ]) {
      expect(text, currentToken).toContain(currentToken);
    }
    for (const staleClaim of [
      "lack <code>slug</code> fields",
      "holds a single <code>LLMConfig</code>",
      "event bus is in-process and single-pod",
      "Zero production <code>any</code>",
      "No <code>TODO</code>",
    ]) {
      expect(text, staleClaim).not.toContain(staleClaim);
    }
  });

  it("states that the two CLI providers execute today", () => {
    const text = source("the-north-star");
    expect(text).toContain("claude-cli");
    expect(text).toContain("codex-cli");
    expect(text).toContain("llm.Provider");
    expect(text).not.toContain("ignores them and invokes Claude regardless");
  });

  it("describes enforced contracts without claiming a permanently spotless tree", () => {
    const text = source("what-works-well");
    expect(text).toContain("contract tests");
    expect(text).toContain("ordinary maintenance debt");
    expect(text).not.toContain("tree carries zero");
    expect(text).not.toContain("frontend production code has zero");
  });

  it.each(["es", "pt-BR"] as const)(
    "keeps every Honest Remarks source string exact in %s",
    (locale) => {
      for (const slug of HONEST_REMARKS_SLUGS) {
        expect(
          getMissingDocumentationStrings(locale, slug),
          `${locale}:${slug} is missing source strings`,
        ).toEqual([]);
        expect(
          getUnexpectedDocumentationStrings(locale, slug),
          `${locale}:${slug} contains stale source strings`,
        ).toEqual([]);
      }
    },
  );
});
