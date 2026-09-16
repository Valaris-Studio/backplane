// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { ApplyLabelEditor } from "../ApplyLabelEditor";

describe("ApplyLabelEditor", () => {
  it("renders the label input with current value", () => {
    renderWithProviders(
      <ApplyLabelEditor params={{ label: "documented" }} onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText(/label/i)).toHaveValue("documented");
  });

  it("emits onChange when typing", async () => {
    const onChange = vi.fn();
    renderWithProviders(<ApplyLabelEditor params={{}} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText(/label/i), "d");
    expect(onChange).toHaveBeenLastCalledWith({ label: "d" });
  });
});
