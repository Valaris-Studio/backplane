// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { PROMPT_DOCS, PROMPT_NAMES } from "../prompts-resources";

describe("MCP reference prompt docs parity", () => {
  // Completes the drift chain: @mcp.prompt() decorators → PROMPT_NAMES
  // (backend test_mcp_catalog_drift.py) → PROMPT_DOCS, the array the docs
  // page actually renders. toEqual also pins the declared pipeline order.
  it("documents exactly the prompt set in PROMPT_NAMES", () => {
    expect(PROMPT_DOCS.map((doc) => doc.name)).toEqual([...PROMPT_NAMES]);
  });

  it("has no duplicate prompt names", () => {
    const names = PROMPT_DOCS.map((doc) => doc.name);
    const duplicates = names.filter((name, i) => names.indexOf(name) !== i);
    expect(duplicates).toEqual([]);
  });
});
