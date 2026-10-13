// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../App";
import type { AgentAccess, DiscoveredProject } from "../../ipc/bindings";
import { setAgentAccess } from "../../stores/agent-access";
import { startDaemonStream, statusStore } from "../../stores/daemon-stream";
import { resetProjectsForTests, type RawMapping } from "../../stores/projects";
import { fixtureStatus, mockDaemonIpc } from "../../test/daemon-ipc";
import { BoundPanel } from "./BoundPanel";
import {
  DAEMON_DOWN,
  HOME,
  RULES,
  SERVER_UNREACHABLE,
  accessOff,
  accessOn,
  apiError,
  baseStatus,
  boards,
  createdMapping,
  backplaneMapping,
  docsMapping,
  dotfilesProject,
  ignored,
  mappings,
  storefrontMapping,
  overview,
  withAgents,
  withRules,
  withoutPolicy,
  type Status,
} from "./projects-fixtures";
import { resetDisplayPathsForTests } from "../shared/display-path";
import { resetRulesForTests, setConfirmTimeoutForTests } from "./rules-store";

type Handlers = Parameters<typeof mockDaemonIpc>[0];
interface Overview {
  mappings: RawMapping[];
  discovered: DiscoveredProject[];
  ignored: string[];
}

/** Rust's display_path, faked: the test HOME shows as `~`. */
const maskHome = ({ path }: Record<string, unknown>) => String(path).replace(new RegExp(`^${HOME}(?=/|$)`), "~");

function defaultHandlers(state: { overview: Overview; access: AgentAccess }, overrides: Handlers): Handlers {
  return {
    projects: () => state.overview,
    agent_access_get: () => state.access,
    boards: () => boards,
    display_path: maskHome,
    ...overrides,
  };
}

async function renderProjects({ status = baseStatus as Status, data = overview as Overview, access = accessOff, handlers = {} as Handlers } = {}) {
  const state = { overview: data, access };
  const daemon = mockDaemonIpc(defaultHandlers(state, handlers));
  startDaemonStream();
  const user = userEvent.setup();
  render(<App />);
  await act(async () => {});
  act(() => {
    daemon.emit({ type: "daemon.connected" });
    daemon.emit({ type: "status", data: status });
  });
  await user.click(screen.getByRole("tab", { name: /^Projects/ }));
  await act(async () => {});
  // display_path answers after the rows mount.
  await act(async () => {});
  /** The daemon's next GET /v1/projects answer, and its SSE `projects` event. */
  const publish = (next: Overview) => {
    state.overview = next;
    act(() => daemon.emit({ type: "projects", data: next }));
  };
  return { daemon, user, publish };
}

// Motion times its exits off real frames: let the list collapse finish.
async function finishExitAnimations() {
  for (let step = 0; step < 10; step += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
  }
}

const subTab = (name: RegExp) => screen.getByRole("tab", { name });
async function openSubTab(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(subTab(name));
  await act(async () => {});
  await act(async () => {});
}
const rowNamed = (listName: string, folder: string) => {
  const row = within(screen.getByRole("list", { name: listName }))
    .getAllByRole("listitem")
    .find((item) => within(item).queryByText(folder, { selector: "b" }) !== null);
  if (!row) throw new Error(`no ${listName} row for ${folder}`);
  return row;
};
const boundRow = (folder: string) => rowNamed("Bound folders", folder);
const captureSwitch = (folder: string) => within(boundRow(folder)).getByRole("switch", { name: `Capture sessions in ${folder}` });
const agentSwitch = (folder: string) => within(boundRow(folder)).getByRole("switch", { name: `Let your agents work on this board from ${folder}` });
const agentList = (folder: string) => within(boundRow(folder)).getByRole("list", { name: `Agents working from ${folder}` });
const agentItem = (folder: string, agent: string) => {
  const item = within(agentList(folder))
    .getAllByRole("listitem")
    .find((candidate) => within(candidate).queryByText(agent, { selector: "b" }) !== null);
  if (!item) throw new Error(`no ${agent} under ${folder}`);
  return item;
};
const foundRow = (folder: string) => rowNamed("Found folders", folder);
function toastRegion(kind: "status" | "alert"): HTMLElement {
  const region = document.querySelector<HTMLElement>(`[data-toast-region="${kind}"]`);
  if (!region) throw new Error(`no ${kind} toast region`);
  return region;
}
const statusToast = async (text: string) => expect(await within(toastRegion("status")).findByText(text)).toBeInTheDocument();
const errorToast = async (text: string) => expect(await within(toastRegion("alert")).findByText(text)).toBeInTheDocument();
function firstIgnoredRow(): HTMLElement {
  const [row] = within(screen.getByRole("list", { name: "Ignored folders" })).getAllByRole("listitem");
  if (!row) throw new Error("no ignored rows");
  return row;
}
const sheet = () => screen.getByRole("dialog");
/** What the daemon answers for a picked folder: the found project it recorded. */
function foundAt(root: string, repo: string | null = null): DiscoveredProject {
  return { root, repo_url: repo, first_seen: "2026-09-29T09:00:00Z", reason: repo ? "not_bound" : "no_origin", candidates: [] };
}

