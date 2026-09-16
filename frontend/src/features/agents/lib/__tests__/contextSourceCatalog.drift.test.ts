// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CONTEXT_SOURCE_KINDS } from "../contextSourceCatalog";

const VALIDATOR_PATH = path.resolve(
  __dirname,
  "../../../../../../backend/app/services/pipeline_config_validation.py",
);

function backendContextSourceKinds(): string[] {
  const source = readFileSync(VALIDATOR_PATH, "utf8");
  // Match `_CONTEXT_SOURCE_KINDS = frozenset({...})`. The literal lives on
  // a single line today; widen `[\s\S]` if the backend ever line-wraps it.
  const frozensetBody = source.match(
    /_CONTEXT_SOURCE_KINDS\s*=\s*frozenset\(\{([\s\S]*?)\}\)/,
  )?.[1];
  if (frozensetBody === undefined) {
    throw new Error(
      `_CONTEXT_SOURCE_KINDS frozenset literal not found in ${VALIDATOR_PATH}`,
    );
  }
  const kinds: string[] = [];
  for (const literal of frozensetBody.matchAll(/"([^"]+)"/g)) {
    const value = literal[1];
    if (value !== undefined) kinds.push(value);
  }
  return kinds;
}

describe("context source catalog drift", () => {
  it("frontend CONTEXT_SOURCE_KINDS === backend _CONTEXT_SOURCE_KINDS", () => {
    const backend = backendContextSourceKinds().slice().sort();
    const frontend = [...CONTEXT_SOURCE_KINDS].sort();
    expect(frontend).toEqual(backend);
  });
});
