// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));

import { copyTextToClipboard } from "../clipboard";

// navigator.clipboard is undefined in jsdom by default (matches real browsers on
// non-secure-context HTTP origins), so each test explicitly installs or removes it
// rather than relying on jsdom's baseline.
function stubSecureClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
}

function removeClipboard() {
  Object.defineProperty(navigator, "clipboard", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

describe("copyTextToClipboard", () => {
  let execCommandSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    toastError.mockClear();
    execCommandSpy = vi.fn().mockReturnValue(true);
    // vi.fn()'s loose signature doesn't structurally match the DOM's
    // execCommand(commandId, showUI?, value?) — cast for the assignment only.
    document.execCommand = execCommandSpy as unknown as typeof document.execCommand;
  });

  afterEach(() => {
    removeClipboard();
    vi.restoreAllMocks();
  });

  it("uses navigator.clipboard.writeText when available and returns true", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubSecureClipboard(writeText);

    const result = await copyTextToClipboard("secret-value");

    expect(result).toBe(true);
    expect(writeText).toHaveBeenCalledWith("secret-value");
  });

  it("does not touch the DOM or show a toast on the secure clipboard path", async () => {
    stubSecureClipboard(vi.fn().mockResolvedValue(undefined));
    const textareasBefore = document.querySelectorAll("textarea").length;

    await copyTextToClipboard("secret-value");

    expect(document.querySelectorAll("textarea").length).toBe(textareasBefore);
    expect(execCommandSpy).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("falls back to execCommand when navigator.clipboard is undefined (non-secure HTTP origin)", async () => {
    removeClipboard();

    const result = await copyTextToClipboard("fallback-value");

    expect(result).toBe(true);
    expect(execCommandSpy).toHaveBeenCalledWith("copy");
  });

  it("never throws when navigator.clipboard is undefined", async () => {
    removeClipboard();

    await expect(copyTextToClipboard("fallback-value")).resolves.not.toThrow();
  });

  it("falls through to execCommand when navigator.clipboard.writeText rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    stubSecureClipboard(writeText);

    const result = await copyTextToClipboard("permission-denied-value");

    expect(result).toBe(true);
    expect(writeText).toHaveBeenCalled();
    expect(execCommandSpy).toHaveBeenCalledWith("copy");
  });

  it("removes the fallback textarea from the DOM after a successful execCommand copy", async () => {
    removeClipboard();
    const textareasBefore = document.querySelectorAll("textarea").length;

    await copyTextToClipboard("cleanup-value");

    expect(document.querySelectorAll("textarea").length).toBe(textareasBefore);
  });

  it("returns false and shows exactly one error toast when both clipboard paths fail", async () => {
    removeClipboard();
    execCommandSpy.mockReturnValue(false);

    const result = await copyTextToClipboard("unreachable-value");

    expect(result).toBe(false);
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("never throws even when execCommand itself throws", async () => {
    removeClipboard();
    execCommandSpy.mockImplementation(() => {
      throw new Error("execCommand not supported");
    });

    await expect(copyTextToClipboard("throws-value")).resolves.not.toThrow();
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("removes the fallback textarea from the DOM even when both copy paths fail", async () => {
    removeClipboard();
    execCommandSpy.mockReturnValue(false);
    const textareasBefore = document.querySelectorAll("textarea").length;

    await copyTextToClipboard("unreachable-value");

    expect(document.querySelectorAll("textarea").length).toBe(textareasBefore);
  });

  it("restores focus to the previously focused element after a successful fallback copy", async () => {
    removeClipboard();
    const previouslyFocused = document.createElement("button");
    document.body.appendChild(previouslyFocused);
    previouslyFocused.focus();
    expect(document.activeElement).toBe(previouslyFocused);

    await copyTextToClipboard("focus-preserving-value");

    expect(document.activeElement).toBe(previouslyFocused);
    document.body.removeChild(previouslyFocused);
  });

  it("restores focus to the previously focused element even when the fallback copy fails", async () => {
    removeClipboard();
    execCommandSpy.mockReturnValue(false);
    const previouslyFocused = document.createElement("input");
    document.body.appendChild(previouslyFocused);
    previouslyFocused.focus();
    expect(document.activeElement).toBe(previouslyFocused);

    await copyTextToClipboard("focus-preserving-failure-value");

    expect(document.activeElement).toBe(previouslyFocused);
    document.body.removeChild(previouslyFocused);
  });
});
