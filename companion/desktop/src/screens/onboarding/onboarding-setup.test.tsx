// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setPlatformForTests } from "../../platform/platform";
import { catalogResource, overviewResource, resetProjectsForTests } from "../../stores/projects";
import { resetDisplayPathsForTests } from "../shared/display-path";
import { resetOnboardingForTests } from "./onboarding-store";
import {
  AGENTS,
  BOARDS,
  DAEMON_DOWN,
  PROJECTS,
  apiError,
  codexNeedingRestart,
  codexNeedingTrust,
  connectedStatus,
  maskHome,
  renderSetup,
  type Handlers,
} from "./test-support";

function activeView(): HTMLElement {
  const views = [...screen.getByTestId("screen-onboarding").querySelectorAll<HTMLElement>("[data-view]")];
  const active = views.find((view) => view.dataset.leaving !== "true");
  if (!active) throw new Error("no active onboarding view");
  return active;
}

const inView = () => within(activeView());
const SHOP = { root: "/home/tester/code/shop", repo_url: "github.com/acme/shop", first_seen: "2026-09-29T09:00:00Z", reason: "not_bound", candidates: [] };
const stepHeading = () => inView().getByRole("heading", { level: 1 });
const agentRow = (name: string) => inView().getByRole("listitem", { name });
const projectRow = (name: string) => inView().getByRole("listitem", { name });

async function settle() {
  await act(async () => {});
}

async function goToProjects(handlers: Handlers = {}) {
  const rendered = await renderSetup(handlers);
  await userEvent.click(inView().getByRole("button", { name: "Continue" }));
  await settle();
  return rendered;
}

beforeEach(() => {
  localStorage.clear();
  resetOnboardingForTests();
  resetDisplayPathsForTests();
});

afterEach(() => {
  localStorage.clear();
  resetOnboardingForTests();
});

