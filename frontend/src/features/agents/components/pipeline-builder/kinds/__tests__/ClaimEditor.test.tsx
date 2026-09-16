// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { ClaimEditor } from "../ClaimEditor";

describe("ClaimEditor", () => {
  it("renders participant role select and execution action input", () => {
    renderWithProviders(
      <ClaimEditor
        params={{ participant_role: "hero", execution_action: "implement" }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/participant role/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/execution action/i)).toHaveValue("implement");
  });

  it("emits onChange when execution_action changes", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <ClaimEditor params={{ execution_action: "" }} onChange={onChange} />,
    );
    await userEvent.type(screen.getByLabelText(/execution action/i), "r");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ execution_action: "r" }),
    );
  });
});
