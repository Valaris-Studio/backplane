// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen } from "@/test/test-utils";
import { WakeRoleEditor } from "../WakeRoleEditor";

describe("WakeRoleEditor", () => {
  it("renders empty input when no roles set", () => {
    renderWithProviders(<WakeRoleEditor params={{}} onChange={vi.fn()} />);
    expect(screen.getByLabelText(/roles/i)).toHaveValue("");
  });

  it("renders comma-separated roles when populated", () => {
    renderWithProviders(
      <WakeRoleEditor
        params={{ roles: ["reviewer", "documentator"] }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/roles/i)).toHaveValue("reviewer, documentator");
  });

  it("emits onChange with a string[] when the field is edited", () => {
    const onChange = vi.fn();
    renderWithProviders(<WakeRoleEditor params={{}} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/roles/i), {
      target: { value: "reviewer, documentator" },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      roles: ["reviewer", "documentator"],
    });
  });

  it("drops empty fragments and trims whitespace", () => {
    const onChange = vi.fn();
    renderWithProviders(<WakeRoleEditor params={{}} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/roles/i), {
      target: { value: "a,,  b ," },
    });
    expect(onChange).toHaveBeenLastCalledWith({ roles: ["a", "b"] });
  });
});
