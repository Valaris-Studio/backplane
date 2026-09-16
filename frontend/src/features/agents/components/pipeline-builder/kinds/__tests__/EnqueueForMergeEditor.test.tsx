// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { EnqueueForMergeEditor } from "../EnqueueForMergeEditor";

describe("EnqueueForMergeEditor", () => {
  it("renders the strategy input with current value", () => {
    renderWithProviders(
      <EnqueueForMergeEditor params={{ strategy: "squash" }} onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText(/strategy/i)).toHaveValue("squash");
  });

  it("emits onChange when typing", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <EnqueueForMergeEditor params={{}} onChange={onChange} />,
    );
    await userEvent.type(screen.getByLabelText(/strategy/i), "r");
    expect(onChange).toHaveBeenLastCalledWith({ strategy: "r" });
  });
});
