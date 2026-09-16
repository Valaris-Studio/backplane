// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { MoveCardEditor } from "../MoveCardEditor";

describe("MoveCardEditor", () => {
  it("renders the to_column_type select with current value", () => {
    renderWithProviders(
      <MoveCardEditor params={{ to_column_type: "done" }} onChange={vi.fn()} />,
    );
    const trigger = screen.getByLabelText(/to column type/i);
    expect(trigger).toBeInTheDocument();
    // Trigger shows the selected option label. Use the trigger's text content
    // rather than `getByText` because the (hidden) listbox also contains
    // every option label.
    expect(trigger.textContent).toMatch(/done/i);
  });
});
