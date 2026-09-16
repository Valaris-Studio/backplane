// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent, act } from "@/test/test-utils";
import { McpCallEditor } from "../McpCallEditor";

describe("McpCallEditor", () => {
  it("renders tool and args fields", () => {
    renderWithProviders(
      <McpCallEditor
        params={{ tool: "mcp__valaris__create_card", args: { title: "hi" } }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/tool/i)).toHaveValue("mcp__valaris__create_card");
    expect(screen.getByLabelText(/args/i)).toHaveValue(
      JSON.stringify({ title: "hi" }, null, 2),
    );
  });

  it("emits onChange with parsed args on blur", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <McpCallEditor params={{ tool: "x", args: {} }} onChange={onChange} />,
    );
    const textarea = screen.getByLabelText(/args/i);
    await userEvent.clear(textarea);
    await userEvent.type(textarea, '{{"foo":1}');
    await act(async () => {
      textarea.blur();
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ args: { foo: 1 } }),
    );
  });
});
