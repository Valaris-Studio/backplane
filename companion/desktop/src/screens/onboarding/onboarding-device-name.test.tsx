// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetOnboardingForTests } from "./onboarding-store";
import { NOW, SERVER_URL, TICKET, apiError, disconnectedStatus, renderApp, type Handlers } from "./test-support";

const FAKE_CLOCK: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], shouldAdvanceTime: true };

const MAC_NAME = "Ada’s MacBook Pro";

function activeView(): HTMLElement {
  const views = [...screen.getByTestId("screen-onboarding").querySelectorAll<HTMLElement>("[data-view]")];
  const active = views.find((view) => view.dataset.leaving !== "true");
  if (!active) throw new Error("no active onboarding view");
  return active;
}

const inView = () => within(activeView());
const deviceNameField = () => inView().getByRole("textbox", { name: "Device name" });

function user() {
  return userEvent.setup({ delay: null });
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function pairingHandlers(overrides: Handlers = {}): Handlers {
  return { pair_start: () => TICKET, pair_poll: () => ({ state: "pending" }), pair_cancel: () => ({ cancelled: true }), ...overrides };
}

async function goToServer(suggestion: string | null, handlers: Handlers) {
  const { daemon } = await renderApp({ ...disconnectedStatus, suggested_device_name: suggestion }, handlers);
  await user().click(inView().getByRole("button", { name: "Get started" }));
  return daemon;
}

type Daemon = Awaited<ReturnType<typeof renderApp>>["daemon"];

/**
 * Remounts the server step. jsdom never finishes ViewSwap's exit, so Back
 * then forward would revive the same instance; a daemon drop unmounts the
 * whole onboarding screen instead, as a real remount does.
 */
async function remountServerStep(daemon: Daemon, suggestion: string | null = MAC_NAME) {
  act(() => daemon.emit({ type: "daemon.unreachable", data: { reason: "control_file_missing" } }));
  await flush();
  expect(screen.queryByTestId("screen-onboarding")).not.toBeInTheDocument();
  act(() => {
    daemon.emit({ type: "daemon.connected" });
    daemon.emit({ type: "status", data: { ...disconnectedStatus, suggested_device_name: suggestion } });
  });
  await flush();
  expect(inView().getByRole("heading", { level: 1 })).toHaveTextContent("Where is your Backplane?");
}

async function pressContinue() {
  const address = inView().getByRole("textbox", { name: "Server address" });
  if (!(address as HTMLInputElement).value) await user().type(address, SERVER_URL);
  await user().click(inView().getByRole("button", { name: "Continue" }));
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers(FAKE_CLOCK);
  vi.setSystemTime(NOW);
  localStorage.clear();
  resetOnboardingForTests();
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  resetOnboardingForTests();
});

