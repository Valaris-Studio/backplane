// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { ShipEditor } from "../ShipEditor";

describe("ShipEditor", () => {
  it("renders the to_column_type select empty by default", () => {
    renderWithProviders(<ShipEditor params={{}} onChange={vi.fn()} />);
    expect(screen.getByLabelText(/to column type/i)).toBeInTheDocument();
  });

  it("renders populated value", () => {
    renderWithProviders(
      <ShipEditor params={{ to_column_type: "done" }} onChange={vi.fn()} />,
    );
    const trigger = screen.getByLabelText(/to column type/i);
    expect(trigger.textContent).toMatch(/done/i);
  });

  it("renders exactly the five backend column types", async () => {
    renderWithProviders(<ShipEditor params={{}} onChange={vi.fn()} />);
    await userEvent.click(screen.getByLabelText(/to column type/i));
    expect(screen.getAllByRole("option")).toHaveLength(5);
  });

  it("emits onChange with the selected column type", async () => {
    const onChange = vi.fn();
    renderWithProviders(<ShipEditor params={{}} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText(/to column type/i));
    await userEvent.click(screen.getByRole("option", { name: /done/i }));
    expect(onChange).toHaveBeenLastCalledWith({ to_column_type: "done" });
  });
});
