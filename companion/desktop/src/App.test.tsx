// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AttentionItem, CompanionStatus_Deserialize } from "./ipc/bindings";
import { openSheet } from "./shell/layers";
import { finishOnboarding, push } from "./shell/navigation";
import { registerRoute } from "./shell/routes";
import { Field, Input } from "./components/Field";
import { startDaemonStream } from "./stores/daemon-stream";
import { fixtureStatus, mockDaemonIpc } from "./test/daemon-ipc";

type Status = CompanionStatus_Deserialize;

const projectRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./screens/projects", () => ({
  ProjectsScreen: () => {
    projectRenders.count += 1;
    return <div data-testid="screen-projects" />;
  },
}));
const base = fixtureStatus as Status;
type Handlers = Parameters<typeof mockDaemonIpc>[0];

async function renderConnected(status: Status = base, handlers: Handlers = {}) {
  const daemon = mockDaemonIpc(handlers);
  startDaemonStream();
  render(<App />);
  await act(async () => {});
  act(() => {
    daemon.emit({ type: "daemon.connected" });
    daemon.emit({ type: "status", data: status });
  });
  return daemon;
}

function withCapture(state: string): Status {
  return { ...base, capture: { ...base.capture, state } };
}

const header = () => screen.getByTestId("status-header");

