// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../App";
import { setPlatformForTests } from "../../platform/platform";
import { render } from "@testing-library/react";
import { ONBOARDING_FINISHED_KEY } from "./constants";
import { resetOnboardingForTests } from "./onboarding-store";
import {
  AGENTS,
  DAEMON_DOWN,
  NOW,
  PROJECTS,
  SERVER_URL,
  TICKET,
  apiError,
  connectedStatus,
  disconnectedStatus,
  renderApp,
  renderSetup,
  type Handlers,
} from "./test-support";

// shouldAdvanceTime: Testing Library's async wrapper awaits a real-looking setTimeout(0) it can only
// advance under Jest, so the fake clock must also creep forward on its own.
const FAKE_CLOCK: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], shouldAdvanceTime: true };

/** The step on screen: ViewSwap may still hold the previous one while it slides out. */
function activeView(): HTMLElement {
  const views = [...screen.getByTestId("screen-onboarding").querySelectorAll<HTMLElement>("[data-view]")];
  const active = views.find((view) => view.dataset.leaving !== "true");
  if (!active) throw new Error("no active onboarding view");
  return active;
}

const inView = () => within(activeView());
const stepHeading = () => inView().getByRole("heading", { level: 1 });

// user-event installs its own clipboard on every setup(), so these tests click with fireEvent after stubbing.
function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

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

async function goToServer(handlers: Handlers = pairingHandlers(), address: string | null = SERVER_URL) {
  const rendered = await renderApp(disconnectedStatus, handlers);
  await user().click(inView().getByRole("button", { name: "Get started" }));
  if (address) await user().type(addressField(), address);
  return rendered;
}

function addressField() {
  return inView().getByRole("textbox", { name: "Server address" });
}

