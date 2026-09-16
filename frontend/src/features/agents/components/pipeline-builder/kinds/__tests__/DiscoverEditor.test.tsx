// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { DiscoverEditor } from "../DiscoverEditor";

describe("DiscoverEditor", () => {
  it("renders all fields with current values", () => {
    renderWithProviders(
      <DiscoverEditor
        params={{
          strategy: "column_scan",
          column_type: "backlog",
          column_type_exclude: "done",
          filters: { include_label: "ready" },
          preconditions: ["a", "b"],
        }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/strategy/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^column type$/i)).toHaveValue("backlog");
    expect(screen.getByLabelText(/exclude column type/i)).toHaveValue("done");
    expect(screen.getByLabelText(/preconditions/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/filters/i)).toBeInTheDocument();
  });

  it("emits onChange when column_type input changes", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <DiscoverEditor params={{ column_type: "" }} onChange={onChange} />,
    );
    const input = screen.getByLabelText(/^column type$/i);
    await userEvent.type(input, "r");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ column_type: "r" }),
    );
  });
});
