// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../App";
import type { DaemonStreamMessage, LocalSession } from "../../ipc/bindings";
import { startDaemonStream } from "../../stores/daemon-stream";
import { setPlatformForTests } from "../../platform/platform";
import { mockDaemonIpc } from "../../test/daemon-ipc";
import {
  AGENTS_NOW,
  AGENTS_SCENARIOS,
  baseStatus,
  brokenAgent,
  capturingAgent,
  entryFor,
  idleAgent,
  invalidConfigAgent,
  needsTrustAgent,
  neverSeenAgent,
  notConfiguredAgent,
  notInstalledAgent,
  otelConflictAgent,
  quietCapturingAgent,
  restartRequiredAgent,
  withAgents,
  type Status,
} from "./agents-fixtures";
import { resetDisplayPathsForTests } from "../shared/display-path";
import { AgentsScreen } from "./index";
import { resetSettingsQueueForTests } from "./settings-queue";

type Handlers = NonNullable<Parameters<typeof mockDaemonIpc>[0]>;

const envelope = (status: number, code: string, message = "raw daemon text /home/tester/.codex/hooks.json") => ({ kind: "api", status, code, message, detail: null });
const UNREACHABLE = { kind: "unreachable", reason: "control_file_missing" };

async function renderAgents({ status = AGENTS_SCENARIOS.healthy as Status, handlers = {} as Handlers, messages = [] as DaemonStreamMessage[] } = {}) {
  const daemon = mockDaemonIpc(handlers);
  startDaemonStream();
  const user = userEvent.setup();
  render(<App />);
  await act(async () => {});
  act(() => {
    daemon.emit({ type: "daemon.connected" });
    daemon.emit({ type: "status", data: status });
    for (const message of messages) daemon.emit(message);
  });
  await user.click(screen.getByRole("tab", { name: /Agents/ }));
  return { daemon, user };
}

const agentList = () => screen.getByRole("list", { name: "Coding agents on this Mac" });
const agentRows = () => [...agentList().children].filter((child) => child.tagName === "LI");
const rowHeading = (name: string) => within(agentList()).getByRole("heading", { level: 4, name });
const rowFor = (name: string) => {
  const row = rowHeading(name).closest("li");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
};

function liveSession(id: string, harness: string): DaemonStreamMessage {
  const session: LocalSession = {
    native_session_id: id,
    harness,
    repo: "github.com/valaris/backplane",
    mapping_id: null,
    started_at: new Date(AGENTS_NOW.getTime() - 60_000).toISOString(),
    last_event_at: new Date(AGENTS_NOW.getTime() - 1_000).toISOString(),
    tokens: null,
    cost_estimated_usd: null,
    cost_basis: null,
    auth_kind: null,
    history_deleted: null,
  };
  return { type: "session", data: { kind: "started", session } };
}

/** Commands the screen sent, in order, with their arguments. */
function recordCalls() {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const record =
    (command: string, result: (args: Record<string, unknown>) => unknown = () => ({})) =>
    (args: Record<string, unknown>) => {
      calls.push({ command, args });
      return result(args);
    };
  return { calls, record };
}

const enabledAgentsIn = (args: Record<string, unknown> | undefined) => (args?.update as { enabled_agents?: unknown } | undefined)?.enabled_agents;

beforeEach(() => {
  // Only Date is frozen: Motion's frame loop needs real intervals.
  vi.useFakeTimers({ toFake: ["Date"], now: AGENTS_NOW });
});

afterEach(() => {
  vi.useRealTimers();
  resetSettingsQueueForTests();
  resetDisplayPathsForTests();
});

describe("Agents list", () => {
  it("shows one row per agent with its tile, name and status pill", async () => {
    await renderAgents();
    expect(agentRows()).toHaveLength(3);
    expect(within(rowFor("Claude Code")).getByText("Capturing")).toBeInTheDocument();
    expect(within(rowFor("Codex")).getByText("Needs your approval")).toBeInTheDocument();
    expect(within(rowFor("Pi")).getByText("Not installed")).toBeInTheDocument();
  });

  it("offers the enable switch only where capture can be toggled", async () => {
    await renderAgents();
    expect(within(rowFor("Claude Code")).getByRole("switch", { name: "Capture Claude Code sessions" })).toBeChecked();
    expect(within(rowFor("Codex")).queryByRole("switch")).toBeNull();
    expect(within(rowFor("Pi")).queryByRole("switch")).toBeNull();
  });

  it("shows the footer help", async () => {
    await renderAgents();
    expect(
      screen.getByText("Turning an agent on adds a small hook to its settings; turning it off removes it. Capture only runs in bound projects."),
    ).toBeInTheDocument();
  });
});

describe("capturing and idle", () => {
  it("counts only this agent's live sessions and says when it last uploaded", async () => {
    await renderAgents({ messages: [liveSession("s1", "claude_code"), liveSession("s2", "codex_cli")] });
    expect(within(rowFor("Claude Code")).getByText("1 session now · last upload 8 s ago")).toBeInTheDocument();
  });

  it("counts Codex Desktop sessions on the one Codex row, without a second Codex row", async () => {
    const status = withAgents([capturingAgent("claude_code"), capturingAgent("codex_cli"), idleAgent("pi_cli")]);
    await renderAgents({ status, messages: [liveSession("s1", "codex_desktop"), liveSession("s2", "codex_cli")] });
    expect(agentRows()).toHaveLength(3);
    expect(within(agentList()).queryByRole("heading", { level: 4, name: "Codex app" })).not.toBeInTheDocument();
    expect(within(rowFor("Codex")).getByText(/^2 sessions now/)).toBeInTheDocument();
  });

  it("pluralises several live sessions", async () => {
    await renderAgents({ messages: [liveSession("s1", "claude_code"), liveSession("s3", "claude_code")] });
    expect(within(rowFor("Claude Code")).getByText("2 sessions now · last upload 8 s ago")).toBeInTheDocument();
  });

  it("says when the last session was seen while nothing is live", async () => {
    await renderAgents({ status: withAgents([quietCapturingAgent("claude_code")]) });
    expect(within(rowFor("Claude Code")).getByText("Ready · last session 2 h ago")).toBeInTheDocument();
  });

  it("describes an idle agent by its last session", async () => {
    await renderAgents({ status: withAgents([idleAgent("claude_code")]) });
    expect(within(rowFor("Claude Code")).getByText("Idle")).toBeInTheDocument();
    expect(within(rowFor("Claude Code")).getByText("Ready · last session 3 d ago")).toBeInTheDocument();
  });

  it("describes an idle agent that has never been seen", async () => {
    await renderAgents({ status: withAgents([neverSeenAgent("claude_code")]) });
    expect(within(rowFor("Claude Code")).getByText("Ready. No sessions yet.")).toBeInTheDocument();
  });

  it("follows status updates without a click", async () => {
    const { daemon } = await renderAgents({ status: withAgents([idleAgent("claude_code")]) });
    act(() => daemon.emit({ type: "status", data: withAgents([capturingAgent("claude_code")]) }));
    expect(within(rowFor("Claude Code")).getByText("Capturing")).toBeInTheDocument();
  });
});

