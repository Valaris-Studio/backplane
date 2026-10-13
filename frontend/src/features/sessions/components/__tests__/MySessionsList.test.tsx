// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { act, renderWithProviders, screen, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { AgentSession, AgentSessionPage } from "@/types/agent-session";
import { SLUG, makeSession, minutesAgo, stubAuthModes } from "../../__tests__/fixtures";
import { setPromptsHidden } from "../../hooks/use-hide-prompts";
import { MySessionsPage } from "../MySessionsPage";

const DAY_MINUTES = 24 * 60;

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

interface ListServer {
  requests: URLSearchParams[];
}

function serveSessions(pages: AgentSessionPage[] | ((params: URLSearchParams) => AgentSessionPage)): ListServer {
  const requests: URLSearchParams[] = [];
  server.use(
    http.get(`/api/workspaces/${SLUG}/sessions`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      requests.push(params);
      if (typeof pages === "function") return HttpResponse.json(pages(params));
      const cursor = params.get("cursor");
      const page = cursor ? pages.find((_, index) => `page-${index}` === cursor) : pages[0];
      return HttpResponse.json(page ?? { items: [], next_cursor: null });
    }),
    http.get(`/api/workspaces/${SLUG}/boards`, () =>
      HttpResponse.json([{ id: "board-1", name: "Storefront" }]),
    ),
  );
  return { requests };
}

