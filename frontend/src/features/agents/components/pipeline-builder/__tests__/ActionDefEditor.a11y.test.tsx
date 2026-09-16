// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { ActionDefEditor } from "../ActionDefEditor";
import type { ActionDef } from "../../../api/pipelineConfig";

const EMPTY: ActionDef = {};

describe("ActionDefEditor accessibility", () => {
  it("associates the add-label input with its label", () => {
    renderWithProviders(
      <ActionDefEditor
        value={EMPTY}
        onChange={vi.fn()}
        knownRoles={["implementer"]}
        fieldPath="stages[0].on_success"
        errorsByPath={new Map()}
      />,
    );

    expect(screen.getByLabelText(/add label/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/remove label/i)).toBeInTheDocument();
  });
});
