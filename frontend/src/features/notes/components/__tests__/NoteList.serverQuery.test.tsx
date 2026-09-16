// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
  within,
} from "@/test/test-utils";
import type { NoteSummary } from "@/types/note";

// The list is server-driven: every control the toolbar exposes must arrive as
// a REQUEST param, because search/sort/filter have to span the whole
// collection, not just the pages that happen to be loaded.
const listHook = vi.fn();
const fetchNextPage = vi.fn();

vi.mock("../../api/use-notes-list", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useNotesList: (...args: unknown[]) => listHook(...args),
}));
vi.mock("../../api/use-notes", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useNotes: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/features/members/api/use-members", () => ({
  useMembers: () => ({
    data: [
      { user_id: "u1", name: "Ada Lovelace", email: "ada@x.dev" },
      { user_id: "u2", name: "Grace Hopper", email: "grace@x.dev" },
    ],
  }),
}));
vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: () => null,
}));

import { NoteList } from "../NoteList";

function makeSummary(id: string, overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id,
    workspace_id: "ws-1",
    board_id: null,
    card_id: null,
    title: `Note ${id}`,
    preview: `preview ${id}`,
    pinned: false,
    kind: "user_note",
    failure_class: null,
    findings: null,
    source_execution_id: null,
    created_by: "u1",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

interface HookResult {
  items?: NoteSummary[];
  totalCount?: number;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  isLoading?: boolean;
}

function stubList(overrides: HookResult = {}) {
  listHook.mockReturnValue({
    items: [makeSummary("n1")],
    totalCount: 1,
    isLoading: false,
    isFetching: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage,
    ...overrides,
  });
}

/** The params object the component last handed the list hook. */
function lastParams(): Record<string, unknown> {
  return (listHook.mock.calls.at(-1)?.[2] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  listHook.mockReset();
  fetchNextPage.mockReset();
  window.localStorage.clear();
  stubList();
});

describe("NoteList sends its controls to the server", () => {
  it("passes the workspace slug and boardId through to the list hook", async () => {
    renderWithProviders(<NoteList slug="acme" boardId="board-1" />);
    await waitFor(() => expect(listHook).toHaveBeenCalled());
    expect(listHook.mock.calls.at(-1)?.[0]).toBe("acme");
    expect(listHook.mock.calls.at(-1)?.[1]).toBe("board-1");
  });

  it("defaults to updated_at descending", async () => {
    renderWithProviders(<NoteList slug="acme" />);
    await waitFor(() => expect(listHook).toHaveBeenCalled());
    expect(lastParams()).toMatchObject({
      orderBy: "updated_at",
      direction: "desc",
    });
  });

  it("sends the typed search term as q, debounced", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<NoteList slug="acme" />);

    await user.type(screen.getByRole("searchbox"), "budget");
    // Still un-sent immediately after typing — one request per keystroke would
    // be a search-as-you-type stampede against the whole collection.
    expect(lastParams().q ?? "").toBe("");

    await vi.advanceTimersByTimeAsync(300);
    await waitFor(() => expect(lastParams().q).toBe("budget"));
    vi.useRealTimers();
  });

  it("sends the chosen sort field as orderBy", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<NoteList slug="acme" />);

    await user.click(screen.getByText(/sort by/i).closest("button")!);
    await user.click(await screen.findByRole("menuitem", { name: /author/i }));

    await waitFor(() => expect(lastParams().orderBy).toBe("author"));
  });

  it("sends the sort direction flip", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<NoteList slug="acme" />);

    await user.click(screen.getByRole("button", { name: /descending/i }));
    await waitFor(() => expect(lastParams().direction).toBe("asc"));
  });

  it("sends pinnedOnly when the pinned toggle is on", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<NoteList slug="acme" />);

    await user.click(screen.getByRole("button", { name: /pinned only/i }));
    await waitFor(() => expect(lastParams().pinnedOnly).toBe(true));
  });

  it("sends the selected author ids", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<NoteList slug="acme" />);

    await user.click(screen.getByRole("button", { name: /author/i }));
    // The name also renders in each card's byline — pick the one in the menu.
    const menu = await screen.findByTestId("filter-multi-select-options");
    await user.click(within(menu).getByText("Ada Lovelace"));

    await waitFor(() => expect(lastParams().authors).toEqual(["u1"]));
  });

  it("expands the origin filter into the matching note kinds", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<NoteList slug="acme" />);

    await user.click(screen.getByRole("button", { name: /source/i }));
    await user.click(await screen.findByText("Runner"));

    await waitFor(() => {
      const kinds = lastParams().kinds as string[];
      expect(kinds).toBeDefined();
      // Every agent-origin kind, so the server can filter without knowing the
      // frontend's human/agent taxonomy.
      expect([...kinds].sort()).toEqual(
        ["plan", "review_verdict", "rework_brief", "system"].sort(),
      );
    });
  });

  it("sends no kinds at all when both origins are selected", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<NoteList slug="acme" />);

    await user.click(screen.getByRole("button", { name: /source/i }));
    await user.click(await screen.findByText("Runner"));
    await user.click(await screen.findByText("People"));

    await waitFor(() => {
      // "everything" must not become an explicit kind allowlist — a kind the
      // frontend catalog doesn't know about would silently disappear.
      expect(lastParams().kinds).toBeUndefined();
    });
  });
});

describe("NoteList pagination", () => {
  it("reports the server total, not the number of loaded rows", async () => {
    stubList({ items: [makeSummary("n1")], totalCount: 317 });
    renderWithProviders(<NoteList slug="acme" />);
    expect(await screen.findByText("1 of 317")).toBeInTheDocument();
  });

  it("offers a load-more control while more pages remain", async () => {
    stubList({ hasNextPage: true });
    renderWithProviders(<NoteList slug="acme" />);
    expect(
      await screen.findByRole("button", { name: /load more/i }),
    ).toBeInTheDocument();
  });

  it("fetches the next page when load-more is pressed", async () => {
    stubList({ hasNextPage: true });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<NoteList slug="acme" />);

    await user.click(await screen.findByRole("button", { name: /load more/i }));
    expect(fetchNextPage).toHaveBeenCalled();
  });

  it("hides load-more on the last page", () => {
    stubList({ hasNextPage: false });
    renderWithProviders(<NoteList slug="acme" />);
    expect(
      screen.queryByRole("button", { name: /load more/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the empty state only when the server reports zero matches with no filters", async () => {
    stubList({ items: [], totalCount: 0 });
    renderWithProviders(<NoteList slug="acme" />);
    expect(await screen.findByText(/no notes yet/i)).toBeInTheDocument();
  });

  it("shows 'no results' — not the empty state — when a filter matched nothing", async () => {
    // Starts populated (so the toolbar is on screen), then the pinned filter
    // comes back empty from the server.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<NoteList slug="acme" />);
    await screen.findByRole("searchbox");

    stubList({ items: [], totalCount: 0 });
    await user.click(screen.getByRole("button", { name: /pinned only/i }));

    // The toolbar must stay reachable, else the user is stranded in an empty
    // state with no way to clear the filter that produced it.
    await waitFor(() =>
      expect(screen.queryByText(/no notes yet/i)).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("searchbox")).toBeInTheDocument();
    expect(screen.getByText(/no items match/i)).toBeInTheDocument();
  });
});
