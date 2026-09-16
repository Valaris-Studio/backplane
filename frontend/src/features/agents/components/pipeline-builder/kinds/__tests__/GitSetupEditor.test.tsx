// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { GitSetupEditor } from "../GitSetupEditor";

describe("GitSetupEditor", () => {
  it("renders fields for create_branch action including branch_prefix", () => {
    renderWithProviders(
      <GitSetupEditor
        params={{
          action: "create_branch",
          branch_prefix: "feat/",
          create_pr: true,
          force_push_on_rework: false,
          base_ref: "default_branch",
        }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/action/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/branch prefix/i)).toHaveValue("feat/");
    expect(screen.getByLabelText(/base ref/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/create pr/i)).toBeChecked();
    expect(screen.getByLabelText(/force-push on rework/i)).not.toBeChecked();
  });

  it("hides branch_prefix field when action is not create_branch", () => {
    renderWithProviders(
      <GitSetupEditor params={{ action: "none" }} onChange={vi.fn()} />,
    );
    expect(screen.queryByLabelText(/branch prefix/i)).toBeNull();
  });

  it("emits onChange when toggling create_pr", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <GitSetupEditor
        params={{ action: "create_branch", create_pr: false }}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByLabelText(/create pr/i));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ create_pr: true }),
    );
  });
});
