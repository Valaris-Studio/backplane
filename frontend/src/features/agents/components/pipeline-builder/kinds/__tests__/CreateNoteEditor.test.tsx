// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { CreateNoteEditor } from "../CreateNoteEditor";

describe("CreateNoteEditor", () => {
  it("renders kind input and from_llm_output checkbox", () => {
    renderWithProviders(
      <CreateNoteEditor
        params={{ kind: "review", from_llm_output: true }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/note kind/i)).toHaveValue("review");
    expect(screen.getByLabelText(/body from llm output/i)).toBeChecked();
  });

  it("emits onChange when toggling from_llm_output", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <CreateNoteEditor
        params={{ kind: "review", from_llm_output: false }}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByLabelText(/body from llm output/i));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ from_llm_output: true }),
    );
  });
});