describe("turning capture on and off", () => {
  it("shows a disabled agent off, with the switch off", async () => {
    await renderAgents({ status: AGENTS_SCENARIOS.trouble });
    const pi = rowFor("Pi");
    expect(within(pi).getByText("Off")).toBeInTheDocument();
    expect(within(pi).getByRole("switch", { name: "Capture Pi sessions" })).not.toBeChecked();
    expect(within(pi).getByText("Off. Pi sessions on this Mac are not captured, and its hook is removed.")).toBeInTheDocument();
  });

  it("turns one off from null by listing the other two, then removes its hook", async () => {
    const { calls, record } = recordCalls();
    const { user } = await renderAgents({
      status: withAgents([capturingAgent("claude_code"), idleAgent("codex_cli"), idleAgent("pi_cli")]),
      handlers: { update_settings: record("update_settings"), agent_uninstall: record("agent_uninstall") },
    });
    await user.click(within(rowFor("Codex")).getByRole("switch"));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]?.command).toBe("update_settings");
    expect(enabledAgentsIn(calls[0]?.args)).toEqual(["claude_code", "pi_cli"]);
    expect(calls[1]).toEqual({ command: "agent_uninstall", args: { agentId: "codex_cli" } });
    expect(within(rowFor("Codex")).getByRole("switch")).not.toBeChecked();
  });

  it("turns one on by installing its hook, then lists every agent explicitly", async () => {
    const { calls, record } = recordCalls();
    const { user } = await renderAgents({
      status: withAgents([idleAgent("claude_code"), idleAgent("codex_cli"), idleAgent("pi_cli")], ["claude_code", "codex_cli"]),
      handlers: { update_settings: record("update_settings"), agent_install: record("agent_install") },
    });
    await user.click(within(rowFor("Pi")).getByRole("switch"));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]).toEqual({ command: "agent_install", args: { agentId: "pi_cli" } });
    expect(calls[1]?.command).toBe("update_settings");
    expect(enabledAgentsIn(calls[1]?.args)).toEqual(["claude_code", "codex_cli", "pi_cli"]);
  });

  it("only installs the hook for an agent that is enabled but has none", async () => {
    const { calls, record } = recordCalls();
    const { user } = await renderAgents({
      status: withAgents([idleAgent("claude_code"), notConfiguredAgent("codex_cli")]),
      handlers: { update_settings: record("update_settings"), agent_install: record("agent_install") },
    });
    await user.click(within(rowFor("Codex")).getByRole("switch"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ command: "agent_install", args: { agentId: "codex_cli" } });
  });

  it("keeps the hook when saving the setting fails, and says so", async () => {
    const { calls, record } = recordCalls();
    const { user } = await renderAgents({
      status: withAgents([idleAgent("claude_code"), idleAgent("codex_cli")]),
      handlers: {
        update_settings: record("update_settings", () => {
          throw envelope(502, "server_unreachable");
        }),
        agent_uninstall: record("agent_uninstall"),
      },
    });
    await user.click(within(rowFor("Codex")).getByRole("switch"));
    const alert = await within(rowFor("Codex")).findByRole("alert");
    expect(alert).toHaveTextContent("Can’t reach Backplane right now.");
    expect(calls.map((call) => call.command)).toEqual(["update_settings"]);
    expect(within(rowFor("Codex")).getByRole("switch")).toBeChecked();
    expect(screen.queryByText(/raw daemon text/)).toBeNull();
  });

  it("reports a failed hook removal after capture was turned off", async () => {
    const { record } = recordCalls();
    const { user } = await renderAgents({
      status: withAgents([idleAgent("claude_code"), idleAgent("codex_cli")]),
      handlers: {
        update_settings: record("update_settings"),
        agent_uninstall: record("agent_uninstall", () => {
          throw envelope(500, "internal");
        }),
      },
    });
    await user.click(within(rowFor("Codex")).getByRole("switch"));
    const alert = await within(rowFor("Codex")).findByRole("alert");
    expect(alert).toHaveTextContent("Capture is off, but Codex’s hook couldn’t be removed.");
    expect(screen.queryByText(/raw daemon text/)).toBeNull();
  });

  it("does not turn an agent on when its hook cannot be installed", async () => {
    const { calls, record } = recordCalls();
    const { user } = await renderAgents({
      status: withAgents([idleAgent("claude_code"), idleAgent("pi_cli")], ["claude_code"]),
      handlers: {
        update_settings: record("update_settings"),
        agent_install: record("agent_install", () => {
          throw envelope(409, "conflict");
        }),
      },
    });
    await user.click(within(rowFor("Pi")).getByRole("switch"));
    const alert = await within(rowFor("Pi")).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn’t add Pi’s hook.");
    expect(calls.map((call) => call.command)).toEqual(["agent_install"]);
    expect(within(rowFor("Pi")).getByRole("switch")).not.toBeChecked();
  });
});