describe("App shell gates", () => {
  it("says the companion isn't running when the daemon is unreachable", async () => {
    const daemon = mockDaemonIpc();
    startDaemonStream();
    render(<App />);
    await act(async () => {});
    act(() => daemon.emit({ type: "daemon.unreachable", data: { reason: "control_file_missing" } }));
    expect(screen.getByRole("heading", { name: "Companion isn't running" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("shows a neutral connecting state before the first message", () => {
    mockDaemonIpc();
    startDaemonStream();
    render(<App />);
    expect(screen.getByText("Connecting to Companion…")).toBeInTheDocument();
    expect(screen.queryByTestId("status-header")).not.toBeInTheDocument();
  });

  it("shows Home with the streamed status once connected", async () => {
    await renderConnected();
    expect(header()).toHaveTextContent("Capturing");
    expect(screen.getByRole("heading", { name: "No sessions yet" })).toBeInTheDocument();
    expect(screen.getByText("Bound projects").nextElementSibling).toHaveTextContent("2");
  });
});

describe("Status header", () => {
  it("announces only the title politely; the busy sub-line is not a live region", async () => {
    await renderConnected();
    const status = within(header()).getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent(/^Capturing$/);
    const sub = within(header()).getByText("Receiving from Claude Code");
    expect(sub.closest("[aria-live]")).toBeNull();
    expect(header()).toHaveAttribute("data-tone", "success");
  });

  it("counts live sessions from the session stream and names the device when the status carries it", async () => {
    const daemon = await renderConnected({ ...base, account: { ...(base.account ?? { email: "", display_name: null, web_origin: null }), device_name: "Ada’s MacBook Pro" } as never });
    const started = (id: string) => ({
      type: "session" as const,
      data: { kind: "started", session: { native_session_id: id, harness: "claude", repo: null, mapping_id: null, started_at: null, last_event_at: null, tokens: null, cost_estimated_usd: null, cost_basis: null, auth_kind: null, history_deleted: null } },
    });
    act(() => {
      daemon.emit(started("s1"));
      daemon.emit(started("s2"));
    });
    expect(within(header()).getByText("2 live sessions · Ada’s MacBook Pro")).toBeInTheDocument();
  });

  it("leaves the device name out when the status has none", async () => {
    const daemon = await renderConnected();
    act(() =>
      daemon.emit({
        type: "session",
        data: { kind: "started", session: { native_session_id: "s1", harness: "codex", repo: null, mapping_id: null, started_at: null, last_event_at: null, tokens: null, cost_estimated_usd: null, cost_basis: null, auth_kind: null, history_deleted: null } },
      }),
    );
    expect(within(header()).getByText("1 live session")).toBeInTheDocument();
  });

  it("updates in place when a new status arrives", async () => {
    const daemon = await renderConnected();
    act(() => daemon.emit({ type: "status", data: withCapture("paused_locally") }));
    expect(within(header()).getByRole("status")).toHaveTextContent("Paused");
    expect(within(header()).getByRole("button", { name: "Resume capture" })).toBeInTheDocument();
  });

  it("warns when an attention item arrives", async () => {
    const daemon = await renderConnected();
    const item: AttentionItem = { code: "needs_trust", severity: "warning", agent: "codex_cli", message: "Codex needs approval" };
    act(() => daemon.emit({ type: "attention", data: { items: [item] } }));
    expect(header()).toHaveAttribute("data-tone", "warning");
    expect(screen.getByRole("tab", { name: "Agents, needs attention" })).toBeInTheDocument();
  });

  it("pauses capture from the header and confirms with a toast", async () => {
    const daemon = await renderConnected(base, { pause: () => ({ paused: true }) });
    await userEvent.click(screen.getByRole("button", { name: "Pause capture" }));
    expect(daemon.invoked()).toContain("pause");
    expect(await screen.findByText("Capture paused on this Mac.")).toBeInTheDocument();
  });

  it("resumes capture from the header when paused locally", async () => {
    const daemon = await renderConnected(withCapture("paused_locally"), { resume: () => ({ paused: false }) });
    await userEvent.click(screen.getByRole("button", { name: "Resume capture" }));
    expect(daemon.invoked()).toContain("resume");
    expect(await screen.findByText("Capture resumed.")).toBeInTheDocument();
  });

  it("reports a failed pause in an error toast", async () => {
    await renderConnected(base, {
      pause: () => {
        throw { kind: "unreachable", reason: "control_file_missing" };
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Pause capture" }));
    const toast = await screen.findByText(/Couldn’t pause capture/);
    expect(toast.closest("[data-toast]")).toHaveAttribute("data-tone", "error");
  });

  it("disables pause when Backplane paused this Mac", async () => {
    await renderConnected(withCapture("paused_by_server"));
    const pause = within(header()).getByRole("button", { name: "Pause capture" });
    expect(pause).toBeDisabled();
    expect(pause).toHaveAttribute("title", "Paused from Backplane");
  });

  it("hides the tabs and the pause control once the device is revoked", async () => {
    await renderConnected({ ...withCapture("revoked"), revoked: true });
    expect(within(header()).getByRole("status")).toHaveTextContent("Disconnected");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /capture/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });
});

describe("Main tabs", () => {
  it("offers Home, Projects and Agents with Home selected", async () => {
    await renderConnected();
    const tablist = screen.getByRole("tablist", { name: "Sections" });
    expect(within(tablist).getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { name: "Home" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "tab-home");
  });

  it("badges Projects with the number of discovered projects", async () => {
    await renderConnected();
    expect(screen.getByRole("tab", { name: "Projects, 1 not captured yet" })).toBeInTheDocument();
  });

  it("drops the Projects badge when nothing is waiting", async () => {
    await renderConnected({ ...base, pending_projects: [] });
    expect(screen.getByRole("tab", { name: "Projects" })).toBeInTheDocument();
  });

  it("dots Agents when an agent is in a problem state, and not otherwise", async () => {
    const daemon = await renderConnected();
    expect(screen.getByRole("tab", { name: "Agents" })).toBeInTheDocument();
    act(() =>
      daemon.emit({ type: "status", data: { ...base, agents: base.agents.map((agent) => ({ ...agent, state: "needs_trust" })) } }),
    );
    expect(screen.getByRole("tab", { name: "Agents, needs attention" })).toBeInTheDocument();
  });

  it("switches screens with a click and with the arrow keys", async () => {
    await renderConnected();
    await userEvent.click(screen.getByRole("tab", { name: /Projects/ }));
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "tab-projects");
    expect(await screen.findByTestId("screen-projects")).toBeInTheDocument();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: /Agents/ })).toHaveFocus();
    expect(await screen.findByTestId("screen-agents")).toBeInTheDocument();
  });

  it("moves focus to the active tab whenever the popover is opened", async () => {
    await renderConnected();
    await userEvent.click(screen.getByRole("tab", { name: /Agents/ }));
    (document.activeElement as HTMLElement).blur();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByRole("tab", { name: /Agents/ })).toHaveFocus();
  });
});

describe("Settings push and pop", () => {
  it("pushes Settings with a Back button that takes focus, and hides the tabs", async () => {
    await renderConnected();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toHaveFocus();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getByTestId("screen-settings")).toBeInTheDocument();
  });

  it("pops back with the Back button and restores focus to the Settings button", async () => {
    await renderConnected();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("tablist", { name: "Sections" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus();
  });

  it("pops with Escape too", async () => {
    await renderConnected();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  });

  it("returns to the tab it was pushed from", async () => {
    await renderConnected();
    await userEvent.click(screen.getByRole("tab", { name: /Agents/ }));
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("tab", { name: /Agents/ })).toHaveAttribute("aria-selected", "true");
  });
});

describe("Onboarding mode", () => {
  it("takes over the whole panel while the device is not connected", async () => {
    await renderConnected({ ...withCapture("not_connected"), connected: false });
    expect(screen.getByTestId("screen-onboarding")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByTestId("status-header")).not.toBeInTheDocument();
  });

  it("stays in onboarding after pairing connects, until onboarding finishes", async () => {
    const daemon = await renderConnected({ ...withCapture("not_connected"), connected: false });
    act(() => daemon.emit({ type: "status", data: base }));
    expect(screen.getByTestId("screen-onboarding")).toBeInTheDocument();
    act(() => finishOnboarding());
    expect(await screen.findByRole("tablist", { name: "Sections" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Home" })).toHaveAttribute("aria-selected", "true");
  });

  it("never shows onboarding to a device that was connected from the start", async () => {
    await renderConnected();
    expect(screen.queryByTestId("screen-onboarding")).not.toBeInTheDocument();
  });
});

describe("Layers inside the shell", () => {
  it("makes the panel behind an open layer inert", async () => {
    await renderConnected(base, { pause: () => ({ paused: true }) });
    act(() => openSheet({ title: "Bind mobile-app", render: () => <p>boards</p> }));
    expect(screen.getByTestId("shell-content")).toHaveAttribute("inert");
    expect(screen.getByRole("dialog", { name: "Bind mobile-app" }).closest("[inert]")).toBeNull();
  });
});

describe("Render isolation", () => {
  it("does not re-render the active screen when only queue.records changes", async () => {
    const daemon = await renderConnected();
    await userEvent.click(screen.getByRole("tab", { name: /Projects/ }));
    const rendersBefore = projectRenders.count;
    act(() => daemon.emit({ type: "status", data: { ...base, queue: { ...base.queue, records: 99 } } }));
    act(() => daemon.emit({ type: "status", data: { ...base, queue: { ...base.queue, records: 100 } } }));
    expect(projectRenders.count).toBe(rendersBefore);
  });
});

describe("Route registry and the Escape rule", () => {
  function RenameProbe() {
    return (
      <Field label="Device name" onEscape={() => document.body.setAttribute("data-rename-cancelled", "true")}>
        <Input defaultValue="Ada’s MacBook Pro" />
      </Field>
    );
  }

  it("renders a registered route with its title and a Back button", async () => {
    registerRoute("rename-probe", { title: "Rename", component: RenameProbe });
    await renderConnected();
    act(() => push("rename-probe"));
    expect(await screen.findByRole("heading", { name: "Rename" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
  });

  it("lets an input's Escape cancel its edit without popping the route", async () => {
    registerRoute("rename-probe", { title: "Rename", component: RenameProbe });
    await renderConnected();
    act(() => push("rename-probe"));
    screen.getByRole("textbox", { name: "Device name" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(document.body).toHaveAttribute("data-rename-cancelled", "true");
    expect(screen.getByRole("heading", { name: "Rename" })).toBeInTheDocument();
    document.body.removeAttribute("data-rename-cancelled");
    screen.getByRole("button", { name: "Back" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("heading", { name: "Rename" })).toBeNull();
  });

  it("ignores a push to a route nobody registered", async () => {
    await renderConnected();
    act(() => push("nowhere"));
    expect(screen.getByRole("tablist", { name: "Sections" })).toBeInTheDocument();
  });
});
