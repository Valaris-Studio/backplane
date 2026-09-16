// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { CreatePREditor } from "../CreatePREditor";

describe("CreatePREditor", () => {
  it("renders both title_from and body_from inputs empty by default", () => {
    renderWithProviders(<CreatePREditor params={{}} onChange={vi.fn()} />);
    expect(screen.getByLabelText(/title from/i)).toHaveValue("");
    expect(screen.getByLabelText(/body from/i)).toHaveValue("");
  });

  it("renders populated values", () => {
    renderWithProviders(
      <CreatePREditor
        params={{ title_from: "card.title", body_from: "llm.summary" }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/title from/i)).toHaveValue("card.title");
    expect(screen.getByLabelText(/body from/i)).toHaveValue("llm.summary");
  });

  it("emits onChange when typing in title_from", async () => {
    const onChange = vi.fn();
    renderWithProviders(<CreatePREditor params={{}} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText(/title from/i), "x");
    expect(onChange).toHaveBeenLastCalledWith({ title_from: "x" });
  });

  it("renders the template-reserved note", () => {
    renderWithProviders(<CreatePREditor params={{}} onChange={vi.fn()} />);
    expect(screen.getByText(/reserved for future templating/i)).toBeInTheDocument();
  });
});