function renderList(search = "") {
  stubAuthModes(true);
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/sessions"
        element={
          <>
            <MySessionsPage />
            <LocationProbe />
          </>
        }
      />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/sessions${search}`] } },
  );
}

function rowFor(title: string) {
  const row = screen.getByText(title).closest("tr");
  if (!row) throw new Error(`no row for ${title}`);
  return row;
}

function groupBodies() {
  return screen.getAllByRole("rowgroup").filter((group) => group.tagName === "TBODY");
}

afterEach(() => {
  // The store notifies every mounted subscriber; reset inside act().
  act(() => setPromptsHidden(false));
  window.localStorage.clear();
});

describe("My sessions list — presenter mode", () => {
  it("hides every title (a first prompt) behind one per-viewer toggle that survives a reload", async () => {
    serveSessions([{ items: [makeSession({ title: "Rotate the staging database password" })], next_cursor: null }]);
    renderList();

    await screen.findByRole("link", { name: "Rotate the staging database password" });
    const toggle = screen.getByRole("button", { name: "Presenter mode" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    const blurred = screen.getByText("Rotate the staging database password");
    expect(blurred).toHaveAttribute("aria-hidden", "true");
    expect(blurred.closest("[data-prompt-hidden]")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Prompt hidden" })).toBeInTheDocument();
    expect(window.localStorage.getItem("backplane.sessions.hidePrompts")).toBe("1");
  });

  it("blurs device names, which often carry the owner's name, while presenting", async () => {
    serveSessions([{ items: [makeSession({ device_name: "Carol's MacBook Pro" })], next_cursor: null }]);
    renderList();
    expect(await screen.findByText("Carol's MacBook Pro")).not.toHaveAttribute("aria-hidden");
    await userEvent.click(screen.getByRole("button", { name: "Presenter mode" }));
    expect(screen.getByText("Carol's MacBook Pro")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("valaris/backplane")).not.toHaveAttribute("aria-hidden");
  });
});

describe("My sessions list — grouping and period", () => {
  it("puts live sessions first, then today, yesterday and older days", async () => {
    // Day groups follow the local calendar; pin the clock to midday so
    // "five minutes ago" is today whenever the suite runs.
    const midday = new Date();
    midday.setHours(12, 0, 0, 0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(midday);
    onTestFinished(() => {
      vi.useRealTimers();
    });

    serveSessions([
      {
        items: [
          makeSession({ id: "live", title: "Fix linked_summary double-counting", display_state: "active", status: "active", last_event_at: minutesAgo(1) }),
          makeSession({ id: "today", title: "Audit i18n keys", last_event_at: minutesAgo(5) }),
          makeSession({ id: "yesterday", title: "Wire the realtime cache", last_event_at: minutesAgo(DAY_MINUTES + 60), started_at: minutesAgo(DAY_MINUTES + 120) }),
          makeSession({ id: "older", title: "Spike the OTLP collector", last_event_at: minutesAgo(4 * DAY_MINUTES), started_at: minutesAgo(4 * DAY_MINUTES + 30) }),
        ],
        next_cursor: null,
      },
    ]);
    renderList();

    await screen.findByText("Audit i18n keys");
    const bodies = groupBodies();
    expect(bodies).toHaveLength(4);
    const [live, today, yesterday, older] = bodies as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    expect(within(live).getByText("Live now")).toBeInTheDocument();
    expect(within(live).getByText("Fix linked_summary double-counting")).toBeInTheDocument();
    expect(within(today).getByText("Today")).toBeInTheDocument();
    expect(within(today).getByText("Audit i18n keys")).toBeInTheDocument();
    expect(within(yesterday).getByText("Yesterday")).toBeInTheDocument();
    expect(within(older).getByText("Spike the OTLP collector")).toBeInTheDocument();
  });

  it("asks the server for the last 7 days from a stable day boundary, then 30 days", async () => {
    const { requests } = serveSessions(() => ({ items: [makeSession({ title: "Recent work" })], next_cursor: null }));
    renderList();

    await screen.findByText("Recent work");
    expect(screen.getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");
    const weekStart = new Date(requests.at(-1)?.get("since") ?? "");
    expect(weekStart.getHours()).toBe(0);
    expect(Math.round((Date.now() - weekStart.getTime()) / 86_400_000)).toBeGreaterThanOrEqual(7);

    await userEvent.click(screen.getByRole("button", { name: "30 days" }));
    await waitFor(() => expect(new Date(requests.at(-1)?.get("since") ?? "").getTime()).toBeLessThan(weekStart.getTime()));
    expect(screen.getByTestId("location")).toHaveTextContent("period=30d");
  });

  it("drops day groups when sorted by anything but recent activity", async () => {
    const { requests } = serveSessions(() => ({
      items: [makeSession({ id: "a", title: "Biggest session" }), makeSession({ id: "b", title: "Smaller session" })],
      next_cursor: null,
    }));
    renderList();
    await screen.findByText("Biggest session");
    const dayHeaders = () => [...document.querySelectorAll('th[scope="rowgroup"]')].map((header) => header.textContent);
    expect(dayHeaders()).toContainEqual(expect.stringContaining("Today"));

    await userEvent.click(screen.getByRole("button", { name: "Sort" }));
    await userEvent.click(screen.getByRole("option", { name: "Most tokens" }));

    await waitFor(() => expect(requests.at(-1)?.get("sort")).toBe("tokens"));
    expect(screen.getByTestId("location")).toHaveTextContent("sort=tokens");
    expect(dayHeaders()).toHaveLength(0);
  });

  it("loads the next keyset page on Load more", async () => {
    const { requests } = serveSessions([
      { items: [makeSession({ id: "a", title: "First page", last_event_at: minutesAgo(10) })], next_cursor: "page-1" },
      { items: [makeSession({ id: "b", title: "Second page", last_event_at: minutesAgo(20) })], next_cursor: null },
    ]);
    renderList();

    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Second page")).toBeInTheDocument();
    expect(requests.at(-1)?.get("cursor")).toBe("page-1");
  });
});

describe("My sessions list — filters live in the URL", () => {
  it("narrows to one agent with a pressed monogram and the harness parameter", async () => {
    const { requests } = serveSessions(() => ({
      items: [
        makeSession({ id: "cc", title: "Claude work", harness: "claude_code", harness_display_name: "Claude Code" }),
        makeSession({ id: "cx", title: "Codex work", harness: "codex_cli", harness_display_name: "Codex CLI" }),
      ],
      next_cursor: null,
    }));
    renderList();

    const claude = await screen.findByRole("button", { name: "Only Claude Code" });
    expect(claude).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(claude);

    await waitFor(() => expect(requests.at(-1)?.get("harness")).toBe("claude_code"));
    expect(screen.getByRole("button", { name: "Only Claude Code" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("location")).toHaveTextContent("agent=claude");
  });

  it("offers one Codex toggle that keeps both Codex hosts", async () => {
    const { requests } = serveSessions(() => ({
      items: [
        makeSession({ id: "cc", title: "Claude work", harness: "claude_code", harness_display_name: "Claude Code" }),
        makeSession({ id: "cli", title: "Codex CLI work", harness: "codex_cli", harness_display_name: "Codex CLI" }),
        makeSession({ id: "app", title: "Codex app work", harness: "codex_desktop", harness_display_name: "Codex Desktop" }),
      ],
      next_cursor: null,
    }));
    renderList();

    await screen.findByText("Codex app work");
    expect(screen.getAllByRole("button", { name: /^Only Codex/ })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Only Codex" }));

    await waitFor(() => expect(screen.queryByText("Claude work")).not.toBeInTheDocument());
    expect(screen.getByText("Codex CLI work")).toBeInTheDocument();
    expect(screen.getByText("Codex app work")).toBeInTheDocument();
    expect(requests.at(-1)?.get("harness")).toBeNull();
  });

  it("reads state, board, linked work, search and subagents from the URL into the API query", async () => {
    const { requests } = serveSessions(() => ({ items: [makeSession()], next_cursor: null }));
    renderList("?state=incomplete&board=board-1&subagents=1&linked=1&q=retry");

    await screen.findByText("Audit i18n keys for the sessions namespace");
    const params = requests.at(-1);
    expect(params?.get("state")).toBe("incomplete");
    expect(params?.get("status")).toBeNull();
    expect(params?.get("board_id")).toBe("board-1");
    expect(params?.get("root_only")).toBe("false");
    expect(params?.get("linked_only")).toBe("true");
    expect(params?.get("q")).toBe("retry");
    expect(screen.getByRole("searchbox", { name: "Search sessions" })).toHaveValue("retry");
  });

  it("searches on the server as you type, with / to focus and Escape to clear", async () => {
    const { requests } = serveSessions(() => ({ items: [makeSession()], next_cursor: null }));
    renderList();
    await screen.findByText("Audit i18n keys for the sessions namespace");

    await userEvent.keyboard("/");
    const search = screen.getByRole("searchbox", { name: "Search sessions" });
    expect(search).toHaveFocus();
    await userEvent.keyboard("checkout");
    await waitFor(() => expect(requests.at(-1)?.get("q")).toBe("checkout"));
    expect(screen.getByTestId("location")).toHaveTextContent("q=checkout");

    await userEvent.keyboard("{Escape}");
    expect(search).toHaveValue("");
    await waitFor(() => expect(requests.at(-1)?.get("q")).toBeNull());
  });

  it("offers every display state, including the ones a lifecycle cannot tell", async () => {
    serveSessions(() => ({ items: [makeSession()], next_cursor: null }));
    renderList();
    await screen.findByText("Audit i18n keys for the sessions namespace");
    await userEvent.click(screen.getByRole("button", { name: "State" }));
    for (const state of ["Live", "Idle", "Ended", "Incomplete", "Paused", "Disconnected"]) {
      expect(screen.getByRole("option", { name: state })).toBeInTheDocument();
    }
  });

  it("hides subagent threads by default", async () => {
    const { requests } = serveSessions(() => ({ items: [makeSession()], next_cursor: null }));
    renderList();
    await screen.findByText("Audit i18n keys for the sessions namespace");
    expect(requests.at(-1)?.get("root_only")).toBe("true");
  });

  it("asks the server for linked work only", async () => {
    const { requests } = serveSessions((params) => ({
      items:
        params.get("linked_only") === "true"
          ? [makeSession({ id: "linked", title: "Touched a card", link_count: 1, link_preview: [] })]
          : [makeSession({ id: "unlinked", title: "Touched nothing", link_count: 0, link_preview: [] })],
      next_cursor: null,
    }));
    renderList();

    await screen.findByText("Touched nothing");
    await userEvent.click(screen.getByRole("switch", { name: "Linked work only" }));
    expect(await screen.findByText("Touched a card")).toBeInTheDocument();
    expect(requests.at(-1)?.get("linked_only")).toBe("true");
    expect(screen.getByTestId("location")).toHaveTextContent("linked=1");
  });

  it("does not call it a first run when only hidden subagent sessions exist", async () => {
    serveSessions((params) => ({
      items: params.get("root_only") === "true" ? [] : [makeSession({ title: "A subagent thread", parent_session_id: "gone" })],
      next_cursor: null,
    }));
    renderList();

    expect(await screen.findByRole("heading", { name: "No sessions match" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "See what your agents did" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show subagents" }));
    expect(await screen.findByText("A subagent thread")).toBeInTheDocument();
  });

  it("still teaches the first run when nothing at all was captured", async () => {
    serveSessions(() => ({ items: [], next_cursor: null }));
    renderList();
    expect(await screen.findByRole("heading", { name: "See what your agents did" })).toBeInTheDocument();
  });

  it("explains an empty filtered result and clears the filters", async () => {
    serveSessions((params) => ({
      items: params.get("harness") ? [] : [makeSession({ title: "Back again" })],
      next_cursor: null,
    }));
    renderList("?agent=pi");

    expect(await screen.findByRole("heading", { name: "No sessions match" })).toBeInTheDocument();
    // A deep link to one agent can still switch to another without clearing.
    expect(screen.getByRole("button", { name: "Only Claude Code" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText(/Nothing in the last 7 days matches Pi/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByText("Back again")).toBeInTheDocument();
  });
});

describe("My sessions list — rows", () => {
  function serveOne(session: AgentSession) {
    serveSessions([{ items: [session], next_cursor: null }]);
  }

  it("links the title to the session and names the agent", async () => {
    serveOne(makeSession({ id: "s-42" }));
    renderList();
    const link = await screen.findByRole("link", { name: "Audit i18n keys for the sessions namespace" });
    expect(link).toHaveAttribute("href", `/${SLUG}/sessions/s-42`);
    expect(within(rowFor("Audit i18n keys for the sessions namespace")).getByRole("img", { name: "Claude Code" })).toHaveTextContent("CC");
  });

  it("always labels cost with its basis, and flags estimates and unpriced usage", async () => {
    serveSessions([
      {
        items: [
          makeSession({ id: "a", title: "Subscription work", cost_usd: 6.18, cost_basis: "api_equivalent", cost_source: "reported", cost_complete: true }),
          makeSession({ id: "b", title: "Paid work", cost_usd: 0.92, cost_basis: "spend", cost_source: "estimated", cost_complete: false, last_event_at: minutesAgo(19) }),
        ],
        next_cursor: null,
      },
    ]);
    renderList();

    await screen.findByText("Subscription work");
    const subscription = within(rowFor("Subscription work"));
    expect(subscription.getByText("$6.18")).toBeInTheDocument();
    expect(subscription.getByText("API-equivalent")).toBeInTheDocument();

    const paid = within(rowFor("Paid work"));
    expect(paid.getByText(/\$0\.92/)).toBeInTheDocument();
    expect(paid.getByText(/spend/)).toBeInTheDocument();
    expect(paid.getByText("est.")).toBeInTheDocument();
    expect(paid.getByTitle("Some usage has no price yet")).toHaveTextContent("+");
  });

  it("never shows Untitled: a Metadata session reads as its folder, with a lock", async () => {
    serveOne(makeSession({ title: null, cwd: "storefront-api" }));
    renderList();
    expect(await screen.findByText("storefront-api · title not sent at Metadata")).toBeInTheDocument();
    expect(screen.queryByText(/untitled/i)).not.toBeInTheDocument();
  });

  it("never names a withheld title after a device path from an older row", async () => {
    serveOne(makeSession({ title: null, cwd: "/home/operator/code/storefront-api" }));
    renderList();
    expect(await screen.findByText("storefront-api · title not sent at Metadata")).toBeInTheDocument();
  });

  it("names a withheld title by its bound folder, not the path inside it", async () => {
    serveOne(makeSession({ title: null, cwd: "backplane/packages/api" }));
    renderList();
    expect(await screen.findByText("backplane · title not sent at Metadata")).toBeInTheDocument();
  });

  it("shows the state as a word, with the reason for an incomplete session", async () => {
    serveOne(makeSession({ display_state: "incomplete", capture_gaps: 3 }));
    renderList();
    await screen.findByText("Audit i18n keys for the sessions namespace");
    const badge = within(rowFor("Audit i18n keys for the sessions namespace")).getByText("Incomplete");
    expect(badge.closest("[title]")).toHaveAttribute("title", "3 records weren't captured");
  });

  it("renders linked work as green Changed chips and outline Consulted chips", async () => {
    serveOne(
      makeSession({
        link_count: 3,
        link_preview: [
          { entity_type: "card", entity_id: "card-1", board_id: "board-1", title: "Bug: double-counts", relation: "changed", provenance: "exact" },
          { entity_type: "note", entity_id: "note-1", board_id: null, title: "Codex desktop capture plan", relation: "consulted", provenance: "correlated" },
        ],
      }),
    );
    renderList();

    const changed = await screen.findByRole("link", { name: "Changed: Bug: double-counts" });
    expect(changed).toHaveAttribute("href", `/${SLUG}/boards/board-1/kanban?card=card-1`);
    expect(changed).toHaveAttribute("data-relation", "changed");
    const consulted = screen.getByRole("link", { name: "Consulted: Codex desktop capture plan, matched by timing" });
    expect(consulted).toHaveAttribute("data-relation", "consulted");
    expect(consulted).toHaveAttribute("title", "Matched by timing, not by an exact call id");
    expect(screen.getByText("+1")).toBeInTheDocument();
  });

  it("says when a session touched no work", async () => {
    serveOne(makeSession({ link_count: 0, link_preview: [] }));
    renderList();
    expect(await screen.findByText("No linked work")).toBeInTheDocument();
  });

  it("takes linked work from the list itself, never one request per row", async () => {
    const perRow = vi.fn();
    serveOne(
      makeSession({
        id: "s-1",
        child_count: 2,
        link_count: 1,
        link_preview: [{ entity_type: "card", entity_id: "card-9", board_id: "board-1", title: "Checkout retries on 502", relation: "changed", provenance: "exact" }],
      }),
    );
    server.use(
      http.get(`/api/workspaces/${SLUG}/sessions/s-1/links`, () => {
        perRow();
        return HttpResponse.json({ items: [] });
      }),
    );
    renderList();
    expect(await screen.findByRole("link", { name: "Changed: Checkout retries on 502" })).toBeInTheDocument();
    expect(screen.getByText("2 subagents")).toBeInTheDocument();
    expect(perRow).not.toHaveBeenCalled();
  });
});
