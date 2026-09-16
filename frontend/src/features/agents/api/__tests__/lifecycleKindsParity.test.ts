// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { FALLBACK_KINDS } from "../../components/pipeline-builder/LifecyclePipelineBuilderPage";
import { KIND_EDITORS } from "../../components/pipeline-builder/kinds/registry";

// Frontend↔backend closed-set parity. The backend (lifecycle_kinds.py) is the
// source of truth for which step kinds exist; the runner validates configs
// server-side against it. The frontend mirrors the set in three places — the
// LifecycleKindName union, the KIND_EDITORS registry, and FALLBACK_KINDS — and
// if any drifts the pipeline-config page renders an undefined editor and
// crashes with React #130 (this happened when create_fix_cards shipped to the
// backend without a frontend editor). The other kind tests pin the three
// frontend surfaces to EACH OTHER; THIS test pins them to the BACKEND, which is
// the drift that actually reaches prod. See
// project_consolidation_and_fe_revamp_2026_06_04.
function backendKinds(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(
    here,
    "../../../../../../backend/app/services/agents/lifecycle_kinds.py",
  );
  const src = readFileSync(path, "utf8");
  // Each kind is a top-level entry in LIFECYCLE_KINDS whose canonical name is
  // restated as `"name": "<kind>"`. Matching on that line (not the dict key)
  // avoids picking up nested params_schema keys like "strategy" or "label".
  const names = new Set<string>();
  for (const m of src.matchAll(/^\s{8}"name":\s*"([a-z_]+)"/gm)) {
    if (m[1]) names.add(m[1]);
  }
  return [...names].sort();
}

describe("lifecycle kinds frontend↔backend parity", () => {
  const backend = backendKinds();

  it("backend declares a non-trivial closed set (sanity)", () => {
    // Guard against a path/regex break silently producing an empty set that
    // would make every parity assertion vacuously pass.
    expect(backend.length).toBeGreaterThanOrEqual(20);
    expect(backend).toContain("create_fix_cards");
  });

  it("KIND_EDITORS has exactly one editor per backend kind", () => {
    expect(Object.keys(KIND_EDITORS).sort()).toEqual(backend);
  });

  it("FALLBACK_KINDS matches the backend kind set", () => {
    expect([...FALLBACK_KINDS].sort()).toEqual(backend);
  });
});