beforeEach(() => {
  resetProjectsForTests();
  resetRulesForTests();
  resetDisplayPathsForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Projects sub-tabs", () => {
  it("offers Bound, Found, Ignored and Rules, with counts for the three lists", async () => {
    await renderProjects();
    const tablist = screen.getByRole("tablist", { name: "Project lists" });
    const names = within(tablist)
      .getAllByRole("tab")
      .map((tab) => tab.getAttribute("aria-label") ?? tab.textContent);
    expect(names).toEqual(["Bound, 3 folders", "Found, 5 not captured yet", "Ignored, 2 folders", "Rules"]);
    expect(subTab(/^Bound/)).toHaveAttribute("aria-selected", "true");
  });

  it("counts one folder in the singular", async () => {
    await renderProjects({ data: { mappings: [backplaneMapping], discovered: [dotfilesProject], ignored: [ignored[0] ?? ""] } });
    expect(subTab(/^Bound/)).toHaveAccessibleName("Bound, 1 folder");
    expect(subTab(/^Ignored/)).toHaveAccessibleName("Ignored, 1 folder");
  });

  it("moves between sub-tabs with the arrow keys", async () => {
    const { user } = await renderProjects();
    subTab(/^Bound/).focus();
    await user.keyboard("{ArrowRight}");
    expect(subTab(/^Found/)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Not captured yet" })).toBeInTheDocument();
  });
});

describe("Bound", () => {
  it("shows each folder with its ~/ path, its board and workspace, a switch and what's sent", async () => {
    await renderProjects();
    const backplane = boundRow("backplane");
    expect(backplane).toHaveTextContent("~/code/valaris/backplane");
    expect(backplane).not.toHaveTextContent(HOME);
    expect(backplane).toHaveTextContent("Backplane · Internal projects");
    expect(within(backplane).getByRole("switch", { name: "Capture sessions in backplane" })).toHaveAttribute("aria-checked", "true");
    expect(within(backplane).getByRole("radio", { name: "Standard" })).toHaveAttribute("aria-checked", "true");
    expect(within(backplane).getByRole("radiogroup", { name: "What’s sent for backplane" })).toBeInTheDocument();
    expect(backplane).toHaveTextContent("Tool output and the agent’s replies stay on this Mac.");
    expect(within(backplane).getByRole("button", { name: "What Standard sends, in detail" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("heading", { name: "Captured, and what’s sent" })).toBeInTheDocument();

    const docs = boundRow("docs-site");
    expect(within(docs).getByRole("switch", { name: "Capture sessions in docs-site" })).toHaveAttribute("aria-checked", "false");
    expect(docs).toHaveTextContent("Off. Sessions in this folder are not captured.");
  });

  it("masks HOME through display_path, whatever the daemon's data dir says", async () => {
    await renderProjects({ status: { ...baseStatus, data_dir: "/var/lib/backplane-companion" } });
    const backplane = boundRow("backplane");
    expect(backplane).toHaveTextContent("~/code/valaris/backplane");
    expect(backplane).not.toHaveTextContent(HOME);
  });

  it("holds each row's path line empty, never the raw path, while display_path has not answered", async () => {
    await renderProjects({ handlers: { display_path: () => new Promise(() => {}) } });
    const backplane = boundRow("backplane");
    expect(backplane).not.toHaveTextContent(HOME);
    expect(backplane).not.toHaveTextContent("~/code");
    expect(backplane.querySelector(".projects-proj-name small")?.textContent).toBe("\u00a0");
  });

  it("shows a folder outside HOME as its own path, and a rootless repo mapping by host/owner/repo only", async () => {
    await renderProjects({
      data: {
        ...overview,
        mappings: [
          { ...backplaneMapping, id: "m-opt", root_path: "/opt/work/tools" },
          { ...storefrontMapping, id: "m-repo", root_path: null, repo_url_normalized: "github.com/acme/storefront-api" },
          { ...docsMapping, id: "m-bad", root_path: null, repo_url_normalized: "https://user:secret@github.com/a/b" },
        ],
      },
    });
    expect(boundRow("tools")).toHaveTextContent("/opt/work/tools");
    expect(boundRow("storefront-api")).toHaveTextContent("github.com/acme/storefront-api");
    expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
  });

  it("turns capture off for a folder through mapping_update", async () => {
    const calls: unknown[] = [];
    const { user } = await renderProjects({
      handlers: {
        mapping_update: (args) => {
          calls.push(args);
          return { ...mappings[0], enabled: false };
        },
      },
    });
    await user.click(captureSwitch("backplane"));
    expect(calls).toEqual([{ id: "m1", update: { enabled: false } }]);
    expect(captureSwitch("backplane")).toHaveAttribute("aria-checked", "false");
    expect(boundRow("backplane")).toHaveTextContent("Off. Sessions in this folder are not captured.");
  });

  it("puts the switch back and says why when the change fails", async () => {
    const { user } = await renderProjects({
      handlers: {
        mapping_update: () => {
          throw SERVER_UNREACHABLE;
        },
      },
    });
    await user.click(captureSwitch("backplane"));
    await errorToast("Couldn’t change backplane. Backplane can’t be reached right now.");
    expect(captureSwitch("backplane")).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByText("raw daemon message")).not.toBeInTheDocument();
  });

  it("changes what's sent through mapping_update, with the owner-only Full copy", async () => {
    const calls: unknown[] = [];
    const { user } = await renderProjects({
      handlers: {
        mapping_update: (args) => {
          calls.push(args);
          return { ...mappings[0], content_level: "full" };
        },
      },
    });
    await user.click(within(boundRow("backplane")).getByRole("radio", { name: "Full" }));
    expect(calls).toEqual([{ id: "m1", update: { content_level: "full" } }]);
    expect(boundRow("backplane")).toHaveTextContent("Only you can read sessions in Backplane.");
  });

  it("Add a folder… records the picked folder, then binds it by root_path when it has no remote", async () => {
    const created: unknown[] = [];
    const { user } = await renderProjects({
      handlers: {
        pick_project_folder: () => foundAt(`${HOME}/code/new-project`),
        mapping_create: (args) => {
          created.push(args);
          return createdMapping({ board_id: "b-fleet", workspace_id: "w-northwind", root_path: `${HOME}/code/new-project`, repo_url_normalized: null });
        },
      },
    });
    await user.click(screen.getByRole("button", { name: "Add a folder…" }));
    expect(await screen.findByRole("dialog", { name: "Bind new-project" })).toBeInTheDocument();
    await user.click(within(sheet()).getByRole("option", { name: "Fleet portal" }));
    await user.click(within(sheet()).getByRole("button", { name: "Bind" }));
    expect(created).toEqual([{ req: { workspace_id: "w-northwind", board_id: "b-fleet", root_path: `${HOME}/code/new-project`, content_level: "standard" } }]);
    await statusToast("Bound new-project to Fleet portal. New sessions there are captured.");
  });

  it("Add a folder… binds a picked repository by its remote, as the daemon resolved it", async () => {
    const created: unknown[] = [];
    const { user } = await renderProjects({
      handlers: {
        pick_project_folder: () => foundAt(`${HOME}/code/shop`, "github.com/acme/shop"),
        mapping_create: (args) => {
          created.push(args);
          return createdMapping({ board_id: "b-fleet", workspace_id: "w-northwind", root_path: null, repo_url_normalized: "github.com/acme/shop" });
        },
      },
    });
    await user.click(screen.getByRole("button", { name: "Add a folder…" }));
    await user.click(await within(await screen.findByRole("dialog", { name: "Bind shop" })).findByRole("option", { name: "Fleet portal" }));
    await user.click(within(sheet()).getByRole("button", { name: "Bind" }));
    expect(created).toEqual([{ req: { workspace_id: "w-northwind", board_id: "b-fleet", repo_url: "github.com/acme/shop", content_level: "standard" } }]);
  });

  it("does nothing when the folder picker is cancelled", async () => {
    const { user, daemon } = await renderProjects({ handlers: { pick_project_folder: () => null } });
    await user.click(screen.getByRole("button", { name: "Add a folder…" }));
    await act(async () => {});
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(daemon.invoked()).not.toContain("mapping_create");
    expect(toastRegion("alert")).toBeEmptyDOMElement();
  });

  it("says so when the folder picker can't open", async () => {
    const { user } = await renderProjects({
      handlers: {
        pick_project_folder: () => {
          throw { kind: "local", message: "no window" };
        },
      },
    });
    await user.click(screen.getByRole("button", { name: "Add a folder…" }));
    await errorToast("Couldn’t open the folder picker. Try again.");
  });

  it("opens no sheet and says why when the daemon refuses the folder", async () => {
    const { user } = await renderProjects({
      handlers: {
        pick_project_folder: () => {
          throw apiError(409, "already_mapped");
        },
      },
    });
    await user.click(screen.getByRole("button", { name: "Add a folder…" }));
    await errorToast("That folder is already bound. It’s listed under Bound in Projects.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("Bound: agents on this board", () => {
  it("offers each bound folder a switch, off, with one line on what it does and where the key stays", async () => {
    await renderProjects();
    expect(agentSwitch("backplane")).toHaveAttribute("aria-checked", "false");
    expect(agentSwitch("backplane")).toBeEnabled();
    expect(boundRow("backplane")).toHaveTextContent("Let your agents work on this board");
    expect(boundRow("backplane")).toHaveTextContent("Your coding agents get Backplane tools for this board. The key stays in the keychain.");
    expect(within(boundRow("backplane")).queryByRole("list", { name: /^Agents working from/ })).not.toBeInTheDocument();
  });

  it("names the platform's credential store, never a Mac, on another platform", async () => {
    const { setPlatformForTests } = await import("../../platform/platform");
    setPlatformForTests("windows");
    await renderProjects();
    expect(boundRow("backplane")).toHaveTextContent("The key stays in Credential Manager.");
    expect(boundRow("backplane")).not.toHaveTextContent(/keychain|Mac/);
  });

  it("turns agents on through agent_access_set, showing the switch on before the daemon answers", async () => {
    const calls: unknown[] = [];
    let answer: (value: AgentAccess) => void = () => {};
    const { user } = await renderProjects({
      handlers: {
        agent_access_set: (args) => {
          calls.push(args);
          return new Promise<AgentAccess>((resolve) => (answer = resolve));
        },
      },
    });
    await user.click(agentSwitch("backplane"));
    expect(calls).toEqual([{ mappingId: "m1", enabled: true }]);
    expect(agentSwitch("backplane")).toHaveAttribute("aria-checked", "true");
    await act(async () => answer(accessOn));
    expect(agentSwitch("backplane")).toHaveAttribute("aria-checked", "true");
    expect(agentList("backplane")).toBeInTheDocument();
  });

  it("puts the switch back and says why when turning agents on fails", async () => {
    const { user } = await renderProjects({
      handlers: {
        agent_access_set: () => {
          throw SERVER_UNREACHABLE;
        },
      },
    });
    await user.click(agentSwitch("backplane"));
    await errorToast("Couldn’t turn on agent access for backplane. Backplane can’t be reached right now.");
    expect(agentSwitch("backplane")).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText("raw daemon message")).not.toBeInTheDocument();
  });

  it("turns agents off, and puts the switch back on when that fails", async () => {
    const calls: unknown[] = [];
    const { user } = await renderProjects({
      access: accessOn,
      handlers: {
        agent_access_set: (args) => {
          calls.push(args);
          throw DAEMON_DOWN;
        },
      },
    });
    await user.click(agentSwitch("backplane"));
    expect(calls).toEqual([{ mappingId: "m1", enabled: false }]);
    await errorToast("Couldn’t turn off agent access for backplane. The Companion service isn’t running.");
    expect(agentSwitch("backplane")).toHaveAttribute("aria-checked", "true");
  });

  it("shows no error for a toggle a newer one replaced, and keeps the newer state", async () => {
    const pending: { resolve: (value: AgentAccess) => void; reject: (error: unknown) => void }[] = [];
    const { user } = await renderProjects({
      handlers: { agent_access_set: () => new Promise<AgentAccess>((resolve, reject) => pending.push({ resolve, reject })) },
    });
    await user.click(agentSwitch("backplane"));
    let newer: Promise<unknown> = Promise.resolve();
    act(() => {
      newer = setAgentAccess("m1", false);
    });
    await act(async () => {
      pending[1]?.resolve(accessOff);
      await newer;
    });
    await act(async () => {
      pending[0]?.reject(SERVER_UNREACHABLE);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(within(toastRegion("alert")).queryByText(/Couldn’t turn/)).not.toBeInTheDocument();
    expect(agentSwitch("backplane")).toHaveAttribute("aria-checked", "false");
  });

  it("explains the daemon's own refusals in fixed words", async () => {
    const { user } = await renderProjects({
      handlers: {
        agent_access_set: () => {
          throw apiError(409, "mapping_root_unknown");
        },
      },
    });
    await user.click(agentSwitch("backplane"));
    await errorToast("Couldn’t turn on agent access for backplane. This Mac hasn’t found this repository’s folder yet.");
  });

  it("shows each agent once on: Claude Code in this folder, Codex and Pi following the folder you're in", async () => {
    await renderProjects({ access: accessOn });
    const claude = agentItem("backplane", "Claude Code");
    expect(claude).toHaveTextContent("This folder");
    expect(claude).toHaveTextContent("Ready");
    expect(agentItem("backplane", "Codex")).toHaveTextContent("Follows the folder you’re in");
    expect(agentItem("backplane", "Pi")).toHaveTextContent("Follows the folder you’re in");
  });

  it("asks for a Codex restart with the same steps as capture", async () => {
    await renderProjects({ access: accessOn });
    const codex = agentItem("backplane", "Codex");
    expect(codex).toHaveTextContent("Restart needed");
    expect(codex).toHaveTextContent("Restart the Codex app to pick up Backplane tools. It was already open when they were set up.");
    const steps = within(codex).getByRole("list", { name: "How to restart Codex" });
    expect(steps).toHaveTextContent("Quit Codex with ⌘Q.");
    expect(steps).toHaveTextContent("Open Codex again.");
  });

  it("says Pi's MCP add-on is optional, and how to get it", async () => {
    await renderProjects({ access: accessOn });
    const pi = agentItem("backplane", "Pi");
    expect(pi).toHaveTextContent("Optional");
    expect(pi).toHaveTextContent("Pi gets Backplane tools through the optional pi-mcp-adapter package.");
    expect(within(pi).getByText("pi install npm:pi-mcp-adapter", { selector: "code" })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(pi).getByRole("button", { name: "Copy command" }));
    expect(await navigator.clipboard.readText()).toBe("pi install npm:pi-mcp-adapter");
  });

  it("gives every problem code a short reason of its own", async () => {
    await renderProjects({
      access: withAgents([
        { agent_id: "claude_code", scope: "folder", state: "conflict", problem: "folder_bound_to_other_mapping" },
        { agent_id: "codex_cli", scope: "global", state: "pending", problem: "agent_config_changed" },
        { agent_id: "pi_cli", scope: "global", state: "unsupported", problem: "agent_not_installed" },
      ]),
    });
    expect(agentItem("backplane", "Claude Code")).toHaveTextContent("Another bound folder in this repository already has Claude Code’s Backplane tools.");
    expect(agentItem("backplane", "Codex")).toHaveTextContent("Setting up");
    expect(agentItem("backplane", "Codex")).toHaveTextContent("Codex was changing its config. Trying again shortly.");
    expect(agentItem("backplane", "Pi")).toHaveTextContent("Not installed on this Mac.");
  });

  it("says which entry holds the name when another server is already called backplane", async () => {
    await renderProjects({
      access: withAgents([{ agent_id: "codex_cli", scope: "global", state: "conflict", problem: null }], {
        warnings: [{ agent_id: "codex_cli", entry_name: "backplane", reason: "mcp_name_taken" }],
      }),
    });
    const codex = agentItem("backplane", "Codex");
    expect(codex).toHaveTextContent("Needs you");
    expect(codex).toHaveTextContent("Codex already has a server named backplane. Rename yours so the Companion can add its own.");
  });

  it("falls back to generic words for a problem code or state this build doesn't know", async () => {
    await renderProjects({
      access: withAgents([
        { agent_id: "claude_code", scope: "folder", state: "error", problem: "brand_new_problem" },
        { agent_id: "codex_cli", scope: "global", state: "brand_new_state", problem: null },
      ]),
    });
    const claude = agentItem("backplane", "Claude Code");
    expect(claude).toHaveTextContent("Couldn’t set up");
    expect(claude).toHaveTextContent("This version of the app can’t explain this yet.");
    expect(claude).not.toHaveTextContent("brand_new_problem");
    expect(agentItem("backplane", "Codex")).not.toHaveTextContent("brand_new_state");
  });

  it("warns about overlapping entries by name only, never their values", async () => {
    const leaky = { agent_id: "codex_cli", entry_name: "old-backplane", reason: "other_backplane_entry", value: "vlr_secret_value" };
    await renderProjects({
      access: { ...accessOn, warnings: [...accessOn.warnings, leaky as AgentAccess["warnings"][number]] },
    });
    const warnings = screen.getByRole("list", { name: "Other Backplane servers your agents have" });
    expect(warnings).toHaveTextContent("You also have valaris set up for this server in Claude Code — your agent will see the tools twice.");
    expect(within(warnings).getByText("valaris", { selector: "code" })).toBeInTheDocument();
    expect(warnings).toHaveTextContent("You also have old-backplane set up as another Backplane server in Codex. Your agent will see its tools next to this board’s.");
    expect(document.body).not.toHaveTextContent("vlr_secret_value");
  });

  it("says the tools double only for an entry known to serve this server, never for another Backplane entry", async () => {
    await renderProjects({
      access: { ...accessOn, warnings: [{ agent_id: "codex_cli", entry_name: "old-backplane", reason: "other_backplane_entry" }] },
    });
    const warnings = screen.getByRole("list", { name: "Other Backplane servers your agents have" });
    expect(warnings).not.toHaveTextContent(/twice|If it points/);
  });

  it("says an entry's tools double only once, when it is both another Backplane entry and this server", async () => {
    await renderProjects({
      access: {
        ...accessOn,
        warnings: [
          { agent_id: "claude_code", entry_name: "valaris", reason: "other_backplane_entry" },
          { agent_id: "claude_code", entry_name: "valaris", reason: "same_endpoint" },
        ],
      },
    });
    const warnings = screen.getByRole("list", { name: "Other Backplane servers your agents have" });
    expect(within(warnings).getAllByRole("listitem")).toHaveLength(1);
    expect(warnings).toHaveTextContent("your agent will see the tools twice");
  });

  it("shows no warnings list when there is nothing to warn about", async () => {
    await renderProjects({ access: { ...accessOn, warnings: [] } });
    expect(screen.queryByRole("list", { name: "Other Backplane servers your agents have" })).not.toBeInTheDocument();
  });

  it("asks for uv when it is missing, and opens its install page in the browser", async () => {
    const opened: string[] = [];
    const { user } = await renderProjects({
      access: withAgents([{ agent_id: "claude_code", scope: "folder", state: "configured", problem: "uvx_missing" }], { prerequisites: { uvx: false } }),
      handlers: { open_uv_install_page: () => opened.push("uv") && null },
    });
    expect(agentItem("backplane", "Claude Code")).toHaveTextContent("Needs uv");
    expect(screen.getByText("Install uv to let agents use Backplane")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "How to install uv" }));
    expect(opened).toEqual(["uv"]);
  });

  it("says so when uv's install page can't be opened", async () => {
    const { user } = await renderProjects({
      access: { ...accessOn, prerequisites: { uvx: false } },
      handlers: {
        open_uv_install_page: () => {
          throw apiError(500, "protocol_error");
        },
      },
    });
    await user.click(screen.getByRole("button", { name: "How to install uv" }));
    await errorToast("Couldn’t open uv’s install page in your browser.");
  });

  it("doesn't ask for uv while no folder has agents on", async () => {
    await renderProjects({ access: { ...accessOff, prerequisites: { uvx: false } } });
    expect(screen.queryByText("Install uv to let agents use Backplane")).not.toBeInTheDocument();
  });

  it("offers to turn agents back on when the key was deleted on the web", async () => {
    const calls: unknown[] = [];
    const { user } = await renderProjects({
      access: { ...accessOn, key: { present: false, key_prefix: null, server_state: "missing" } },
      handlers: {
        agent_access_set: (args) => {
          calls.push(args);
          return accessOn;
        },
      },
    });
    expect(screen.getByText("The key was deleted on the web — turn it back on")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Turn it back on" }));
    expect(calls).toEqual([{ mappingId: "m1", enabled: true }]);
    expect(screen.queryByText("The key was deleted on the web — turn it back on")).not.toBeInTheDocument();
  });

  it("keeps the deleted-key notice and says why when turning it back on fails", async () => {
    const { user } = await renderProjects({
      access: { ...accessOn, key: { present: false, key_prefix: null, server_state: "missing" } },
      handlers: {
        agent_access_set: () => {
          throw SERVER_UNREACHABLE;
        },
      },
    });
    await user.click(screen.getByRole("button", { name: "Turn it back on" }));
    await errorToast("Couldn’t turn agent access back on. Backplane can’t be reached right now.");
    expect(screen.getByText("The key was deleted on the web — turn it back on")).toBeInTheDocument();
  });

  it("disables the switch, and says why, while this Mac isn't connected", async () => {
    // The shell hides the tabs once disconnected, so the panel is rendered on its own here.
    const calls: unknown[] = [];
    mockDaemonIpc({ agent_access_get: () => accessOff, agent_access_set: (args) => calls.push(args), display_path: maskHome });
    act(() => statusStore.set({ ...fixtureStatus, connected: false }));
    const user = userEvent.setup();
    const mapping = { ...backplaneMapping, board_name: "Backplane", workspace_name: "Internal projects", workspace_slug: "internal" };
    render(<BoundPanel mappings={[mapping]} discovered={[]} onAddFolder={() => {}} />);
    await act(async () => {});
    expect(agentSwitch("backplane")).toBeDisabled();
    expect(boundRow("backplane")).toHaveTextContent("Connect this Mac to Backplane to turn this on.");
    await user.click(agentSwitch("backplane"));
    expect(calls).toEqual([]);
  });

  it("says to connect first when the daemon refuses because this Mac isn't connected", async () => {
    const { user } = await renderProjects({
      handlers: {
        agent_access_set: () => {
          throw apiError(409, "not_connected");
        },
      },
    });
    await user.click(agentSwitch("backplane"));
    await errorToast("Couldn’t turn on agent access for backplane. Connect this Mac to Backplane first.");
    expect(agentSwitch("backplane")).toHaveAttribute("aria-checked", "false");
  });

  it("leaves the switch usable for a repository whose folder only the daemon can find", async () => {
    const calls: unknown[] = [];
    const { user } = await renderProjects({
      data: { ...overview, mappings: [{ ...storefrontMapping, root_path: null, repo_url_normalized: "github.com/acme/elsewhere", origin: "auto_repo" }] },
      handlers: {
        agent_access_set: (args) => {
          calls.push(args);
          return accessOff;
        },
      },
    });
    expect(agentSwitch("elsewhere")).toBeEnabled();
    expect(boundRow("elsewhere")).toHaveTextContent("Your coding agents get Backplane tools for this board.");
    expect(boundRow("elsewhere")).not.toHaveTextContent("hasn’t found this repository’s folder");
    await user.click(agentSwitch("elsewhere"));
    expect(calls).toEqual([{ mappingId: "m2", enabled: true }]);
  });

  it("puts the switch back and keeps saying why when the daemon hasn't found the repository's folder", async () => {
    let refuse = true;
    const { user } = await renderProjects({
      data: { ...overview, mappings: [{ ...storefrontMapping, root_path: null, repo_url_normalized: "github.com/acme/elsewhere", origin: "auto_repo" }] },
      handlers: {
        agent_access_set: () => {
          if (refuse) throw apiError(409, "mapping_root_unknown");
          return { ...accessOn, mappings: [{ mapping_id: "m2", enabled: true, agents: [] }] };
        },
      },
    });
    await user.click(agentSwitch("elsewhere"));
    await errorToast("Couldn’t turn on agent access for elsewhere. This Mac hasn’t found this repository’s folder yet.");
    expect(agentSwitch("elsewhere")).toHaveAttribute("aria-checked", "false");
    expect(agentSwitch("elsewhere")).toBeEnabled();
    expect(boundRow("elsewhere")).toHaveTextContent("This Mac hasn’t found this repository’s folder yet. Run an agent in it once, then come back.");
    refuse = false;
    await user.click(agentSwitch("elsewhere"));
    await waitFor(() => expect(agentSwitch("elsewhere")).toHaveAttribute("aria-checked", "true"));
    expect(boundRow("elsewhere")).not.toHaveTextContent("Run an agent in it once, then come back.");
  });

  it("keeps saying nothing about a missing folder after other failures", async () => {
    const { user } = await renderProjects({
      handlers: {
        agent_access_set: () => {
          throw SERVER_UNREACHABLE;
        },
      },
    });
    await user.click(agentSwitch("backplane"));
    await errorToast("Couldn’t turn on agent access for backplane. Backplane can’t be reached right now.");
    expect(boundRow("backplane")).not.toHaveTextContent("Run an agent in it once, then come back.");
  });

  it("keeps the switch usable for a repository mapping whose folder this Mac has found", async () => {
    await renderProjects({
      data: { ...overview, mappings: [{ ...storefrontMapping, root_path: null, repo_url_normalized: "github.com/acme/mobile-app", origin: "auto_repo" }] },
    });
    expect(agentSwitch("mobile-app")).toBeEnabled();
  });

  it("follows the SSE agent_access event", async () => {
    const { daemon } = await renderProjects();
    act(() => daemon.emit({ type: "agent_access", data: accessOn }));
    expect(agentSwitch("backplane")).toHaveAttribute("aria-checked", "true");
    expect(agentItem("backplane", "Claude Code")).toHaveTextContent("Ready");
  });

  it("shows no agent switch at all while the daemon can't say whether agents are on", async () => {
    await renderProjects({
      handlers: {
        agent_access_get: () => {
          throw apiError(501, "invalid_request");
        },
      },
    });
    expect(within(boundRow("backplane")).queryByRole("switch", { name: /agents/ })).not.toBeInTheDocument();
    expect(captureSwitch("backplane")).toBeInTheDocument();
  });
});

describe("Found: Add a folder…", () => {
  /** The Found view itself: a sub-tab switch leaves the previous view in the DOM while it animates out. */
  const foundView = () => {
    const view = document.querySelector<HTMLElement>('#projects-panel > [data-view]:not([data-leaving="true"])');
    if (!view) throw new Error("no active projects view");
    return view;
  };
  const addButtons = () => within(foundView()).getAllByRole("button", { name: "Add a folder…" });
  /** The section header's link comes first; the empty state's button, when there is one, last. */
  const addButton = (where: "header" | "empty state" = "header") => {
    const buttons = addButtons();
    const button = where === "header" ? buttons[0] : buttons.at(-1);
    if (!button) throw new Error("no Add a folder… button");
    return button;
  };
  const empty: Overview = { ...(overview as Overview), discovered: [] };

  it("says how the list fills when it is empty, and offers to add a folder", async () => {
    const { user } = await renderProjects({ data: empty });
    await openSubTab(user, /^Found/);
    const panel = foundView();
    expect(panel).toHaveTextContent("Nothing waiting yet");
    expect(panel).toHaveTextContent("Add a folder, or just start Claude Code or Codex in a repo and it shows up here.");
    expect(within(panel).getAllByRole("button", { name: "Add a folder…" })).toHaveLength(2);
  });

  it("adds the picked folder to the list and focuses its row", async () => {
    const added = foundAt(`${HOME}/code/shop`, "github.com/acme/shop");
    const state = { next: empty };
    const { user, publish } = await renderProjects({
      data: empty,
      handlers: {
        pick_project_folder: () => {
          state.next = { ...empty, discovered: [added] };
          return added;
        },
      },
    });
    await openSubTab(user, /^Found/);
    await user.click(addButton("empty state"));
    publish(state.next);
    await act(async () => {});
    expect(within(foundRow("shop")).getByRole("button", { name: "Bind to board…" })).toHaveFocus();
    expect(screen.queryByText("Nothing waiting yet")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("focuses the row as soon as the list shows it, even when the event comes first", async () => {
    const added = foundAt(`${HOME}/code/shop`, "github.com/acme/shop");
    let publishNow: (next: Overview) => void = () => {};
    const { user, publish } = await renderProjects({
      handlers: {
        pick_project_folder: () => {
          publishNow({ ...(overview as Overview), discovered: [...(overview as Overview).discovered, added] });
          return added;
        },
      },
    });
    publishNow = publish;
    await openSubTab(user, /^Found/);
    await user.click(addButton());
    await act(async () => {});
    expect(within(foundRow("shop")).getByRole("button", { name: "Bind to board…" })).toHaveFocus();
  });

  it("re-adding a folder already listed focuses its row and adds no second one", async () => {
    const { user } = await renderProjects({ handlers: { pick_project_folder: () => dotfilesProject } });
    await openSubTab(user, /^Found/);
    const before = within(screen.getByRole("list", { name: "Found folders" })).getAllByRole("listitem").length;
    await user.click(addButton());
    await act(async () => {});
    expect(within(foundRow("dotfiles")).getByRole("button", { name: "Bind to board…" })).toHaveFocus();
    expect(within(screen.getByRole("list", { name: "Found folders" })).getAllByRole("listitem")).toHaveLength(before);
  });

  it("changes nothing when the picker is cancelled", async () => {
    const { user, daemon } = await renderProjects({ data: empty, handlers: { pick_project_folder: () => null } });
    await openSubTab(user, /^Found/);
    const button = addButton();
    await user.click(button);
    await act(async () => {});
    expect(button).toHaveFocus();
    expect(toastRegion("alert")).toBeEmptyDOMElement();
    expect(daemon.invoked().filter((command) => command === "pick_project_folder")).toHaveLength(1);
  });

  const refusals: Array<[string, unknown, string]> = [
    ["ignored", apiError(409, "ignored_path"), "That folder is on your Ignored list. Stop ignoring it in Projects to add it."],
    ["excluded", apiError(409, "excluded_path"), "That folder matches one of your never-capture rules, so it can’t be added."],
    ["home", apiError(400, "home_or_root"), "Choose a project’s own folder, not your home folder or the whole disk."],
    ["daemon down", DAEMON_DOWN, "Couldn’t add the folder. The Companion service isn’t running."],
  ];

  it.each(refusals)("keeps the list and says why when adding fails: %s", async (_label, error, message) => {
    const { user } = await renderProjects({
      data: empty,
      handlers: {
        pick_project_folder: () => {
          throw error;
        },
      },
    });
    await openSubTab(user, /^Found/);
    await user.click(addButton());
    await errorToast(message);
    expect(foundView()).toHaveTextContent("Nothing waiting yet");
    expect(document.body).not.toHaveTextContent("raw daemon message");
  });
});

describe("Found", () => {
  it("lists every discovered folder with its reason chip and explanation, and the privacy promise", async () => {
    const { user } = await renderProjects();
    await openSubTab(user, /^Found/);

    expect(foundRow("marketing-site")).toHaveTextContent("Auto-match off");
    expect(foundRow("marketing-site")).toHaveTextContent("Its remote is linked to Marketing site, but automatic binding is off.");
    expect(foundRow("mobile-app")).toHaveTextContent("Matches 2 boards");
    expect(foundRow("mobile-app")).toHaveTextContent("Its remote is linked to two boards: Mobile app and Mobile app QA. Choose one.");
    expect(foundRow("dotfiles")).toHaveTextContent("Not bound");
    expect(foundRow("dotfiles")).toHaveTextContent("No board is linked to github.com/ada/dotfiles. Pick one to start capturing.");
    expect(foundRow("scratch")).toHaveTextContent("No git remote");
    expect(foundRow("scratch")).toHaveTextContent("This folder has no git remote, so no board can match it.");
    expect(foundRow("scratch")).not.toHaveTextContent("You can still bind the folder itself.");
    expect(foundRow("contract-work")).toHaveTextContent("Excluded");
    expect(foundRow("contract-work")).toHaveTextContent("Matches one of your never-capture rules, so it is never captured.");
    expect(foundRow("contract-work")).toHaveTextContent("~/clients/northwind/contract-work");

    expect(screen.getByText("Nothing from these folders leaves this Mac until you bind them.")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(HOME);
  });

  it("never renders a remote that isn't a plain host/owner/repo", async () => {
    const { user } = await renderProjects({
      data: {
        ...overview,
        discovered: [{ root: `${HOME}/leaky`, repo_url: "https://x-token:ghp_abc@github.com/a/b.git", first_seen: "", reason: "not_bound", candidates: [] }],
      },
    });
    await openSubTab(user, /^Found/);
    expect(foundRow("leaky")).toHaveTextContent("No board is linked to this repository. Pick one to start capturing.");
    expect(document.body).not.toHaveTextContent("ghp_abc");
  });

  it("hides a discovered folder that a mapping already covers", async () => {
    const { user } = await renderProjects({
      data: { ...overview, mappings: [...mappings, { ...backplaneMapping, id: "m-dot", root_path: null, repo_url_normalized: "github.com/ada/dotfiles" }] },
    });
    await openSubTab(user, /^Found/);
    expect(within(screen.getByRole("list", { name: "Found folders" })).queryByText("dotfiles", { selector: "b" })).not.toBeInTheDocument();
    expect(subTab(/^Found/)).toHaveAccessibleName("Found, 4 not captured yet");
  });

  it("binds an auto_match_off folder to its candidate board in one step", async () => {
    const created: unknown[] = [];
    const { user, publish } = await renderProjects({
      handlers: {
        mapping_create: (args) => {
          created.push(args);
          return createdMapping();
        },
      },
    });
    await openSubTab(user, /^Found/);
    await user.click(within(foundRow("marketing-site")).getByRole("button", { name: "Bind to Marketing site" }));
    expect(created).toEqual([
      { req: { workspace_id: "w-internal", board_id: "b-marketing", repo_url: "github.com/valaris/marketing-site", content_level: "standard" } },
    ]);
    await statusToast("Bound marketing-site to Marketing site. New sessions there are captured.");
    await finishExitAnimations();
    expect(within(screen.getByRole("list", { name: "Found folders" })).queryByText("marketing-site", { selector: "b" })).not.toBeInTheDocument();

    publish({ ...overview, mappings: [...mappings, { ...createdMapping(), root_path: null }] });
    await openSubTab(user, /^Bound/);
    expect(boundRow("marketing-site")).toHaveTextContent("Marketing site · Internal projects");
  });

  it("Other board… opens the picker for an auto_match_off folder, with its candidate flagged", async () => {
    const { user } = await renderProjects();
    await openSubTab(user, /^Found/);
    await user.click(within(foundRow("marketing-site")).getByRole("button", { name: "Other board…" }));
    const option = within(sheet()).getByRole("option", { name: "Marketing site" });
    expect(option).toHaveAccessibleDescription(/Linked to this repo/);
  });

  it("Choose board… flags both boards of an ambiguous repo", async () => {
    const { user } = await renderProjects();
    await openSubTab(user, /^Found/);
    await user.click(within(foundRow("mobile-app")).getByRole("button", { name: "Choose board…" }));
    const picker = screen.getByRole("dialog", { name: "Bind mobile-app" });
    expect(within(picker).getByRole("option", { name: "Mobile app" })).toHaveAccessibleDescription(/Linked to this repo/);
    expect(within(picker).getByRole("option", { name: "Mobile app QA" })).toHaveAccessibleDescription(/Linked to this repo/);
    expect(within(picker).getByRole("option", { name: "Backplane" })).not.toHaveAccessibleDescription(/Linked to this repo/);
  });

  it("Edit rules switches to the Rules sub-tab", async () => {
    const { user } = await renderProjects();
    await openSubTab(user, /^Found/);
    await user.click(within(foundRow("contract-work")).getByRole("button", { name: "Edit rules" }));
    expect(subTab(/^Rules/)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Never capture" })).toBeInTheDocument();
  });

  it("Bind folder… binds a folder without a remote by root_path", async () => {
    const created: unknown[] = [];
    const { user } = await renderProjects({
      handlers: {
        mapping_create: (args) => {
          created.push(args);
          return createdMapping({ root_path: `${HOME}/scratch`, repo_url_normalized: null, board_id: "b-companion" });
        },
      },
    });
    await openSubTab(user, /^Found/);
    await user.click(within(foundRow("scratch")).getByRole("button", { name: "Bind folder…" }));
    await user.click(within(sheet()).getByRole("option", { name: "Companion desktop" }));
    await user.click(within(sheet()).getByRole("radio", { name: "Metadata" }));
    await user.click(within(sheet()).getByRole("button", { name: "Bind" }));
    expect(created).toEqual([{ req: { workspace_id: "w-internal", board_id: "b-companion", root_path: `${HOME}/scratch`, content_level: "metadata" } }]);
  });

  it("Ignore sends the folder's path to project_ignore and moves focus to the next row", async () => {
    const ignoredPaths: unknown[] = [];
    const { user } = await renderProjects({
      handlers: {
        project_ignore: (args) => {
          ignoredPaths.push(args);
          return { ignored: args.path };
        },
      },
    });
    await openSubTab(user, /^Found/);
    const ignore = within(foundRow("dotfiles")).getByRole("button", { name: "Ignore" });
    ignore.focus();
    await user.keyboard("{Enter}");
    expect(ignoredPaths).toEqual([{ path: `${HOME}/dotfiles` }]);
    await finishExitAnimations();
    expect(within(screen.getByRole("list", { name: "Found folders" })).queryByText("dotfiles", { selector: "b" })).not.toBeInTheDocument();
    expect(within(foundRow("scratch")).getByRole("button", { name: "Bind folder…" })).toHaveFocus();
  });

  it("focus lands on the list heading when the last row leaves", async () => {
    const { user } = await renderProjects({
      data: { ...overview, discovered: [dotfilesProject] },
      handlers: { project_ignore: (args) => ({ ignored: args.path }) },
    });
    await openSubTab(user, /^Found/);
    within(foundRow("dotfiles")).getByRole("button", { name: "Ignore" }).focus();
    await user.keyboard("{Enter}");
    await finishExitAnimations();
    expect(screen.getByRole("heading", { name: "Not captured yet" })).toHaveFocus();
    expect(screen.getByText("Nothing waiting yet")).toBeInTheDocument();
  });

  it("keeps the row and says why when ignoring fails", async () => {
    const { user } = await renderProjects({
      handlers: {
        project_ignore: () => {
          throw DAEMON_DOWN;
        },
      },
    });
    await openSubTab(user, /^Found/);
    await user.click(within(foundRow("dotfiles")).getByRole("button", { name: "Ignore" }));
    await errorToast("Couldn’t ignore dotfiles. The Companion service isn’t running.");
    expect(foundRow("dotfiles")).toBeInTheDocument();
  });

  it("ignores a second press while the first ignore is in flight", async () => {
    const calls: unknown[] = [];
    let answer: (value: unknown) => void = () => {};
    const { user } = await renderProjects({
      handlers: {
        project_ignore: (args) => {
          calls.push(args);
          return new Promise((resolve) => {
            answer = resolve;
          });
        },
      },
    });
    await openSubTab(user, /^Found/);
    const ignore = within(foundRow("dotfiles")).getByRole("button", { name: "Ignore" });
    await user.dblClick(ignore);
    await user.click(ignore);
    expect(calls).toHaveLength(1);
    expect(ignore).toHaveAttribute("aria-disabled", "true");
    expect(within(foundRow("dotfiles")).getByRole("button", { name: "Bind to board…" })).toHaveAttribute("aria-disabled", "true");
    await act(async () => answer({ ignored: `${HOME}/dotfiles` }));
  });

  it("locks the row's other actions while its one-step bind is in flight", async () => {
    const calls: string[] = [];
    let answer: (value: unknown) => void = () => {};
    const { user } = await renderProjects({
      handlers: {
        mapping_create: () => {
          calls.push("create");
          return new Promise((resolve) => {
            answer = resolve;
          });
        },
        project_ignore: () => {
          calls.push("ignore");
          return { ignored: "" };
        },
      },
    });
    await openSubTab(user, /^Found/);
    const row = foundRow("marketing-site");
    await user.click(within(row).getByRole("button", { name: "Bind to Marketing site" }));
    await user.click(within(row).getByRole("button", { name: "Ignore" }));
    await user.click(within(row).getByRole("button", { name: "Other board…" }));
    await user.click(within(row).getByRole("button", { name: "Bind to Marketing site" }));
    expect(calls).toEqual(["create"]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Other rows stay usable.
    expect(within(foundRow("dotfiles")).getByRole("button", { name: "Ignore" })).not.toHaveAttribute("aria-disabled", "true");
    await act(async () => answer(createdMapping()));
    await statusToast("Bound marketing-site to Marketing site. New sessions there are captured.");
  });

  it("unlocks the row after a failed ignore", async () => {
    const { user } = await renderProjects({
      handlers: {
        project_ignore: () => {
          throw SERVER_UNREACHABLE;
        },
      },
    });
    await openSubTab(user, /^Found/);
    await user.click(within(foundRow("dotfiles")).getByRole("button", { name: "Ignore" }));
    await errorToast("Couldn’t ignore dotfiles. Backplane can’t be reached right now.");
    expect(within(foundRow("dotfiles")).getByRole("button", { name: "Ignore" })).not.toHaveAttribute("aria-disabled", "true");
  });

  it("describes each action by its folder, so repeated buttons stay distinguishable", async () => {
    const { user } = await renderProjects();
    await openSubTab(user, /^Found/);
    expect(within(foundRow("dotfiles")).getByRole("button", { name: "Ignore" })).toHaveAccessibleDescription(/dotfiles/);
  });
});

describe("Bind sheet", () => {
  async function openDotfilesSheet(handlers: Handlers = {}) {
    const rendered = await renderProjects({ handlers });
    await openSubTab(rendered.user, /^Found/);
    const opener = within(foundRow("dotfiles")).getByRole("button", { name: "Bind to board…" });
    await rendered.user.click(opener);
    return { ...rendered, opener };
  }

  it("lists the reachable boards grouped by workspace, with their repositories", async () => {
    await openDotfilesSheet();
    const list = within(sheet()).getByRole("listbox", { name: "Boards" });
    const groups = within(list).getAllByRole("group");
    expect(groups.map((group) => document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent)).toEqual([
      "Internal projects",
      "Acme",
      "Northwind",
    ]);
    expect(within(list).getByRole("option", { name: "Backplane" })).toHaveAccessibleDescription(/github.com\/valaris\/backplane/);
    expect(within(list).getByRole("option", { name: "Fleet portal" })).toHaveAccessibleDescription(/No linked repository/);
    expect(within(sheet()).getByRole("button", { name: "Bind" })).toBeDisabled();
  });

  it("heads the level with What’s sent and offers the detail, collapsed", async () => {
    const { user } = await openDotfilesSheet();
    expect(within(sheet()).getByRole("heading", { name: "What’s sent" })).toBeInTheDocument();
    expect(within(sheet()).queryByRole("heading", { name: "What’s stored" })).not.toBeInTheDocument();
    const toggle = within(sheet()).getByRole("button", { name: "What Standard sends, in detail" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(within(sheet()).getByRole("list", { name: "Sent" })).toHaveTextContent("Your prompts");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("searches, picks with the keyboard, and binds with the chosen level", async () => {
    const created: unknown[] = [];
    const { user } = await openDotfilesSheet({
      mapping_create: (args) => {
        created.push(args);
        return createdMapping({ board_id: "b-docs", repo_url_normalized: "github.com/ada/dotfiles" });
      },
    });
    const search = within(sheet()).getByRole("combobox", { name: "Search boards" });
    expect(search).toHaveFocus();
    await user.keyboard("docs");
    expect(within(sheet()).getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(within(sheet()).getByRole("option", { name: "Docs" })).toHaveAttribute("aria-selected", "true");
    await user.click(within(sheet()).getByRole("radio", { name: "Full" }));
    expect(sheet()).toHaveTextContent("Only you can read sessions in Backplane.");
    await user.click(within(sheet()).getByRole("button", { name: "Bind" }));
    expect(created).toEqual([{ req: { workspace_id: "w-internal", board_id: "b-docs", repo_url: "github.com/ada/dotfiles", content_level: "full" } }]);
    await statusToast("Bound dotfiles to Docs. New sessions there are captured.");
  });

  it("says when no board matches the search", async () => {
    const { user } = await openDotfilesSheet();
    await user.keyboard("zzz");
    expect(within(sheet()).getByText("No boards match “zzz”. You can only bind to boards you can open in Backplane.")).toBeInTheDocument();
  });

  it("Escape clears the search first, then closes the sheet and returns focus to the opener", async () => {
    const { user, opener } = await openDotfilesSheet();
    await user.keyboard("docs");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(sheet()).getByRole("combobox")).toHaveValue("");
    await user.keyboard("{Escape}");
    await finishExitAnimations();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("Cancel closes the sheet and returns focus to the opener", async () => {
    const { user, opener } = await openDotfilesSheet();
    await user.click(within(sheet()).getByRole("button", { name: "Cancel" }));
    await finishExitAnimations();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("after a bind, focus moves to the next row once the bound row leaves", async () => {
    const { user } = await openDotfilesSheet({ mapping_create: () => createdMapping({ board_id: "b-docs" }) });
    await user.click(within(sheet()).getByRole("option", { name: "Docs" }));
    await user.click(within(sheet()).getByRole("button", { name: "Bind" }));
    await finishExitAnimations();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(within(foundRow("scratch")).getByRole("button", { name: "Bind folder…" })).toHaveFocus();
  });


  it("says the board list can't load when Backplane is unreachable, and retries", async () => {
    let reachable = false;
    const rendered = await renderProjects({
      handlers: {
        boards: () => {
          if (!reachable) throw SERVER_UNREACHABLE;
          return boards;
        },
      },
    });
    await openSubTab(rendered.user, /^Found/);
    await rendered.user.click(within(foundRow("dotfiles")).getByRole("button", { name: "Bind to board…" }));
    expect(await within(sheet()).findByText("Backplane can’t be reached, so your boards can’t be listed right now.")).toBeInTheDocument();
    reachable = true;
    await rendered.user.click(within(sheet()).getByRole("button", { name: "Try again" }));
    expect(await within(sheet()).findByRole("option", { name: "Docs" })).toBeInTheDocument();
  });

  const bindErrors: [string, unknown, string][] = [
    ["not_found", apiError(404, "not_found"), "That board no longer exists, or you can no longer open it. Pick another board."],
    ["forbidden", apiError(502, "server_rejected", { status: 403, error_code: null }), "You no longer have access to that workspace. Pick a board you can open."],
    ["forbidden (code)", apiError(403, "forbidden"), "You no longer have access to that workspace. Pick a board you can open."],
    ["server_unreachable", SERVER_UNREACHABLE, "Backplane can’t be reached right now. Nothing was bound; try again in a moment."],
    ["daemon down", DAEMON_DOWN, "The Companion service isn’t running, so nothing was bound. Try again once it starts."],
    ["unauthorized_device", apiError(401, "unauthorized_device"), "Backplane disconnected this Mac. Connect it again to bind folders."],
    ["invalid_request", apiError(400, "invalid_request"), "Backplane didn’t accept this binding. Pick another board or try again."],
    ["anything else", apiError(500, "internal"), "Couldn’t bind dotfiles. Try again."],
  ];

  it.each(bindErrors)("keeps the sheet open and explains a %s failure", async (_label, error, message) => {
    const { user } = await openDotfilesSheet({
      mapping_create: () => {
        throw error;
      },
    });
    await user.click(within(sheet()).getByRole("option", { name: "Docs" }));
    await user.click(within(sheet()).getByRole("button", { name: "Bind" }));
    expect(await within(sheet()).findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText("raw daemon message")).not.toBeInTheDocument();
    expect(within(sheet()).getByRole("button", { name: "Bind" })).toBeEnabled();
  });

  async function bindPickedFolder(folder: string, handlers: Handlers) {
    const rendered = await renderProjects({ handlers: { pick_project_folder: () => foundAt(folder), ...handlers } });
    await rendered.user.click(screen.getByRole("button", { name: "Add a folder…" }));
    await rendered.user.click(await within(await screen.findByRole("dialog")).findByRole("option", { name: "Fleet portal" }));
    const bind = within(sheet()).getByRole("button", { name: "Bind" });
    await rendered.user.click(bind);
    return { ...rendered, bind };
  }

  function conflictThenCreate(calls: string[], deleteHandler: (args: Record<string, unknown>) => unknown = (args) => ({ deleted: args.id })): Handlers {
    let createCount = 0;
    return {
      mapping_create: () => {
        createCount += 1;
        calls.push("create");
        if (createCount === 1) throw apiError(409, "conflict");
        return createdMapping({ board_id: "b-fleet", workspace_id: "w-northwind", root_path: docsMapping.root_path ?? null });
      },
      mapping_delete: (args) => {
        calls.push(`delete ${String(args.id)}`);
        return deleteHandler(args);
      },
    };
  }

  it("on a conflict with a binding this Mac knows, deletes it and binds here only after an explicit confirm", async () => {
    const calls: string[] = [];
    const { user } = await bindPickedFolder(`${HOME}/code/valaris/docs-site`, conflictThenCreate(calls));

    const dialog = await screen.findByRole("alertdialog", { name: "Already bound elsewhere" });
    expect(dialog).toHaveTextContent("docs-site is already bound to Docs.");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(calls).toEqual(["create"]);

    await user.click(within(dialog).getByRole("button", { name: "Delete the old binding and bind here" }));
    await waitFor(() => expect(calls).toEqual(["create", "delete m3", "create"]));
    await statusToast("Bound docs-site to Fleet portal. New sessions there are captured.");
    await finishExitAnimations();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("cancelling the conflict dialog deletes nothing and keeps the sheet", async () => {
    const calls: string[] = [];
    const { user, bind } = await bindPickedFolder(`${HOME}/code/valaris/docs-site`, conflictThenCreate(calls));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await finishExitAnimations();
    expect(calls).toEqual(["create"]);
    expect(screen.getByRole("dialog", { name: "Bind docs-site" })).toBeInTheDocument();
    expect(bind).toHaveFocus();
  });

  it("explains a conflict with a binding this Mac doesn't know, and deletes nothing", async () => {
    const calls: string[] = [];
    await bindPickedFolder(`${HOME}/elsewhere`, conflictThenCreate(calls));
    expect(await within(sheet()).findByRole("alert")).toHaveTextContent("It’s already bound to another board, so it can’t be bound here too.");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(calls).toEqual(["create"]);
  });

  it("keeps the conflict dialog open with the reason when deleting the old binding fails", async () => {
    const calls: string[] = [];
    const { user } = await bindPickedFolder(
      `${HOME}/code/valaris/docs-site`,
      conflictThenCreate(calls, () => {
        throw SERVER_UNREACHABLE;
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete the old binding and bind here" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Backplane can’t be reached right now. Nothing was bound; try again in a moment.");
    expect(calls).toEqual(["create", "delete m3"]);
  });

  it("the auto_match_off one-step bind explains failures in a toast", async () => {
    const { user } = await renderProjects({
      handlers: {
        mapping_create: () => {
          throw apiError(404, "not_found");
        },
      },
    });
    await openSubTab(user, /^Found/);
    await user.click(within(foundRow("marketing-site")).getByRole("button", { name: "Bind to Marketing site" }));
    await errorToast("That board no longer exists, or you can no longer open it. Pick another board.");
    expect(foundRow("marketing-site")).toBeInTheDocument();
  });
});

describe("Ignored", () => {
  it("lists ignored folders as ~/ paths", async () => {
    const { user } = await renderProjects();
    await openSubTab(user, /^Ignored/);
    const list = screen.getByRole("list", { name: "Ignored folders" });
    expect(within(list).getAllByRole("listitem").map((item) => item.querySelector(".projects-mono")?.textContent)).toEqual([
      "~/Downloads/tmp-repo",
      "~/code/forks/tiptap",
    ]);
    expect(screen.getByText("Ignored folders are never suggested again. Un-ignore one to see it under Found.")).toBeInTheDocument();
  });

  it("Un-ignore sends the absolute path to project_unignore and confirms with a toast", async () => {
    const calls: unknown[] = [];
    const { user } = await renderProjects({
      handlers: {
        project_unignore: (args) => {
          calls.push(args);
          return { unignored: args.path };
        },
      },
    });
    await openSubTab(user, /^Ignored/);
    const row = firstIgnoredRow();
    await user.click(within(row).getByRole("button", { name: "Un-ignore" }));
    expect(calls).toEqual([{ path: ignored[0] }]);
    await statusToast("~/Downloads/tmp-repo is no longer ignored.");
    await finishExitAnimations();
    expect(within(screen.getByRole("list", { name: "Ignored folders" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("says why when un-ignoring fails", async () => {
    const { user } = await renderProjects({
      handlers: {
        project_unignore: () => {
          throw SERVER_UNREACHABLE;
        },
      },
    });
    await openSubTab(user, /^Ignored/);
    const row = firstIgnoredRow();
    await user.click(within(row).getByRole("button", { name: "Un-ignore" }));
    await errorToast("Couldn’t un-ignore ~/Downloads/tmp-repo. Backplane can’t be reached right now.");
  });

  it("says so when nothing is ignored", async () => {
    const { user } = await renderProjects({ data: { ...overview, ignored: [] } });
    await openSubTab(user, /^Ignored/);
    expect(screen.getByText("No ignored folders.")).toBeInTheDocument();
  });
});

describe("Rules", () => {
  it("stays read-only, and says why, while the current rules are unknown", async () => {
    const { user, daemon } = await renderProjects({ status: withoutPolicy });
    await openSubTab(user, /^Rules/);
    expect(screen.getByText("Your current rules aren’t available yet.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Bind repositories automatically" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "New folder pattern" })).toBeDisabled();
    expect(daemon.invoked()).not.toContain("update_settings");
  });

  it("shows the auto-bind switch and turns it on through update_settings", async () => {
    const calls: unknown[] = [];
    const { user } = await renderProjects({
      status: withRules(RULES),
      handlers: {
        update_settings: (args) => {
          calls.push(args);
          return { paused: false, auto_match_repos: true, enabled_agents: ["claude_code"], exclude_globs: RULES.exclude_globs, retention_days: null };
        },
      },
    });
    await openSubTab(user, /^Rules/);
    expect(
      screen.getByText("When a repository’s remote is linked to exactly one board, bind it with the Standard level, which sends your prompts and commands."),
    ).toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: "Bind repositories automatically" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);
    expect(calls).toEqual([{ update: { auto_match_repos: true } }]);
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("lists the never-capture rules and adds one to the full list", async () => {
    const calls: unknown[] = [];
    const { user } = await renderProjects({
      status: withRules(RULES),
      handlers: {
        update_settings: (args) => {
          calls.push(args);
          const update = (args.update ?? {}) as { exclude_globs?: string[] };
          return { paused: false, auto_match_repos: false, enabled_agents: [], exclude_globs: update.exclude_globs ?? [], retention_days: null };
        },
      },
    });
    await openSubTab(user, /^Rules/);
    const list = screen.getByRole("list", { name: "Never capture rules" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["~/clients/**", "~/personal/**"]);
    expect(screen.getByText("2 rules")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "New folder pattern" }), "  ~/work/secret/**  ");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(calls).toEqual([{ update: { exclude_globs: ["~/clients/**", "~/personal/**", "~/work/secret/**"] } }]);
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByRole("textbox", { name: "New folder pattern" })).toHaveValue("");
  });

  const invalidRules: [string, string, string][] = [
    ["an empty pattern", "   ", "Type a folder pattern, like ~/clients/**."],
    ["a pattern over 256 characters", `~/${"a".repeat(256)}`, "Keep the pattern to 256 characters or fewer."],
    ["a duplicate", "~/clients/**", "That rule is already in the list."],
  ];

  it.each(invalidRules)("rejects %s without calling the daemon", async (_label, typed, message) => {
    const { user, daemon } = await renderProjects({ status: withRules(RULES) });
    await openSubTab(user, /^Rules/);
    const input = screen.getByRole("textbox", { name: "New folder pattern" });
    if (typed.trim() !== "") await user.type(input, typed);
    else await user.type(input, " ");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(daemon.invoked()).not.toContain("update_settings");
  });

  it("stops at 50 rules", async () => {
    const fifty = Array.from({ length: 50 }, (_, index) => `~/r${index}/**`);
    const { user, daemon } = await renderProjects({ status: withRules({ auto_match_repos: true, exclude_globs: fifty }) });
    await openSubTab(user, /^Rules/);
    await user.type(screen.getByRole("textbox", { name: "New folder pattern" }), "~/one-more/**");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText("You can have up to 50 rules. Remove one first.")).toBeInTheDocument();
    expect(daemon.invoked()).not.toContain("update_settings");
  });

  it("explains a pattern Backplane refuses, without its raw message", async () => {
    const { user } = await renderProjects({
      status: withRules(RULES),
      handlers: {
        update_settings: () => {
          throw apiError(400, "invalid_request", { status: 422, error_code: null });
        },
      },
    });
    await openSubTab(user, /^Rules/);
    await user.type(screen.getByRole("textbox", { name: "New folder pattern" }), "~/weird/***/x");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Backplane didn’t accept that pattern. Use a folder path with * or ** wildcards, like ~/clients/**.")).toBeInTheDocument();
    expect(screen.queryByText("raw daemon message")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "New folder pattern" })).toHaveValue("~/weird/***/x");
  });

  it("removes a rule through update_settings and confirms it", async () => {
    const calls: unknown[] = [];
    const { user } = await renderProjects({
      status: withRules(RULES),
      handlers: {
        update_settings: (args) => {
          calls.push(args);
          return { paused: false, auto_match_repos: false, enabled_agents: [], exclude_globs: ["~/personal/**"], retention_days: null };
        },
      },
    });
    await openSubTab(user, /^Rules/);
    await user.click(screen.getByRole("button", { name: "Remove rule ~/clients/**" }));
    expect(calls).toEqual([{ update: { exclude_globs: ["~/personal/**"] } }]);
    await statusToast("Removed ~/clients/**.");
  });

  it("keeps the switch and says why when saving a rule fails", async () => {
    const { user } = await renderProjects({
      status: withRules(RULES),
      handlers: {
        update_settings: () => {
          throw DAEMON_DOWN;
        },
      },
    });
    await openSubTab(user, /^Rules/);
    const toggle = screen.getByRole("switch", { name: "Bind repositories automatically" });
    await user.click(toggle);
    await errorToast("Couldn’t save your rules. The Companion service isn’t running.");
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("keeps a just-added rule when a stale status arrives, and the next add builds on it", async () => {
    const calls: unknown[] = [];
    const { user, daemon } = await renderProjects({
      status: withRules(RULES),
      handlers: {
        update_settings: (args) => {
          calls.push(args.update);
          const update = args.update as { exclude_globs: string[] };
          return { paused: false, auto_match_repos: false, enabled_agents: [], exclude_globs: update.exclude_globs, retention_days: null };
        },
      },
    });
    await openSubTab(user, /^Rules/);
    const input = screen.getByRole("textbox", { name: "New folder pattern" });
    await user.type(input, "~/c/**");
    await user.click(screen.getByRole("button", { name: "Add" }));
    // The daemon's policy refresh failed: its next status still has the old list.
    act(() => daemon.emit({ type: "status", data: withRules(RULES) }));
    expect(within(screen.getByRole("list", { name: "Never capture rules" })).getAllByRole("listitem")).toHaveLength(3);
    await user.type(input, "~/d/**");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(calls).toEqual([
      { exclude_globs: ["~/clients/**", "~/personal/**", "~/c/**"] },
      { exclude_globs: ["~/clients/**", "~/personal/**", "~/c/**", "~/d/**"] },
    ]);
  });

  it("blocks edits, and says so, while Backplane hasn't confirmed the last change", async () => {
    setConfirmTimeoutForTests(30);
    let answerSnapshot: (value: Status) => void = () => {};
    const { user } = await renderProjects({
      status: withRules(RULES),
      handlers: {
        update_settings: () => ({ paused: false, auto_match_repos: true, enabled_agents: [], exclude_globs: RULES.exclude_globs, retention_days: null }),
        status: () =>
          new Promise((resolve) => {
            answerSnapshot = resolve;
          }),
      },
    });
    await openSubTab(user, /^Rules/);
    await user.click(screen.getByRole("switch", { name: "Bind repositories automatically" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(screen.getByText("Backplane hasn’t confirmed your last change yet.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Bind repositories automatically" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "New folder pattern" })).toBeDisabled();

    await act(async () => answerSnapshot(withRules({ ...RULES, auto_match_repos: true })));
    expect(screen.queryByText("Backplane hasn’t confirmed your last change yet.")).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Bind repositories automatically" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Bind repositories automatically" })).toHaveAttribute("aria-checked", "true");
  });

  it("after the confirm timeout, shows the rules Backplane really has when another device changed them, and unlocks", async () => {
    setConfirmTimeoutForTests(30);
    const { user } = await renderProjects({
      status: withRules(RULES),
      handlers: {
        update_settings: (args) => ({ paused: false, auto_match_repos: false, enabled_agents: [], exclude_globs: (args.update as { exclude_globs: string[] }).exclude_globs, retention_days: null }),
        status: () => withRules({ auto_match_repos: false, exclude_globs: ["~/from-another-mac/**"] }),
      },
    });
    await openSubTab(user, /^Rules/);
    await user.type(screen.getByRole("textbox", { name: "New folder pattern" }), "~/c/**");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    await statusToast("Your rules were changed elsewhere; showing the current ones.");
    const list = screen.getByRole("list", { name: "Never capture rules" });
    await waitFor(() => expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["~/from-another-mac/**"]));
    expect(screen.getByRole("textbox", { name: "New folder pattern" })).toBeEnabled();
    expect(screen.queryByText("Backplane hasn’t confirmed your last change yet.")).not.toBeInTheDocument();
  });
});

describe("Bind sheet with no boards yet", () => {
  const NO_WORKSPACES = { workspaces: [] };
  const ONE_EMPTY_WORKSPACE = { workspaces: [{ id: "w-fresh", slug: "fresh", name: "Fresh", boards: [] }] };

  async function openEmptySheet({ status = baseStatus as Status, handlers = {} as Handlers } = {}) {
    const rendered = await renderProjects({ status, handlers: { boards: () => NO_WORKSPACES, open_backplane_url: () => null, ...handlers } });
    await openSubTab(rendered.user, /^Found/);
    await rendered.user.click(within(foundRow("dotfiles")).getByRole("button", { name: "Bind to board…" }));
    await act(async () => {});
    return rendered;
  }

  /** The owner went to the browser and came back: the panel lost key focus, then got it again. */
  async function returnFromBrowser() {
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {});
  }

  it("sells a board instead of reporting a gap: headline, value, the create button and the agent tip", async () => {
    await openEmptySheet();
    expect(within(sheet()).getByRole("heading", { name: "Keep real track of your project with Backplane" })).toBeInTheDocument();
    expect(sheet()).toHaveTextContent(
      "Give it a board, and every Claude Code and Codex session here lands on it with its cost and progress. Your agents can work from the same board.",
    );
    expect(within(sheet()).getByRole("button", { name: "Open Backplane to create a board" })).toBeInTheDocument();
    expect(sheet()).toHaveTextContent("Or ask Claude Code: “create a Backplane board for this project”. It shows up here when you come back.");
    expect(sheet()).not.toHaveTextContent("No boards to choose from yet");
    expect(within(sheet()).queryByRole("radio", { name: "Full" })).not.toBeInTheDocument();
    expect(within(sheet()).getByRole("button", { name: "Bind" })).toBeDisabled();
  });

  it("opens the web app's root on the account's web origin when there is no single workspace to land in", async () => {
    const opened: unknown[] = [];
    const { user } = await openEmptySheet({ handlers: { open_backplane_url: (args) => opened.push(args) && null } });
    await user.click(within(sheet()).getByRole("button", { name: "Open Backplane to create a board" }));
    expect(opened).toEqual([{ url: "https://app.bp.example.dev/" }]);
  });

  it("opens the workspace's boards page, where the create button is, when the owner has exactly one workspace", async () => {
    const opened: unknown[] = [];
    const { user } = await openEmptySheet({ handlers: { boards: () => ONE_EMPTY_WORKSPACE, open_backplane_url: (args) => opened.push(args) && null } });
    await user.click(within(sheet()).getByRole("button", { name: "Open Backplane to create a board" }));
    expect(opened).toEqual([{ url: "https://app.bp.example.dev/fresh/boards" }]);
  });

  it("never builds a path out of a workspace slug that a browser would resolve as a step", async () => {
    const opened: unknown[] = [];
    const { user } = await openEmptySheet({
      handlers: { boards: () => ({ workspaces: [{ id: "w", slug: "..", name: "Odd", boards: [] }] }), open_backplane_url: (args) => opened.push(args) && null },
    });
    await user.click(within(sheet()).getByRole("button", { name: "Open Backplane to create a board" }));
    expect(opened).toEqual([{ url: "https://app.bp.example.dev/" }]);
  });

  it("offers no button without a web origin, and says where to create one instead", async () => {
    const account = baseStatus.account;
    if (!account) throw new Error("the status fixture has no account");
    await openEmptySheet({ status: { ...baseStatus, account: { ...account, web_origin: null } } });
    expect(within(sheet()).queryByRole("button", { name: "Open Backplane to create a board" })).not.toBeInTheDocument();
    expect(sheet()).toHaveTextContent("Create a board in Backplane on the web, then come back here to pick it.");
    expect(sheet()).toHaveTextContent("Or ask Claude Code: “create a Backplane board for this project”.");
  });

  it("says so in a toast when the browser can't be opened", async () => {
    const { user } = await openEmptySheet({
      handlers: {
        open_backplane_url: () => {
          throw apiError(400, "invalid_input");
        },
      },
    });
    await user.click(within(sheet()).getByRole("button", { name: "Open Backplane to create a board" }));
    await errorToast("Couldn’t open Backplane in your browser.");
  });

  it("shows the new board when the owner comes back from the browser, without a restart", async () => {
    let created = false;
    await openEmptySheet({ handlers: { boards: () => (created ? boards : NO_WORKSPACES) } });
    expect(within(sheet()).queryByRole("option")).not.toBeInTheDocument();
    created = true;
    await returnFromBrowser();
    expect(await within(sheet()).findByRole("option", { name: "Docs" })).toBeInTheDocument();
    expect(within(sheet()).queryByRole("button", { name: "Open Backplane to create a board" })).not.toBeInTheDocument();
  });

  it("moves focus to the board search and says the board is ready when the invite it was on turns into the list", async () => {
    let created = false;
    const { user } = await openEmptySheet({ handlers: { boards: () => (created ? boards : NO_WORKSPACES) } });
    await user.click(within(sheet()).getByRole("button", { name: "Open Backplane to create a board" }));
    created = true;
    await returnFromBrowser();
    await within(sheet()).findByRole("option", { name: "Docs" });
    expect(within(sheet()).getByRole("combobox", { name: "Search boards" })).toHaveFocus();
    expect(within(sheet()).getByText("Your new board is ready to pick.").closest('[role="status"]')).not.toBeNull();
  });

  it("leaves focus where the owner put it inside the sheet when the list arrives", async () => {
    let created = false;
    await openEmptySheet({ handlers: { boards: () => (created ? boards : NO_WORKSPACES) } });
    const cancel = within(sheet()).getByRole("button", { name: "Cancel" });
    cancel.focus();
    created = true;
    await returnFromBrowser();
    await within(sheet()).findByRole("option", { name: "Docs" });
    expect(cancel).toHaveFocus();
  });

  it("announces nothing while the sheet simply shows its boards", async () => {
    await openEmptySheet({ handlers: { boards: () => boards } });
    expect(within(sheet()).queryByText("Your new board is ready to pick.")).not.toBeInTheDocument();
  });

  it("keeps the list it has when the refresh on return fails", async () => {
    let reachable = true;
    const rendered = await renderProjects({
      handlers: {
        boards: () => {
          if (!reachable) throw SERVER_UNREACHABLE;
          return boards;
        },
      },
    });
    await openSubTab(rendered.user, /^Found/);
    await rendered.user.click(within(foundRow("dotfiles")).getByRole("button", { name: "Bind to board…" }));
    expect(await within(sheet()).findByRole("option", { name: "Docs" })).toBeInTheDocument();
    reachable = false;
    await returnFromBrowser();
    expect(within(sheet()).getByRole("option", { name: "Docs" })).toBeInTheDocument();
    expect(within(sheet()).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refetches the catalog on each return to the panel, not on every render", async () => {
    let fetched = 0;
    await openEmptySheet({
      handlers: {
        boards: () => {
          fetched += 1;
          return NO_WORKSPACES;
        },
      },
    });
    const before = fetched;
    await returnFromBrowser();
    await returnFromBrowser();
    expect(fetched).toBe(before + 2);
  });
});

describe("Found: what a bind covers", () => {
  it("says a board bind follows the remote and a folder bind covers only the folder", async () => {
    const { user } = await renderProjects();
    await openSubTab(user, /^Found/);
    expect(foundRow("dotfiles")).toHaveTextContent("Binds by remote: any clone of this repo is captured.");
    expect(foundRow("scratch")).toHaveTextContent("Binds by path: only this folder is captured.");
  });

  it("describes the bind that really happens when a remote can't be bound by repo", async () => {
    const { user } = await renderProjects({
      data: {
        ...overview,
        discovered: [{ root: `${HOME}/leaky`, repo_url: "https://x-token:ghp_abc@github.com/a/b.git", first_seen: "", reason: "not_bound", candidates: [] }],
      },
    });
    await openSubTab(user, /^Found/);
    expect(foundRow("leaky")).toHaveTextContent("Binds by path: only this folder is captured.");
    expect(foundRow("leaky")).not.toHaveTextContent("Binds by remote");
  });

  it("says the board binds on Choose board… and Bind to {board} rows follow the remote too", async () => {
    const { user } = await renderProjects();
    await openSubTab(user, /^Found/);
    expect(foundRow("mobile-app")).toHaveTextContent("Binds by remote: any clone of this repo is captured.");
    expect(foundRow("marketing-site")).toHaveTextContent("Binds by remote: any clone of this repo is captured.");
  });

  it("adds no scope line where there is nothing to bind", async () => {
    const { user } = await renderProjects();
    await openSubTab(user, /^Found/);
    expect(foundRow("contract-work")).not.toHaveTextContent("Binds by");
  });
});

describe("Projects: rich capture", () => {
  // The control API maps the server's 409 to its conflict envelope, keeping the upstream code (contract A, RC-03).
  const RICH_REFUSED = apiError(409, "conflict", { status: 409, error_code: "rich_capture_unavailable" });
  // The proxy refusal envelope can carry the same code.
  const RICH_REJECTED = apiError(502, "server_rejected", { status: 409, error_code: "rich_capture_unavailable" });
  // Whether this Backplane offered rich capture is a fact of the current connection (contract §2, §12).
  const connection = { installation_id: baseStatus.installation_id, endpoint: baseStatus.endpoint, connected: true, revoked: false, capture_state: "active" };
  const offered = (offer: "offered" | "not_offered" | "unknown"): Status => ({ ...baseStatus, connections: [{ ...connection, rich_capture: { offer } }] });
  const richOffered = offered("offered");

  async function openSheet(status: Status, handlers: Handlers = {}) {
    const rendered = await renderProjects({ status, handlers });
    await openSubTab(rendered.user, /^Found/);
    await rendered.user.click(within(foundRow("dotfiles")).getByRole("button", { name: "Bind to board…" }));
    return rendered;
  }

  function creating(created: unknown[]): Handlers {
    return {
      mapping_create: (args) => {
        created.push(args);
        return createdMapping({ board_id: "b-docs", repo_url_normalized: "github.com/ada/dotfiles" });
      },
    };
  }

  it("binds a new folder rich by default when this Backplane offers rich capture", async () => {
    const created: unknown[] = [];
    const { user } = await openSheet(richOffered, creating(created));
    expect(within(sheet()).getByRole("radio", { name: "Rich" })).toHaveAttribute("aria-checked", "true");
    await user.click(within(sheet()).getByRole("option", { name: "Docs" }));
    await user.click(within(sheet()).getByRole("button", { name: "Bind" }));
    expect(created).toEqual([{ req: { workspace_id: "w-internal", board_id: "b-docs", repo_url: "github.com/ada/dotfiles", content_level: "rich" } }]);
  });

  it("shows Rich as unavailable on a Backplane that doesn't offer it, and says so instead of silently picking Standard", async () => {
    const created: unknown[] = [];
    const { user } = await openSheet(offered("not_offered"), creating(created));
    const rich = within(sheet()).getByRole("radio", { name: "Rich" });
    expect(rich).toHaveAttribute("aria-disabled", "true");
    expect(within(sheet()).getByRole("radio", { name: "Standard" })).toHaveAttribute("aria-checked", "true");
    expect(sheet()).toHaveTextContent("Rich isn’t available on this Backplane.");
    await user.click(rich);
    expect(rich).toHaveAttribute("aria-checked", "false");
    await user.click(within(sheet()).getByRole("option", { name: "Docs" }));
    await user.click(within(sheet()).getByRole("button", { name: "Bind" }));
    expect(created).toEqual([{ req: expect.objectContaining({ content_level: "standard" }) }]);
  });

  it("treats a daemon that reports no offer state as one that can't capture rich", async () => {
    await openSheet({ ...baseStatus, connections: [connection] });
    expect(within(sheet()).getByRole("radio", { name: "Rich" })).toHaveAttribute("aria-disabled", "true");
    expect(sheet()).toHaveTextContent("Update Companion to capture rich content.");
  });

  it("reads the offer of the current connection only", async () => {
    await openSheet({ ...baseStatus, connections: [{ ...connection, installation_id: "another-backplane", rich_capture: { offer: "offered" } }] });
    expect(within(sheet()).getByRole("radio", { name: "Rich" })).toHaveAttribute("aria-disabled", "true");
  });

  it("says this Backplane hasn't offered rich capture while the offer is unknown, and follows it to Rich once offered", async () => {
    const { daemon } = await openSheet(offered("unknown"));
    expect(within(sheet()).getByRole("radio", { name: "Rich" })).toHaveAttribute("aria-disabled", "true");
    expect(within(sheet()).getByRole("radio", { name: "Standard" })).toHaveAttribute("aria-checked", "true");
    // True both before the first policy and against a server that predates rich capture.
    expect(sheet()).toHaveTextContent("This Backplane hasn’t offered rich capture. It may need an update. Standard is selected for now.");
    act(() => daemon.emit({ type: "status", data: richOffered }));
    expect(within(sheet()).getByRole("radio", { name: "Rich" })).toHaveAttribute("aria-checked", "true");
    expect(sheet()).not.toHaveTextContent("hasn’t offered rich capture");
  });

  it("keeps the owner's own pick when the offer arrives later", async () => {
    const { daemon, user } = await openSheet(offered("unknown"));
    await user.click(within(sheet()).getByRole("radio", { name: "Metadata" }));
    act(() => daemon.emit({ type: "status", data: richOffered }));
    expect(within(sheet()).getByRole("radio", { name: "Metadata" })).toHaveAttribute("aria-checked", "true");
  });

  it("says why nothing was bound when this Backplane turned rich capture off after offering it", async () => {
    const { user } = await openSheet(richOffered, {
      mapping_create: () => {
        throw RICH_REFUSED;
      },
    });
    await user.click(within(sheet()).getByRole("option", { name: "Docs" }));
    await user.click(within(sheet()).getByRole("button", { name: "Bind" }));
    expect(await within(sheet()).findByRole("alert")).toHaveTextContent("Rich capture isn’t enabled on this Backplane. Nothing was bound; pick another level.");
    expect(screen.queryByRole("alertdialog", { name: "Already bound elsewhere" })).not.toBeInTheDocument();
  });

  it("quick-binds a suggested board rich when offered", async () => {
    const created: unknown[] = [];
    const { user } = await renderProjects({
      status: withRules({ auto_match_repos: false, exclude_globs: [] }, richOffered),
      handlers: {
        mapping_create: (args) => {
          created.push(args);
          return createdMapping({ board_id: "b-marketing", repo_url_normalized: "github.com/valaris/marketing-site" });
        },
      },
    });
    await openSubTab(user, /^Found/);
    await user.click(within(foundRow("marketing-site")).getByRole("button", { name: "Bind to Marketing site" }));
    expect(created).toEqual([{ req: expect.objectContaining({ repo_url: "github.com/valaris/marketing-site", content_level: "rich" }) }]);
  });

  it("leaves existing bindings at their own level", async () => {
    await renderProjects({ status: richOffered });
    expect(within(boundRow("backplane")).getByRole("radio", { name: "Standard" })).toHaveAttribute("aria-checked", "true");
    expect(within(boundRow("storefront-api")).getByRole("radio", { name: "Metadata" })).toHaveAttribute("aria-checked", "true");
  });

  it("says a rich binding captures as Full while this Backplane has rich capture off", async () => {
    const rich = { ...backplaneMapping, content_level: "rich", capture: { content_level: "rich", effective_content_level: "full", reason: "server_disabled" } };
    await renderProjects({ status: offered("not_offered"), data: { ...overview, mappings: [rich, storefrontMapping, docsMapping] } as Overview });
    expect(within(boundRow("backplane")).getByRole("radio", { name: "Rich" })).toHaveAttribute("aria-checked", "true");
    expect(boundRow("backplane")).toHaveTextContent("Captured as Full: rich capture is off on this Backplane.");
  });

  it("says a rich binding captures as Full on a Companion that can't capture rich", async () => {
    const rich = { ...backplaneMapping, content_level: "rich", capture: { content_level: "rich", effective_content_level: "full", reason: "device_unsupported" } };
    await renderProjects({ status: richOffered, data: { ...overview, mappings: [rich, storefrontMapping, docsMapping] } as Overview });
    expect(boundRow("backplane")).toHaveTextContent("Captured as Full until Companion is updated.");
  });

  it("explains a rich refusal the daemon forwards as server_rejected", async () => {
    const { user } = await renderProjects({
      status: richOffered,
      handlers: {
        mapping_update: () => {
          throw RICH_REJECTED;
        },
      },
    });
    await user.click(within(boundRow("backplane")).getByRole("radio", { name: "Rich" }));
    await errorToast("Couldn’t change backplane. Rich capture isn’t enabled on this Backplane.");
  });

  it("explains a refused rich level when changing a binding", async () => {
    const { user } = await renderProjects({
      status: richOffered,
      handlers: {
        mapping_update: () => {
          throw RICH_REFUSED;
        },
      },
    });
    await user.click(within(boundRow("backplane")).getByRole("radio", { name: "Rich" }));
    await errorToast("Couldn’t change backplane. Rich capture isn’t enabled on this Backplane.");
    expect(within(boundRow("backplane")).getByRole("radio", { name: "Standard" })).toHaveAttribute("aria-checked", "true");
  });
});
