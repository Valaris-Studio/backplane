// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent, act } from "@/test/test-utils";
import { SensorEditor } from "../SensorEditor";

describe("SensorEditor", () => {
  it("renders name, on_pass, on_fail and config JSON", () => {
    renderWithProviders(
      <SensorEditor
        params={{
          name: "go-test",
          on_pass: "approve",
          on_fail: "request_changes",
          config: { timeout: 60 },
        }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/^name$/i)).toHaveValue("go-test");
    expect(screen.getByLabelText(/on pass/i)).toHaveValue("approve");
    expect(screen.getByLabelText(/on fail/i)).toHaveValue("request_changes");
    expect(screen.getByLabelText(/config/i)).toHaveValue(
      JSON.stringify({ timeout: 60 }, null, 2),
    );
  });

  it("emits onChange when name input changes", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <SensorEditor params={{ name: "" }} onChange={onChange} />,
    );
    await userEvent.type(screen.getByLabelText(/^name$/i), "g");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "g" }),
    );
  });

  it("emits onChange with parsed config on blur", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <SensorEditor params={{ config: {} }} onChange={onChange} />,
    );
    const textarea = screen.getByLabelText(/config/i);
    await userEvent.clear(textarea);
    await userEvent.type(textarea, '{{"timeout":30}');
    await act(async () => {
      textarea.blur();
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ config: { timeout: 30 } }),
    );
  });
});
