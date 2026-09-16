// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PROMPT_DESCRIPTION_KEYS_BY_SLUG } from "../promptDescriptionCatalog";

const PROMPT_DEFAULTS_PATH = path.resolve(
  __dirname,
  "../../../../../../backend/app/services/agents/prompt_defaults.py",
);

function backendPromptSlugs(): string[] {
  const source = readFileSync(PROMPT_DEFAULTS_PATH, "utf8");
  const registry = source.match(
    /PROMPT_STAGE_REGISTRY:[\s\S]*?= \[([\s\S]*?)\n\]\n\n\ndef get_prompt_defaults/,
  )?.[1];
  if (registry === undefined) {
    throw new Error(
      `PROMPT_STAGE_REGISTRY literal not found in ${PROMPT_DEFAULTS_PATH}`,
    );
  }

  return [...registry.matchAll(/PromptStageDefault\(\s*slug="([^"]+)"/g)].map(
    (match) => match[1]!,
  );
}

describe("prompt description catalog drift", () => {
  it("covers every built-in prompt slug exposed by the backend", () => {
    expect(Object.keys(PROMPT_DESCRIPTION_KEYS_BY_SLUG)).toEqual(
      backendPromptSlugs(),
    );
  });
});
