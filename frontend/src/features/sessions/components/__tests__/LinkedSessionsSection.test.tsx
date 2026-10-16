// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createTestQueryClient, renderWithProviders, screen, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { AgentSession, LinkedSessionList } from "@/types/agent-session";
import { SLUG, makeSession, minutesAgo, stubAuthModes } from "../../__tests__/fixtures";
import { setPromptsHidden } from "../../hooks/use-hide-prompts";
import { CardSessionsSection, NoteSessionsSection } from "../LinkedSessionsSection";

const BOARD = "board-1";
const CARD = "card-1";
const NOTE = "note-1";
const CARD_SESSIONS = `/api/workspaces/${SLUG}/boards/${BOARD}/cards/${CARD}/sessions`;
const NOTE_SESSIONS = `/api/workspaces/${SLUG}/notes/${NOTE}/sessions`;
const DEVICES = "/api/me/companion/installations";

// The section loads once it scrolls into view; report every target visible.
class VisibleObserver {
  constructor(private readonly report: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.report([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
const originalObserver = window.IntersectionObserver;

beforeEach(() => {
  window.IntersectionObserver = VisibleObserver as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  window.IntersectionObserver = originalObserver;
  act(() => setPromptsHidden(false));
  window.localStorage.clear();
});

const DEVICE = {
  installation_id: "inst-1",
  name: "Build box",
  platform: "darwin",
  token_prefix: "bpc_",
  created_at: minutesAgo(9000),
  last_seen_at: minutesAgo(1),
  revoked_at: null,
  policy: {},
  status: null,
  status_reported_at: null,
};

function linked(session: Partial<AgentSession>, relations: ("changed" | "consulted")[], provenance: "exact" | "correlated" = "exact") {
  const full = makeSession(session);
  return { session: full, relations, provenance, first_seen_at: full.started_at, last_seen_at: full.last_event_at };
}

function listOf(items: ReturnType<typeof linked>[], overrides: Partial<LinkedSessionList["summary"]> = {}): LinkedSessionList {
  return {
    items,
    summary: {
      session_count: items.length,
      first_seen_at: null,
      last_seen_at: null,
      total_duration_seconds: 9999,
      wall_duration_seconds: 94 * 60,
      input_tokens: 300_000,
      output_tokens: 200_000,
      cache_read_tokens: 2_400_000,
      cache_creation_tokens: 200_000,
      reasoning_tokens: 0,
      cost_usd: 7.41,
      cost_reported_usd: null,
      cost_estimated_usd: null,
      cost_source: "reported",
      cost_basis: "mixed",
      cost_complete: true,
      ...overrides,
    },
  };
}

function serve({ companion = true, devices = [DEVICE], list = listOf([]) }: { companion?: boolean; devices?: unknown[]; list?: LinkedSessionList }) {
  stubAuthModes(companion);
  const calls = vi.fn();
  server.use(
    http.get("/api/workspaces", () => HttpResponse.json([{ id: "ws-1", slug: SLUG, name: "Acme" }])),
    http.get(DEVICES, () => HttpResponse.json(devices)),
    http.get(CARD_SESSIONS, () => {
      calls();
      return HttpResponse.json(list);
    }),
    http.get(NOTE_SESSIONS, () => {
      calls();
      return HttpResponse.json(list);
    }),
  );
  return calls;
}

function renderCard() {
  const queryClient = createTestQueryClient();
  renderWithProviders(<CardSessionsSection slug={SLUG} boardId={BOARD} cardId={CARD} />, { queryClient });
  return queryClient;
}

const THREE = listOf([
  linked(
    { id: "s-main", title: "Fix linked_summary double-counting overlapping subagent spans", display_state: "active", status: "active", cost_usd: 6.18, cost_basis: "api_equivalent" },
    ["changed", "consulted"],
  ),
  linked(
    { id: "s-review", parent_session_id: "s-main", title: "Reviewer · interval merge edge cases", display_state: "active", status: "active", cost_usd: 0.92, cost_basis: "api_equivalent" },
    ["consulted"],
  ),
  linked(
    { id: "s-pi", harness: "pi_cli", harness_display_name: "Pi", title: null, cwd: "backplane", cost_usd: 0.31, cost_basis: "spend" },
    ["changed"],
    "correlated",
  ),
]);

describe("Your sessions on this card", () => {
  it("lists the viewer's own sessions with how each touched the card", async () => {
    serve({ list: THREE });
    renderCard();

    const section = await screen.findByRole("region", { name: "Your sessions on this card" });
    const main = await within(section).findByRole("link", { name: "Fix linked_summary double-counting overlapping subagent spans" });
    expect(main).toHaveAttribute("href", `/${SLUG}/sessions/s-main`);

    const mainRow = main.closest("li") as HTMLElement;
    expect(within(mainRow).getByText("Changed")).toBeInTheDocument();
    expect(within(mainRow).getByText("Consulted")).toBeInTheDocument();
    expect(within(mainRow).getByText("Live")).toBeInTheDocument();

    const reviewRow = within(section).getByRole("link", { name: "Reviewer · interval merge edge cases" }).closest("li") as HTMLElement;
    expect(within(reviewRow).getByText("subagent of the session above")).toBeInTheDocument();

    const piRow = within(section).getByText("backplane · title not sent at Metadata").closest("li") as HTMLElement;
    expect(within(piRow).getByText("matched by timing")).toBeInTheDocument();
  });

  it("sums time as wall time and never adds costs across bases", async () => {
    serve({ list: THREE });
    renderCard();
    const section = await screen.findByRole("region", { name: "Your sessions on this card" });
    const summary = within(section).getByTestId("linked-sessions-summary");
    expect(summary).toHaveTextContent("3 sessions");
    expect(summary).toHaveTextContent("1h 34m wall time");
    expect(summary).toHaveTextContent("3.1M tokens");
    expect(summary).toHaveTextContent("$7.10 API-equivalent");
    expect(summary).toHaveTextContent("$0.31 spend");
    expect(summary).not.toHaveTextContent("$7.41");
  });

  it("always says only the viewer's own sessions are listed, and links to them all", async () => {
    serve({ list: THREE });
    renderCard();
    const section = await screen.findByRole("region", { name: "Your sessions on this card" });
    expect(within(section).getByText("Only your own sessions are listed. Other people's sessions on this card stay private to them.")).toBeInTheDocument();
    expect(within(section).getByRole("link", { name: "All my sessions" })).toHaveAttribute("href", `/${SLUG}/sessions?board=${BOARD}&period=30d`);
  });

  it("says so in one line when the viewer has devices but no session touched the card", async () => {
    serve({ list: listOf([]) });
    renderCard();
    const section = await screen.findByRole("region", { name: "Your sessions on this card" });
    expect(within(section).getByText("None of your sessions touched this card.")).toBeInTheDocument();
  });

  it("stays out of the way for teammates without Companion devices", async () => {
    serve({ devices: [], list: listOf([]) });
    const queryClient = renderCard();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.queryByRole("region", { name: "Your sessions on this card" })).not.toBeInTheDocument();
  });

  it("still lists linked sessions after the viewer's device is gone", async () => {
    serve({ devices: [], list: THREE });
    renderCard();
    expect(await screen.findByRole("region", { name: "Your sessions on this card" })).toBeInTheDocument();
  });

  it("is not rendered, and calls nothing, when this Backplane does not accept sessions", async () => {
    const calls = serve({ companion: false, list: THREE });
    const queryClient = renderCard();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.queryByRole("region", { name: "Your sessions on this card" })).not.toBeInTheDocument();
    expect(calls).not.toHaveBeenCalled();
  });

  it("explains a timing match where it is shown", async () => {
    serve({ list: THREE });
    renderCard();
    const section = await screen.findByRole("region", { name: "Your sessions on this card" });
    expect(await within(section).findByText("matched by timing")).toHaveAttribute("title", "Matched by timing, not by an exact call id");
  });

  it("keeps its heading and offers a retry when the server fails", async () => {
    stubAuthModes(true);
    let attempts = 0;
    server.use(
      http.get("/api/workspaces", () => HttpResponse.json([{ id: "ws-1", slug: SLUG, name: "Acme" }])),
      http.get(DEVICES, () => HttpResponse.json([DEVICE])),
      http.get(CARD_SESSIONS, () => {
        attempts += 1;
        return attempts === 1 ? HttpResponse.json({ detail: "boom" }, { status: 500 }) : HttpResponse.json(THREE);
      }),
    );
    renderCard();
    const section = await screen.findByRole("region", { name: "Your sessions on this card" });
    expect(within(section).getByText("Couldn't load your sessions here.")).toBeInTheDocument();
    await userEvent.click(within(section).getByRole("button", { name: "Try again" }));
    expect(await within(section).findByTestId("linked-sessions-summary")).toHaveTextContent("3 sessions");
  });

  it("blurs session titles in presenter mode", async () => {
    act(() => setPromptsHidden(true));
    serve({ list: THREE });
    renderCard();
    const section = await screen.findByRole("region", { name: "Your sessions on this card" });
    expect(await within(section).findByText("Fix linked_summary double-counting overlapping subagent spans")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("Your sessions on this note", () => {
  it("reads the note's own sessions and speaks about the note", async () => {
    serve({ list: listOf([]) });
    renderWithProviders(<NoteSessionsSection slug={SLUG} noteId={NOTE} boardId={null} />);
    const section = await screen.findByRole("region", { name: "Your sessions on this note" });
    expect(within(section).getByText("None of your sessions touched this note.")).toBeInTheDocument();
    expect(within(section).getByText("Only your own sessions are listed. Other people's sessions on this note stay private to them.")).toBeInTheDocument();
  });
});
