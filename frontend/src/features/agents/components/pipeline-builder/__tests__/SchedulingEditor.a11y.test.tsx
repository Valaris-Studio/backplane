// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test/test-utils";
import { SchedulingEditor } from "../SchedulingEditor";
import type { SchedulingDef } from "../../../api/pipelineConfig";

const SCHEDULING: SchedulingDef = {
  priority_order: ["implementer"],
  mode: "priority",
};

describe("SchedulingEditor", () => {
  it("renders the mode select associated with its label and current value", () => {
    renderWithProviders(
      <SchedulingEditor
        value={SCHEDULING}
        onChange={vi.fn()}
        knownRoles={["implementer", "reviewer"]}
        errorsByPath={new Map()}
      />,
    );

    const select = screen.getByLabelText(/scheduling mode/i);
    expect(select).toBeInTheDocument();
    expect(select).toHaveTextContent(/priority/i);
  });

  it("calls onChange with a round_robin SchedulingDef when mode changes", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <SchedulingEditor
        value={SCHEDULING}
        onChange={onChange}
        knownRoles={["implementer", "reviewer"]}
        errorsByPath={new Map()}
      />,
    );

    await userEvent.click(screen.getByLabelText(/scheduling mode/i));
    await userEvent.click(screen.getByRole("option", { name: /round robin/i }));

    expect(onChange).toHaveBeenCalledWith({
      priority_order: ["implementer"],
      mode: "round_robin",
    });
  });

  it("does not render a max-consecutive input (deprecated field)", () => {
    renderWithProviders(
      <SchedulingEditor
        value={SCHEDULING}
        onChange={vi.fn()}
        knownRoles={["implementer"]}
        errorsByPath={new Map()}
      />,
    );

    expect(screen.queryByLabelText(/max consecutive/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/starvation/i)).not.toBeInTheDocument();
  });
});
