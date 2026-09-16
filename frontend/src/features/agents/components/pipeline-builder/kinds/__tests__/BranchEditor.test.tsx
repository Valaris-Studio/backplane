// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent, act } from "@/test/test-utils";
import { BranchEditor } from "../BranchEditor";

describe("BranchEditor", () => {
  it("renders expression and cases fields", () => {
    renderWithProviders(
      <BranchEditor
        params={{ expression: "card.priority", cases: { high: "step_a" } }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/expression/i)).toHaveValue("card.priority");
    expect(screen.getByLabelText(/cases/i)).toHaveValue(
      JSON.stringify({ high: "step_a" }, null, 2),
    );
  });

  it("emits onChange with parsed cases on blur", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <BranchEditor params={{ expression: "x", cases: {} }} onChange={onChange} />,
    );
    const textarea = screen.getByLabelText(/cases/i);
    await userEvent.clear(textarea);
    await userEvent.type(textarea, '{{"a":"b"}');
    await act(async () => {
      textarea.blur();
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ cases: { a: "b" } }),
    );
  });
});
