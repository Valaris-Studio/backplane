// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../App";
import { agentDisplayName } from "../../components/agent-identity";
import type { AttentionItem, DaemonStreamMessage, LocalSession } from "../../ipc/bindings";
import { startDaemonStream } from "../../stores/daemon-stream";
import { popoverVisibleStore, trackPopoverVisibility } from "../../shell/popover-visibility";
import { mergeServerSessions, sessionsStore } from "../../stores/sessions";
import { mockDaemonIpc } from "../../test/daemon-ipc";
import { HOME_RESORT_INTERVAL_MS, resetHomeViewForTests } from "./use-home-view";

// Clears the filter outside the toolbar, as another surface (or a later release) might.
const clearFilterElsewhere = () => resetHomeViewForTests();
import {
  NOW,
  baseStatus,
  boards,
  claudeSession,
  codexSession,
  projects,
  session,
  sessionEvent,
  withCapture,
  type Status,
} from "./home-fixtures";

type Handlers = Parameters<typeof mockDaemonIpc>[0];

const SERVER_UNREACHABLE = { kind: "api", status: 502, code: "server_unreachable", message: "Can’t reach the server", detail: null };

function defaultHandlers(overrides: Handlers = {}): Handlers {
  return {
    boards: () => boards,
    projects: () => projects,
    resume: () => ({ paused: false }),
    open_backplane_url: () => null,
    ...overrides,
  };
}

async function renderHome({
  status = baseStatus,
  sessions = [] as DaemonStreamMessage[],
  attention = [] as AttentionItem[],
  handlers = {} as Handlers,
} = {}) {
  const daemon = mockDaemonIpc(defaultHandlers(handlers));
  startDaemonStream();
  const user = userEvent.setup();
  render(<App />);
  await act(async () => {});
  act(() => {
    daemon.emit({ type: "daemon.connected" });
    daemon.emit({ type: "status", data: status });
    if (attention.length > 0) daemon.emit({ type: "attention", data: { items: attention } });
    for (const message of sessions) daemon.emit(message);
  });
  // Board names load asynchronously over IPC.
  await act(async () => {});
  return { daemon, user };
}

const started = (payload: LocalSession): DaemonStreamMessage => ({ type: "session", data: sessionEvent("started", payload) });
const updated = (payload: LocalSession): DaemonStreamMessage => ({ type: "session", data: sessionEvent("updated", payload) });
const ended = (payload: LocalSession): DaemonStreamMessage => ({ type: "session", data: sessionEvent("ended", payload) });