describe("concurrent capture changes", () => {
  /** update_settings answers in call order, each when its own release() runs; it echoes the list back as Settings. */
  function deferredSettings() {
    const writes: { list: unknown; release: () => void }[] = [];
    const handler = (args: Record<string, unknown>) =>
      new Promise((resolve) => {
        const list = enabledAgentsIn(args);
        writes.push({ list, release: () => resolve({ paused: false, auto_match_repos: true, enabled_agents: list, exclude_globs: [], retention_days: null }) });
      });
    return { writes, handler };
  }

  it("turning two agents off at once keeps both off", async () => {
    const settings = deferredSettings();
    const { user } = await renderAgents({
      status: withAgents([idleAgent("claude_code"), idleAgent("codex_cli"), idleAgent("pi_cli")]),
      handlers: { update_settings: settings.handler, agent_uninstall: () => ({}) },
    });
    await user.click(within(rowFor("Codex")).getByRole("switch"));
    await user.click(within(rowFor("Pi")).getByRole("switch"));
    await waitFor(() => expect(settings.writes).toHaveLength(1));
    await act(async () => settings.writes[0]?.release());
    await waitFor(() => expect(settings.writes).toHaveLength(2));
    await act(async () => settings.writes[1]?.release());
    expect(settings.writes.map((write) => write.list)).toEqual([["claude_code", "pi_cli"], ["claude_code"]]);
  });

  it("turning one off while another turns on keeps both changes", async () => {
    const settings = deferredSettings();
    const { user } = await renderAgents({
      status: withAgents([idleAgent("claude_code"), idleAgent("codex_cli"), notConfiguredAgent("pi_cli")], ["claude_code", "codex_cli"]),
      handlers: { update_settings: settings.handler, agent_uninstall: () => ({}), agent_install: () => ({}) },
    });
    await user.click(within(rowFor("Codex")).getByRole("switch"));
    await user.click(within(rowFor("Pi")).getByRole("switch"));
    await waitFor(() => expect(settings.writes).toHaveLength(1));
    await act(async () => settings.writes[0]?.release());
    await waitFor(() => expect(settings.writes).toHaveLength(2));
    await act(async () => settings.writes[1]?.release());
    expect(settings.writes.map((write) => write.list)).toEqual([["claude_code"], ["claude_code", "pi_cli"]]);
  });

  it("keeps a saved change when a stale status arrives before the next toggle", async () => {
    const { calls, record } = recordCalls();
    const initial = withAgents([idleAgent("claude_code"), idleAgent("codex_cli"), idleAgent("pi_cli")]);
    const { daemon, user } = await renderAgents({
      status: initial,
      handlers: {
        update_settings: record("update_settings", (args) => ({ paused: false, auto_match_repos: true, enabled_agents: enabledAgentsIn(args), exclude_globs: [], retention_days: null })),
        agent_uninstall: record("agent_uninstall"),
      },
    });
    await user.click(within(rowFor("Codex")).getByRole("switch"));
    await waitFor(() => expect(calls.map((call) => call.command)).toEqual(["update_settings", "agent_uninstall"]));
    // The daemon's policy refresh failed, so its next status still carries the old list.
    act(() => daemon.emit({ type: "status", data: withAgents([idleAgent("claude_code"), idleAgent("codex_cli"), idleAgent("pi_cli")]) }));
    expect(within(rowFor("Codex")).getByRole("switch")).not.toBeChecked();
    await user.click(within(rowFor("Pi")).getByRole("switch"));
    await waitFor(() => expect(calls).toHaveLength(4));
    expect(enabledAgentsIn(calls[2]?.args)).toEqual(["claude_code"]);
  });

  it("trusts the status again once it reports the saved list", async () => {
    const { calls, record } = recordCalls();
    const all = [idleAgent("claude_code"), idleAgent("codex_cli"), idleAgent("pi_cli")];
    const { daemon, user } = await renderAgents({
      status: withAgents(all),
      handlers: { update_settings: record("update_settings"), agent_uninstall: record("agent_uninstall"), agent_install: record("agent_install") },
    });
    await user.click(within(rowFor("Codex")).getByRole("switch"));
    await waitFor(() => expect(calls).toHaveLength(2));
    // Caught up, then changed elsewhere (the web app turned Codex back on and Claude off).
    act(() => daemon.emit({ type: "status", data: withAgents(all, ["pi_cli", "claude_code"]) }));
    act(() => daemon.emit({ type: "status", data: withAgents(all, ["codex_cli", "pi_cli"]) }));
    await user.click(within(rowFor("Pi")).getByRole("switch"));
    await waitFor(() => expect(calls).toHaveLength(4));
    expect(enabledAgentsIn(calls[2]?.args)).toEqual(["codex_cli"]);
  });

  it("starts from every agent the daemon reports when enabled_agents is null", async () => {
    const { calls, record } = recordCalls();
    const pi = idleAgent("pi_cli");
    const status = withAgents([idleAgent("claude_code"), idleAgent("codex_cli")]);
    const { user } = await renderAgents({
      status,
      handlers: { update_settings: record("update_settings"), agent_uninstall: record("agent_uninstall") },
      messages: [{ type: "agents", data: [...status.agents, pi].map((agent) => entryFor(agent)) }],
    });
    await user.click(within(rowFor("Codex")).getByRole("switch"));
    await waitFor(() => expect(calls.map((call) => call.command)).toContain("agent_uninstall"));
    expect(enabledAgentsIn(calls[0]?.args)).toEqual(["claude_code", "pi_cli"]);
  });

  it("announces a finished change politely", async () => {
    const { user } = await renderAgents({
      status: withAgents([idleAgent("claude_code"), idleAgent("codex_cli")]),
      handlers: { update_settings: () => ({}), agent_uninstall: () => ({}) },
    });
    await user.click(within(rowFor("Codex")).getByRole("switch"));
    const announcement = await screen.findByText("Codex capture is off.");
    expect(announcement.closest("[role=status]")).not.toBeNull();
  });

  it("shows the hook removed from the uninstall result without waiting for a status", async () => {
    const codex = idleAgent("codex_cli");
    const { user } = await renderAgents({
      status: withAgents([idleAgent("claude_code"), codex]),
      handlers: { update_settings: () => ({}), agent_uninstall: () => entryFor(codex, { state: "not_installed" }) },
    });
    await user.click(within(rowFor("Codex")).getByRole("switch"));
    expect(await within(rowFor("Codex")).findByText("Off. Codex sessions on this Mac are not captured, and its hook is removed.")).toBeInTheDocument();
  });
});

