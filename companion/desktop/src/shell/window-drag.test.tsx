// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { mockWindows } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../App";
import { setPlatformForTests } from "../platform/platform";
import { startDaemonStream } from "../stores/daemon-stream";
import { fixtureStatus, mockDaemonIpc, type FakeDaemonIpc } from "../test/daemon-ipc";
import { NotRunning } from "./Gates";
import { push } from "./navigation";
import { registerRoute } from "./routes";
import { installWindowDrag } from "./window-drag";

const START_DRAGGING = "plugin:window|start_dragging";

let daemon: FakeDaemonIpc;
let uninstall: () => void;

beforeEach(() => {
  daemon = mockDaemonIpc({ [START_DRAGGING]: () => null, hide_popover: () => null, start_companion_service: () => null });
  mockWindows("popover");
  uninstall = installWindowDrag();
});

afterEach(() => uninstall());

const dragStarts = () => daemon.invoked().filter((command) => command === START_DRAGGING).length;

describe("window drag regions", () => {
  it("starts a native window drag from a primary press on a drag region", async () => {
    render(
      <div data-window-drag data-testid="region">
        <span data-testid="label">Capturing</span>
      </div>,
    );
    fireEvent.mouseDown(screen.getByTestId("label"), { button: 0 });
    await act(async () => {});
    expect(dragStarts()).toBe(1);
  });

  it("leaves controls inside a drag region clickable", async () => {
    render(
      <div data-window-drag>
        <button type="button">Settings</button>
        <a href="https://example.test">Docs</a>
        <input aria-label="Name" />
        <div role="tab" tabIndex={0}>
          Home
        </div>
        <span role="switch" aria-checked="false" tabIndex={0}>
          Toggle
        </span>
        <div data-no-window-drag>
          <span>Opt-out</span>
        </div>
        <div role="combobox" aria-expanded="false" aria-controls="none" tabIndex={0}>
          Combo
        </div>
        <div role="menuitemcheckbox" aria-checked="false" tabIndex={-1}>
          Check item
        </div>
        <div role="menuitemradio" aria-checked="false" tabIndex={-1}>
          Radio item
        </div>
        <div role="treeitem" aria-selected="false" tabIndex={-1}>
          Tree item
        </div>
        <div role="spinbutton" aria-valuenow={1} tabIndex={-1}>
          Spin
        </div>
        <div role="textbox" tabIndex={-1}>
          Text
        </div>
        <div role="searchbox" tabIndex={-1}>
          Search
        </div>
        <div role="grid">
          <div role="row">
            <div role="gridcell">Cell</div>
          </div>
        </div>
        <div tabIndex={0}>Focusable</div>
      </div>,
    );
    for (const target of [
      screen.getByRole("button", { name: "Settings" }),
      screen.getByRole("link", { name: "Docs" }),
      screen.getByRole("textbox", { name: "Name" }),
      screen.getByRole("tab", { name: "Home" }),
      screen.getByRole("switch", { name: "Toggle" }),
      screen.getByText("Opt-out"),
      screen.getByText("Combo"),
      screen.getByText("Check item"),
      screen.getByText("Radio item"),
      screen.getByText("Tree item"),
      screen.getByText("Spin"),
      screen.getByText("Text"),
      screen.getByText("Search"),
      screen.getByText("Cell"),
      screen.getByText("Focusable"),
    ]) {
      fireEvent.mouseDown(target, { button: 0 });
    }
    await act(async () => {});
    expect(dragStarts()).toBe(0);
  });

  it("ignores presses outside a drag region, secondary buttons and double clicks", async () => {
    render(
      <>
        <p data-testid="body">Body copy</p>
        <div data-window-drag data-testid="region" />
      </>,
    );
    fireEvent.mouseDown(screen.getByTestId("body"), { button: 0 });
    fireEvent.mouseDown(screen.getByTestId("region"), { button: 2 });
    fireEvent.mouseDown(screen.getByTestId("region"), { button: 0, detail: 2 });
    await act(async () => {});
    expect(dragStarts()).toBe(0);
  });

  it("still drags from a programmatic focus target (tabindex -1)", async () => {
    render(
      <div data-window-drag tabIndex={-1}>
        <span>Panel copy</span>
      </div>,
    );
    fireEvent.mouseDown(screen.getByText("Panel copy"), { button: 0 });
    await act(async () => {});
    expect(dragStarts()).toBe(1);
  });

  it("stays off on Linux, where the window has a native title bar", async () => {
    uninstall();
    setPlatformForTests("linux");
    uninstall = installWindowDrag();
    render(<div data-window-drag data-testid="region" />);
    fireEvent.mouseDown(screen.getByTestId("region"), { button: 0 });
    await act(async () => {});
    expect(dragStarts()).toBe(0);
  });

  it("stops listening once uninstalled", async () => {
    render(<div data-window-drag data-testid="region" />);
    uninstall();
    fireEvent.mouseDown(screen.getByTestId("region"), { button: 0 });
    await act(async () => {});
    expect(dragStarts()).toBe(0);
  });
});

describe("the popover's header is the drag handle", () => {
  async function renderConnected() {
    startDaemonStream();
    render(<App />);
    await act(async () => {});
    act(() => {
      daemon.emit({ type: "daemon.connected" });
      daemon.emit({ type: "status", data: fixtureStatus });
    });
  }

  it("drags from the status header but not from its buttons or the tabs", async () => {
    await renderConnected();
    const header = screen.getByTestId("status-header").closest("[data-window-drag]");
    expect(header).not.toBeNull();
    fireEvent.mouseDown(screen.getByRole("button", { name: "Settings" }), { button: 0 });
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Home/ }), { button: 0 });
    await act(async () => {});
    expect(dragStarts()).toBe(0);
    fireEvent.mouseDown(screen.getByTestId("status-header"), { button: 0 });
    await act(async () => {});
    expect(dragStarts()).toBe(1);
  });

  it("drags from a pushed screen's title bar but not from Back", async () => {
    registerRoute("drag-probe", { title: "Probe", component: () => <p>probe</p> });
    await renderConnected();
    act(() => push("drag-probe"));
    fireEvent.mouseDown(screen.getByRole("button", { name: "Back" }), { button: 0 });
    await act(async () => {});
    expect(dragStarts()).toBe(0);
    fireEvent.mouseDown(screen.getByRole("heading", { name: "Probe" }), { button: 0 });
    await act(async () => {});
    expect(dragStarts()).toBe(1);
  });

  it("drags onboarding by its brand row", async () => {
    startDaemonStream();
    render(<App />);
    await act(async () => {});
    act(() => {
      daemon.emit({ type: "daemon.connected" });
      daemon.emit({ type: "status", data: { ...fixtureStatus, connected: false } });
    });
    fireEvent.mouseDown(await screen.findByText("Companion"), { button: 0 });
    await act(async () => {});
    expect(dragStarts()).toBe(1);
  });

  it("drags the connecting gate", async () => {
    startDaemonStream();
    render(<App />);
    fireEvent.mouseDown(screen.getByText("Connecting to Companion…"), { button: 0 });
    await act(async () => {});
    expect(dragStarts()).toBe(1);
  });

  it("drags the not-running gate but not from Retry", async () => {
    render(<NotRunning />);
    await act(async () => {});
    fireEvent.mouseDown(screen.getByRole("button", { name: "Retry" }), { button: 0 });
    await act(async () => {});
    expect(dragStarts()).toBe(0);
    fireEvent.mouseDown(screen.getByRole("heading", { name: "Companion isn't running" }), { button: 0 });
    await act(async () => {});
    expect(dragStarts()).toBe(1);
  });
});