const liveList = () => screen.getByRole("list", { name: "Live now" });
const earlierList = () => screen.getByRole("list", { name: "Earlier today" });
const liveRows = () => within(liveList()).queryAllByRole("listitem");
// By the daemon's harness id, named however the kit's identity table names it.
const rowFor = (list: HTMLElement, harness: string) => {
  const row = within(list)
    .getAllByRole("listitem")
    .find((item) => item.textContent?.includes(`${agentDisplayName(harness)}:`));
  if (!row) throw new Error(`no row for ${harness}`);
  return row;
};
// Motion times its exits off the (frozen) clock: step it past the longest exit.
async function finishExitAnimations() {
  for (let step = 0; step < 10; step += 1) {
    await act(async () => {
      vi.advanceTimersByTime(60);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

const totals = () => screen.getByRole("group", { name: "Today’s totals" });

// A usage figure's value sits in the <dd> after the <dt> that holds its term.
const usageFigure = (panel: ReturnType<typeof within>, term: string) => panel.getByText(term).closest("dt")?.nextElementSibling;

async function expandRow(user: ReturnType<typeof userEvent.setup>, list: HTMLElement, harness: string) {
  const trigger = within(rowFor(list, harness)).getByRole("button", { expanded: false });
  await user.click(trigger);
  return within(document.getElementById(trigger.getAttribute("aria-controls") ?? "") as HTMLElement);
}

// Only Date is frozen: Motion's frame loop runs on real intervals, and faking those wedges it for later tests.
const freezeDate = () => vi.useFakeTimers({ toFake: ["Date"], now: NOW });

let stopTrackingVisibility: () => void = () => {};

beforeEach(() => {
  freezeDate();
  // As main.tsx does; the popover is on screen while Home is tested.
  stopTrackingVisibility = trackPopoverVisibility();
  popoverVisibleStore.set(true);
});

afterEach(() => {
  stopTrackingVisibility();
  vi.useRealTimers();
});

describe("Home, capturing", () => {
  it("lists live sessions with agent, repo → board, elapsed time, tokens and a labelled cost", async () => {
    await renderHome({ sessions: [started(codexSession), started(claudeSession)] });

    expect(screen.getByRole("heading", { name: "Live now" })).toBeInTheDocument();
    expect(liveRows()).toHaveLength(2);

    const claude = rowFor(liveList(), "claude_code");
    expect(claude).toHaveTextContent("acme/app");
    expect(claude).toHaveTextContent("to board");
    expect(claude).toHaveTextContent("Backplane");
    expect(claude).toHaveTextContent("14:12");
    expect(claude).toHaveTextContent("182k tokens");
    expect(claude).toHaveTextContent("$1.84");
    expect(claude).toHaveTextContent("API‑equivalent");

    const codex = rowFor(liveList(), "codex_cli");
    expect(codex).toHaveTextContent("acme/storefront-api");
    expect(codex).toHaveTextContent("Storefront");
    expect(codex).toHaveTextContent("3:40");
    expect(codex).toHaveTextContent("$0.38");
    expect(codex).toHaveTextContent("spend");
  });

  it("lists the newest live session first", async () => {
    await renderHome({ sessions: [started(codexSession), started(claudeSession)] });
    const [first] = liveRows();
    expect(first).toHaveTextContent(`${agentDisplayName("claude_code")}:`);
  });

  it("shows the repo only when no board is known for it", async () => {
    const unbound = session({ native_session_id: "sess-other", repo: "github.com/acme/unknown-repo" });
    await renderHome({ sessions: [started(unbound)] });
    const row = rowFor(liveList(), "claude_code");
    expect(row).toHaveTextContent("acme/unknown-repo");
    expect(row).not.toHaveTextContent("to board");
  });

  it("shows the repo only when the repo matches two boards and no mapping picks one", async () => {
    const ambiguous = session({ native_session_id: "sess-mobile", repo: "github.com/acme/mobile-app" });
    await renderHome({ sessions: [started(ambiguous)] });
    const row = rowFor(liveList(), "claude_code");
    expect(row).not.toHaveTextContent("Mobile app QA");
    expect(row).not.toHaveTextContent("to board");
  });

  it("shows the repo only, without crashing, when the board list can't be loaded", async () => {
    await renderHome({
      sessions: [started(claudeSession)],
      handlers: {
        boards: () => {
          throw SERVER_UNREACHABLE;
        },
      },
    });
    const row = rowFor(liveList(), "claude_code");
    expect(row).toHaveTextContent("acme/app");
    expect(row).not.toHaveTextContent("to board");
  });

  it("shows — and no label when the cost basis is unknown", async () => {
    const noBasis = session({ native_session_id: "sess-nobasis", cost_basis: null, auth_kind: null });
    await renderHome({ sessions: [started(noBasis)] });
    const row = rowFor(liveList(), "claude_code");
    expect(row).toHaveTextContent("—");
    expect(row).not.toHaveTextContent("$1.84");
    expect(row).not.toHaveTextContent("API‑equivalent");
    expect(row).not.toHaveTextContent(/spend/);
  });

  it("shows — and no label when the cost itself is unknown", async () => {
    const noCost = session({ native_session_id: "sess-nocost", cost_estimated_usd: null });
    await renderHome({ sessions: [started(noCost)] });
    const row = rowFor(liveList(), "claude_code");
    expect(row).toHaveTextContent("—");
    expect(row).not.toHaveTextContent("API‑equivalent");
  });

  it("ticks every live row's elapsed time from one shared clock", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const third = session({ native_session_id: "sess-third", harness: "pi_cli" });
    await renderHome({ sessions: [started(codexSession), started(claudeSession), started(third)] });
    const secondTimers = () => setIntervalSpy.mock.calls.filter(([, delay]) => delay === 1_000).length;
    expect(secondTimers()).toBe(1);

    // Real intervals (Motion's frame loop shares them); only the wall clock is moved.
    vi.setSystemTime(NOW.getTime() + 1_000);
    await waitFor(() => expect(rowFor(liveList(), "claude_code")).toHaveTextContent("14:13"), { timeout: 2_000 });
    expect(rowFor(liveList(), "codex_cli")).toHaveTextContent("3:41");
    expect(secondTimers()).toBe(1);
  });

  it("stops the clock when no live session is shown", async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const { daemon } = await renderHome({ sessions: [started(claudeSession)] });
    act(() => daemon.emit(ended(claudeSession)));
    await finishExitAnimations();
    expect(liveRows()).toHaveLength(0);
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it("expands a row to the token breakdown, the basis explanation and Open in Backplane", async () => {
    const { daemon, user } = await renderHome({ sessions: [started(claudeSession)] });
    const trigger = within(rowFor(liveList(), "claude_code")).getByRole("button", { expanded: false });
    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const detail = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
    expect(detail).not.toBeNull();
    const panel = within(detail as HTMLElement);
    expect(usageFigure(panel, "New input")).toHaveTextContent("38.2k");
    expect(usageFigure(panel, "Output")).toHaveTextContent("21.9k");
    expect(usageFigure(panel, "Context reused")).toHaveTextContent("119k");
    expect(usageFigure(panel, "Context saved")).toHaveTextContent("3.7k");
    expect(panel.getByText(/what these tokens would cost at API list prices/)).toBeInTheDocument();

    await user.click(panel.getByRole("button", { name: "Open in Backplane" }));
    expect(daemon.invoked()).toContain("open_backplane_url");
  });

  it("opens the session's board on the web origin, resolved through its mapping", async () => {
    const opened: unknown[] = [];
    const { user } = await renderHome({
      sessions: [started(claudeSession)],
      handlers: {
        open_backplane_url: (args) => {
          opened.push(args.url);
          return null;
        },
      },
    });
    await user.click(within(rowFor(liveList(), "claude_code")).getByRole("button", { expanded: false }));
    await user.click(screen.getByRole("button", { name: "Open in Backplane" }));
    expect(opened).toEqual(["https://app.bp.example.dev/internal/boards/b-backplane/kanban"]);
  });

  it("falls back to the web origin when no board is known for the session's repo", async () => {
    const opened: unknown[] = [];
    const unbound = session({ native_session_id: "sess-other", repo: "github.com/acme/unknown-repo" });
    const { user } = await renderHome({
      sessions: [started(unbound)],
      handlers: {
        open_backplane_url: (args) => {
          opened.push(args.url);
          return null;
        },
      },
    });
    await user.click(within(rowFor(liveList(), "claude_code")).getByRole("button", { expanded: false }));
    await user.click(screen.getByRole("button", { name: "Open in Backplane" }));
    expect(opened).toEqual(["https://app.bp.example.dev/"]);
  });

  describe("resolves the board from what captured the session", () => {
    const pathBound = session({ native_session_id: "sess-skate", repo: "github.com/acme-labs/skate", mapping_id: "m3" });

    async function openedFor(payload: LocalSession, afterRender: () => void = () => {}) {
      const opened: unknown[] = [];
      const { user } = await renderHome({
        sessions: [started(payload)],
        handlers: {
          open_backplane_url: (args) => {
            opened.push(args.url);
            return null;
          },
        },
      });
      act(afterRender);
      await user.click(within(rowFor(liveList(), "claude_code")).getByRole("button", { expanded: false }));
      await user.click(screen.getByRole("button", { name: "Open in Backplane" }));
      return opened;
    }

    it("opens a path-bound folder's board and names it on the row", async () => {
      expect(await openedFor(pathBound)).toEqual(["https://app.bp.example.dev/acme/boards/b-skate/kanban"]);
      expect(rowFor(liveList(), "claude_code")).toHaveTextContent("Skate");
    });

    it("opens the board the server filed the session under, over the daemon's mapping", async () => {
      const serverPage = { items: [{ id: "srv-skate", native_session_id: "sess-skate", workspace_id: "w1", board_id: "b-backplane", mapping_id: "m1" }] };
      expect(await openedFor(pathBound, () => mergeServerSessions(serverPage))).toEqual(["https://app.bp.example.dev/internal/boards/b-backplane/kanban"]);
      expect(rowFor(liveList(), "claude_code")).toHaveTextContent("Backplane");
    });

    it("opens the web root for a repo two boards list and no mapping settles", async () => {
      const ambiguous = session({ native_session_id: "sess-mobile", repo: "github.com/acme/mobile-app", mapping_id: null });
      expect(await openedFor(ambiguous)).toEqual(["https://app.bp.example.dev/"]);
    });

    it("opens the web root when the capturing mapping's board is not in the catalog", async () => {
      const serverPage = { items: [{ id: "srv-skate", native_session_id: "sess-skate", workspace_id: "w2", board_id: "b-gone", mapping_id: "m3" }] };
      expect(await openedFor(pathBound, () => mergeServerSessions(serverPage))).toEqual(["https://app.bp.example.dev/"]);
    });
  });

  it("marks Open in Backplane as external with a trailing icon", async () => {
    const { user } = await renderHome({ sessions: [started(claudeSession)] });
    await user.click(within(rowFor(liveList(), "claude_code")).getByRole("button", { expanded: false }));
    const open = screen.getByRole("button", { name: "Open in Backplane" });
    expect(open.lastElementChild?.tagName.toLowerCase()).toBe("svg");
  });

  it("explains spend on a spend row and collapses again on a second press", async () => {
    const { user } = await renderHome({ sessions: [started(codexSession)] });
    const trigger = within(rowFor(liveList(), "codex_cli")).getByRole("button", { expanded: false });
    await user.click(trigger);
    expect(screen.getByText("Spend: billed to the API key this agent uses.")).toBeInTheDocument();
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("toggles a row from the keyboard", async () => {
    const { user } = await renderHome({ sessions: [started(claudeSession)] });
    const trigger = within(rowFor(liveList(), "claude_code")).getByRole("button", { expanded: false });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await user.keyboard(" ");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("says an error toast when the browser can't be opened", async () => {
    const { user } = await renderHome({
      sessions: [started(claudeSession)],
      handlers: {
        open_backplane_url: () => {
          throw { kind: "invalid_input", message: "url not allowed" };
        },
      },
    });
    await user.click(within(rowFor(liveList(), "claude_code")).getByRole("button", { expanded: false }));
    await user.click(screen.getByRole("button", { name: "Open in Backplane" }));
    expect(await screen.findByText("Couldn’t open Backplane in your browser.")).toBeInTheDocument();
  });

  it("moves an ended session to Earlier today with its end time, duration and tokens", async () => {
    const { daemon } = await renderHome({ sessions: [started(codexSession), started(claudeSession)] });
    act(() => daemon.emit(ended(claudeSession)));
    await finishExitAnimations();

    expect(liveRows()).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Earlier today" })).toBeInTheDocument();
    const row = rowFor(earlierList(), "claude_code");
    expect(row).toHaveTextContent("12:00");
    expect(row).toHaveTextContent("14 min");
    expect(row).toHaveTextContent("182k tokens");
    expect(row).toHaveTextContent("$1.84");
  });

  it("totals today's sessions, tokens, API‑equivalent and spend in the footer", async () => {
    const { daemon } = await renderHome({ sessions: [started(codexSession), started(claudeSession)] });
    const earlier = session({ native_session_id: "sess-earlier", cost_estimated_usd: 5.1, tokens: { input: 1_000, output: 0, cache_read: 0, cache_write: 0 } });
    act(() => {
      daemon.emit(started(earlier));
      daemon.emit(ended(earlier));
    });

    const footer = totals();
    expect(within(footer).getByText("sessions today").previousElementSibling).toHaveTextContent("3");
    expect(within(footer).getByText("tokens").previousElementSibling).toHaveTextContent("224k");
    expect(within(footer).getByText("API‑equivalent").previousElementSibling).toHaveTextContent("$6.94");
    expect(within(footer).getByText("spend").previousElementSibling).toHaveTextContent("$0.38");
  });

  it("shows — for a basis total that no session has a known cost for", async () => {
    await renderHome({ sessions: [started(claudeSession)] });
    expect(within(totals()).getByText("spend").previousElementSibling).toHaveTextContent("—");
  });
});

describe("Home, usage figures", () => {
  // The owner's QA session: the 1 h prompt cache had expired, so the whole conversation was re-cached.
  const reCached = session({
    native_session_id: "sess-recached",
    tokens: { input: 2, output: 128, cache_read: 25_300, cache_write: 257_000 },
    cost_estimated_usd: 11.27,
  });
  const counting = session({ native_session_id: "sess-counting", harness: "codex_desktop", tokens: null, cost_estimated_usd: null, cost_basis: null });
  const TIPS = {
    "New input": "Prompt tokens the model hadn’t seen before.",
    Output: "Tokens the model wrote.",
    "Context reused": "Earlier conversation read back from the prompt cache — billed at a discount.",
    "Context saved": "Conversation written into the prompt cache so later turns can reuse it.",
  } as const;
  const COLD_CACHE_HINT = "Context re-cached after a pause — the whole conversation was re-sent.";

  it("labels the four figures in plain words, never the raw cache terms", async () => {
    const { user } = await renderHome({ sessions: [started(reCached)] });
    const panel = await expandRow(user, liveList(), "claude_code");
    expect(usageFigure(panel, "New input")).toHaveTextContent("2");
    expect(usageFigure(panel, "Output")).toHaveTextContent("128");
    expect(usageFigure(panel, "Context reused")).toHaveTextContent("25.3k");
    expect(usageFigure(panel, "Context saved")).toHaveTextContent("257k");
    expect(panel.queryByText("Input")).toBeNull();
    expect(panel.queryByText(/Cache read|Cache write/)).toBeNull();
  });

  it("gives each figure a one-line tooltip that the keyboard reaches and assistive tech reads", async () => {
    const { user } = await renderHome({ sessions: [started(reCached)] });
    const panel = await expandRow(user, liveList(), "claude_code");
    for (const [term, tip] of Object.entries(TIPS)) {
      await user.tab();
      const focused = document.activeElement as HTMLElement;
      expect(focused).toHaveTextContent(term);
      expect(focused).toHaveAccessibleDescription(tip);
      expect(panel.getByRole("tooltip", { name: tip, hidden: true })).toBeInTheDocument();
    }
  });

  it("dismisses a focused tooltip with Escape without hiding the popover, and the next Escape hides it", async () => {
    const { daemon, user } = await renderHome({ sessions: [started(reCached)], handlers: { hide_popover: () => null } });
    const panel = await expandRow(user, liveList(), "claude_code");
    await user.tab();
    const term = document.activeElement as HTMLElement;
    const tip = panel.getByRole("tooltip", { name: TIPS["New input"], hidden: true });
    expect(tip).toHaveAttribute("data-dismissed", "false");

    await user.keyboard("{Escape}");
    expect(tip).toHaveAttribute("data-dismissed", "true");
    expect(term).toHaveFocus();
    expect(daemon.invoked()).not.toContain("hide_popover");

    await user.keyboard("{Escape}");
    expect(daemon.invoked()).toContain("hide_popover");
  });

  it("says the figures count from when Companion started capturing the session", async () => {
    const { user } = await renderHome({ sessions: [started(claudeSession)] });
    const panel = await expandRow(user, liveList(), "claude_code");
    expect(panel.getByText("Counted since Companion started capturing this session.")).toBeInTheDocument();
  });

  it("explains a cold cache when re-cached context dominates the session's input", async () => {
    const { user } = await renderHome({ sessions: [started(reCached)] });
    const panel = await expandRow(user, liveList(), "claude_code");
    expect(panel.getByText(COLD_CACHE_HINT)).toBeInTheDocument();
  });

  it("shows no cold-cache hint for a warm cache or a session with no usage", async () => {
    const zeroWithCost = session({ native_session_id: "sess-zero", harness: "pi_cli", tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, cost_estimated_usd: 0 });
    const { user } = await renderHome({ sessions: [started(claudeSession), started(zeroWithCost)] });
    await expandRow(user, liveList(), "claude_code");
    await expandRow(user, liveList(), "pi_cli");
    expect(screen.queryByText(COLD_CACHE_HINT)).toBeNull();
  });

  it("shows Counting tokens… for a captured session with no usage yet, instead of zero and an unknown cost", async () => {
    const { user } = await renderHome({ sessions: [started(counting)] });
    const row = rowFor(liveList(), "codex_desktop");
    expect(row).toHaveTextContent("Counting tokens…");
    expect(row).not.toHaveTextContent("0 tokens");
    expect(row).not.toHaveTextContent("—");

    const panel = await expandRow(user, liveList(), "codex_desktop");
    expect(panel.getByText("Token counts appear once the agent reports usage.")).toBeInTheDocument();
    expect(panel.queryByText("The cost isn’t known for this session yet.")).toBeNull();
    expect(panel.queryByText("New input")).toBeNull();
    expect(panel.queryByText(COLD_CACHE_HINT)).toBeNull();
  });

  it("says the earlier history was deleted, never Counting tokens…, for a session resumed after its owner deleted it", async () => {
    const resumed = { ...counting, history_deleted: "owner" };
    const { user } = await renderHome({ sessions: [started(resumed)] });
    const row = rowFor(liveList(), "codex_desktop");
    expect(row).toHaveTextContent("Earlier history deleted in Backplane");
    expect(row).not.toHaveTextContent("Counting tokens…");

    const panel = await expandRow(user, liveList(), "codex_desktop");
    expect(panel.getByText("You deleted this session’s earlier history in Backplane. Token counts appear once the agent reports new usage.")).toBeInTheDocument();
    expect(panel.queryByText("Token counts appear once the agent reports usage.")).toBeNull();
  });

  it("never tells the owner they deleted history that retention removed", async () => {
    const resumed = { ...counting, history_deleted: "retention" };
    const { user } = await renderHome({ sessions: [started(resumed)] });
    const row = rowFor(liveList(), "codex_desktop");
    expect(row).toHaveTextContent("Earlier history removed after the retention period");
    expect(row).not.toHaveTextContent("Counting tokens…");

    const panel = await expandRow(user, liveList(), "codex_desktop");
    expect(panel.getByText("Backplane removed this session’s earlier history when this device’s retention period ended. Token counts appear once the agent reports new usage.")).toBeInTheDocument();
    expect(panel.queryByText(/You deleted/)).toBeNull();
  });

  it("does not say who deleted history when the daemon could not tell", async () => {
    const resumed = { ...counting, history_deleted: "unknown" };
    const { user } = await renderHome({ sessions: [started(resumed)] });
    expect(rowFor(liveList(), "codex_desktop")).toHaveTextContent("Earlier history deleted in Backplane");
    const panel = await expandRow(user, liveList(), "codex_desktop");
    expect(panel.getByText("This session’s earlier history was deleted in Backplane. Token counts appear once the agent reports new usage.")).toBeInTheDocument();
  });

  it("counts a resumed session's new usage since the deletion", async () => {
    const resumed = { ...claudeSession, history_deleted: "owner" };
    const { user } = await renderHome({ sessions: [started(resumed)] });
    const panel = await expandRow(user, liveList(), "claude_code");
    expect(panel.getByText("Counted since the earlier history was deleted in Backplane.")).toBeInTheDocument();
    expect(panel.queryByText("Counted since Companion started capturing this session.")).toBeNull();
  });

  it("stops counting once usage arrives", async () => {
    const { daemon } = await renderHome({ sessions: [started(counting)] });
    act(() => daemon.emit(updated({ ...counting, tokens: { input: 93_400, output: 114, cache_read: 92_900, cache_write: 0 } })));
    const row = rowFor(liveList(), "codex_desktop");
    expect(row).not.toHaveTextContent("Counting tokens…");
    expect(row).toHaveTextContent("186k tokens");
  });

  it("never shows Counting tokens… for a session with real usage", async () => {
    await renderHome({ sessions: [started(claudeSession), started(codexSession)] });
    expect(liveList()).not.toHaveTextContent("Counting tokens…");
  });

  it("shows a reported zero as zero tokens when the session has a known cost", async () => {
    const zeroWithCost = session({ native_session_id: "sess-zero", tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, cost_estimated_usd: 0 });
    await renderHome({ sessions: [started(zeroWithCost)] });
    const row = rowFor(liveList(), "claude_code");
    expect(row).toHaveTextContent("0 tokens");
    expect(row).toHaveTextContent("$0.00");
    expect(row).not.toHaveTextContent("Counting tokens…");
  });

  it("shows an ended session that never reported usage as zero tokens, since nothing more will be counted", async () => {
    const { daemon } = await renderHome({ sessions: [started(counting)] });
    act(() => daemon.emit(ended(counting)));
    await finishExitAnimations();
    const row = rowFor(earlierList(), "codex_desktop");
    expect(row).toHaveTextContent("0 tokens");
    expect(row).not.toHaveTextContent("Counting tokens…");
  });
});

describe("Home, server costs", () => {
  const unpriced = session({ native_session_id: "sess-unpriced", cost_estimated_usd: null, cost_basis: null });
  const serverItem = (facts: Record<string, unknown>) => ({ items: [{ id: "srv-1", native_session_id: "sess-unpriced", ...facts }] });

  it("shows the server's reported spend once a poll has seen the session", async () => {
    await renderHome({ sessions: [started(unpriced)] });
    expect(rowFor(liveList(), "claude_code")).toHaveTextContent("—");
    act(() => mergeServerSessions(serverItem({ cost_reported_usd: 0.52, cost_estimated_usd: null, cost_basis: "spend" })));
    const row = rowFor(liveList(), "claude_code");
    expect(row).toHaveTextContent("$0.52");
    expect(row).toHaveTextContent("spend");
  });

  it("prefers the reported cost over the estimate, as the server's own total does", async () => {
    await renderHome({ sessions: [started(unpriced)] });
    act(() => mergeServerSessions(serverItem({ cost_reported_usd: 0.5, cost_estimated_usd: 0.62, cost_basis: "spend" })));
    expect(rowFor(liveList(), "claude_code")).toHaveTextContent("$0.50");
    expect(within(totals()).getByText("spend").previousElementSibling).toHaveTextContent("$0.50");
  });

  it("labels a server estimate API‑equivalent", async () => {
    await renderHome({ sessions: [started(unpriced)] });
    act(() => mergeServerSessions(serverItem({ cost_reported_usd: null, cost_estimated_usd: 3.1, cost_basis: "api_equivalent" })));
    const row = rowFor(liveList(), "claude_code");
    expect(row).toHaveTextContent("$3.10");
    expect(row).toHaveTextContent("API‑equivalent");
  });

  it("shows no dollar figure for a server cost without a basis", async () => {
    await renderHome({ sessions: [started(unpriced)] });
    act(() => mergeServerSessions(serverItem({ cost_reported_usd: 1.25, cost_estimated_usd: null, cost_basis: null })));
    const row = rowFor(liveList(), "claude_code");
    expect(row).toHaveTextContent("—");
    expect(row).not.toHaveTextContent("$1.25");
  });
});

describe("Home, attention", () => {
  const withAgentState = (id: string, state: string): Status => ({
    ...baseStatus,
    agents: baseStatus.agents.map((agent) => (agent.id === id ? { ...agent, state } : agent)),
  });
  const codex = agentDisplayName("codex_cli");

  it("raises a banner for an agent in a problem state, and Show me how opens Agents", async () => {
    const { user } = await renderHome({ status: withAgentState("codex_cli", "needs_trust"), sessions: [started(claudeSession)] });

    expect(screen.getByText(`${codex} needs your approval before its sessions can be captured.`)).toBeInTheDocument();
    expect(screen.getByText(`Until it is fixed, ${codex} sessions are not captured. Other agents are fine.`)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show me how" }));
    expect(screen.getByRole("tab", { name: /Agents/ })).toHaveAttribute("aria-selected", "true");
  });

  it("says which problem a broken or misconfigured agent has", async () => {
    await renderHome({ status: withAgentState("codex_cli", "broken") });
    expect(screen.getByText(`${codex}’s capture hook stopped working.`)).toBeInTheDocument();
  });

  it("counts several agents that need attention in one banner", async () => {
    const both: Status = { ...baseStatus, agents: baseStatus.agents.map((agent) => ({ ...agent, state: "invalid_config" })) };
    await renderHome({ status: both });
    expect(screen.getByText("2 agents need your attention.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show me how" })).toBeInTheDocument();
  });

  it("renders a known attention code from its fixed template, never the daemon's message", async () => {
    await renderHome({
      attention: [{ code: "needs_trust", severity: "warning", agent: "codex_cli", message: "RAW DAEMON TEXT run codex trust" }],
      sessions: [started(claudeSession)],
    });
    expect(screen.getByText(`${codex} needs your approval before its sessions can be captured.`)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("RAW DAEMON TEXT");
    expect(screen.getByRole("button", { name: "Show me how" })).toBeInTheDocument();
  });

  it("renders agent_broken and conflict_existing_otel attention codes from templates", async () => {
    await renderHome({
      attention: [{ code: "conflict_existing_otel", severity: "warning", agent: "codex_cli", message: "RAW DAEMON TEXT otel" }],
    });
    expect(screen.getByText(`${codex}’s OpenTelemetry settings need review.`)).toBeInTheDocument();
    expect(screen.getByText("Companion can’t confirm that it manages these settings and left them unchanged.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/telemetry elsewhere|capture can’t turn on|Remove that exporter/);
    expect(document.body.textContent).not.toContain("RAW DAEMON TEXT");
  });

  it.each(["restart_required", "daemon_restart_required"] as const)("shows conflict and co-present %s without conflating settings ownership and capture", async (restart) => {
    const status: Status = {
      ...baseStatus,
      agents: baseStatus.agents.map((agent) => agent.id === "codex_cli" ? {
        ...agent,
        state: "broken",
        configured: false,
        broken: true,
        integration: { ...agent.integration, state: "broken", problems: ["conflict_existing_otel", restart] },
      } : agent),
    };
    // The daemon emits one attention item; status carries the co-present problems.
    await renderHome({ status, attention: [
      { code: "agent_broken", severity: "error", agent: "codex_cli", message: "RAW DAEMON TEXT broken" },
    ] });
    expect(screen.getByText(`${codex}’s OpenTelemetry settings need review.`)).toBeInTheDocument();
    expect(screen.getByText("Companion can’t confirm that it manages these settings and left them unchanged.")).toBeInTheDocument();
    expect(document.body.textContent).toContain("reload its settings");
    expect(document.body.textContent).toContain("does not confirm that Companion manages the OpenTelemetry settings");
    expect(document.body.textContent).not.toMatch(/telemetry elsewhere|capture can’t turn on|start capturing|RAW DAEMON TEXT/);
    expect(screen.getByRole("button", { name: "Show me how" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(Restart|Quit|Repair)/i })).toBeNull();
  });

  it.each(["restart_required", "daemon_restart_required"] as const)("keeps standalone %s separate from an OpenTelemetry conflict", async (restart) => {
    await renderHome({ attention: [{ code: restart, severity: "warning", agent: "codex_cli", message: "RAW DAEMON TEXT restart" }] });
    expect(screen.getByText(`${codex} needs your attention.`)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/OpenTelemetry|RAW DAEMON TEXT/);
    expect(screen.getByRole("button", { name: "Show me how" })).toBeInTheDocument();
  });

  it("falls back to a short generic line for an unknown code that names an agent", async () => {
    await renderHome({
      attention: [{ code: "hook_errors", severity: "warning", agent: "claude_code", message: "RAW DAEMON TEXT hooks reported 3 errors." }],
      sessions: [started(claudeSession)],
    });
    expect(screen.getByText(`${agentDisplayName("claude_code")} needs your attention.`)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("RAW DAEMON TEXT");
    expect(screen.getByRole("button", { name: "Show me how" })).toBeInTheDocument();
  });

  it("falls back to a generic line, without Show me how, for an unknown code that names no agent", async () => {
    await renderHome({
      attention: [{ code: "inbox_dropped", severity: "warning", agent: null, message: "RAW DAEMON TEXT events could not be read." }],
      sessions: [started(claudeSession)],
    });
    expect(screen.getByText("Something needs your attention.")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("RAW DAEMON TEXT");
    expect(screen.queryByRole("button", { name: "Show me how" })).not.toBeInTheDocument();
  });

  it("names an attention item's unknown agent id as Unknown agent", async () => {
    await renderHome({ attention: [{ code: "agent_broken", severity: "error", agent: "gemini_cli", message: "x" }] });
    expect(screen.getByText("Unknown agent’s capture hook stopped working.")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("gemini_cli");
  });

  it("shows no banner when nothing needs attention", async () => {
    await renderHome({ sessions: [started(claudeSession)] });
    expect(screen.queryByRole("button", { name: "Show me how" })).not.toBeInTheDocument();
    expect(document.querySelector("[data-banner]")).toBeNull();
  });
});

describe("Home, paused on this Mac", () => {
  it("shows an info banner with Resume and hides the live list", async () => {
    const { daemon, user } = await renderHome({ status: withCapture("paused_locally"), sessions: [started(claudeSession)] });

    expect(screen.getByText("Capture is paused")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Live now" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resume" }));
    expect(daemon.invoked()).toContain("resume");
    expect(await screen.findByText("Capture resumed.")).toBeInTheDocument();
  });

  it("keeps Earlier today while paused", async () => {
    const { daemon } = await renderHome({ sessions: [started(claudeSession)] });
    act(() => {
      daemon.emit(ended(claudeSession));
      daemon.emit({ type: "status", data: withCapture("paused_locally") });
    });
    expect(rowFor(earlierList(), "claude_code")).toBeInTheDocument();
    expect(totals()).toBeInTheDocument();
  });

  it("says an error when resuming fails", async () => {
    const { user } = await renderHome({
      status: withCapture("paused_locally"),
      handlers: {
        resume: () => {
          throw { kind: "timeout" };
        },
      },
    });
    await user.click(screen.getByRole("button", { name: "Resume" }));
    expect(await screen.findByText("Couldn’t resume capture. Try again in a moment.")).toBeInTheDocument();
  });
});

describe("Home, paused from Backplane", () => {
  it("replaces Home with a state panel that opens the device page on the web origin", async () => {
    const opened: unknown[] = [];
    const { user } = await renderHome({
      status: withCapture("paused_by_server"),
      sessions: [started(claudeSession)],
      handlers: {
        open_backplane_url: (args) => {
          opened.push(args.url);
          return null;
        },
      },
    });
    expect(screen.getByRole("heading", { name: "Paused from Backplane" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Live now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Today’s totals" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open device page" }));
    expect(opened).toEqual(["https://app.bp.example.dev/"]);
  });

  it("falls back to the API endpoint when the account has no web origin", async () => {
    const opened: unknown[] = [];
    const { user } = await renderHome({
      status: withCapture("paused_by_server", { account: null }),
      handlers: {
        open_backplane_url: (args) => {
          opened.push(args.url);
          return null;
        },
      },
    });
    await user.click(screen.getByRole("button", { name: "Open device page" }));
    expect(opened).toEqual(["https://bp.example.dev/"]);
  });
});

describe("Home, can't reach Backplane", () => {
  const offline = withCapture("policy_stale");

  it("shows a warning banner with the honest queued count and says it retries by itself", async () => {
    await renderHome({ status: offline, sessions: [started(claudeSession)] });
    expect(screen.getByText("Can’t reach bp.example.dev")).toBeInTheDocument();
    expect(screen.getByText(/4 are ready to upload when the connection is back/)).toBeInTheDocument();
    expect(screen.getByText("Retrying automatically.")).toBeInTheDocument();
  });

  it("marks live rows as waiting to upload", async () => {
    await renderHome({ status: offline, sessions: [started(claudeSession)] });
    const row = rowFor(liveList(), "claude_code");
    expect(row).toHaveTextContent("Waiting to upload");
    expect(row).not.toHaveTextContent("tokens");
    expect(screen.getByText("saved on this Mac")).toBeInTheDocument();
  });

  it("treats a backing-off queue while active as unreachable too", async () => {
    await renderHome({ status: { ...baseStatus, queue: { ...baseStatus.queue, backing_off: true, records: 1 } }, sessions: [started(claudeSession)] });
    expect(screen.getByText(/1 is ready to upload when the connection is back/)).toBeInTheDocument();
  });

  it("says nothing is waiting when the queue is empty", async () => {
    await renderHome({ status: { ...offline, queue: { ...offline.queue, records: 0 } }, sessions: [started(claudeSession)] });
    expect(screen.getByText(/Nothing is waiting to upload/)).toBeInTheDocument();
  });
});

describe("Home, Try now", () => {
  const offline = withCapture("policy_stale");

  it("asks the uploader to retry now and says so", async () => {
    const { daemon, user } = await renderHome({ status: offline, handlers: { queue_flush: () => ({ scheduled: true, reason: null }) } });
    await user.click(screen.getByRole("button", { name: "Try now" }));
    expect(daemon.invoked().filter((command) => command === "queue_flush")).toHaveLength(1);
    expect(await screen.findByText("Trying to upload now.")).toBeInTheDocument();
  });

  it.each([
    ["queue_empty", "Nothing is waiting to upload."],
    ["not_connected", "This Mac isn’t connected to Backplane, so there’s nothing to retry."],
    ["device_revoked", "This Mac was disconnected in Backplane, so nothing can upload."],
    ["daemon_not_running", "Companion isn’t running, so it can’t retry right now."],
    ["something_new", "Couldn’t retry right now. Companion keeps trying on its own."],
  ])("explains a retry that wasn't scheduled (%s) in plain words", async (reason, sentence) => {
    const { user } = await renderHome({ status: offline, handlers: { queue_flush: () => ({ scheduled: false, reason }) } });
    await user.click(screen.getByRole("button", { name: "Try now" }));
    expect(await screen.findByText(sentence)).toBeInTheDocument();
    expect(screen.queryByText(reason)).not.toBeInTheDocument();
  });

  it("says so, without the daemon's text, when the retry can't be asked for", async () => {
    const { user } = await renderHome({
      status: offline,
      handlers: {
        queue_flush: () => {
          throw { kind: "api", status: 500, code: "internal", message: "raw uploader text", detail: null };
        },
      },
    });
    await user.click(screen.getByRole("button", { name: "Try now" }));
    expect(await screen.findByText("Couldn’t retry right now. Companion keeps trying on its own.")).toBeInTheDocument();
    expect(screen.queryByText(/raw uploader text/)).not.toBeInTheDocument();
  });

  it("asks at most once a second, however fast it is pressed", async () => {
    const { daemon, user } = await renderHome({ status: offline, handlers: { queue_flush: () => ({ scheduled: true, reason: null }) } });
    const flushes = () => daemon.invoked().filter((command) => command === "queue_flush").length;
    const button = screen.getByRole("button", { name: /Try now|Trying/ });
    await user.click(button);
    await user.click(button);
    await user.click(button);
    expect(flushes()).toBe(1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });
    await user.click(screen.getByRole("button", { name: "Try now" }));
    expect(flushes()).toBe(2);
  });
});

describe("Home, state precedence", () => {
  it("agrees with the header when paused from Backplane and the queue is backing off", async () => {
    const both = withCapture("paused_by_server", { queue: { ...baseStatus.queue, backing_off: true } });
    await renderHome({ status: both, sessions: [started(claudeSession)] });
    expect(screen.getByTestId("status-header")).toHaveTextContent("Can’t reach Backplane");
    expect(screen.getByText("Can’t reach bp.example.dev")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Paused from Backplane" })).not.toBeInTheDocument();
  });
});

describe("Home, focus when a live row leaves", () => {
  const liveTrigger = (harness: string) => within(rowFor(liveList(), harness)).getAllByRole("button")[0] as HTMLElement;

  it("moves focus to the session's Earlier today row when it ends", async () => {
    const { daemon } = await renderHome({ sessions: [started(codexSession), started(claudeSession)] });
    liveTrigger("claude_code").focus();
    act(() => daemon.emit(ended(claudeSession)));
    const earlierTrigger = within(rowFor(earlierList(), "claude_code")).getAllByRole("button")[0];
    expect(earlierTrigger).toHaveFocus();
  });

  it("moves focus to the next live row when the session leaves without an Earlier row", async () => {
    await renderHome({ sessions: [started(codexSession), started(claudeSession)] });
    liveTrigger("claude_code").focus();
    act(() => {
      const state = sessionsStore.get();
      sessionsStore.set({ ...state, live: state.live.filter((held) => held.native_session_id !== "sess-claude"), liveCount: 1 });
    });
    expect(liveTrigger("codex_cli")).toHaveFocus();
  });

  it("moves focus to the Live now heading when no live row is left", async () => {
    await renderHome({ sessions: [started(claudeSession), started(codexSession)] });
    act(() => {
      const state = sessionsStore.get();
      sessionsStore.set({ ...state, endedToday: [{ ...session({ native_session_id: "sess-older" }), ended_at: NOW.toISOString() }] });
    });
    liveTrigger("claude_code").focus();
    act(() => {
      const state = sessionsStore.get();
      sessionsStore.set({ ...state, live: state.live.filter((held) => held.native_session_id === "sess-codex"), liveCount: 1 });
    });
    act(() => {
      const state = sessionsStore.get();
      sessionsStore.set({ ...state, live: [], liveCount: 0 });
    });
    expect(screen.getByRole("heading", { name: "Live now" })).toHaveFocus();
  });

  it("moves focus to the Earlier today row when focus was inside the expanded panel", async () => {
    const { daemon, user } = await renderHome({ sessions: [started(codexSession), started(claudeSession)] });
    await user.click(liveTrigger("claude_code"));
    const openInBackplane = screen.getByRole("button", { name: "Open in Backplane" });
    openInBackplane.focus();
    act(() => daemon.emit(ended(claudeSession)));
    const earlierTrigger = within(rowFor(earlierList(), "claude_code")).getAllByRole("button")[0];
    expect(earlierTrigger).toHaveFocus();
  });

  it("leaves focus alone when an unfocused row leaves", async () => {
    const { daemon } = await renderHome({ sessions: [started(codexSession), started(claudeSession)] });
    const tab = screen.getByRole("tab", { name: "Home" });
    tab.focus();
    act(() => daemon.emit(ended(claudeSession)));
    expect(tab).toHaveFocus();
  });
});

describe("Home, clock while hidden", () => {
  it("follows the shell's popover visibility, stopping while hidden and catching up when shown", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    await renderHome({ sessions: [started(claudeSession)] });
    const secondTimers = () => setIntervalSpy.mock.calls.filter(([, delay]) => delay === 1_000).length;
    expect(secondTimers()).toBe(1);

    act(() => popoverVisibleStore.set(false));
    expect(clearIntervalSpy).toHaveBeenCalled();

    vi.setSystemTime(NOW.getTime() + 5_000);
    act(() => popoverVisibleStore.set(true));
    expect(secondTimers()).toBe(2);
    expect(rowFor(liveList(), "claude_code")).toHaveTextContent("14:17");
  });

  it("stops the 1 Hz clock when the popover loses focus and catches up when it returns", async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    await renderHome({ sessions: [started(claudeSession)] });
    const secondTimers = () => setIntervalSpy.mock.calls.filter(([, delay]) => delay === 1_000).length;
    expect(secondTimers()).toBe(1);

    act(() => window.dispatchEvent(new Event("blur")));
    expect(clearIntervalSpy).toHaveBeenCalled();

    vi.setSystemTime(NOW.getTime() + 5_000);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(secondTimers()).toBe(2);
    expect(rowFor(liveList(), "claude_code")).toHaveTextContent("14:17");
  });

  it("stops the clock while the document is hidden and restarts it when shown", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    await renderHome({ sessions: [started(claudeSession)] });
    const secondTimers = () => setIntervalSpy.mock.calls.filter(([, delay]) => delay === 1_000);
    const firstTimer = setIntervalSpy.mock.results[setIntervalSpy.mock.calls.findIndex(([, delay]) => delay === 1_000)]?.value;

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(clearIntervalSpy).toHaveBeenCalledWith(firstTimer);

    vi.setSystemTime(NOW.getTime() + 5_000);
    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(secondTimers()).toHaveLength(2);
    expect(rowFor(liveList(), "claude_code")).toHaveTextContent("14:17");
  });
});

describe("Home, board names", () => {
  const rebound = {
    workspaces: [{ id: "w1", slug: "internal", name: "Internal projects", boards: [{ id: "b-other", name: "Other board", repos: [] }] }],
  };
  const reboundProjects = {
    mappings: [{ id: "m9", workspace_id: "w1", board_id: "b-other", repo_url_normalized: "github.com/acme/app", enabled: true }],
    discovered: [],
    ignored: [],
  };

  function switchableHandlers() {
    const served = { boards: boards as unknown, projects: projects as unknown };
    return { served, handlers: { boards: () => served.boards, projects: () => served.projects } };
  }

  it("reloads names when the policy changes", async () => {
    const { served, handlers } = switchableHandlers();
    const { daemon } = await renderHome({ sessions: [started(claudeSession)], handlers });
    expect(rowFor(liveList(), "claude_code")).toHaveTextContent("Backplane");

    served.boards = rebound;
    served.projects = reboundProjects;
    act(() => daemon.emit({ type: "policy.changed" }));
    await act(async () => {});
    expect(rowFor(liveList(), "claude_code")).toHaveTextContent("Other board");
  });

  it("follows a pushed projects event without asking again", async () => {
    const { daemon } = await renderHome({ sessions: [started(claudeSession)] });
    const projectCalls = () => daemon.invoked().filter((command) => command === "projects").length;
    const before = projectCalls();
    act(() =>
      daemon.emit({
        type: "projects",
        data: { mappings: [{ id: "m7", workspace_id: "w1", board_id: "b-mobile", repo_url_normalized: "github.com/acme/app", enabled: true }], discovered: [], ignored: [] },
      }),
    );
    expect(rowFor(liveList(), "claude_code")).toHaveTextContent("Mobile app");
    expect(projectCalls()).toBe(before);
  });

  it("reloads names after a reconnect to another installation", async () => {
    const { served, handlers } = switchableHandlers();
    const { daemon } = await renderHome({ sessions: [started(claudeSession)], handlers });
    served.boards = rebound;
    served.projects = reboundProjects;
    act(() => {
      daemon.emit({ type: "daemon.unreachable", data: { reason: "control_file_missing" } });
      daemon.emit({ type: "daemon.connected" });
      daemon.emit({ type: "status", data: { ...baseStatus, installation_id: "inst_other" } });
      daemon.emit(started(claudeSession));
    });
    await act(async () => {});
    expect(rowFor(liveList(), "claude_code")).toHaveTextContent("Other board");
  });

  it("never names a board from another installation's mappings", async () => {
    const { served, handlers } = switchableHandlers();
    const { daemon } = await renderHome({ sessions: [started(claudeSession)], handlers });
    served.boards = { workspaces: [] };
    served.projects = { mappings: [], discovered: [], ignored: [] };
    act(() => daemon.emit({ type: "status", data: { ...baseStatus, installation_id: "inst_other" } }));
    await act(async () => {});
    expect(rowFor(liveList(), "claude_code")).not.toHaveTextContent("to board");
  });

  it("names nothing when two mappings of one repo point at different boards", async () => {
    const split = {
      ...projects,
      mappings: [
        ...projects.mappings,
        { id: "m3", workspace_id: "w1", board_id: "b-mobile", root_path: "/home/tester/code/app-fork", repo_url_normalized: "github.com/acme/app", enabled: true },
      ],
    };
    await renderHome({ sessions: [started(claudeSession)], handlers: { projects: () => split } });
    expect(rowFor(liveList(), "claude_code")).not.toHaveTextContent("to board");
  });
});

describe("Home, revoked", () => {
  it("shows one path forward: Connect again starts onboarding", async () => {
    const { user } = await renderHome({ status: withCapture("revoked", { revoked: true }), sessions: [started(claudeSession)] });
    expect(screen.getByRole("heading", { name: "This Mac was disconnected" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Live now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Today’s totals" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect again" }));
    expect(screen.getByTestId("screen-onboarding")).toBeInTheDocument();
  });

  it("offers Open Backplane on the web origin", async () => {
    const { daemon, user } = await renderHome({ status: withCapture("revoked", { revoked: true }) });
    await user.click(screen.getByRole("button", { name: "Open Backplane" }));
    expect(daemon.invoked()).toContain("open_backplane_url");
  });

  it("puts the admin hint in the panel's fine print, after its actions, and marks the links external", async () => {
    await renderHome({ status: withCapture("revoked", { revoked: true }) });
    const hint = screen.getByText("If you didn’t remove it, ask a workspace admin who did.");
    const open = screen.getByRole("button", { name: "Open Backplane" });
    expect(hint).toHaveClass("bp-panel-fine");
    expect(open.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(open.lastElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(open.firstChild?.nodeType).toBe(Node.TEXT_NODE);
  });
});

describe("Home, empty", () => {
  it("says no sessions yet with the bound project and agents-on counts", async () => {
    const { user } = await renderHome();
    expect(screen.getByRole("heading", { name: "No sessions yet" })).toBeInTheDocument();
    expect(screen.getByText("Bound projects").nextElementSibling).toHaveTextContent("2");
    expect(screen.getByText("Agents on").nextElementSibling).toHaveTextContent("2 of 2");
    expect(screen.queryByRole("group", { name: "Today’s totals" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review projects" }));
    expect(screen.getByRole("tab", { name: /Projects/ })).toHaveAttribute("aria-selected", "true");
  });

  it("does not count an agent in a problem state as on", async () => {
    const broken: Status = { ...baseStatus, agents: baseStatus.agents.map((agent) => (agent.id === "codex_cli" ? { ...agent, state: "broken" } : agent)) };
    await renderHome({ status: broken });
    expect(screen.getByText("Agents on").nextElementSibling).toHaveTextContent("1 of 2");
  });

  it("says no agent is running when only earlier sessions exist", async () => {
    const { daemon } = await renderHome({ sessions: [started(claudeSession)] });
    act(() => daemon.emit(ended(claudeSession)));
    await waitFor(() => expect(screen.getByText("No agent is running in a bound project right now.")).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "No sessions yet" })).not.toBeInTheDocument();
  });
});

describe("Home, negatives and privacy", () => {
  it("never renders prompt text or paths that ride along on a session event", async () => {
    const leaky = {
      ...claudeSession,
      prompt: "SECRET_PROMPT_TEXT",
      cwd: "/home/tester/code/app",
      transcript_path: "/home/tester/.claude/projects/app/sess.jsonl",
      title: "Refactor the billing module",
    } as unknown as LocalSession;
    const { user } = await renderHome({ sessions: [started(leaky)] });
    await user.click(within(rowFor(liveList(), "claude_code")).getByRole("button", { expanded: false }));

    const text = document.body.textContent ?? "";
    for (const forbidden of ["SECRET_PROMPT_TEXT", "/home/tester", ".jsonl", "Refactor the billing module"]) {
      expect(text).not.toContain(forbidden);
    }
    for (const element of document.body.querySelectorAll("*")) {
      for (const attribute of element.getAttributeNames()) {
        expect(element.getAttribute(attribute) ?? "").not.toContain("SECRET_PROMPT_TEXT");
        expect(element.getAttribute(attribute) ?? "").not.toContain("/home/tester");
      }
    }
  });

  it("does not crash on an ended event for a session it never saw", async () => {
    const stranger = session({ native_session_id: "sess-unknown" });
    const { daemon } = await renderHome({ sessions: [started(claudeSession)] });
    act(() => daemon.emit(ended(stranger)));
    expect(liveRows()).toHaveLength(1);
    expect(rowFor(earlierList(), "claude_code")).toBeInTheDocument();
  });

  it("does not duplicate rows when a reconnect replays the same sessions", async () => {
    const { daemon } = await renderHome({ sessions: [started(claudeSession), started(codexSession)] });
    act(() => {
      daemon.emit({ type: "daemon.connected" });
      daemon.emit({ type: "status", data: baseStatus });
      daemon.emit(started(claudeSession));
      daemon.emit(updated(codexSession));
    });
    expect(liveRows()).toHaveLength(2);
  });

  it("does not flash the previous live rows after the daemon goes away and comes back", async () => {
    const { daemon } = await renderHome({ sessions: [started(claudeSession)] });
    act(() => daemon.emit({ type: "daemon.unreachable", data: { reason: "control_file_missing" } }));
    expect(screen.queryByRole("list", { name: "Live now" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Companion isn't running" })).toBeInTheDocument();

    act(() => {
      daemon.emit({ type: "daemon.connected" });
      daemon.emit({ type: "status", data: baseStatus });
    });
    expect(screen.queryByRole("list", { name: "Live now" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No sessions yet" })).toBeInTheDocument();
  });

  it("keeps the final state of a 100-event burst, even with a stale update arriving last", async () => {
    const { daemon } = await renderHome({ sessions: [started(claudeSession)] });
    const base = Date.parse(claudeSession.last_event_at ?? "");
    act(() => {
      for (let step = 1; step <= 100; step += 1) {
        daemon.emit(
          updated({
            ...claudeSession,
            last_event_at: new Date(base + step * 10).toISOString(),
            tokens: { input: 1_000 * step, output: 0, cache_read: 0, cache_write: 0 },
            cost_estimated_usd: step / 100,
          }),
        );
      }
      daemon.emit(updated({ ...claudeSession, tokens: { input: 5, output: 0, cache_read: 0, cache_write: 0 } }));
    });
    const row = rowFor(liveList(), "claude_code");
    expect(row).toHaveTextContent("100k tokens");
    expect(row).toHaveTextContent("$1.00");
    expect(liveRows()).toHaveLength(1);
  });

  it("shows a live session without tokens as still counting, not a crash", async () => {
    await renderHome({ sessions: [started(session({ native_session_id: "sess-bare", tokens: null, cost_estimated_usd: null }))] });
    expect(rowFor(liveList(), "claude_code")).toHaveTextContent("Counting tokens…");
  });

  it("names an unknown harness Unknown agent, never its raw id, and a session without a repo neutrally", async () => {
    await renderHome({ sessions: [started(session({ native_session_id: "sess-odd", harness: "gemini_cli", repo: "" }))] });
    const [row] = liveRows();
    expect(row).toHaveTextContent("Unknown agent:");
    expect(row).toHaveTextContent("No git remote");
    expect(document.body.textContent).not.toContain("gemini_cli");
    expect(document.body.innerHTML).not.toContain("gemini_cli");
  });

  it("shows a Codex Desktop session on Codex's tile as the Codex app, with its tokens", async () => {
    await renderHome({ sessions: [started(session({ native_session_id: "sess-desktop", harness: "codex_desktop" }))] });
    const [row] = liveRows();
    expect(row).toHaveTextContent("Codex app:");
    expect(row).not.toHaveTextContent("Unknown agent");
    expect(row).toHaveTextContent("182k tokens");
    const tile = row?.querySelector(".bp-agent-tile");
    expect(tile).toHaveAttribute("data-agent", "codex_desktop");
    expect(tile).toHaveTextContent("Cx");
  });

  it("never renders a repo that carries credentials, and names no board for it", async () => {
    const leakyRepo = "https://x-access-token:ghp_SECRETTOKEN@github.com/acme/app";
    await renderHome({ sessions: [started(session({ native_session_id: "sess-cred", repo: leakyRepo }))] });
    const row = rowFor(liveList(), "claude_code");
    expect(row).toHaveTextContent("No git remote");
    expect(row).not.toHaveTextContent("to board");
    expect(document.body.innerHTML).not.toContain("ghp_");
  });
});

describe("Home, sort and filter", () => {
  const piEnded = session({ native_session_id: "e-pi", harness: "pi_cli", repo: "github.com/acme/mobile-app", cost_estimated_usd: 0.21, cost_basis: "spend" });
  const claudeEnded = session({ native_session_id: "e-claude", repo: "github.com/acme/storefront-api", cost_estimated_usd: 3.12 });
  const codexEnded = session({ native_session_id: "e-codex", harness: "codex_cli", repo: "github.com/acme/app", cost_estimated_usd: 1.02, cost_basis: "spend" });
  const endedEach = (sessions: LocalSession[]) => sessions.flatMap((payload) => [started(payload), ended(payload)]);
  const busyDay = [...endedEach([piEnded, claudeEnded, codexEnded]), started(codexSession), started(claudeSession)];

  const toolbar = () => screen.queryByRole("search", { name: "Sessions" });
  const filterField = () => screen.getByRole("searchbox", { name: "Filter sessions by repository, board or agent" });
  const agentGroup = () => screen.queryByRole("group", { name: "Show one agent" });
  const soloTile = (agent: string) => screen.getByRole("button", { name: `Only ${agent}` });
  const sortButton = () => screen.getByRole("button", { name: /^Sort sessions:/ });
  const sectionAside = (title: string) => screen.getByRole("heading", { name: title }).parentElement?.querySelector(".bp-section-aside");
  const repoOrder = (list: HTMLElement) => within(list).getAllByRole("listitem").map((row) => row.querySelector(".home-s-repo")?.textContent);
  const liveRegion = () => screen.getByTestId("home-filter-announcer");

  beforeEach(() => {
    localStorage.clear();
    resetHomeViewForTests();
  });

  it("shows no toolbar for a quiet day of three sessions", async () => {
    await renderHome({ sessions: [...endedEach([piEnded]), started(codexSession), started(claudeSession)] });
    expect(liveRows()).toHaveLength(2);
    expect(toolbar()).not.toBeInTheDocument();
  });

  it("shows the toolbar from the fourth session today", async () => {
    await renderHome({ sessions: [...endedEach([piEnded, claudeEnded]), started(codexSession), started(claudeSession)] });
    expect(toolbar()).toBeInTheDocument();
    expect(filterField()).toHaveAttribute("placeholder", "Filter");
    expect(sortButton()).toHaveAccessibleName("Sort sessions: Recent");
  });

  it("keeps the toolbar while a filter is active, even under four sessions", async () => {
    const { user } = await renderHome({ sessions: busyDay });
    await user.type(filterField(), "store");
    act(() => {
      const state = sessionsStore.get();
      sessionsStore.set({ ...state, endedToday: [] });
    });
    expect(toolbar()).toBeInTheDocument();
    expect(filterField()).toHaveValue("store");
  });

  it("shows no toolbar on an empty day", async () => {
    await renderHome();
    expect(screen.getByRole("heading", { name: "No sessions yet" })).toBeInTheDocument();
    expect(toolbar()).not.toBeInTheDocument();
  });

  it("offers one solo tile per agent seen today, and none for a single agent", async () => {
    await renderHome({ sessions: busyDay });
    expect(within(agentGroup() as HTMLElement).getAllByRole("button").map((tile) => tile.getAttribute("aria-label"))).toEqual([
      "Only Claude Code",
      "Only Codex",
      "Only Pi",
    ]);
  });

  it("offers no solo tiles when only one agent ran today", async () => {
    const claudeOnly = [1, 2, 3, 4].map((n) => started(session({ native_session_id: `c${n}` })));
    await renderHome({ sessions: claudeOnly });
    expect(toolbar()).toBeInTheDocument();
    expect(agentGroup()).not.toBeInTheDocument();
  });

  it("filters both sections by repository, board or agent and counts what is shown", async () => {
    const { user } = await renderHome({ sessions: busyDay });
    await user.type(filterField(), "STORE");
    await finishExitAnimations();
    expect(repoOrder(liveList())).toEqual(["acme/storefront-api"]);
    expect(repoOrder(earlierList())).toEqual(["acme/storefront-api"]);
    expect(sectionAside("Live now")).toHaveTextContent("1 of 2");
    expect(sectionAside("Earlier today")).toHaveTextContent("1 of 3");

    await user.clear(filterField());
    await user.type(filterField(), "backplane");
    await finishExitAnimations();
    expect(repoOrder(liveList())).toEqual(["acme/app"]);
    expect(repoOrder(earlierList())).toEqual(["acme/app"]);
  });

  it("hides a section that has no match", async () => {
    const { user } = await renderHome({ sessions: busyDay });
    await user.type(filterField(), "mobile");
    await finishExitAnimations();
    expect(screen.queryByRole("heading", { name: "Live now" })).not.toBeInTheDocument();
    expect(screen.queryByText("No agent is running in a bound project right now.")).not.toBeInTheDocument();
    expect(repoOrder(earlierList())).toEqual(["acme/mobile-app"]);
  });

  it("keeps the unfiltered asides when nothing filters", async () => {
    await renderHome({ sessions: busyDay });
    expect(sectionAside("Live now")).toHaveTextContent("updates as they run");
    expect(sectionAside("Earlier today")).toHaveTextContent("3");
  });

  it("solos one agent, moves the solo to another tile, and clears it on a second press", async () => {
    const { user } = await renderHome({ sessions: busyDay });
    await user.click(soloTile("Codex"));
    await finishExitAnimations();
    expect(soloTile("Codex")).toHaveAttribute("aria-pressed", "true");
    expect(agentGroup()).toHaveAttribute("data-solo", "true");
    expect(liveRows()).toHaveLength(1);
    expect(rowFor(liveList(), "codex_cli")).toBeInTheDocument();
    expect(within(earlierList()).getAllByRole("listitem")).toHaveLength(1);

    await user.click(soloTile("Pi"));
    await finishExitAnimations();
    expect(soloTile("Codex")).toHaveAttribute("aria-pressed", "false");
    expect(soloTile("Pi")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("list", { name: "Live now" })).not.toBeInTheDocument();

    await user.click(soloTile("Pi"));
    await finishExitAnimations();
    expect(soloTile("Pi")).toHaveAttribute("aria-pressed", "false");
    expect(agentGroup()).toHaveAttribute("data-solo", "false");
    expect(liveRows()).toHaveLength(2);
  });

  it("makes the solo tiles one tab stop, with arrows between them and Space or Enter to toggle", async () => {
    const { user } = await renderHome({ sessions: busyDay });
    filterField().focus();
    await user.tab();
    expect(soloTile("Claude Code")).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(soloTile("Codex")).toHaveFocus();
    expect(soloTile("Codex")).toHaveAttribute("aria-pressed", "false");
    await user.keyboard(" ");
    expect(soloTile("Codex")).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(soloTile("Pi")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(soloTile("Pi")).toHaveAttribute("aria-pressed", "true");
    await user.tab();
    expect(sortButton()).toHaveFocus();
    await user.tab({ shift: true });
    expect(soloTile("Pi")).toHaveFocus();
  });

  it("sorts inside each section by name or cost, never mixing live and ended, and remembers the sort", async () => {
    const { user } = await renderHome({ sessions: busyDay });
    await user.click(sortButton());
    await user.click(screen.getByRole("menuitemradio", { name: "Cost, highest first" }));
    expect(sortButton()).toHaveAccessibleName("Sort sessions: Cost");
    expect(repoOrder(liveList())).toEqual(["acme/app", "acme/storefront-api"]);
    expect(repoOrder(earlierList())).toEqual(["acme/storefront-api", "acme/app", "acme/mobile-app"]);
    expect(localStorage.getItem("bp.home.sort")).toBe("cost");

    await user.click(sortButton());
    await user.click(screen.getByRole("menuitemradio", { name: "Name" }));
    expect(repoOrder(liveList())).toEqual(["acme/app", "acme/storefront-api"]);
    expect(repoOrder(earlierList())).toEqual(["acme/app", "acme/mobile-app", "acme/storefront-api"]);
  });

  it("says the totals always count all of today, and keeps them unfiltered", async () => {
    const { user } = await renderHome({ sessions: busyDay });
    const before = totals().textContent;
    await user.type(filterField(), "mobile");
    expect(totals().textContent).toBe(before);
    expect(totals()).toHaveTextContent("5");
    await user.click(sortButton());
    expect(screen.getByRole("menu", { name: "Sort sessions" })).toHaveAccessibleDescription("Totals below always count all of today.");
  });

  it("focuses the filter with / or ⌘F, but not while typing in another field", async () => {
    const { user } = await renderHome({ sessions: busyDay });
    screen.getByRole("tab", { name: "Home" }).focus();
    await user.keyboard("/");
    expect(filterField()).toHaveFocus();
    expect(filterField()).toHaveValue("");

    screen.getByRole("tab", { name: "Home" }).focus();
    await user.keyboard("{Meta>}f{/Meta}");
    expect(filterField()).toHaveFocus();

    screen.getByRole("tab", { name: "Home" }).focus();
    await user.keyboard("{Control>}f{/Control}");
    expect(filterField()).toHaveFocus();

    const other = document.createElement("input");
    document.body.append(other);
    other.focus();
    await user.keyboard("/");
    expect(other).toHaveFocus();
    expect(other).toHaveValue("/");
    other.remove();
  });

  it("does not take / once Home is not the active tab", async () => {
    const { user } = await renderHome({ sessions: busyDay });
    await user.click(screen.getByRole("tab", { name: /^Projects/ }));
    await finishExitAnimations();
    const tab = screen.getByRole("tab", { name: /^Projects/ });
    tab.focus();
    await user.keyboard("/");
    expect(tab).toHaveFocus();
  });

  it("clears the query with Escape and keeps the popover open; a second Escape hides it", async () => {
    const { daemon, user } = await renderHome({ sessions: busyDay, handlers: { hide_popover: () => null } });
    await user.type(filterField(), "mobile");
    await user.keyboard("{Escape}");
    expect(filterField()).toHaveValue("");
    expect(filterField()).toHaveFocus();
    expect(daemon.invoked()).not.toContain("hide_popover");
    await user.keyboard("{Escape}");
    expect(daemon.invoked()).toContain("hide_popover");
  });

  it("clears the query with the × button and returns focus to the field", async () => {
    const { user } = await renderHome({ sessions: busyDay });
    expect(screen.queryByRole("button", { name: "Clear filter" })).not.toBeInTheDocument();
    await user.type(filterField(), "mobile");
    await user.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(filterField()).toHaveValue("");
    expect(filterField()).toHaveFocus();
  });

  it("moves from the filter to the first visible row with ArrowDown", async () => {
    const { user } = await renderHome({ sessions: busyDay });
    await user.type(filterField(), "mobile");
    await user.keyboard("{ArrowDown}");
    expect(within(earlierList()).getAllByRole("listitem")[0]?.querySelector("button")).toHaveFocus();
  });

  const noResult = () => screen.getByText("No sessions match.").closest("[role='status']");

  it("says what matched nothing for a query", async () => {
    const { user } = await renderHome({ sessions: busyDay });
    await user.type(filterField(), "zzz");
    expect(noResult()).toHaveTextContent("No sessions match. Nothing today matches “zzz”.");
    expect(screen.queryByRole("list", { name: "Live now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Earlier today" })).not.toBeInTheDocument();
    expect(totals()).toBeInTheDocument();
  });

  it("says what matched nothing for a solo and a query together", async () => {
    const { user } = await renderHome({ sessions: busyDay });
    await user.click(soloTile("Codex"));
    await user.type(filterField(), "mobile");
    expect(noResult()).toHaveTextContent("No sessions match. Nothing today from Codex matches “mobile”.");
  });

  it("says what matched nothing for a solo alone, keeping its tile so it can be cleared", async () => {
    const { user } = await renderHome({ sessions: busyDay });
    await user.click(soloTile("Codex"));
    act(() => {
      const state = sessionsStore.get();
      const live = state.live.filter((held) => held.harness !== "codex_cli");
      sessionsStore.set({ ...state, live, liveCount: live.length, endedToday: state.endedToday.filter((held) => held.harness !== "codex_cli") });
    });
    expect(noResult()).toHaveTextContent("No sessions match. Nothing today from Codex.");
    expect(soloTile("Codex")).toHaveAttribute("aria-pressed", "true");
  });

  it("Clear filters resets the query and the solo and focuses the field", async () => {
    const { user } = await renderHome({ sessions: busyDay });
    await user.click(soloTile("Codex"));
    await user.type(filterField(), "mobile");
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(filterField()).toHaveValue("");
    expect(filterField()).toHaveFocus();
    expect(soloTile("Codex")).toHaveAttribute("aria-pressed", "false");
    expect(liveRows()).toHaveLength(2);
  });

  it("keeps the query and solo when Home is left and shown again", async () => {
    const { user } = await renderHome({ sessions: busyDay });
    await user.type(filterField(), "store");
    await user.click(soloTile("Codex"));
    await user.click(screen.getByRole("tab", { name: /^Projects/ }));
    await user.click(screen.getByRole("tab", { name: "Home" }));
    expect(filterField()).toHaveValue("store");
    expect(soloTile("Codex")).toHaveAttribute("aria-pressed", "true");
  });

  it("moves focus to the filter when the focused row leaves and no row remains", async () => {
    const { user } = await renderHome({ sessions: busyDay });
    await user.click(soloTile("Claude Code"));
    await user.type(filterField(), "acme/app");
    const trigger = within(rowFor(liveList(), "claude_code")).getAllByRole("button")[0] as HTMLElement;
    trigger.focus();
    act(() => {
      const state = sessionsStore.get();
      sessionsStore.set({ ...state, live: state.live.filter((held) => held.harness !== "claude_code"), liveCount: 1 });
    });
    expect(filterField()).toHaveFocus();
  });

  it("announces the match count after a pause in typing, and the sort when it changes", async () => {
    const { user } = await renderHome({ sessions: busyDay });
    expect(liveRegion()).toHaveAttribute("aria-live", "polite");
    expect(liveRegion()).toBeEmptyDOMElement();
    await user.type(filterField(), "store");
    await waitFor(() => expect(liveRegion()).toHaveTextContent("Showing 2 of 5 sessions"));
    await user.click(sortButton());
    await user.click(screen.getByRole("menuitemradio", { name: "Name" }));
    expect(liveRegion()).toHaveTextContent("Sorted by name");
  });

  it("never announces when only live data changes", async () => {
    const { daemon } = await renderHome({ sessions: busyDay });
    act(() => {
      daemon.emit(updated({ ...claudeSession, last_event_at: NOW.toISOString(), tokens: { input: 1, output: 1, cache_read: 1, cache_write: 1 } }));
      daemon.emit(started(session({ native_session_id: "late" })));
    });
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(liveRegion()).toBeEmptyDOMElement();
  });

  it("holds the live order while the pointer is over the list", async () => {
    const { daemon, user } = await renderHome({ sessions: busyDay });
    expect(repoOrder(liveList())).toEqual(["acme/app", "acme/storefront-api"]);
    await user.hover(liveRows()[0] as HTMLElement);
    act(() => {
      vi.setSystemTime(NOW.getTime() + HOME_RESORT_INTERVAL_MS + 1);
      daemon.emit(updated({ ...codexSession, last_event_at: new Date(NOW.getTime() + 5_000).toISOString() }));
    });
    expect(repoOrder(liveList())).toEqual(["acme/app", "acme/storefront-api"]);
    await user.unhover(liveList());
    expect(repoOrder(liveList())).toEqual(["acme/storefront-api", "acme/app"]);
  });

  it("holds the live order while a row is expanded", async () => {
    const { daemon, user } = await renderHome({ sessions: busyDay });
    await expandRow(user, earlierList(), "pi_cli");
    await user.unhover(earlierList());
    screen.getByRole("tab", { name: "Home" }).focus();
    act(() => {
      vi.setSystemTime(NOW.getTime() + HOME_RESORT_INTERVAL_MS + 1);
      daemon.emit(updated({ ...codexSession, last_event_at: new Date(NOW.getTime() + 5_000).toISOString() }));
    });
    expect(repoOrder(liveList())).toEqual(["acme/app", "acme/storefront-api"]);
  });

  it("applies the toolbar only to Earlier today while paused on this Mac", async () => {
    const { daemon, user } = await renderHome({ sessions: [...busyDay, ...endedEach([session({ native_session_id: "e-4", repo: "github.com/acme/docs" })])] });
    act(() => daemon.emit({ type: "status", data: withCapture("paused_locally") }));
    expect(screen.queryByRole("list", { name: "Live now" })).not.toBeInTheDocument();
    await user.type(filterField(), "docs");
    await finishExitAnimations();
    expect(repoOrder(earlierList())).toEqual(["acme/docs"]);
    await waitFor(() => expect(liveRegion()).toHaveTextContent("Showing 1 of 4 sessions"));
  });

  it("keeps the toolbar and its clear control when pausing here leaves no session in view", async () => {
    const liveOnly = [1, 2, 3, 4].map((n) => started(session({ native_session_id: `l${n}`, repo: `github.com/acme/app-${n}` })));
    const { daemon, user } = await renderHome({ sessions: liveOnly });
    await user.type(filterField(), "app-2");
    act(() => daemon.emit({ type: "status", data: withCapture("paused_locally") }));
    expect(screen.getByText("Capture is paused")).toBeInTheDocument();
    expect(toolbar()).toBeInTheDocument();
    expect(filterField()).toHaveValue("app-2");
    // Cleared, nothing is filtered and nothing is in view: the toolbar has done its job and goes.
    await user.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(toolbar()).not.toBeInTheDocument();
    expect(screen.getByRole("tabpanel")).toHaveFocus();
  });

  it("moves focus to the tab panel when Escape clears the last filter and the toolbar goes", async () => {
    const liveOnly = [1, 2, 3, 4].map((n) => started(session({ native_session_id: `l${n}`, repo: `github.com/acme/app-${n}` })));
    const { daemon, user } = await renderHome({ sessions: liveOnly, handlers: { hide_popover: () => null } });
    await user.type(filterField(), "app-2");
    act(() => daemon.emit({ type: "status", data: withCapture("paused_locally") }));
    await user.keyboard("{Escape}");
    expect(toolbar()).not.toBeInTheDocument();
    expect(screen.getByRole("tabpanel")).toHaveFocus();
    expect(daemon.invoked()).not.toContain("hide_popover");
  });

  it("leaves focus alone when the toolbar goes while focus is elsewhere", async () => {
    const liveOnly = [1, 2, 3, 4].map((n) => started(session({ native_session_id: `l${n}`, repo: `github.com/acme/app-${n}` })));
    const { daemon, user } = await renderHome({ sessions: liveOnly });
    await user.type(filterField(), "app-2");
    act(() => daemon.emit({ type: "status", data: withCapture("paused_locally") }));
    const resume = screen.getByRole("button", { name: "Resume" });
    resume.focus();
    act(() => clearFilterElsewhere());
    expect(toolbar()).not.toBeInTheDocument();
    expect(resume).toHaveFocus();
  });

  it.each([
    ["revoked", withCapture("revoked", { revoked: true })],
    ["paused from Backplane", withCapture("paused_by_server")],
  ])("shows no toolbar when %s", async (_mode, status) => {
    await renderHome({ status: status as Status, sessions: busyDay });
    expect(toolbar()).not.toBeInTheDocument();
  });
});
