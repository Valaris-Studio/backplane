// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandChip } from "./CommandChip";

const COMMAND = "codex app-server daemon restart";

function renderInSentence() {
  const user = userEvent.setup();
  render(
    <p>
      In a terminal, run <CommandChip command={COMMAND} punctuation="." />
    </p>,
  );
  return user;
}

afterEach(() => vi.useRealTimers());

describe("CommandChip", () => {
  it("shows the command as monospace code, and adds nothing to the sentence's text", () => {
    renderInSentence();
    expect(screen.getByText(COMMAND, { selector: "code" })).toBeInTheDocument();
    expect(screen.getByRole("paragraph")).toHaveTextContent(/^In a terminal, run codex app-server daemon restart\.$/);
  });

  it("copies the exact command and says Copied politely", async () => {
    const user = renderInSentence();
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toBeEmptyDOMElement();
    await user.click(screen.getByRole("button", { name: "Copy command" }));
    expect(await navigator.clipboard.readText()).toBe(COMMAND);
    expect(status).toHaveTextContent("Copied");
  });

  it("copies from the keyboard, with Enter and with Space", async () => {
    const user = renderInSentence();
    await user.tab();
    const button = screen.getByRole("button", { name: "Copy command" });
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await navigator.clipboard.readText()).toBe(COMMAND);
    await navigator.clipboard.writeText("");
    await user.keyboard(" ");
    expect(await navigator.clipboard.readText()).toBe(COMMAND);
  });

  it("clears the feedback after a moment", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = renderInSentence();
    await user.click(screen.getByRole("button", { name: "Copy command" }));
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("selects the command and says to type it when the clipboard refuses", async () => {
    const user = renderInSentence();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    await user.click(screen.getByRole("button", { name: "Copy command" }));
    expect(screen.getByRole("status")).toHaveTextContent(`Couldn’t copy. Type ${COMMAND} in a terminal instead.`);
    expect(screen.getByRole("status")).not.toHaveTextContent("Copied");
    expect(window.getSelection()?.toString()).toBe(COMMAND);
  });
});