describe("turning on when saving fails", () => {
  it("removes the hook it just added", async () => {
    const { calls, record } = recordCalls();
    const { user } = await renderAgents({
      status: withAgents([idleAgent("claude_code"), notConfiguredAgent("pi_cli")], ["claude_code"]),
      handlers: {
        agent_install: record("agent_install"),
        update_settings: record("update_settings", () => {
          throw envelope(502, "server_unreachable");
        }),
        agent_uninstall: record("agent_uninstall"),
      },
    });
    await user.click(within(rowFor("Pi")).getByRole("switch"));
    const alert = await within(rowFor("Pi")).findByRole("alert");
    expect(alert).toHaveTextContent("Can’t reach Backplane right now.");
    expect(calls.map((call) => call.command)).toEqual(["agent_install", "update_settings", "agent_uninstall"]);
    expect(within(rowFor("Pi")).getByRole("switch")).not.toBeChecked();
  });

  it("never says nothing changed when the hook stayed installed", async () => {
    const { user } = await renderAgents({
      status: withAgents([idleAgent("claude_code"), notConfiguredAgent("pi_cli")], ["claude_code"]),
      handlers: {
        agent_install: () => ({}),
        update_settings: () => {
          throw envelope(502, "server_unreachable");
        },
        agent_uninstall: () => {
          throw envelope(500, "internal");
        },
      },
    });
    await user.click(within(rowFor("Pi")).getByRole("switch"));
    const alert = await within(rowFor("Pi")).findByRole("alert");
    expect(alert).toHaveTextContent("Its hook is installed, but capture is off.");
    expect(alert).not.toHaveTextContent("Nothing was changed");
  });

  it("says plainly when the hook could not be taken back out", async () => {
    const { user } = await renderAgents({
      status: withAgents([idleAgent("claude_code"), notConfiguredAgent("pi_cli")], ["claude_code"]),
      handlers: {
        agent_install: () => ({}),
        update_settings: () => {
          throw envelope(500, "internal");
        },
        agent_uninstall: () => {
          throw envelope(500, "internal");
        },
      },
    });
    await user.click(within(rowFor("Pi")).getByRole("switch"));
    const alert = await within(rowFor("Pi")).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn’t turn Pi on.");
    expect(alert).toHaveTextContent("Its hook is installed, but capture is off.");
  });

  it("does not claim the hook is removed while it is still installed", async () => {
    await renderAgents({ status: withAgents([idleAgent("claude_code"), idleAgent("pi_cli")], ["claude_code"]) });
    const pi = rowFor("Pi");
    expect(pi).toHaveTextContent("Off. Pi sessions on this Mac are not captured.");
    expect(pi).not.toHaveTextContent("hook is removed");
  });
});