describe("Device name", () => {
  it("is prefilled with this computer’s name and sent only when the user continues", async () => {
    const pairStart = vi.fn(() => TICKET);
    await goToServer(MAC_NAME, pairingHandlers({ pair_start: pairStart }));
    expect(deviceNameField()).toHaveValue(MAC_NAME);
    expect(pairStart).not.toHaveBeenCalled();
    await pressContinue();
    expect(pairStart).toHaveBeenCalledWith({ endpoint: SERVER_URL, name: MAC_NAME, replace: null });
  });

  it("sends the name as the user edited it, trimmed", async () => {
    const pairStart = vi.fn(() => TICKET);
    await goToServer(MAC_NAME, pairingHandlers({ pair_start: pairStart }));
    await user().clear(deviceNameField());
    await user().type(deviceNameField(), "  Studio Mac  ");
    await pressContinue();
    expect(pairStart).toHaveBeenCalledWith({ endpoint: SERVER_URL, name: "Studio Mac", replace: null });
  });

  it("starts empty, with the neutral default as its placeholder, when the computer has no usable name", async () => {
    const pairStart = vi.fn(() => TICKET);
    await goToServer(null, pairingHandlers({ pair_start: pairStart }));
    expect(deviceNameField()).toHaveValue("");
    expect(deviceNameField()).toHaveAttribute("placeholder", "A generic name, like darwin-arm64-…");
    await pressContinue();
    expect(pairStart).toHaveBeenCalledWith({ endpoint: SERVER_URL, name: null, replace: null });
  });

  it("falls back to the neutral default when the user clears the name", async () => {
    const pairStart = vi.fn(() => TICKET);
    await goToServer(MAC_NAME, pairingHandlers({ pair_start: pairStart }));
    await user().clear(deviceNameField());
    await pressContinue();
    expect(pairStart).toHaveBeenCalledWith({ endpoint: SERVER_URL, name: null, replace: null });
  });

  it("refuses a name longer than 80 characters without calling the daemon", async () => {
    const pairStart = vi.fn(() => TICKET);
    await goToServer(MAC_NAME, pairingHandlers({ pair_start: pairStart }));
    fireEvent.change(deviceNameField(), { target: { value: "é".repeat(81) } });
    await pressContinue();
    expect(deviceNameField()).toHaveAttribute("aria-invalid", "true");
    expect(deviceNameField()).toHaveAccessibleDescription("Keep it to 80 characters or fewer.");
    expect(deviceNameField()).toHaveFocus();
    expect(pairStart).not.toHaveBeenCalled();
  });

  it("accepts exactly 80 characters, counting an emoji as one", async () => {
    const pairStart = vi.fn(() => TICKET);
    await goToServer(null, pairingHandlers({ pair_start: pairStart }));
    const name = "🖥️".slice(0, 2) + "a".repeat(79);
    fireEvent.change(deviceNameField(), { target: { value: name } });
    await pressContinue();
    expect(pairStart).toHaveBeenCalledWith({ endpoint: SERVER_URL, name, replace: null });
  });

  it("refuses control and bidi characters without calling the daemon", async () => {
    const pairStart = vi.fn(() => TICKET);
    await goToServer(MAC_NAME, pairingHandlers({ pair_start: pairStart }));
    for (const value of ["Mac‮orp", "Mac\u0007"]) {
      fireEvent.change(deviceNameField(), { target: { value } });
      await pressContinue();
      expect(deviceNameField()).toHaveAccessibleDescription("Use letters, numbers, spaces and punctuation only.");
    }
    expect(pairStart).not.toHaveBeenCalled();
  });

  it("clears the error once the name is edited", async () => {
    await goToServer(MAC_NAME, pairingHandlers());
    fireEvent.change(deviceNameField(), { target: { value: "é".repeat(81) } });
    await pressContinue();
    await user().type(deviceNameField(), "{Backspace}");
    expect(deviceNameField()).not.toHaveAttribute("aria-invalid", "true");
  });

  it("keeps the confirmed name when a new code is needed", async () => {
    let calls = 0;
    const pairStart = vi.fn(() => {
      calls += 1;
      return calls === 1 ? TICKET : { ...TICKET, pairing_id: "pair-2" };
    });
    await goToServer(MAC_NAME, pairingHandlers({ pair_start: pairStart, pair_poll: () => { throw apiError(410, "pairing_expired"); } }));
    await user().clear(deviceNameField());
    await user().type(deviceNameField(), "Studio Mac");
    await pressContinue();
    await flush(5_000);
    await user().click(inView().getByRole("button", { name: "Get a new code" }));
    await flush();
    expect(pairStart).toHaveBeenLastCalledWith({ endpoint: SERVER_URL, name: "Studio Mac", replace: null });
  });

  it("keeps an edited name when the step remounts", async () => {
    const daemon = await goToServer(MAC_NAME, pairingHandlers());
    await user().clear(deviceNameField());
    await user().type(deviceNameField(), "Studio Mac");
    await remountServerStep(daemon);
    expect(deviceNameField()).toHaveValue("Studio Mac");
  });

  it("keeps a deliberately cleared name empty when the step remounts, and withholds it", async () => {
    const pairStart = vi.fn(() => TICKET);
    const daemon = await goToServer(MAC_NAME, pairingHandlers({ pair_start: pairStart }));
    await user().clear(deviceNameField());
    await remountServerStep(daemon);
    expect(deviceNameField()).toHaveValue("");
    await pressContinue();
    expect(pairStart).toHaveBeenCalledWith({ endpoint: SERVER_URL, name: null, replace: null });
  });

  it("still takes a suggestion that arrives while the name is untouched", async () => {
    const daemon = await goToServer(null, pairingHandlers());
    expect(deviceNameField()).toHaveValue("");
    await remountServerStep(daemon, MAC_NAME);
    expect(deviceNameField()).toHaveValue(MAC_NAME);
  });
});
