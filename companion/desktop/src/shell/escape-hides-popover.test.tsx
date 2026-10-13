// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "../App";
import { startDaemonStream } from "../stores/daemon-stream";
import { fixtureStatus, mockDaemonIpc } from "../test/daemon-ipc";
import { openSheet } from "./layers";
import { push } from "./navigation";
import { registerRoute } from "./routes";

async function renderConnected() {
  const daemon = mockDaemonIpc({ hide_popover: () => null });
  startDaemonStream();
  render(<App />);
  await act(async () => {});
  act(() => {
    daemon.emit({ type: "daemon.connected" });
    daemon.emit({ type: "status", data: fixtureStatus });
  });
  return daemon;
}

const hideCalls = (daemon: Awaited<ReturnType<typeof renderConnected>>) =>
  daemon.invoked().filter((command) => command === "hide_popover").length;

describe("Escape at the top level", () => {
  it("hides the popover through hide_popover", async () => {
    const daemon = await renderConnected();
    screen.getByRole("tab", { name: /Home/ }).focus();
    await userEvent.keyboard("{Escape}");
    expect(hideCalls(daemon)).toBe(1);
  });

  it("pops a pushed screen instead of hiding", async () => {
    registerRoute("escape-probe", { title: "Probe", component: () => <p>probe</p> });
    const daemon = await renderConnected();
    act(() => push("escape-probe"));
    screen.getByRole("button", { name: "Back" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("heading", { name: "Probe" })).toBeNull();
    expect(hideCalls(daemon)).toBe(0);
  });

  it("closes an open sheet instead of hiding", async () => {
    const daemon = await renderConnected();
    act(() => {
      openSheet({ title: "Sheet probe", render: () => <button type="button">Inside</button> });
    });
    screen.getByRole("button", { name: "Inside" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(hideCalls(daemon)).toBe(0);
  });

  it("leaves an Escape an input already handled alone", async () => {
    const daemon = await renderConnected();
    const probe = document.createElement("input");
    probe.addEventListener("keydown", (event) => event.preventDefault());
    screen.getByTestId("shell-content").appendChild(probe);
    probe.focus();
    await userEvent.keyboard("{Escape}");
    expect(hideCalls(daemon)).toBe(0);
  });
});
