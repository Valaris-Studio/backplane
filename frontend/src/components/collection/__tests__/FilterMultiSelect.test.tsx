// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import {
  renderWithProviders,
  screen,
  waitFor,
  userEvent,
} from "@/test/test-utils";
import { FilterMultiSelect } from "../FilterMultiSelect";

// Devops UX round 2 (#4): label-heavy boards made the labels filter grow past
// the viewport with no scroll or search, and every toggle closed the menu.

const FEW = ["backend", "frontend", "runner"].map((v) => ({
  value: v,
  label: v,
}));
const MANY = Array.from({ length: 20 }, (_, i) => ({
  value: `label-${i}`,
  label: `label-${i}`,
}));

function renderSelect(
  options = FEW,
  value: string[] = [],
  onChange = vi.fn(),
) {
  renderWithProviders(
    <FilterMultiSelect
      label="Labels"
      options={options}
      value={value}
      onChange={onChange}
    />,
  );
  return onChange;
}

async function openMenu() {
  await userEvent.click(screen.getByRole("button", { name: /labels/i }));
  await screen.findByTestId("filter-multi-select-options");
}

describe("FilterMultiSelect", () => {
  it("keeps the menu open when an option is toggled (multi-select)", async () => {
    const onChange = renderSelect();
    await openMenu();

    await userEvent.click(screen.getByText("backend"));

    expect(onChange).toHaveBeenCalledWith(["backend"]);
    // The menu must survive the pick so the next toggle is one click away.
    expect(
      screen.getByTestId("filter-multi-select-options"),
    ).toBeInTheDocument();
    expect(screen.getByText("frontend")).toBeInTheDocument();
  });

  it("bounds the option list height with an internal scroll region", async () => {
    renderSelect(MANY);
    await openMenu();

    const list = screen.getByTestId("filter-multi-select-options");
    expect(list.className).toContain("max-h-64");
    expect(list.className).toContain("overflow-y-auto");
  });

  it("scrolling inside the option list does not close the menu", async () => {
    renderSelect(MANY);
    await openMenu();

    fireEvent.scroll(screen.getByTestId("filter-multi-select-options"));

    expect(
      screen.getByTestId("filter-multi-select-options"),
    ).toBeInTheDocument();
  });

  it("still closes when something outside the menu scrolls", async () => {
    renderSelect(MANY);
    await openMenu();

    fireEvent.scroll(window);

    await waitFor(() =>
      expect(
        screen.queryByTestId("filter-multi-select-options"),
      ).not.toBeInTheDocument(),
    );
  });

  it("offers type-to-filter search once the option set is large", async () => {
    renderSelect(MANY);
    await openMenu();

    const search = screen.getByTestId("filter-multi-select-search");
    await userEvent.type(search, "label-19");

    expect(screen.getByText("label-19")).toBeInTheDocument();
    expect(screen.queryByText("label-2")).not.toBeInTheDocument();
  });

  it("shows an empty state when the query matches nothing", async () => {
    renderSelect(MANY);
    await openMenu();

    await userEvent.type(
      screen.getByTestId("filter-multi-select-search"),
      "zzz-no-such-label",
    );

    expect(screen.getByText(/no items match/i)).toBeInTheDocument();
  });

  it("hides the search box for small option sets", async () => {
    renderSelect(FEW);
    await openMenu();

    expect(
      screen.queryByTestId("filter-multi-select-search"),
    ).not.toBeInTheDocument();
  });
});
