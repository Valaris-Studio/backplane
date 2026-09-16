// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { copyTextToClipboard } from "@/lib/clipboard";
import { CopyableBlock } from "../components/CopyableBlock";
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: vi.fn() }));

describe("CopyableBlock recovery", () => {
  it("retains selectable content and clears an inline error after retry", async () => {
    vi.mocked(copyTextToClipboard).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    renderWithProviders(<CopyableBlock label="Message" value="example command" copyLabel="Copy message" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Copy message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/select.*copy/i);
    expect(screen.getByText("example command")).toHaveAttribute("tabindex", "0");
    await user.click(screen.getByRole("button", { name: "Copy message" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
