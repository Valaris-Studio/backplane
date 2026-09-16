// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import userEvent from "@testing-library/user-event";
import { ToolDenyEditor } from "../ToolDenyEditor";

describe("ToolDenyEditor", () => {
  it("renders each existing deny pattern as a removable row", () => {
    renderWithProviders(
      <ToolDenyEditor
        value={["Bash(gh pr merge:*)", "Bash(git push --force:*)"]}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("Bash(gh pr merge:*)")).toBeInTheDocument();
    expect(screen.getByText("Bash(git push --force:*)")).toBeInTheDocument();
  });

  it("shows an empty-state when there are no deny patterns", () => {
    renderWithProviders(<ToolDenyEditor value={[]} onChange={() => {}} />);
    expect(screen.getByTestId("tool-deny-editor")).toBeInTheDocument();
    expect(
      screen.queryByTestId("tool-deny-row-0"),
    ).not.toBeInTheDocument();
  });

  it("appends a trimmed pattern and calls onChange when Add is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<ToolDenyEditor value={[]} onChange={onChange} />);

    await user.type(
      screen.getByTestId("tool-deny-input"),
      "  Bash(rm -rf:*)  ",
    );
    await user.click(screen.getByRole("button", { name: /add/i }));

    expect(onChange).toHaveBeenCalledWith(["Bash(rm -rf:*)"]);
  });

  it("ignores an empty / whitespace-only entry on add", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<ToolDenyEditor value={[]} onChange={onChange} />);

    await user.type(screen.getByTestId("tool-deny-input"), "   ");
    await user.click(screen.getByRole("button", { name: /add/i }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("dedupes a pattern already present", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <ToolDenyEditor value={["Bash(gh pr merge:*)"]} onChange={onChange} />,
    );

    await user.type(
      screen.getByTestId("tool-deny-input"),
      "Bash(gh pr merge:*)",
    );
    await user.click(screen.getByRole("button", { name: /add/i }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("removes an entry and calls onChange without it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <ToolDenyEditor
        value={["Bash(gh pr merge:*)", "Bash(git push --force:*)"]}
        onChange={onChange}
      />,
    );

    await user.click(
      screen.getAllByRole("button", { name: /remove/i })[0]!,
    );

    expect(onChange).toHaveBeenCalledWith(["Bash(git push --force:*)"]);
  });
});