async function goToCode(handlers: Handlers = pairingHandlers()) {
  const rendered = await goToServer(handlers);
  await user().click(inView().getByRole("button", { name: "Continue" }));
  await flush();
  return rendered;
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

describe("Welcome", () => {
  it("opens on the three promises before anything is asked", async () => {
    await renderApp(disconnectedStatus);
    expect(stepHeading()).toHaveTextContent("See which sessions worked on which card");
    for (const promise of ["Only folders you bind", "You choose what’s sent", "Pause any time"]) {
      expect(inView().getByText(promise)).toBeInTheDocument();
    }
    expect(inView().queryByText("You choose what’s kept")).not.toBeInTheDocument();
    expect(inView().getByRole("img", { name: "Step 1 of 5" })).toBeInTheDocument();
    expect(inView().queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  });

  it("names all three levels in the what’s-sent promise", async () => {
    await renderApp(disconnectedStatus);
    expect(
      inView().getByText(
        "Per project. Metadata sends activity only. Standard, the default, adds your prompts and commands. Full adds tool output and the agent’s replies.",
      ),
    ).toBeInTheDocument();
    expect(activeView()).not.toHaveTextContent(/titles and tool names too/);
  });

  it("promises pausing from the tray menu or the window on Linux", async () => {
    setPlatformForTests("linux");
    await renderApp(disconnectedStatus);
    expect(inView().getByText("From the tray icon’s menu, or the pause button in this window.")).toBeInTheDocument();
    expect(inView().queryByText(/in one click/)).not.toBeInTheDocument();
  });

  it("moves to the server step and focuses its heading", async () => {
    await goToServer(pairingHandlers(), null);
    expect(stepHeading()).toHaveTextContent("Where is your Backplane?");
    expect(stepHeading()).toHaveFocus();
    expect(inView().getByRole("img", { name: "Step 2 of 5" })).toBeInTheDocument();
  });

  it("skips the welcome for a Mac that finished onboarding before and was disconnected", async () => {
    localStorage.setItem(ONBOARDING_FINISHED_KEY, "1");
    await renderApp(disconnectedStatus);
    expect(stepHeading()).toHaveTextContent("Where is your Backplane?");
  });
});

describe("Server", () => {
  it("asks for the server address with nothing filled in, and pairs with what the user enters", async () => {
    const pairStart = vi.fn(() => TICKET);
    await goToServer(pairingHandlers({ pair_start: pairStart }), null);
    expect(addressField()).toHaveValue("");
    expect(addressField()).toBeRequired();
    await user().type(addressField(), SERVER_URL);
    await user().click(inView().getByRole("button", { name: "Continue" }));
    await flush();
    expect(pairStart).toHaveBeenCalledWith({ endpoint: SERVER_URL, name: null, replace: null });
    expect(stepHeading()).toHaveTextContent("Approve this Mac in Backplane");
  });

  it("refuses an empty address without calling the daemon", async () => {
    const pairStart = vi.fn(() => TICKET);
    await goToServer(pairingHandlers({ pair_start: pairStart }), null);
    await user().click(inView().getByRole("button", { name: "Continue" }));
    expect(addressField()).toHaveAttribute("aria-invalid", "true");
    expect(addressField()).toHaveAccessibleDescription("Enter your server’s address.");
    expect(addressField()).toHaveFocus();
    expect(pairStart).not.toHaveBeenCalled();
  });

  it("offers no preset server", async () => {
    await goToServer(pairingHandlers(), null);
    expect(inView().queryByRole("radio")).not.toBeInTheDocument();
    expect(inView().queryByRole("button", { name: /Advanced/ })).not.toBeInTheDocument();
  });

  it("prefills the address a development or test build was configured with", async () => {
    vi.stubEnv("VITE_COMPANION_SERVER_URL", "https://staging.example.dev");
    try {
      await goToServer(pairingHandlers(), null);
      expect(addressField()).toHaveValue("https://staging.example.dev");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("goes back to the welcome with Back", async () => {
    await goToServer();
    await user().click(inView().getByRole("button", { name: "Back" }));
    expect(stepHeading()).toHaveTextContent("See which sessions worked on which card");
    expect(stepHeading()).toHaveFocus();
  });

  it("refuses a plain http address without calling the daemon", async () => {
    const pairStart = vi.fn(() => TICKET);
    await goToServer(pairingHandlers({ pair_start: pairStart }), null);
    const field = inView().getByRole("textbox", { name: "Server address" });
    await user().type(field, "http://backplane.example.dev");
    await user().click(inView().getByRole("button", { name: "Continue" }));
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("Use an https:// address.");
    expect(field).toHaveFocus();
    expect(pairStart).not.toHaveBeenCalled();
  });

  it("refuses an https prefix that is not a valid address", async () => {
    const pairStart = vi.fn(() => TICKET);
    await goToServer(pairingHandlers({ pair_start: pairStart }), null);
    const field = inView().getByRole("textbox", { name: "Server address" });
    await user().type(field, "https://exa mple");
    await user().click(inView().getByRole("button", { name: "Continue" }));
    expect(field).toHaveAccessibleDescription("That isn’t a valid web address.");
    expect(pairStart).not.toHaveBeenCalled();
  });

  it("pairs with a valid custom address submitted with Enter", async () => {
    const pairStart = vi.fn(() => TICKET);
    await goToServer(pairingHandlers({ pair_start: pairStart }), null);
    await user().type(inView().getByRole("textbox", { name: "Server address" }), "https://backplane.northwind.dev{Enter}");
    await flush();
    expect(pairStart).toHaveBeenCalledWith({ endpoint: "https://backplane.northwind.dev", name: null, replace: null });
    expect(stepHeading()).toHaveTextContent("Approve this Mac in Backplane");
  });

  it("sends the address normalised the way the daemon stores it", async () => {
    const pairStart = vi.fn(() => TICKET);
    await goToServer(pairingHandlers({ pair_start: pairStart }), null);
    await user().type(inView().getByRole("textbox", { name: "Server address" }), "HTTPS://Backplane.Northwind.dev/{Enter}");
    await flush();
    expect(pairStart).toHaveBeenCalledWith({ endpoint: "https://backplane.northwind.dev", name: null, replace: null });
  });

  it("refuses an address with a query before calling the daemon", async () => {
    const pairStart = vi.fn(() => TICKET);
    await goToServer(pairingHandlers({ pair_start: pairStart }), null);
    const field = inView().getByRole("textbox", { name: "Server address" });
    await user().type(field, "https://backplane.northwind.dev/?team=a{Enter}");
    expect(field).toHaveAccessibleDescription("Use just the server’s address, without ? or #.");
    expect(pairStart).not.toHaveBeenCalled();
  });

  it("drops a pairing that arrives after Back, and cancels it", async () => {
    let resolveStart: (ticket: typeof TICKET) => void = () => {};
    const pairStart = vi.fn(() => new Promise<typeof TICKET>((resolve) => { resolveStart = resolve; }));
    const cancel = vi.fn(() => ({ cancelled: true }));
    await goToServer(pairingHandlers({ pair_start: pairStart, pair_cancel: cancel }));
    await user().click(inView().getByRole("button", { name: "Continue" }));
    await flush();
    await user().click(inView().getByRole("button", { name: "Back" }));
    expect(stepHeading()).toHaveTextContent("See which sessions worked on which card");
    resolveStart(TICKET);
    await flush();
    expect(stepHeading()).toHaveTextContent("See which sessions worked on which card");
    expect(cancel).toHaveBeenCalledWith({ pairingId: "pair-1" });
  });

  it("stays on the server step when the server can't be reached", async () => {
    await goToServer(pairingHandlers({ pair_start: () => { throw apiError(502, "server_unreachable"); } }));
    await user().click(inView().getByRole("button", { name: "Continue" }));
    await flush();
    expect(stepHeading()).toHaveTextContent("Where is your Backplane?");
    const alert = inView().getByRole("alert");
    expect(alert).toHaveTextContent("Can’t reach backplane.example.dev");
    expect(alert).toHaveTextContent("No Backplane server answered at this address.");
  });

  it("stays on the server step when the server refuses pairing", async () => {
    await goToServer(pairingHandlers({ pair_start: () => { throw apiError(502, "server_rejected"); } }));
    await user().click(inView().getByRole("button", { name: "Continue" }));
    await flush();
    expect(stepHeading()).toHaveTextContent("Where is your Backplane?");
    expect(inView().getByRole("alert")).toHaveTextContent("backplane.example.dev didn’t accept this Mac");
  });

  it("marks a custom address invalid when that server can't be reached", async () => {
    await goToServer(pairingHandlers({ pair_start: () => { throw apiError(502, "server_unreachable"); } }), null);
    const field = inView().getByRole("textbox", { name: "Server address" });
    await user().type(field, "https://nope.example.dev{Enter}");
    await flush();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(inView().getByRole("alert")).toHaveTextContent("Can’t reach nope.example.dev");
  });

  it("goes straight to agents when the daemon says the Mac is already connected", async () => {
    await goToServer(pairingHandlers({ pair_start: () => { throw apiError(409, "already_connected"); }, agents: () => AGENTS }));
    await user().click(inView().getByRole("button", { name: "Continue" }));
    await flush();
    expect(stepHeading()).toHaveTextContent("Capture from these agents");
  });

  it("explains a revoked device and starts again after disconnecting it", async () => {
    let revoked = true;
    const disconnect = vi.fn(() => {
      revoked = false;
      return { connected: false, server_revoked: true };
    });
    const pairStart = vi.fn(() => {
      if (revoked) throw apiError(401, "unauthorized_device");
      return TICKET;
    });
    await goToServer(pairingHandlers({ pair_start: pairStart, disconnect }));
    await user().click(inView().getByRole("button", { name: "Continue" }));
    await flush();
    expect(inView().getByRole("alert")).toHaveTextContent("This Mac’s old connection was revoked");
    await user().click(inView().getByRole("button", { name: "Start again" }));
    await flush();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(pairStart).toHaveBeenCalledTimes(2);
    expect(stepHeading()).toHaveTextContent("Approve this Mac in Backplane");
  });

  it("explains a locked keychain in plain words", async () => {
    await goToServer(pairingHandlers({ pair_start: () => { throw apiError(503, "secure_credential_store_unavailable", "OS credential store"); } }));
    await user().click(inView().getByRole("button", { name: "Continue" }));
    await flush();
    const alert = inView().getByRole("alert");
    expect(alert).toHaveTextContent("Your keychain isn’t available");
    expect(alert).toHaveTextContent("Nothing was stored.");
    expect(alert).not.toHaveTextContent("OS credential store");
  });

  it("shows any other daemon error with its message", async () => {
    await goToServer(pairingHandlers({ pair_start: () => { throw apiError(400, "invalid_request", "endpoint must be an https:// URL"); } }));
    await user().click(inView().getByRole("button", { name: "Continue" }));
    await flush();
    const alert = inView().getByRole("alert");
    expect(alert).toHaveTextContent("Couldn’t start pairing");
    expect(alert).toHaveTextContent("Companion couldn’t understand that request.");
    expect(alert).not.toHaveTextContent("endpoint must be an https:// URL");
  });

  it("says Companion isn't running when the daemon is down, and retries", async () => {
    let down = true;
    const pairStart = vi.fn(() => {
      if (down) throw DAEMON_DOWN;
      return TICKET;
    });
    await goToServer(pairingHandlers({ pair_start: pairStart }));
    await user().click(inView().getByRole("button", { name: "Continue" }));
    await flush();
    expect(inView().getByRole("heading", { name: "Companion isn't running" })).toBeInTheDocument();
    down = false;
    await user().click(inView().getByRole("button", { name: "Try again" }));
    await flush();
    expect(pairStart).toHaveBeenCalledTimes(2);
    expect(stepHeading()).toHaveTextContent("Approve this Mac in Backplane");
  });
});

describe("Code", () => {
  it("shows the code large with the time left and waits for approval", async () => {
    await goToCode();
    expect(inView().getByLabelText("Code KMTR-XQBW")).toHaveTextContent("KMTR–XQBW");
    expect(inView().getByText("Waiting for you to approve in Backplane")).toBeInTheDocument();
    expect(inView().getByText("10:00")).toBeInTheDocument();
    expect(inView().getByRole("img", { name: "Step 3 of 5" })).toBeInTheDocument();
    expect(stepHeading()).toHaveFocus();
  });

  it("counts down and drains the meter as time passes", async () => {
    await goToCode();
    await flush(65_000);
    expect(inView().getByText("8:55")).toBeInTheDocument();
    const meter = screen.getByTestId("code-meter");
    expect(Number(meter.getAttribute("value"))).toBeCloseTo(535 / 600, 2);
  });

  it("polls at the interval the daemon gave", async () => {
    const poll = vi.fn(() => ({ state: "pending" }));
    await goToCode(pairingHandlers({ pair_poll: poll }));
    expect(poll).not.toHaveBeenCalled();
    await flush(5_000);
    expect(poll).toHaveBeenCalledWith({ pairingId: "pair-1" });
    await flush(5_000);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("copies the code to the clipboard", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    await goToCode();
    stubClipboard(writeText);
    fireEvent.click(inView().getByRole("button", { name: "Copy code" }));
    await flush();
    expect(writeText).toHaveBeenCalledWith("KMTR-XQBW");
    expect(inView().getByRole("button", { name: "Copied" })).toBeInTheDocument();
    const announcement = screen.getByTestId("copy-status");
    expect(announcement).toHaveAttribute("role", "status");
    expect(announcement).toHaveTextContent("Code copied");
  });

  it("falls back to a selected code when the clipboard is blocked", async () => {
    await goToCode();
    stubClipboard(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    fireEvent.click(inView().getByRole("button", { name: "Copy code" }));
    await flush();
    expect(inView().getByText("Copying isn’t allowed here. The code is selected, so press ⌘C.")).toBeInTheDocument();
    expect(window.getSelection()?.toString().replace(/\s/g, "")).toContain("KMTR");
  });

  it("opens the approval page with the code filled in", async () => {
    const open = vi.fn(() => null);
    await goToCode(pairingHandlers({ open_backplane_url: open }));
    await user().click(inView().getByRole("button", { name: "Open Backplane" }));
    await flush();
    expect(open).toHaveBeenCalledWith({ url: TICKET.verification_uri_complete });
  });

  it("tells the user where to go when the opener refuses the link", async () => {
    await goToCode(pairingHandlers({ open_backplane_url: () => { throw { kind: "invalid_input", message: "not connected to Backplane" }; } }));
    await user().click(inView().getByRole("button", { name: "Open Backplane" }));
    await flush();
    expect(inView().getByText(/Couldn’t open Backplane from here\. Go to/)).toHaveTextContent(TICKET.verification_uri);
  });

  it("moves on to agents once the pairing connects", async () => {
    const { daemon } = await goToCode(pairingHandlers({ pair_poll: () => ({ state: "connected", installation_id: "inst-1" }), agents: () => AGENTS }));
    await flush(5_000);
    act(() => daemon.emit({ type: "status", data: connectedStatus }));
    await flush();
    expect(stepHeading()).toHaveTextContent("Capture from these agents");
    expect(stepHeading()).toHaveFocus();
  });

  it("still lists the agents after the new account's status replaces the old one", async () => {
    const { daemon } = await goToCode(pairingHandlers({ pair_poll: () => ({ state: "connected", installation_id: "inst-1" }), agents: () => AGENTS }));
    await flush(5_000);
    expect(inView().getByRole("listitem", { name: "Claude Code" })).toBeInTheDocument();
    act(() => daemon.emit({ type: "status", data: connectedStatus }));
    await flush();
    expect(inView().getByRole("listitem", { name: "Claude Code" })).toBeInTheDocument();
  });

  it("drains the meter over the ticket's own lifetime and says how long codes last", async () => {
    const issued = { ...TICKET, issued_at: "2026-09-28T09:58:00Z" };
    await goToCode(pairingHandlers({ pair_start: () => issued, pair_poll: () => { throw apiError(410, "pairing_expired"); } }));
    expect(Number(screen.getByTestId("code-meter").getAttribute("value"))).toBeCloseTo(600 / 720, 2);
    await flush(5_000);
    expect(inView().getByRole("alert")).toHaveTextContent("Codes last 12 minutes. Get a new one and try again.");
  });

  it("focuses the new code after getting one", async () => {
    let expired = true;
    await goToCode(pairingHandlers({ pair_start: () => (expired ? TICKET : { ...TICKET, pairing_id: "pair-2" }), pair_poll: () => { throw apiError(410, "pairing_expired"); } }));
    await flush(5_000);
    expired = false;
    await user().click(inView().getByRole("button", { name: "Get a new code" }));
    await flush();
    expect(inView().getByRole("group", { name: "Code KMTR-XQBW" })).toHaveFocus();
  });

  it("drops a new code that arrives after Back, and cancels both", async () => {
    let resolveStart: (ticket: typeof TICKET) => void = () => {};
    let calls = 0;
    const pairStart = vi.fn(() => {
      calls += 1;
      if (calls === 1) return TICKET;
      return new Promise<typeof TICKET>((resolve) => { resolveStart = resolve; });
    });
    const cancel = vi.fn(() => ({ cancelled: true }));
    await goToCode(pairingHandlers({ pair_start: pairStart, pair_cancel: cancel, pair_poll: () => { throw apiError(410, "pairing_expired"); } }));
    await flush(5_000);
    await user().click(inView().getByRole("button", { name: "Get a new code" }));
    await flush();
    await user().click(inView().getByRole("button", { name: "Back" }));
    await flush();
    expect(stepHeading()).toHaveTextContent("Where is your Backplane?");
    resolveStart({ ...TICKET, pairing_id: "pair-2" });
    await flush();
    expect(stepHeading()).toHaveTextContent("Where is your Backplane?");
    expect(cancel).toHaveBeenCalledWith({ pairingId: "pair-1" });
    expect(cancel).toHaveBeenCalledWith({ pairingId: "pair-2" });
  });

  it("strikes an expired code and gets a new one", async () => {
    const pairStart = vi.fn(() => TICKET);
    await goToCode(pairingHandlers({ pair_start: pairStart, pair_poll: () => { throw apiError(410, "pairing_expired"); } }));
    await flush(5_000);
    const alert = inView().getByRole("alert");
    expect(alert).toHaveTextContent("This code expired");
    expect(inView().queryByRole("button", { name: "Copy code" })).not.toBeInTheDocument();
    expect(screen.getByTestId("code-card")).toHaveAttribute("data-state", "expired");
    await user().click(inView().getByRole("button", { name: "Get a new code" }));
    await flush();
    expect(pairStart).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("code-card")).toHaveAttribute("data-state", "waiting");
  });

  it("expires the code on its own when the countdown runs out", async () => {
    const poll = vi.fn(() => ({ state: "pending" }));
    await goToCode(pairingHandlers({ pair_poll: poll }));
    await flush(600_000);
    expect(inView().getByRole("alert")).toHaveTextContent("This code expired");
    const polls = poll.mock.calls.length;
    await flush(30_000);
    expect(poll).toHaveBeenCalledTimes(polls);
  });

  it("says calmly that a denied request leaves the Mac disconnected", async () => {
    const pairStart = vi.fn(() => TICKET);
    await goToCode(pairingHandlers({ pair_start: pairStart, pair_poll: () => { throw apiError(403, "pairing_denied"); } }));
    await flush(5_000);
    expect(inView().getByRole("alert")).toHaveTextContent("The request was declined in Backplane");
    expect(inView().getByRole("alert")).toHaveTextContent("This Mac stays disconnected.");
    await user().click(inView().getByRole("button", { name: "Start again" }));
    await flush();
    expect(pairStart).toHaveBeenCalledTimes(2);
  });

  it("shows a failed pairing's message with a retry", async () => {
    const pairStart = vi.fn(() => TICKET);
    await goToCode(pairingHandlers({ pair_start: pairStart, pair_poll: () => { throw apiError(422, "pairing_failed", "The pairing failed; start again."); } }));
    await flush(5_000);
    const alert = inView().getByRole("alert");
    expect(alert).toHaveTextContent("Pairing didn’t finish");
    expect(alert).toHaveTextContent("Nothing was connected. Get a new code and try again.");
    expect(alert).not.toHaveTextContent("The pairing failed; start again.");
    await user().click(inView().getByRole("button", { name: "Try again" }));
    await flush();
    expect(pairStart).toHaveBeenCalledTimes(2);
  });

  it("keeps polling behind a banner while the server is unreachable", async () => {
    let offline = true;
    const poll = vi.fn(() => {
      if (offline) throw apiError(502, "server_unreachable");
      return { state: "pending" };
    });
    await goToCode(pairingHandlers({ pair_poll: poll }));
    await flush(5_000);
    expect(inView().getByRole("alert")).toHaveTextContent("Can’t reach backplane.example.dev");
    expect(inView().getByText("Can’t reach the server. Retrying on its own.")).toBeInTheDocument();
    expect(inView().getByRole("button", { name: "Copy code" })).toBeInTheDocument();
    offline = false;
    await flush(5_000);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(inView().queryByRole("alert")).not.toBeInTheDocument();
    expect(inView().getByText("Waiting for you to approve in Backplane")).toBeInTheDocument();
  });

  it("explains a keychain failure while finishing the pairing", async () => {
    await goToCode(pairingHandlers({ pair_poll: () => { throw apiError(503, "secure_credential_store_unavailable"); } }));
    await flush(5_000);
    expect(inView().getByRole("alert")).toHaveTextContent("Your keychain isn’t available");
    expect(inView().getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("says Companion isn't running when polling loses the daemon, and resumes", async () => {
    let down = true;
    const poll = vi.fn(() => {
      if (down) throw DAEMON_DOWN;
      return { state: "pending" };
    });
    await goToCode(pairingHandlers({ pair_poll: poll }));
    await flush(5_000);
    expect(inView().getByRole("heading", { name: "Companion isn't running" })).toBeInTheDocument();
    down = false;
    await user().click(inView().getByRole("button", { name: "Try again" }));
    await flush();
    expect(poll).toHaveBeenCalledTimes(2);
    expect(inView().getByLabelText("Code KMTR-XQBW")).toBeInTheDocument();
  });

  it("cancels the pairing when the user goes back", async () => {
    const cancel = vi.fn(() => ({ cancelled: true }));
    const poll = vi.fn(() => ({ state: "pending" }));
    await goToCode(pairingHandlers({ pair_cancel: cancel, pair_poll: poll }));
    await user().click(inView().getByRole("button", { name: "Back" }));
    await flush();
    expect(cancel).toHaveBeenCalledWith({ pairingId: "pair-1" });
    expect(stepHeading()).toHaveTextContent("Where is your Backplane?");
    await flush(20_000);
    expect(poll).not.toHaveBeenCalled();
  });
});

describe("Revocation mid-setup", () => {
  it("goes back to pairing when the Mac is disconnected after the pairing connected", async () => {
    const { daemon } = await goToCode(pairingHandlers({ pair_poll: () => ({ state: "connected", installation_id: "inst-1" }), agents: () => AGENTS }));
    await flush(5_000);
    act(() => daemon.emit({ type: "status", data: connectedStatus }));
    await flush();
    expect(stepHeading()).toHaveTextContent("Capture from these agents");
    act(() => daemon.emit({ type: "status", data: disconnectedStatus }));
    await flush();
    expect(stepHeading()).toHaveTextContent("See which sessions worked on which card");
  });

  it("stays on agents while the status has not caught up with the pairing yet", async () => {
    const { daemon } = await goToCode(pairingHandlers({ pair_poll: () => ({ state: "connected", installation_id: "inst-1" }), agents: () => AGENTS }));
    await flush(5_000);
    act(() => daemon.emit({ type: "status", data: disconnectedStatus }));
    await flush();
    expect(stepHeading()).toHaveTextContent("Capture from these agents");
  });
});

describe("Daemon drops", () => {
  it("keeps Projects and its Bound and Skipped labels through a daemon drop and reconnect", async () => {
    const { daemon } = await renderSetup({ mapping_create: () => ({ id: "map-1" }) });
    await user().click(inView().getByRole("button", { name: "Continue" }));
    await flush();
    await user().click(within(inView().getByRole("listitem", { name: "backplane" })).getByRole("button", { name: "Bind" }));
    await flush();
    await user().click(within(inView().getByRole("listitem", { name: "dotfiles" })).getByRole("button", { name: "Skip" }));
    act(() => daemon.emit({ type: "daemon.unreachable", data: { reason: "control_file_missing" } }));
    await flush();
    expect(screen.getByRole("heading", { name: "Companion isn't running" })).toBeInTheDocument();
    act(() => {
      daemon.emit({ type: "daemon.connected" });
      daemon.emit({ type: "status", data: connectedStatus });
      daemon.emit({ type: "projects", data: { ...PROJECTS, discovered: PROJECTS.discovered.slice(1) } });
    });
    await flush();
    expect(stepHeading()).toHaveTextContent("Bind your first projects");
    expect(within(inView().getByRole("listitem", { name: "backplane" })).getByText("Bound")).toBeInTheDocument();
    expect(within(inView().getByRole("listitem", { name: "dotfiles" })).getByText("Skipped")).toBeInTheDocument();
  });
});

describe("Busy state", () => {
  it("never leaves Continue busy after Back abandoned a pairing that is still starting", async () => {
    let calls = 0;
    const pairStart = vi.fn(() => {
      calls += 1;
      return calls === 1 ? new Promise(() => {}) : TICKET;
    });
    await goToServer(pairingHandlers({ pair_start: pairStart }));
    await user().click(inView().getByRole("button", { name: "Continue" }));
    await flush();
    await user().click(inView().getByRole("button", { name: "Back" }));
    await user().click(inView().getByRole("button", { name: "Get started" }));
    await flush();
    const next = inView().getByRole("button", { name: "Continue" });
    expect(next).not.toHaveAttribute("aria-busy");
    await user().click(next);
    await flush();
    expect(pairStart).toHaveBeenCalledTimes(2);
    expect(stepHeading()).toHaveTextContent("Approve this Mac in Backplane");
  });
});

describe("Pairing events", () => {
  it("moves on to agents as soon as the stream says the pairing connected", async () => {
    const { daemon } = await goToCode(pairingHandlers({ agents: () => AGENTS }));
    act(() => daemon.emit({ type: "pairing", data: { pairing_id: TICKET.pairing_id, state: "connected" } }));
    await flush();
    expect(stepHeading()).toHaveTextContent("Capture from these agents");
  });

  it.each([
    ["denied", "The request was declined in Backplane"],
    ["expired", "This code expired"],
    ["failed", "Pairing didn’t finish"],
  ])("shows a %s pairing from the stream without waiting for the next poll", async (state, title) => {
    const { daemon } = await goToCode();
    act(() => daemon.emit({ type: "pairing", data: { pairing_id: TICKET.pairing_id, state } }));
    expect(inView().getByRole("alert")).toHaveTextContent(title);
  });

  it("ignores events for another pairing", async () => {
    const { daemon } = await goToCode();
    act(() => daemon.emit({ type: "pairing", data: { pairing_id: "pair-other", state: "denied" } }));
    expect(inView().queryByRole("alert")).not.toBeInTheDocument();
    expect(inView().getByLabelText("Code KMTR-XQBW")).toBeInTheDocument();
  });

  it("keeps waiting on a pending event", async () => {
    const { daemon } = await goToCode();
    act(() => daemon.emit({ type: "pairing", data: { pairing_id: TICKET.pairing_id, state: "pending" } }));
    expect(inView().getByText("Waiting for you to approve in Backplane")).toBeInTheDocument();
  });
});

describe("Resume after relaunch", () => {
  const PENDING = { ...TICKET, endpoint: "https://app.backplane.example.dev" };

  it("asks the daemon for a pending pairing and lands on its code", async () => {
    await renderApp(disconnectedStatus, pairingHandlers({ pair_current: () => PENDING }));
    await flush();
    expect(stepHeading()).toHaveTextContent("Approve this Mac in Backplane");
    expect(inView().getByLabelText("Code KMTR-XQBW")).toBeInTheDocument();
  });

  it("keeps polling the resumed pairing", async () => {
    const poll = vi.fn(() => ({ state: "pending" }));
    await renderApp(disconnectedStatus, pairingHandlers({ pair_current: () => PENDING, pair_poll: poll }));
    await flush();
    await flush(5_000);
    expect(poll).toHaveBeenCalledWith({ pairingId: TICKET.pairing_id });
  });

  it("gets a new code from the resumed pairing's own server", async () => {
    const start = vi.fn(() => TICKET);
    await renderApp(disconnectedStatus, pairingHandlers({ pair_current: () => PENDING, pair_start: start }));
    await flush();
    await flush(10 * 60_000);
    await user().click(inView().getByRole("button", { name: "Get a new code" }));
    await flush();
    expect(start).toHaveBeenCalledWith({ endpoint: "https://app.backplane.example.dev", name: null, replace: null });
  });

  it("opens on the welcome when nothing is pending", async () => {
    await renderApp(disconnectedStatus, pairingHandlers({ pair_current: () => null }));
    await flush();
    expect(stepHeading()).toHaveTextContent("See which sessions worked on which card");
  });

  it("opens on the welcome when the daemon can't say", async () => {
    await renderApp(disconnectedStatus, pairingHandlers({ pair_current: () => { throw DAEMON_DOWN; } }));
    await flush();
    expect(stepHeading()).toHaveTextContent("See which sessions worked on which card");
  });

  it("does not resume over a step the user already chose, and cancels the pairing it drops", async () => {
    let answer: (ticket: typeof PENDING) => void = () => {};
    const cancel = vi.fn(() => ({ cancelled: true }));
    await renderApp(disconnectedStatus, pairingHandlers({ pair_current: () => new Promise((resolve) => (answer = resolve)), pair_cancel: cancel }));
    await user().click(inView().getByRole("button", { name: "Get started" }));
    answer(PENDING);
    await flush();
    expect(stepHeading()).toHaveTextContent("Where is your Backplane?");
    expect(cancel).toHaveBeenCalledWith({ pairingId: PENDING.pairing_id });
  });

  it("keeps the pairing the user started meanwhile when the late answer names it", async () => {
    let answer: (ticket: typeof PENDING) => void = () => {};
    const cancel = vi.fn(() => ({ cancelled: true }));
    await renderApp(disconnectedStatus, pairingHandlers({ pair_current: () => new Promise((resolve) => (answer = resolve)), pair_cancel: cancel }));
    await user().click(inView().getByRole("button", { name: "Get started" }));
    await user().type(addressField(), SERVER_URL);
    await user().click(inView().getByRole("button", { name: "Continue" }));
    await flush();
    expect(inView().getByLabelText("Code KMTR-XQBW")).toBeInTheDocument();
    answer(PENDING);
    await flush();
    expect(cancel).not.toHaveBeenCalled();
    expect(inView().getByLabelText("Code KMTR-XQBW")).toBeInTheDocument();
  });

  it("cancels nothing when there was no pending pairing", async () => {
    const cancel = vi.fn(() => ({ cancelled: true }));
    await renderApp(disconnectedStatus, pairingHandlers({ pair_current: () => null, pair_cancel: cancel }));
    await flush();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("Resume", () => {
  it("lands on the code again when the panel reopens mid-pairing", async () => {
    const { unmount } = await goToCode();
    unmount();
    render(<App />);
    await flush();
    expect(stepHeading()).toHaveTextContent("Approve this Mac in Backplane");
    expect(inView().getByLabelText("Code KMTR-XQBW")).toBeInTheDocument();
  });

  it("lands on agents for a connected Mac that has not finished onboarding", async () => {
    await renderSetup();
    expect(stepHeading()).toHaveTextContent("Capture from these agents");
    expect(inView().queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  });

  it("finishes: Done stores the flag and hands over to Home", async () => {
    await renderSetup({ projects: () => ({ ...PROJECTS, discovered: [] }) });
    await user().click(inView().getByRole("button", { name: "Continue" }));
    await flush();
    await user().click(inView().getByRole("button", { name: "Continue" }));
    expect(stepHeading()).toHaveTextContent("You’re set");
    await user().click(inView().getByRole("button", { name: "Done" }));
    await flush();
    expect(localStorage.getItem(ONBOARDING_FINISHED_KEY)).toBe("1");
    expect(screen.getByRole("tablist", { name: "Sections" })).toBeInTheDocument();
    expect(screen.queryByTestId("screen-onboarding")).not.toBeInTheDocument();
  });

  it("still finishes when storage refuses the flag", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    await renderSetup({ projects: () => ({ ...PROJECTS, discovered: [] }) });
    await user().click(inView().getByRole("button", { name: "Continue" }));
    await flush();
    await user().click(inView().getByRole("button", { name: "Continue" }));
    await user().click(inView().getByRole("button", { name: "Done" }));
    await flush();
    expect(screen.getByRole("tablist", { name: "Sections" })).toBeInTheDocument();
  });

  it("reads a missing or unreadable flag as not finished", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    await renderApp(disconnectedStatus);
    expect(stepHeading()).toHaveTextContent("See which sessions worked on which card");
  });
});
