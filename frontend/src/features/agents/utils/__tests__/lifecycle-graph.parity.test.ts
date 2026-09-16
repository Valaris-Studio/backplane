// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { KIND_SEMANTICS } from "../lifecycle-graph";

// Pin the graph's per-kind producesDecision/terminal flags to the backend
// registry (lifecycle_kinds.py), the source of truth the runner validates
// against. The graph's strand/decision analysis is only correct if these flags
// match — drift here would silently mislabel terminal nodes or miss strands.
// Mirrors the kind-list parity guard in api/__tests__/lifecycleKindsParity.test.ts.
function backendSemantics(): Record<
  string,
  { producesDecision: boolean; terminal: boolean }
> {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(
    here,
    "../../../../../../backend/app/services/agents/lifecycle_kinds.py",
  );
  const src = readFileSync(path, "utf8");

  // Each kind block restates its canonical name via `"name": "<kind>"` (8-space
  // indent, top level of the entry), followed later by produces_decision and
  // terminal booleans before the next entry. Walk the file line by line,
  // attributing each boolean to the most recent canonical name.
  const out: Record<string, { producesDecision: boolean; terminal: boolean }> =
    {};
  let current: string | null = null;
  for (const line of src.split("\n")) {
    const nameM = line.match(/^\s{8}"name":\s*"([a-z_]+)"/);
    if (nameM?.[1]) {
      current = nameM[1];
      out[current] = { producesDecision: false, terminal: false };
      continue;
    }
    if (!current) continue;
    const entry = out[current];
    if (!entry) continue;
    const pdM = line.match(/^\s+"produces_decision":\s*(True|False)/);
    if (pdM) entry.producesDecision = pdM[1] === "True";
    const tM = line.match(/^\s+"terminal":\s*(True|False)/);
    if (tM) entry.terminal = tM[1] === "True";
  }
  return out;
}

describe("KIND_SEMANTICS ↔ backend lifecycle_kinds parity", () => {
  const backend = backendSemantics();

  it("backend declares a non-trivial set with the expected flags (sanity)", () => {
    expect(Object.keys(backend).length).toBeGreaterThanOrEqual(20);
    // Spot-check the two subtle ones the analysis depends on.
    expect(backend.apply_label?.terminal).toBe(false);
    expect(backend.llm?.producesDecision).toBe(true);
  });

  it("every backend kind has matching producesDecision + terminal flags", () => {
    for (const [kind, sem] of Object.entries(backend)) {
      expect(KIND_SEMANTICS[kind as keyof typeof KIND_SEMANTICS], kind).toEqual(
        sem,
      );
    }
  });

  it("KIND_SEMANTICS declares no kinds the backend does not", () => {
    expect(Object.keys(KIND_SEMANTICS).sort()).toEqual(
      Object.keys(backend).sort(),
    );
  });
});
