// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import type { SchedulingDef } from "../pipelineConfig";

describe("SchedulingDef", () => {
  it("preserves min_failure_backoff_seconds through a JSON roundtrip", () => {
    const raw = JSON.stringify({
      priority_order: ["hero"],
      mode: "priority",
      min_failure_backoff_seconds: 30,
    });

    const parsed: SchedulingDef = JSON.parse(raw);

    expect(parsed.min_failure_backoff_seconds).toBe(30);
  });
});
