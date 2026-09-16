// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { MergePREditor } from "../MergePREditor";

describe("MergePREditor", () => {
  it("renders the strategy select empty by default", () => {
    renderWithProviders(<MergePREditor params={{}} onChange={vi.fn()} />);
    expect(screen.getByLabelText(/strategy/i)).toBeInTheDocument();
  });

  it("renders the strategy select with the current value", () => {
    renderWithProviders(
      <MergePREditor params={{ strategy: "rebase" }} onChange={vi.fn()} />,
    );
    const trigger = screen.getByLabelText(/strategy/i);
    expect(trigger.textContent).toMatch(/rebase/i);
  });

  it("renders only the three allowed strategies", async () => {
    renderWithProviders(<MergePREditor params={{}} onChange={vi.fn()} />);
    await userEvent.click(screen.getByLabelText(/strategy/i));
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("emits onChange with the selected strategy", async () => {
    const onChange = vi.fn();
    renderWithProviders(<MergePREditor params={{}} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText(/strategy/i));
    await userEvent.click(screen.getByRole("option", { name: /rebase/i }));
    expect(onChange).toHaveBeenLastCalledWith({ strategy: "rebase" });
  });
});
