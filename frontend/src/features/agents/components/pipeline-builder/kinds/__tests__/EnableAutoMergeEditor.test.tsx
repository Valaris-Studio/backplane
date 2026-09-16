// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { EnableAutoMergeEditor } from "../EnableAutoMergeEditor";

describe("EnableAutoMergeEditor", () => {
  it("renders the strategy select empty by default", () => {
    renderWithProviders(
      <EnableAutoMergeEditor params={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText(/strategy/i)).toBeInTheDocument();
  });

  it("renders the strategy select with the current value", () => {
    renderWithProviders(
      <EnableAutoMergeEditor
        params={{ strategy: "squash" }}
        onChange={vi.fn()}
      />,
    );
    const trigger = screen.getByLabelText(/strategy/i);
    expect(trigger.textContent).toMatch(/squash/i);
  });

  it("renders only the three allowed strategies in the listbox", async () => {
    renderWithProviders(
      <EnableAutoMergeEditor params={{}} onChange={vi.fn()} />,
    );
    await userEvent.click(screen.getByLabelText(/strategy/i));
    const options = screen.getAllByRole("option");
    const texts = options.map((o) => o.textContent ?? "");
    expect(options).toHaveLength(3);
    expect(texts.some((t) => /merge commit/i.test(t))).toBe(true);
    expect(texts.some((t) => /squash/i.test(t))).toBe(true);
    expect(texts.some((t) => /rebase/i.test(t))).toBe(true);
  });

  it("emits onChange with the selected strategy", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <EnableAutoMergeEditor params={{}} onChange={onChange} />,
    );
    await userEvent.click(screen.getByLabelText(/strategy/i));
    await userEvent.click(screen.getByRole("option", { name: /squash/i }));
    expect(onChange).toHaveBeenLastCalledWith({ strategy: "squash" });
  });
});
