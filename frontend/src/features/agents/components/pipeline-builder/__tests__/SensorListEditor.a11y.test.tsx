// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { SensorListEditor } from "../SensorListEditor";
import type { SensorDef } from "../../../api/pipelineConfig";

const SENSORS: SensorDef[] = [
  { name: "go-test", config: {}, on_pass: "approve", on_fail: "request_changes" },
];

describe("SensorListEditor accessibility", () => {
  it("associates the on-pass and on-fail inputs with their labels", () => {
    renderWithProviders(
      <SensorListEditor
        sensors={SENSORS}
        onChange={vi.fn()}
        catalog={[]}
        fieldPath="stages[0].sensors"
        errorsByPath={new Map()}
      />,
    );

    expect(screen.getByLabelText(/on pass/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/on fail/i)).toBeInTheDocument();
  });
});