describe("Agents", () => {
  it("lists the agents the daemon found, with what each one needs", async () => {
    await renderSetup();
    expect(stepHeading()).toHaveTextContent("Capture from these agents");
    expect(inView().getByRole("img", { name: "Step 4 of 5" })).toBeInTheDocument();
    expect(within(agentRow("Claude Code")).getByRole("switch", { name: "Capture Claude Code sessions" })).toHaveAttribute("aria-checked", "true");
    await settle();
    expect(agentRow("Claude Code")).toHaveTextContent("Found in ~/.claude. Already on from an earlier setup. The Companion keeps its hook pointed at this app.");
    expect(agentRow("Claude Code")).not.toHaveTextContent("Ready as soon as it’s on.");
    expect(within(agentRow("Codex")).getByRole("switch", { name: "Capture Codex sessions" })).toHaveAttribute("aria-checked", "false");
    await waitFor(() => expect(agentRow("Codex")).toHaveTextContent("Found in ~/.codex. Needs one approval inside Codex after you turn it on."));
    const pi = agentRow("Pi");
    expect(within(pi).getByRole("switch", { name: "Capture Pi sessions" })).toBeDisabled();
    expect(within(pi).getByText("Not installed")).toBeInTheDocument();
    expect(within(pi).getByText("Install Pi and it will show up in Agents.")).toBeInTheDocument();
  });

  it("says an agent that is off is ready as soon as it's on", async () => {
    const claudeOff = AGENTS.map((agent) => (agent.id === "claude_code" && agent.integration ? { ...agent, integration: { ...agent.integration, state: "not_installed" } } : agent));
    await renderSetup({ agents: () => claudeOff });
    await settle();
    expect(within(agentRow("Claude Code")).getByRole("switch", { name: "Capture Claude Code sessions" })).toHaveAttribute("aria-checked", "false");
    expect(agentRow("Claude Code")).toHaveTextContent("Found in ~/.claude. Ready as soon as it’s on.");
    expect(agentRow("Claude Code")).not.toHaveTextContent("earlier setup");
  });

  it("says an agent the owner just turned on is on, not that it came from an earlier setup", async () => {
    let entries = AGENTS.map((agent) => (agent.id === "claude_code" && agent.integration ? { ...agent, integration: { ...agent.integration, state: "not_installed" } } : agent));
    const install = vi.fn(() => {
      entries = AGENTS;
      return AGENTS[0];
    });
    await renderSetup({ agents: () => entries, agent_install: install });
    await settle();
    await userEvent.click(within(agentRow("Claude Code")).getByRole("switch", { name: "Capture Claude Code sessions" }));
    await settle();
    expect(within(agentRow("Claude Code")).getByRole("switch", { name: "Capture Claude Code sessions" })).toHaveAttribute("aria-checked", "true");
    expect(agentRow("Claude Code")).toHaveTextContent("Found in ~/.claude. On. Sessions in bound projects are captured.");
    expect(agentRow("Claude Code")).not.toHaveTextContent(/Ready as soon as it’s on|earlier setup/);
  });

  it("never shows the home folder unmasked", async () => {
    await renderSetup();
    expect(activeView()).not.toHaveTextContent("/home/tester");
  });

  it("shows no config folder, and keeps its line, until display_path answers", async () => {
    await renderSetup({ display_path: () => new Promise(() => {}) });
    expect(agentRow("Codex")).toHaveTextContent("Needs one approval inside Codex after you turn it on.");
    expect(agentRow("Codex")).not.toHaveTextContent("/home/tester");
    expect(agentRow("Codex")).not.toHaveTextContent("Found in");
  });

  it("turns Codex on and shows the trust steps it needs", async () => {
    let entries = AGENTS;
    const install = vi.fn(() => {
      entries = codexNeedingTrust();
      return entries[1];
    });
    await renderSetup({ agents: () => entries, agent_install: install });
    await userEvent.click(within(agentRow("Codex")).getByRole("switch", { name: "Capture Codex sessions" }));
    await settle();
    expect(install).toHaveBeenCalledWith({ agentId: "codex_cli" });
    const codex = agentRow("Codex");
    expect(within(codex).getByRole("switch", { name: "Capture Codex sessions" })).toHaveAttribute("aria-checked", "true");
    expect(within(codex).getByText("Hook added. One more step, inside Codex:")).toBeInTheDocument();
    const steps = within(codex).getByRole("list", { name: "Trust the hooks in Codex" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(3);
    expect(steps).toHaveTextContent("Trust all and continue");
    const user = userEvent.setup();
    await user.click(within(steps).getByRole("button", { name: "Copy command" }));
    expect(await navigator.clipboard.readText()).toBe("codex");
  });

  it("asks to restart the Codex app right after its hooks go in while it is open", async () => {
    let entries = AGENTS;
    const install = vi.fn(() => {
      entries = codexNeedingRestart();
      return entries[1];
    });
    await renderSetup({ agents: () => entries, agent_install: install });
    await userEvent.click(within(agentRow("Codex")).getByRole("switch", { name: "Capture Codex sessions" }));
    await settle();
    const codex = agentRow("Codex");
    expect(within(codex).getByRole("list", { name: "Trust the hooks in Codex" })).toBeInTheDocument();
    expect(codex).toHaveTextContent("The Codex app was already open, so restart it to start capturing its sessions.");
    const restart = within(codex).getByRole("list", { name: "How to restart Codex" });
    expect(within(restart).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Quit Codex with ⌘Q.", "Open Codex again."]);
    expect(within(codex).queryByRole("button", { name: /quit|restart/i })).toBeNull();
  });

  it("shows only the restart once Codex already trusts the hooks", async () => {
    await renderSetup({ agents: () => codexNeedingRestart("restart_required", true) });
    await settle();
    const codex = agentRow("Codex");
    expect(within(codex).queryByRole("list", { name: "Trust the hooks in Codex" })).toBeNull();
    expect(within(codex).getByRole("list", { name: "How to restart Codex" })).toBeInTheDocument();
  });

  it("gives the command when Codex's background app server was already running", async () => {
    await renderSetup({ agents: () => codexNeedingRestart("daemon_restart_required", true) });
    await settle();
    const codex = agentRow("Codex");
    expect(codex).toHaveTextContent("Codex’s background app server was already running, so restart it to start capturing its sessions.");
    const steps = within(codex).getByRole("list", { name: "How to restart Codex’s app server" });
    expect(steps).toHaveTextContent("In a terminal, run codex app-server daemon restart.");
    const user = userEvent.setup();
    await user.click(within(steps).getByRole("button", { name: "Copy command" }));
    expect(await navigator.clipboard.readText()).toBe("codex app-server daemon restart");
    expect(within(steps).getByRole("status")).toHaveTextContent("Copied");
  });

  it("asks for no restart when nothing Codex runs predates the hooks", async () => {
    let entries = AGENTS;
    await renderSetup({
      agents: () => entries,
      agent_install: () => {
        entries = codexNeedingTrust();
        return entries[1];
      },
    });
    await userEvent.click(within(agentRow("Codex")).getByRole("switch", { name: "Capture Codex sessions" }));
    await settle();
    expect(agentRow("Codex")).not.toHaveTextContent("restart");
  });

  it("turns an agent off with the keyboard", async () => {
    let entries = AGENTS;
    const uninstall = vi.fn(() => {
      entries = AGENTS.map((agent) => (agent.id === "claude_code" && agent.integration ? { ...agent, integration: { ...agent.integration, state: "not_installed" } } : agent));
      return entries[0];
    });
    await renderSetup({ agents: () => entries, agent_uninstall: uninstall });
    within(agentRow("Claude Code")).getByRole("switch").focus();
    await userEvent.keyboard(" ");
    await settle();
    expect(uninstall).toHaveBeenCalledWith({ agentId: "claude_code" });
    expect(within(agentRow("Claude Code")).getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("keeps the switch and says why when installing fails", async () => {
    await renderSetup({ agent_install: () => { throw apiError(409, "agent_config_invalid", "Codex's config.toml is not valid TOML."); } });
    await userEvent.click(within(agentRow("Codex")).getByRole("switch"));
    await settle();
    const codex = agentRow("Codex");
    expect(within(codex).getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(within(codex).getByRole("alert")).toHaveTextContent("Couldn’t turn Codex on. Its settings file isn’t valid, so Companion left it alone. Fix the file, then try again.");
    expect(within(codex).getByRole("alert")).not.toHaveTextContent("TOML");
  });

  it("offers a retry when the agents can't be read", async () => {
    let failing = true;
    await renderSetup({ agents: () => { if (failing) throw apiError(500, "internal", "boom"); return AGENTS; } });
    expect(inView().getByRole("alert")).toHaveTextContent("Couldn’t read the agents on this Mac");
    expect(inView().getByRole("alert")).not.toHaveTextContent("boom");
    failing = false;
    await userEvent.click(inView().getByRole("button", { name: "Try again" }));
    await settle();
    expect(agentRow("Claude Code")).toBeInTheDocument();
  });

  it("says Companion isn't running when the daemon is down", async () => {
    let down = true;
    await renderSetup({ agents: () => { if (down) throw DAEMON_DOWN; return AGENTS; } });
    expect(inView().getByRole("heading", { name: "Companion isn't running" })).toBeInTheDocument();
    down = false;
    await userEvent.click(inView().getByRole("button", { name: "Try again" }));
    await settle();
    expect(agentRow("Claude Code")).toBeInTheDocument();
  });
});

describe("Capture consent", () => {
  it("never enables capture as a whole; only the agent the user turns on gets a hook", async () => {
    const enable = vi.fn();
    const location = vi.fn(() => ({ in_applications: true, path: "/Applications/Backplane Companion.app" }));
    const install = vi.fn(() => codexNeedingTrust()[1]);
    await renderSetup({ enable_capture: enable, app_location: location, agent_install: install }, connectedStatus);
    expect(agentRow("Claude Code")).toBeInTheDocument();
    await userEvent.click(within(agentRow("Codex")).getByRole("switch"));
    await settle();
    expect(install).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith({ agentId: "codex_cli" });
    expect(enable).not.toHaveBeenCalled();
    expect(location).not.toHaveBeenCalled();
  });

  it("shows the config folder only as Rust's display_path renders it", async () => {
    const tricky = AGENTS.map((agent) => (agent.id === "claude_code" && agent.presence ? { ...agent, presence: { ...agent.presence, config_path: "/home/tester/.cla\u202Eude" } } : agent));
    await renderSetup({ agents: () => tricky, display_path: ({ path }) => maskHome({ path }).replace(/\u202E/g, "") });
    expect(agentRow("Claude Code")).toHaveTextContent("Found in ~/.claude.");
  });
});

describe("Projects", () => {
  it("lists discovered repositories with their suggested board, leaving out excluded ones", async () => {
    await goToProjects();
    expect(stepHeading()).toHaveTextContent("Bind your first projects");
    expect(stepHeading()).toHaveFocus();
    expect(inView().getByRole("img", { name: "Step 5 of 5" })).toBeInTheDocument();
    const backplane = projectRow("backplane");
    expect(backplane).toHaveTextContent("Backplane · Valaris");
    expect(within(backplane).getByText("Suggested")).toBeInTheDocument();
    expect(within(projectRow("dotfiles")).getByText("No board is linked to this repository.")).toBeInTheDocument();
    expect(within(backplane).getByText("~/code/backplane")).toBeInTheDocument();
    expect(activeView()).not.toHaveTextContent("/home/tester");
    expect(inView().queryByRole("listitem", { name: "private" })).not.toBeInTheDocument();
  });

  it("binds a suggested board at the default level", async () => {
    const create = vi.fn(() => ({ id: "map-1" }));
    await goToProjects({ mapping_create: create });
    expect(inView().getByRole("heading", { name: "Sent by default" })).toBeInTheDocument();
    expect(inView().getByRole("radiogroup", { name: "Sent by default" })).toBeInTheDocument();
    expect(inView().queryByText("Stored by default")).not.toBeInTheDocument();
    await userEvent.click(within(projectRow("backplane")).getByRole("button", { name: "Bind" }));
    await settle();
    expect(create).toHaveBeenCalledWith({
      req: { workspace_id: "ws-1", board_id: "b-1", root_path: "/home/tester/code/backplane", repo_url: "github.com/valaris/backplane", content_level: "standard" },
    });
    const row = projectRow("backplane");
    expect(within(row).getByText("Bound")).toBeInTheDocument();
    expect(row).toHaveFocus();
    expect(row).toHaveTextContent("Captured with the Standard level. Change it any time in Projects.");
    expect(within(row).queryByRole("button", { name: "Bind" })).not.toBeInTheDocument();
  });

  it("binds with the default level chosen on this step", async () => {
    const create = vi.fn(() => ({ id: "map-1" }));
    await goToProjects({ mapping_create: create });
    await userEvent.click(inView().getByRole("radio", { name: "Metadata" }));
    await userEvent.click(within(projectRow("backplane")).getByRole("button", { name: "Bind" }));
    await settle();
    expect(create).toHaveBeenCalledWith({ req: expect.objectContaining({ content_level: "metadata" }) });
  });

  it("skips a repository", async () => {
    const create = vi.fn();
    await goToProjects({ mapping_create: create });
    await userEvent.click(within(projectRow("backplane")).getByRole("button", { name: "Skip" }));
    expect(within(projectRow("backplane")).getByText("Skipped")).toBeInTheDocument();
    expect(projectRow("backplane")).toHaveFocus();
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps the row and says why when binding fails", async () => {
    await goToProjects({ mapping_create: () => { throw apiError(403, "auto_match_disabled", "Matching is off for this device."); } });
    await userEvent.click(within(projectRow("backplane")).getByRole("button", { name: "Bind" }));
    await settle();
    const row = projectRow("backplane");
    expect(within(row).getByRole("alert")).toHaveTextContent("Couldn’t bind backplane. Automatic matching is off for this Mac in Backplane.");
    expect(within(row).getByRole("alert")).not.toHaveTextContent("Matching is off for this device.");
    expect(within(row).getByRole("button", { name: "Bind" })).toBeInTheDocument();
  });

  it("chooses a board in a sheet grouped by workspace and binds to it", async () => {
    const create = vi.fn(() => ({ id: "map-2" }));
    await goToProjects({ mapping_create: create });
    const opener = within(projectRow("dotfiles")).getByRole("button", { name: "Choose board…" });
    await userEvent.click(opener);
    await settle();
    const sheet = screen.getByRole("dialog", { name: "Bind dotfiles" });
    const list = within(sheet).getByRole("listbox", { name: "Boards" });
    expect(within(list).getByRole("group", { name: "Valaris" })).toBeInTheDocument();
    expect(within(list).getByRole("group", { name: "Acme" })).toBeInTheDocument();
    const bind = within(sheet).getByRole("button", { name: "Bind" });
    expect(bind).toBeDisabled();
    await userEvent.click(within(list).getByRole("option", { name: "Storefront" }));
    await userEvent.click(within(sheet).getByRole("radio", { name: "Full" }));
    await userEvent.click(bind);
    await settle();
    expect(create).toHaveBeenCalledWith({ req: { workspace_id: "ws-2", board_id: "b-3", root_path: "/home/tester/dotfiles", content_level: "full" } });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(within(projectRow("dotfiles")).getByText("Bound")).toBeInTheDocument();
  });

  it("marks the repository's linked boards in the sheet and searches them from the keyboard", async () => {
    const [backplane] = PROJECTS.discovered;
    if (!backplane) throw new Error("fixture has no projects");
    const linkedTwice = { ...backplane, candidates: [...(backplane.candidates ?? []), { workspace_id: "ws-2", workspace_name: "Acme", board_id: "b-3", board_name: "Storefront" }] };
    await goToProjects({ projects: () => ({ ...PROJECTS, discovered: [linkedTwice] }) });
    const row = projectRow("backplane");
    expect(row).toHaveTextContent("Linked to 2 boards. Choose one.");
    await userEvent.click(within(row).getByRole("button", { name: "Choose board…" }));
    await settle();
    const sheet = screen.getByRole("dialog", { name: "Bind backplane" });
    expect(within(sheet).getByRole("heading", { name: "What’s sent" })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "What Standard sends, in detail" })).toHaveAttribute("aria-expanded", "false");
    expect(within(sheet).getByRole("option", { name: "Backplane" })).toHaveAccessibleDescription(/Linked to this repo/);
    const search = within(sheet).getByRole("combobox", { name: "Search boards" });
    await userEvent.type(search, "store");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(within(sheet).getByRole("option", { name: "Storefront" })).toHaveAttribute("aria-selected", "true");
  });

  it("returns focus to the opener when the sheet is cancelled", async () => {
    await goToProjects();
    const opener = within(projectRow("dotfiles")).getByRole("button", { name: "Choose board…" });
    await userEvent.click(opener);
    await settle();
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await settle();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(within(projectRow("dotfiles")).getByRole("button", { name: "Choose board…" })).toHaveFocus();
  });

  it("shows an error in the sheet when binding there fails", async () => {
    await goToProjects({ mapping_create: () => { throw apiError(404, "not_found", "That board is gone."); } });
    await userEvent.click(within(projectRow("dotfiles")).getByRole("button", { name: "Choose board…" }));
    await settle();
    const sheet = screen.getByRole("dialog");
    await userEvent.click(within(sheet).getByRole("option", { name: "Website" }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Bind" }));
    await settle();
    expect(within(sheet).getByRole("alert")).toHaveTextContent("That’s no longer there. Refresh and try again.");
    expect(within(sheet).getByRole("alert")).not.toHaveTextContent("That board is gone.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("says so in the sheet when the boards can't be loaded, and retries", async () => {
    let failing = true;
    await goToProjects({ boards: () => { if (failing) throw apiError(502, "server_unreachable"); return BOARDS; } });
    await userEvent.click(within(projectRow("dotfiles")).getByRole("button", { name: "Choose board…" }));
    await settle();
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByRole("alert")).toHaveTextContent("Couldn’t load your boards");
    failing = false;
    await userEvent.click(within(sheet).getByRole("button", { name: "Try again" }));
    await settle();
    expect(within(sheet).getByRole("listbox", { name: "Boards" })).toBeInTheDocument();
  });

  it("shares the projects it fetched with the projects store", async () => {
    await goToProjects();
    expect(overviewResource.store.get()?.discovered).toHaveLength(3);
  });

  it("uses projects the store already holds without asking again", async () => {
    const projects = vi.fn(() => PROJECTS);
    overviewResource.push({ mappings: [], discovered: PROJECTS.discovered, ignored: [] });
    await goToProjects({ projects });
    expect(projectRow("backplane")).toBeInTheDocument();
    expect(projects).not.toHaveBeenCalled();
  });

  it("keeps a bound row after the policy refresh drops it from discovered", async () => {
    const { daemon } = await goToProjects({ mapping_create: () => ({ id: "map-1" }) });
    await userEvent.click(within(projectRow("backplane")).getByRole("button", { name: "Bind" }));
    await settle();
    act(() => daemon.emit({ type: "projects", data: { ...PROJECTS, discovered: PROJECTS.discovered.slice(1) } }));
    expect(within(projectRow("backplane")).getByText("Bound")).toBeInTheDocument();
  });

  it("shows cached boards in the sheet and keeps them when the refresh fails", async () => {
    catalogResource.push(BOARDS);
    await goToProjects({ boards: () => { throw apiError(502, "server_unreachable"); } });
    await userEvent.click(within(projectRow("dotfiles")).getByRole("button", { name: "Choose board…" }));
    await settle();
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByRole("listbox", { name: "Boards" })).toBeInTheDocument();
    expect(within(sheet).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("feeds the boards it fetched to the catalog store", async () => {
    await goToProjects();
    await userEvent.click(within(projectRow("dotfiles")).getByRole("button", { name: "Choose board…" }));
    await settle();
    expect(catalogResource.store.get()?.workspaces).toHaveLength(2);
  });

  it("explains an empty list of repositories, and offers to add a folder", async () => {
    await goToProjects({ projects: () => ({ ...PROJECTS, discovered: [] }) });
    expect(inView().getByText("No projects yet")).toBeInTheDocument();
    expect(activeView()).toHaveTextContent("Add a folder, or just start Claude Code or Codex in a repo and it shows up here.");
    expect(inView().getByRole("button", { name: "Add a folder…" })).toBeInTheDocument();
  });

  it("adds a picked folder to the empty list and focuses its row", async () => {
    await goToProjects({ projects: () => ({ ...PROJECTS, discovered: [] }), pick_project_folder: () => SHOP });
    await userEvent.click(inView().getByRole("button", { name: "Add a folder…" }));
    await settle();
    const row = projectRow("shop");
    expect(row).toHaveFocus();
    expect(row).toHaveTextContent("No board is linked to this repository.");
    expect(within(row).getByRole("button", { name: "Choose board…" })).toBeInTheDocument();
    expect(inView().queryByText("No projects yet")).not.toBeInTheDocument();
  });

  it("adds a picked folder below the repositories already listed", async () => {
    await goToProjects({ pick_project_folder: () => SHOP });
    await userEvent.click(inView().getByRole("button", { name: "Add a folder…" }));
    await settle();
    const rows = within(inView().getByRole("list", { name: "Repositories" })).getAllByRole("listitem");
    expect(rows.at(-1)).toHaveAccessibleName("shop");
    expect(projectRow("shop")).toHaveFocus();
  });

  it("re-adding a listed repository focuses its row instead of adding it twice", async () => {
    const dotfiles = PROJECTS.discovered.find((project) => project.root.endsWith("/dotfiles"));
    await goToProjects({ pick_project_folder: () => dotfiles });
    const before = within(inView().getByRole("list", { name: "Repositories" })).getAllByRole("listitem").length;
    await userEvent.click(inView().getByRole("button", { name: "Add a folder…" }));
    await settle();
    expect(projectRow("dotfiles")).toHaveFocus();
    expect(within(inView().getByRole("list", { name: "Repositories" })).getAllByRole("listitem")).toHaveLength(before);
  });

  it("changes nothing when the folder picker is cancelled", async () => {
    await goToProjects({ projects: () => ({ ...PROJECTS, discovered: [] }), pick_project_folder: () => null });
    const button = inView().getByRole("button", { name: "Add a folder…" });
    await userEvent.click(button);
    await settle();
    expect(button).toHaveFocus();
    expect(inView().queryByRole("alert")).not.toBeInTheDocument();
    expect(inView().getByText("No projects yet")).toBeInTheDocument();
  });

  it("says why, in its own words, when the daemon refuses the folder", async () => {
    await goToProjects({
      projects: () => ({ ...PROJECTS, discovered: [] }),
      pick_project_folder: () => {
        throw apiError(409, "excluded_path", "raw daemon message");
      },
    });
    await userEvent.click(inView().getByRole("button", { name: "Add a folder…" }));
    await settle();
    expect(inView().getByRole("alert")).toHaveTextContent("That folder matches one of your never-capture rules, so it can’t be added.");
    expect(activeView()).not.toHaveTextContent("raw daemon message");
  });

  it("offers a retry when the projects can't be read", async () => {
    let failing = true;
    await goToProjects({ projects: () => { if (failing) throw apiError(500, "internal", "boom"); return PROJECTS; } });
    expect(inView().getByRole("alert")).toHaveTextContent("Couldn’t read your projects");
    failing = false;
    await userEvent.click(inView().getByRole("button", { name: "Try again" }));
    await settle();
    expect(projectRow("backplane")).toBeInTheDocument();
  });

  it("leaves binding for later", async () => {
    await goToProjects();
    await userEvent.click(inView().getByRole("button", { name: "Later" }));
    await settle();
    expect(stepHeading()).toHaveTextContent("You’re set");
  });

  it("goes back to agents with Back", async () => {
    await goToProjects();
    await userEvent.click(inView().getByRole("button", { name: "Back" }));
    await settle();
    expect(stepHeading()).toHaveTextContent("Capture from these agents");
    expect(stepHeading()).toHaveFocus();
  });
});

describe("Done", () => {
  it("teaches the tray glyph and where to pause", async () => {
    await goToProjects();
    await userEvent.click(inView().getByRole("button", { name: "Continue" }));
    await settle();
    expect(stepHeading()).toHaveTextContent("You’re set");
    expect(stepHeading()).toHaveFocus();
    expect(activeView().querySelector('[data-tray-glyph="capturing"]')).not.toBeNull();
    expect(inView().getByText("Pause")).toBeInTheDocument();
    expect(inView().getByText("Click the icon, then the pause button. Or right-click it.")).toBeInTheDocument();
    expect(inView().queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  });

  it("says where to change what’s sent, in the same words as the levels", async () => {
    await goToProjects();
    await userEvent.click(inView().getByRole("button", { name: "Continue" }));
    await settle();
    expect(inView().getByText("Change what’s sent")).toBeInTheDocument();
    expect(inView().getByText("Projects lets you set Metadata, Standard or Full per folder.")).toBeInTheDocument();
    expect(activeView()).not.toHaveTextContent(/what’s kept|what’s stored/);
  });
});

describe("Done on Linux", () => {
  it("teaches pausing from the tray menu, not by clicking the icon", async () => {
    setPlatformForTests("linux");
    await goToProjects();
    await userEvent.click(inView().getByRole("button", { name: "Continue" }));
    await settle();
    expect(stepHeading()).toHaveTextContent("You’re set");
    expect(inView().getByText("Choose Pause capture in the tray icon’s menu, or use the pause button at the top of this window.")).toBeInTheDocument();
    expect(inView().queryByText(/Click the icon/)).not.toBeInTheDocument();
  });
});

describe("Projects: the bind sheet with no boards yet", () => {
  const NO_WORKSPACES = { workspaces: [] };

  beforeEach(() => {
    resetProjectsForTests();
  });

  async function openEmptySheet(handlers: Handlers = {}, status = connectedStatus) {
    await renderSetup({ boards: () => NO_WORKSPACES, open_backplane_url: () => null, ...handlers }, status);
    await userEvent.click(inView().getByRole("button", { name: "Continue" }));
    await settle();
    await userEvent.click(within(projectRow("dotfiles")).getByRole("button", { name: "Choose board…" }));
    await settle();
    return screen.getByRole("dialog", { name: "Bind dotfiles" });
  }

  /** The owner went to the browser and came back: the panel lost key focus, then got it again. */
  async function returnFromBrowser() {
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
  }

  it("invites the owner to create a board, with the agent tip, instead of an empty list", async () => {
    const sheet = await openEmptySheet();
    expect(within(sheet).getByRole("heading", { name: "Keep real track of your project with Backplane" })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Open Backplane to create a board" })).toBeInTheDocument();
    expect(sheet).toHaveTextContent("Or ask Claude Code: “create a Backplane board for this project”. It shows up here when you come back.");
    expect(within(sheet).queryByRole("listbox")).not.toBeInTheDocument();
    expect(within(sheet).queryByRole("radio", { name: "Full" })).not.toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Bind" })).toBeDisabled();
  });

  it("opens the account's web origin to create one", async () => {
    const opened: unknown[] = [];
    const sheet = await openEmptySheet({ open_backplane_url: (args) => opened.push(args) && null });
    await userEvent.click(within(sheet).getByRole("button", { name: "Open Backplane to create a board" }));
    expect(opened).toEqual([{ url: "https://app.bp.example.dev/" }]);
  });

  it("offers no button without a web origin, and says where to create one instead", async () => {
    const account = connectedStatus.account;
    if (!account) throw new Error("the status fixture has no account");
    const sheet = await openEmptySheet({}, { ...connectedStatus, account: { ...account, web_origin: null } });
    expect(within(sheet).queryByRole("button", { name: "Open Backplane to create a board" })).not.toBeInTheDocument();
    expect(sheet).toHaveTextContent("Create a board in Backplane on the web, then come back here to pick it.");
  });

  it("says so in a toast when the browser can't be opened", async () => {
    const sheet = await openEmptySheet({
      open_backplane_url: () => {
        throw apiError(400, "invalid_input");
      },
    });
    await userEvent.click(within(sheet).getByRole("button", { name: "Open Backplane to create a board" }));
    const alerts = document.querySelector<HTMLElement>('[data-toast-region="alert"]');
    if (!alerts) throw new Error("no alert toast region");
    expect(await within(alerts).findByText("Couldn’t open Backplane in your browser.")).toBeInTheDocument();
  });

  it("shows the new board when the owner comes back from the browser", async () => {
    let created = false;
    const sheet = await openEmptySheet({ boards: () => (created ? BOARDS : NO_WORKSPACES) });
    created = true;
    await returnFromBrowser();
    expect(await within(sheet).findByRole("option", { name: "Website" })).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Open Backplane to create a board" })).not.toBeInTheDocument();
  });

  it("moves focus to the board search and says the board is ready when the invite it was on turns into the list", async () => {
    let created = false;
    const sheet = await openEmptySheet({ boards: () => (created ? BOARDS : NO_WORKSPACES) });
    await userEvent.click(within(sheet).getByRole("button", { name: "Open Backplane to create a board" }));
    created = true;
    await returnFromBrowser();
    await within(sheet).findByRole("option", { name: "Website" });
    expect(within(sheet).getByRole("combobox", { name: "Search boards" })).toHaveFocus();
    expect(within(sheet).getByText("Your new board is ready to pick.").closest('[role="status"]')).not.toBeNull();
  });

  it("leaves focus where the owner put it inside the sheet when the list arrives", async () => {
    let created = false;
    const sheet = await openEmptySheet({ boards: () => (created ? BOARDS : NO_WORKSPACES) });
    const cancel = within(sheet).getByRole("button", { name: "Cancel" });
    cancel.focus();
    created = true;
    await returnFromBrowser();
    await within(sheet).findByRole("option", { name: "Website" });
    expect(cancel).toHaveFocus();
  });

  it("keeps the list it has when the refresh on return fails", async () => {
    let reachable = true;
    const sheet = await openEmptySheet({
      boards: () => {
        if (!reachable) throw apiError(502, "server_unreachable");
        return BOARDS;
      },
    });
    expect(within(sheet).getByRole("option", { name: "Website" })).toBeInTheDocument();
    reachable = false;
    await returnFromBrowser();
    expect(within(sheet).getByRole("option", { name: "Website" })).toBeInTheDocument();
    expect(within(sheet).queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("Projects: rich capture", () => {
  const offered = (offer: "offered" | "not_offered"): typeof connectedStatus => ({
    ...connectedStatus,
    connections: [
      { installation_id: connectedStatus.installation_id, endpoint: connectedStatus.endpoint, connected: true, revoked: false, capture_state: "active", rich_capture: { offer } },
    ],
  });

  async function goToProjectsWith(status: typeof connectedStatus, handlers: Handlers = {}) {
    const rendered = await renderSetup(handlers, status);
    await userEvent.click(inView().getByRole("button", { name: "Continue" }));
    await settle();
    return rendered;
  }

  it("defaults to Rich when this Backplane offers rich capture", async () => {
    const create = vi.fn(() => ({ id: "map-1" }));
    await goToProjectsWith(offered("offered"), { mapping_create: create });
    expect(within(inView().getByRole("radiogroup", { name: "Sent by default" })).getByRole("radio", { name: "Rich" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(projectRow("backplane")).getByRole("button", { name: "Bind" }));
    await settle();
    expect(create).toHaveBeenCalledWith({ req: expect.objectContaining({ content_level: "rich" }) });
    expect(projectRow("backplane")).toHaveTextContent("Captured with the Rich level. Change it any time in Projects.");
  });

  it("shows Rich unavailable and keeps Standard when this Backplane doesn't offer it", async () => {
    await goToProjectsWith(offered("not_offered"));
    const levels = inView().getByRole("radiogroup", { name: "Sent by default" });
    expect(within(levels).getByRole("radio", { name: "Rich" })).toHaveAttribute("aria-disabled", "true");
    expect(within(levels).getByRole("radio", { name: "Standard" })).toHaveAttribute("aria-checked", "true");
    expect(activeView()).toHaveTextContent("Rich isn’t available on this Backplane.");
  });

  it("says why nothing was bound in the sheet when this Backplane refuses the rich level", async () => {
    // The control API maps the server's 409 to its conflict envelope, keeping the upstream code (contract A, RC-03).
    const refused = { kind: "api", status: 409, code: "conflict", message: "Backplane refused the change as conflicting.", detail: { status: 409, error_code: "rich_capture_unavailable" } };
    await goToProjectsWith(offered("offered"), { mapping_create: () => { throw refused; } });
    await userEvent.click(within(projectRow("dotfiles")).getByRole("button", { name: "Choose board…" }));
    await settle();
    const sheet = screen.getByRole("dialog");
    await userEvent.click(within(sheet).getByRole("option", { name: "Website" }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Bind" }));
    await settle();
    expect(within(sheet).getByRole("alert")).toHaveTextContent("Rich capture isn’t enabled on this Backplane. Nothing was bound; pick another level.");
    expect(within(sheet).getByRole("alert")).not.toHaveTextContent("Backplane turned the request down.");
  });
});
