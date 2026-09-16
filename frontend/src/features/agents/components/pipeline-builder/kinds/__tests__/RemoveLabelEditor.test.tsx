// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { RemoveLabelEditor } from "../RemoveLabelEditor";

describe("RemoveLabelEditor", () => {
  it("renders the label input with current value", () => {
    renderWithProviders(
      <RemoveLabelEditor params={{ label: "needs-review" }} onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText(/label/i)).toHaveValue("needs-review");
  });

  it("emits onChange when typing", async () => {
    const onChange = vi.fn();
    renderWithProviders(<RemoveLabelEditor params={{}} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText(/label/i), "n");
    expect(onChange).toHaveBeenLastCalledWith({ label: "n" });
  });
});