describe("not installed", () => {
  it("re-fetches the agents on Check again and says when nothing changed", async () => {
    const pi = notInstalledAgent("pi_cli");
    const { calls, record } = recordCalls();
    const { user } = await renderAgents({ status: withAgents([pi]), handlers: { agents: record("agents", () => [entryFor(pi)]) } });
    expect(within(rowFor("Pi")).getByText("Pi isn’t installed on this Mac. Install it, then check again.")).toBeInTheDocument();
    await user.click(within(rowFor("Pi")).getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Still not installed. Nothing changed.")).toBeInTheDocument();
    // One fetch when the agents store first loads, one for the click.
    expect(calls.map((call) => call.command)).toEqual(["agents", "agents"]);
  });

  it("explains a daemon that is down during Check again", async () => {
    const { user } = await renderAgents({
      status: withAgents([notInstalledAgent("pi_cli")]),
      handlers: {
        agents: () => {
          throw UNREACHABLE;
        },
      },
    });
    await user.click(within(rowFor("Pi")).getByRole("button", { name: "Check again" }));
    expect(await within(rowFor("Pi")).findByRole("alert")).toHaveTextContent("Couldn’t reach the Companion.");
  });
});

describe("broken", () => {
  it("explains the removed hook with its home-relative path", async () => {
    await renderAgents({ status: AGENTS_SCENARIOS.trouble });
    const claude = rowFor("Claude Code");
    expect(within(claude).getByText("Needs repair")).toBeInTheDocument();
    expect(claude).toHaveTextContent("The capture hook in Claude Code’s settings.json was removed or changed, so new sessions aren’t seen.");
    expect(claude).not.toHaveTextContent("/home/tester");
    expect(claude).not.toHaveTextContent("~/");
  });

  it("repairs by installing the hook, with a busy button, then a toast", async () => {
    let finishInstall: (value: unknown) => void = () => {};
    const { calls, record } = recordCalls();
    const { user } = await renderAgents({
      status: AGENTS_SCENARIOS.trouble,
      handlers: { agent_install: record("agent_install", () => new Promise((resolve) => (finishInstall = resolve))) },
    });
    await user.click(within(rowFor("Claude Code")).getByRole("button", { name: "Repair" }));
    const busy = await within(rowFor("Claude Code")).findByRole("button", { name: "Repairing…" });
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(calls).toEqual([{ command: "agent_install", args: { agentId: "claude_code" } }]);
    await act(async () => finishInstall({}));
    expect(await screen.findByText("Claude Code hook repaired.")).toBeInTheDocument();
  });

  it("moves focus to the row heading after a successful repair", async () => {
    const { user } = await renderAgents({ status: AGENTS_SCENARIOS.trouble, handlers: { agent_install: () => entryFor(brokenAgent("claude_code"), { state: "installed", problems: [] }) } });
    await user.click(within(rowFor("Claude Code")).getByRole("button", { name: "Repair" }));
    await screen.findByText("Claude Code hook repaired.");
    expect(rowHeading("Claude Code")).toHaveFocus();
  });

  it("shows a failed repair as a humane error banner, never the raw envelope", async () => {
    const { user } = await renderAgents({
      status: AGENTS_SCENARIOS.trouble,
      handlers: {
        agent_install: () => {
          throw envelope(500, "internal");
        },
      },
    });
    await user.click(within(rowFor("Claude Code")).getByRole("button", { name: "Repair" }));
    const alert = await within(rowFor("Claude Code")).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn’t repair Claude Code’s hook.");
    expect(screen.queryByText(/raw daemon text/)).toBeNull();
    expect(within(rowFor("Claude Code")).getByRole("button", { name: "Repair" })).toBeEnabled();
  });

  it("explains a missing Companion executable from its problem code", async () => {
    await renderAgents({ status: withAgents([brokenAgent("claude_code", ["companion_executable_missing"])]) });
    expect(rowFor("Claude Code")).toHaveTextContent("The capture hook points at a Companion that is no longer there");
  });

  it("never renders a problem string it does not know", async () => {
    await renderAgents({ status: withAgents([brokenAgent("claude_code", ["<b>hooks disabled</b>", "/home/tester/secret.json"])]) });
    const claude = rowFor("Claude Code");
    expect(claude).not.toHaveTextContent("hooks disabled");
    expect(claude).not.toHaveTextContent("secret.json");
    expect(claude).toHaveTextContent("This version of the app can’t show this agent’s status yet.");
  });

  it("offers Check again, never Repair, for a problem code this build doesn't know", async () => {
    await renderAgents({ status: withAgents([brokenAgent("claude_code", ["Stop:stale", "brand_new_problem"])]) });
    const claude = rowFor("Claude Code");
    expect(within(claude).queryByRole("button", { name: "Repair" })).toBeNull();
    expect(within(claude).getByRole("button", { name: "Check again" })).toBeInTheDocument();
    expect(claude).not.toHaveTextContent("brand_new_problem");
  });
});

describe("needs trust (Codex)", () => {
  it("shows the CLI's own trust steps", async () => {
    await renderAgents();
    const steps = within(rowFor("Codex")).getByRole("list", { name: "How to approve Codex’s hooks" });
    const items = within(steps).getAllByRole("listitem").map((item) => item.textContent);
    expect(items).toEqual([
      "Open a terminal and start codex.",
      // The kit's Quote draws the curly quotes in CSS, so they are not in the text.
      "At Hooks need review, choose Trust all and continue. To approve only Backplane’s hooks, choose Review hooks.",
      "Come back here. This updates on its own; Codex Desktop picks up the same approval.",
    ]);
    expect(within(steps).getAllByText((_, element) => element?.tagName === "Q").map((quote) => quote.textContent)).toEqual([
      "Hooks need review",
      "Trust all and continue",
      "Review hooks",
    ]);
  });

  it("copies the codex command from its step, once per row", async () => {
    const { user } = await renderAgents();
    const steps = within(rowFor("Codex")).getByRole("list", { name: "How to approve Codex’s hooks" });
    expect(within(rowFor("Codex")).getAllByRole("button", { name: /^Copy/ })).toHaveLength(1);
    await user.click(within(steps).getByRole("button", { name: "Copy command" }));
    expect(await navigator.clipboard.readText()).toBe("codex");
    expect(within(steps).getByRole("status")).toHaveTextContent("Copied");
  });

  it("says so when the clipboard refuses", async () => {
    const { user } = await renderAgents();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("denied"));
    await user.click(within(rowFor("Codex")).getByRole("button", { name: "Copy command" }));
    expect(within(rowFor("Codex")).getByRole("status")).toHaveTextContent("Couldn’t copy. Type codex in a terminal instead.");
  });

  it("confirms the approval when Check again finds it", async () => {
    const codex = needsTrustAgent("codex_cli");
    let approved = false;
    const { user } = await renderAgents({
      status: withAgents([capturingAgent("claude_code"), codex]),
      handlers: { agents: () => [approved ? entryFor(codex, { state: "installed", trust: "trusted" }) : entryFor(codex)] },
    });
    approved = true;
    await user.click(within(rowFor("Codex")).getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Codex approved the hooks. Its sessions will be captured.")).toBeInTheDocument();
    expect(within(rowFor("Codex")).getByText("Idle")).toBeInTheDocument();
  });

  it("updates on its own when the daemon reports the approval", async () => {
    const { daemon } = await renderAgents();
    act(() => daemon.emit({ type: "status", data: withAgents([capturingAgent("claude_code"), idleAgent("codex_cli"), notInstalledAgent("pi_cli")]) }));
    expect(within(rowFor("Codex")).getByText("Idle")).toBeInTheDocument();
    expect(within(rowFor("Codex")).queryByRole("list")).toBeNull();
  });
});

describe("restart required (Codex app started before the hooks)", () => {
  it("asks to restart the Codex app, with the steps, and offers no way to quit it for the user", async () => {
    await renderAgents({ status: AGENTS_SCENARIOS.restart });
    const codex = rowFor("Codex");
    expect(within(codex).getByText("Restart Codex")).toBeInTheDocument();
    expect(codex).toHaveTextContent("Restart the Codex app to start capturing its sessions. It was already open when capture was set up.");
    const steps = within(codex).getByRole("list", { name: "How to restart Codex" });
    expect(within(steps).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Quit Codex with ⌘Q.",
      "Open Codex again.",
      "Come back here. This clears on its own.",
    ]);
    expect(within(codex).queryByRole("button", { name: /quit|restart|repair/i })).toBeNull();
    expect(within(codex).getByRole("switch", { name: "Capture Codex sessions" })).toHaveAttribute("aria-checked", "true");
  });

  it("clears on its own once the daemon no longer reports it", async () => {
    const { daemon } = await renderAgents({ status: AGENTS_SCENARIOS.restart });
    act(() => daemon.emit({ type: "status", data: withAgents([capturingAgent("claude_code"), idleAgent("codex_cli"), notInstalledAgent("pi_cli")]) }));
    const codex = rowFor("Codex");
    expect(within(codex).getByText("Idle")).toBeInTheDocument();
    expect(codex).not.toHaveTextContent("Restart");
    expect(within(codex).queryByRole("list")).toBeNull();
  });

  it("clears after Check again finds Codex restarted", async () => {
    const codex = restartRequiredAgent("codex_cli");
    let restarted = false;
    const { user } = await renderAgents({
      status: withAgents([capturingAgent("claude_code"), codex]),
      handlers: { agents: () => [restarted ? entryFor(codex, { problems: [] }) : entryFor(codex)] },
    });
    restarted = true;
    await user.click(within(rowFor("Codex")).getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Codex restarted with the hooks. Its sessions will be captured.")).toBeInTheDocument();
    expect(within(rowFor("Codex")).getByText("Idle")).toBeInTheDocument();
  });

  it("gives the command for Codex's background app server, and copies it", async () => {
    const { user } = await renderAgents({ status: AGENTS_SCENARIOS.daemonRestart });
    const codex = rowFor("Codex");
    expect(within(codex).getByText("Restart needed")).toBeInTheDocument();
    expect(codex).toHaveTextContent("Restart Codex’s background app server to start capturing its sessions. It was already running when capture was set up.");
    const steps = within(codex).getByRole("list", { name: "How to restart Codex’s app server" });
    expect(within(steps).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "In a terminal, run codex app-server daemon restart.",
      "Come back here. This clears on its own.",
    ]);
    await user.click(within(steps).getByRole("button", { name: "Copy command" }));
    expect(await navigator.clipboard.readText()).toBe("codex app-server daemon restart");
    expect(within(codex).getAllByRole("button", { name: "Copy command" })).toHaveLength(1);
  });

  it("shows the approval steps, then the restart, when Codex needs both", async () => {
    const codex = needsTrustAgent("codex_cli");
    await renderAgents({ status: withAgents([{ ...codex, integration: { ...codex.integration, problems: ["restart_required"] } }]) });
    const row = rowFor("Codex");
    expect(within(row).getByText("Needs your approval")).toBeInTheDocument();
    const lists = within(row).getAllByRole("list");
    expect(lists.map((list) => list.getAttribute("aria-label"))).toEqual(["How to approve Codex’s hooks", "How to restart Codex"]);
    expect(row).toHaveTextContent("Then restart the Codex app: it was already open when capture was set up.");
    expect(within(lists[1] as HTMLElement).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Quit Codex with ⌘Q.", "Open Codex again."]);
    expect(within(lists[0] as HTMLElement).getByRole("button", { name: "Copy command" })).toBeInTheDocument();
  });

  it("names the background app server's command after the approval steps", async () => {
    const codex = needsTrustAgent("codex_cli");
    await renderAgents({ status: withAgents([{ ...codex, integration: { ...codex.integration, problems: ["daemon_restart_required"] } }]) });
    const row = rowFor("Codex");
    expect(row).toHaveTextContent("Then restart Codex’s background app server: it was already running when capture was set up.");
    expect(within(row).getByRole("list", { name: "How to restart Codex’s app server" })).toHaveTextContent("codex app-server daemon restart");
  });

  it("shows no restart while Codex only needs approval", async () => {
    await renderAgents();
    expect(rowFor("Codex")).not.toHaveTextContent(/restart/i);
    expect(within(rowFor("Codex")).getAllByRole("list")).toHaveLength(1);
  });

  it("shows no approval steps when Codex already trusts the hooks and only needs a restart", async () => {
    await renderAgents({ status: AGENTS_SCENARIOS.restart });
    expect(within(rowFor("Codex")).queryByRole("list", { name: "How to approve Codex’s hooks" })).toBeNull();
    expect(rowFor("Codex")).not.toHaveTextContent("Hooks need review");
  });

  it("never asks for a restart for a healthy or another agent", async () => {
    await renderAgents({ status: withAgents([{ ...capturingAgent("claude_code"), integration: { ...capturingAgent("claude_code").integration, problems: [] } }, idleAgent("codex_cli")]) });
    expect(agentList()).not.toHaveTextContent("Restart");
  });

  it("the header asks for attention while the daemon reports it", async () => {
    await renderAgents({
      status: AGENTS_SCENARIOS.restart,
      messages: [{ type: "attention", data: { items: [{ code: "restart_required", severity: "warning", agent: "codex_cli", message: "Restart the Codex app…" }] } }],
    });
    expect(screen.getByText("One agent needs your attention")).toBeInTheDocument();
  });
});

describe("the agents store", () => {
  it("shows a pushed agents event until the next status replaces it", async () => {
    const codex = needsTrustAgent("codex_cli");
    const status = withAgents([capturingAgent("claude_code"), codex]);
    const { daemon } = await renderAgents({ status });
    act(() => daemon.emit({ type: "agents", data: [entryFor(codex, { state: "installed", trust: "trusted" })] }));
    expect(within(rowFor("Codex")).getByText("Idle")).toBeInTheDocument();
    act(() => daemon.emit({ type: "status", data: withAgents([capturingAgent("claude_code"), needsTrustAgent("codex_cli")]) }));
    expect(within(rowFor("Codex")).getByText("Needs your approval")).toBeInTheDocument();
  });

  it("lets a newer status win over an agents event that arrived before the screen opened", async () => {
    const daemon = mockDaemonIpc();
    startDaemonStream();
    const user = userEvent.setup();
    render(<App />);
    await act(async () => {});
    const older = withAgents([capturingAgent("claude_code"), idleAgent("codex_cli")]);
    act(() => {
      daemon.emit({ type: "daemon.connected" });
      daemon.emit({ type: "status", data: older });
      daemon.emit({ type: "agents", data: [entryFor(brokenAgent("codex_cli"))] });
      daemon.emit({ type: "status", data: withAgents([capturingAgent("claude_code"), capturingAgent("codex_cli")]) });
    });
    await user.click(screen.getByRole("tab", { name: /Agents/ }));
    expect(within(rowFor("Codex")).getByText("Capturing")).toBeInTheDocument();
  });

  it("lets a status that lands during Check again win over the fetch's older answer", async () => {
    const codex = needsTrustAgent("codex_cli");
    let answerCheck: (entries: unknown) => void = () => {};
    let fetches = 0;
    const { daemon, user } = await renderAgents({
      status: withAgents([capturingAgent("claude_code"), codex]),
      handlers: {
        agents: () => {
          fetches += 1;
          return fetches === 1 ? [entryFor(codex)] : new Promise((resolve) => (answerCheck = resolve));
        },
      },
    });
    await user.click(within(rowFor("Codex")).getByRole("button", { name: "Check again" }));
    act(() => daemon.emit({ type: "status", data: withAgents([capturingAgent("claude_code"), capturingAgent("codex_cli")]) }));
    await act(async () => answerCheck([entryFor(codex)]));
    expect(within(rowFor("Codex")).getByText("Capturing")).toBeInTheDocument();
  });

  it("ignores an agents entry without an integration", async () => {
    const { daemon } = await renderAgents();
    act(() => daemon.emit({ type: "agents", data: [{ id: "codex_cli", presence: null, integration: null, action: null, telemetry: null }] }));
    expect(within(rowFor("Codex")).getByText("Needs your approval")).toBeInTheDocument();
  });
});

describe("invalid config", () => {
  const maskHome = ({ path }: Record<string, unknown>) => String(path).replace(/^\/home\/tester(?=\/|$)/, "~");

  it("names the unreadable file by its full path with HOME masked, so it can be found in an editor", async () => {
    await renderAgents({ status: AGENTS_SCENARIOS.trouble, handlers: { display_path: maskHome } });
    const codex = rowFor("Codex");
    expect(within(codex).getByText("Config has an error")).toBeInTheDocument();
    await waitFor(() =>
      expect(codex).toHaveTextContent("Codex’s ~/.codex/hooks.json can’t be read. The Companion never edits a file it can’t parse, so fix it in your editor first."),
    );
    expect(codex).not.toHaveTextContent("/home/tester");
    expect(codex).not.toHaveTextContent("hooks_invalid");
  });

  it("names the file by its base name while display_path has not answered", async () => {
    await renderAgents({ status: AGENTS_SCENARIOS.trouble, handlers: { display_path: () => new Promise(() => {}) } });
    const codex = rowFor("Codex");
    expect(codex).toHaveTextContent("Codex’s hooks.json can’t be read.");
    expect(codex).not.toHaveTextContent("/home/tester");
  });

  it("keeps the base name in a broken hook's sentence, where the agent already says which folder", async () => {
    await renderAgents({ status: withAgents([brokenAgent("claude_code")]), handlers: { display_path: maskHome } });
    await act(async () => {});
    expect(rowFor("Claude Code")).toHaveTextContent("Claude Code’s settings.json");
    expect(rowFor("Claude Code")).not.toHaveTextContent("~/");
  });

  it("leaves the path out when the daemon sent none", async () => {
    await renderAgents({ status: withAgents([invalidConfigAgent("codex_cli", "")]) });
    expect(rowFor("Codex")).toHaveTextContent("Codex’s config file can’t be read.");
  });

  it("reveals the file in Finder by agent id only", async () => {
    const { calls, record } = recordCalls();
    const { user } = await renderAgents({ status: AGENTS_SCENARIOS.trouble, handlers: { reveal_agent_config: record("reveal_agent_config", () => null) } });
    await user.click(within(rowFor("Codex")).getByRole("button", { name: "Show in Finder" }));
    await waitFor(() => expect(calls).toEqual([{ command: "reveal_agent_config", args: { agentId: "codex_cli" } }]));
  });

  it("explains a refused reveal without echoing the refusal", async () => {
    const { user } = await renderAgents({
      status: AGENTS_SCENARIOS.trouble,
      handlers: {
        reveal_agent_config: () => {
          throw { kind: "local", message: "config path /home/tester/.codex/hooks.json lies outside the home folder" };
        },
      },
    });
    await user.click(within(rowFor("Codex")).getByRole("button", { name: "Show in Finder" }));
    const alert = await within(rowFor("Codex")).findByRole("alert");
    expect(alert).toHaveTextContent("Finder couldn’t show the file.");
    expect(screen.queryByText(/lies outside/)).toBeNull();
  });

  it("names the platform's file manager and device off the Mac", async () => {
    setPlatformForTests("windows");
    const { user } = await renderAgents({
      status: AGENTS_SCENARIOS.trouble,
      handlers: {
        reveal_agent_config: () => {
          throw { kind: "local", message: "unsupported" };
        },
      },
    });
    const list = screen.getByRole("list", { name: "Coding agents on this PC" });
    const codexRow = within(list).getByRole("heading", { level: 4, name: "Codex" }).closest("li") as HTMLElement;
    expect(within(codexRow).queryByRole("button", { name: "Show in Finder" })).toBeNull();
    await user.click(within(codexRow).getByRole("button", { name: "Show in Explorer" }));
    expect(await within(codexRow).findByRole("alert")).toHaveTextContent("File Explorer couldn’t show the file.");
    expect(screen.queryByText(/\bMac\b|Finder/)).toBeNull();
  });

  it("offers Check again", async () => {
    const codex = invalidConfigAgent("codex_cli");
    const { user } = await renderAgents({ status: withAgents([codex]), handlers: { agents: () => [entryFor(codex)] } });
    await user.click(within(rowFor("Codex")).getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Still the same. Nothing changed.")).toBeInTheDocument();
  });
});

describe("broken, by what can fix it (DK-12p)", () => {
  const maskHome = ({ path }: Record<string, unknown>) => String(path).replace(/^\/home\/tester(?=\/|$)/, "~");
  const CODEX_CONFIG = "/home/tester/.codex/config.toml";
  const codexBroken = (problems: string[]) => {
    const codex = brokenAgent("codex_cli", problems);
    return { ...codex, integration: { ...codex.integration, problem_config_paths: Object.fromEntries(problems.map((problem) => [problem, CODEX_CONFIG])) } };
  };

  it("treats a Claude Code settings.json that won't parse as a file to fix, with no Repair", async () => {
    await renderAgents({ status: withAgents([brokenAgent("claude_code", ["settings_invalid"])]), handlers: { display_path: maskHome } });
    const claude = rowFor("Claude Code");
    expect(within(claude).getByText("Config has an error")).toBeInTheDocument();
    await waitFor(() =>
      expect(claude).toHaveTextContent("Claude Code’s ~/.claude/settings.json can’t be read. The Companion never edits a file it can’t parse, so fix it in your editor first."),
    );
    expect(within(claude).getByRole("button", { name: "Show in Finder" })).toBeInTheDocument();
    expect(within(claude).getByRole("button", { name: "Check again" })).toBeInTheDocument();
    expect(within(claude).queryByRole("button", { name: "Repair" })).toBeNull();
    expect(claude).not.toHaveTextContent("removed or changed");
  });

  it("names config.toml, not hooks.json, when Codex's config.toml can't be read", async () => {
    await renderAgents({ status: withAgents([codexBroken(["config_invalid"])]), handlers: { display_path: maskHome } });
    const codex = rowFor("Codex");
    await waitFor(() => expect(codex).toHaveTextContent("Codex’s ~/.codex/config.toml can’t be read."));
    expect(codex).not.toHaveTextContent("hooks.json");
    expect(within(codex).queryByRole("button", { name: "Repair" })).toBeNull();
  });

  it("says a hook entry can't be read when one event's hooks aren't a list", async () => {
    await renderAgents({ status: withAgents([brokenAgent("claude_code", ["SessionStart:invalid"])]), handlers: { display_path: maskHome } });
    await waitFor(() =>
      expect(rowFor("Claude Code")).toHaveTextContent(
        "Claude Code’s ~/.claude/settings.json has a hook entry the Companion can’t read. The Companion never edits a file it can’t parse, so fix it in your editor first.",
      ),
    );
  });

  it("names Codex's config.toml and the telemetry settings when they are out of date", async () => {
    await renderAgents({ status: withAgents([codexBroken(["otel:stale"])]) });
    const codex = rowFor("Codex");
    expect(codex).toHaveTextContent("The Companion’s telemetry settings in Codex’s config.toml are out of date, so new sessions aren’t seen.");
    expect(codex).not.toHaveTextContent("hooks.json");
    expect(within(codex).getByRole("button", { name: "Repair" })).toBeInTheDocument();
  });

  it("names config.toml when the telemetry settings are missing", async () => {
    await renderAgents({ status: withAgents([codexBroken(["otel:missing"])]) });
    expect(rowFor("Codex")).toHaveTextContent("The Companion’s telemetry settings are missing from Codex’s config.toml, so new sessions aren’t seen.");
  });

  it("says a hook pointing at another copy of the app is out of date, and offers Repair", async () => {
    await renderAgents({ status: withAgents([brokenAgent("claude_code", ["Stop:stale", "SessionStart:stale"])]) });
    const claude = rowFor("Claude Code");
    expect(within(claude).getByText("Needs repair")).toBeInTheDocument();
    expect(claude).toHaveTextContent("The capture hook in Claude Code’s settings.json is out of date. Repair points it at this app.");
    expect(claude).not.toHaveTextContent("removed or changed");
    expect(within(claude).getByRole("button", { name: "Repair" })).toBeInTheDocument();
  });

  it("puts a removed hook ahead of an out-of-date one", async () => {
    await renderAgents({ status: withAgents([brokenAgent("claude_code", ["Stop:stale", "PreToolUse:missing"])]) });
    expect(rowFor("Claude Code")).toHaveTextContent("was removed or changed, so new sessions aren’t seen.");
  });

  it("says Pi's extension is out of date", async () => {
    await renderAgents({ status: withAgents([brokenAgent("pi_cli", ["extension:stale"])]) });
    expect(rowFor("Pi")).toHaveTextContent("The Companion’s extension in Pi’s backplane.ts is out of date. Repair points it at this app.");
  });

  it("sends hooks turned off in Codex back to Codex, with Check again and no Repair", async () => {
    await renderAgents({ status: withAgents([codexBroken(["hook_disabled_in_codex"])]) });
    const codex = rowFor("Codex");
    expect(within(codex).getByText("Off in Codex")).toBeInTheDocument();
    expect(codex).toHaveTextContent("Codex has the Companion’s hooks turned off, so new sessions aren’t seen. Turn them back on in Codex, then check again.");
    expect(within(codex).getByRole("button", { name: "Check again" })).toBeInTheDocument();
    expect(within(codex).queryByRole("button", { name: "Repair" })).toBeNull();
  });

  it("never overwrites another Pi extension: shows the file and Check again, no Repair", async () => {
    await renderAgents({ status: withAgents([brokenAgent("pi_cli", ["extension_not_owned"])]) });
    const pi = rowFor("Pi");
    expect(within(pi).getByText("Extension replaced")).toBeInTheDocument();
    expect(pi).toHaveTextContent("Another extension took the Companion’s place in Pi’s backplane.ts, so new sessions aren’t seen. Move that file out of the way, then check again.");
    expect(within(pi).getByRole("button", { name: "Show in Finder" })).toBeInTheDocument();
    expect(within(pi).getByRole("button", { name: "Check again" })).toBeInTheDocument();
    expect(within(pi).queryByRole("button", { name: "Repair" })).toBeNull();
  });
});

describe("OpenTelemetry conflict", () => {
  it("explains the conflict and offers Check again instead of Repair", async () => {
    await renderAgents({ status: withAgents([otelConflictAgent("codex_cli")]) });
    const codex = rowFor("Codex");
    expect(codex).toHaveTextContent("Companion can’t confirm that it manages the OpenTelemetry settings");
    expect(codex).toHaveTextContent("It left those settings unchanged.");
    expect(codex).not.toHaveTextContent(/another OpenTelemetry endpoint|sessions aren’t captured|Remove that exporter/);
    expect(within(codex).getByRole("button", { name: "Check again" })).toBeInTheDocument();
    expect(within(codex).queryByRole("button", { name: "Repair" })).toBeNull();
    expect(codex).not.toHaveTextContent("conflict_existing_otel");
    expect(within(codex).queryByRole("list", { name: /How to restart/ })).toBeNull();
  });

  it.each(["restart_required", "daemon_restart_required"] as const)("keeps %s visible beside unconfirmed settings without promising capture", async (restart) => {
    const conflict = otelConflictAgent("codex_cli");
    await renderAgents({ status: withAgents([{ ...conflict, integration: { ...conflict.integration, problems: ["conflict_existing_otel", restart] } }]) });
    const codex = rowFor("Codex");
    expect(codex).toHaveTextContent("Companion can’t confirm that it manages the OpenTelemetry settings");
    expect(codex).toHaveTextContent("It left those settings unchanged.");
    expect(codex).toHaveTextContent("Codex also needs to reload its settings.");
    expect(codex).toHaveTextContent("Restarting does not confirm that Companion manages the OpenTelemetry settings.");
    const steps = within(codex).getByRole("list", { name: restart === "restart_required" ? "How to restart Codex" : "How to restart Codex’s app server" });
    expect(steps).toHaveTextContent(restart === "restart_required" ? "Open Codex again." : "codex app-server daemon restart");
    expect(codex).not.toHaveTextContent(/start capturing|sessions aren’t captured|another OpenTelemetry endpoint|Remove that exporter/);
    expect(within(codex).queryByRole("button", { name: /^(Restart|Quit|Repair)/i })).toBeNull();
    expect(within(codex).getByRole("button", { name: "Check again" })).toBeInTheDocument();
  });
});

describe("resilience", () => {
  it("renders an unknown extra agent generically, without controls", async () => {
    await renderAgents({ status: withAgents([idleAgent("claude_code"), { ...idleAgent("gemini_cli"), state: "warp_drive" }]) });
    const extra = rowFor("gemini_cli");
    expect(within(extra).getByText("Unknown")).toBeInTheDocument();
    expect(within(extra).queryByRole("switch")).toBeNull();
    expect(within(extra).queryByRole("button")).toBeNull();
  });

  it("skips an agent id that is not a plain identifier", async () => {
    await renderAgents({ status: withAgents([idleAgent("claude_code"), idleAgent("<img src=x onerror=alert(1)>")]) });
    expect(agentRows()).toHaveLength(1);
  });

  it("never shows the fixture's raw problem strings", async () => {
    await renderAgents({ status: baseStatus });
    expect(screen.queryByText(/hooks disabled/)).toBeNull();
  });

  it("renders nothing to act on while the daemon is down", async () => {
    const daemon = mockDaemonIpc();
    startDaemonStream();
    render(<AgentsScreen />);
    await act(async () => {});
    act(() => daemon.emit({ type: "daemon.unreachable", data: { reason: "control_file_missing" } }));
    expect(screen.getByRole("heading", { name: "Can’t reach the Companion" })).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("keeps a failure scoped to its own row", async () => {
    const { user } = await renderAgents({
      status: AGENTS_SCENARIOS.trouble,
      handlers: {
        agent_install: () => {
          throw envelope(502, "server_unreachable");
        },
      },
    });
    await user.click(within(rowFor("Claude Code")).getByRole("button", { name: "Repair" }));
    await within(rowFor("Claude Code")).findByRole("alert");
    expect(within(rowFor("Codex")).queryByRole("alert")).toBeNull();
  });
});
