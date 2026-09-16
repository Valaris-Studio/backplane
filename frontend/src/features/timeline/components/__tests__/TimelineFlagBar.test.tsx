// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { TimelineFlagBar } from "../TimelineFlagBar";
import { EMPTY_FLAG_QUERY, type ActorFacet, type FlagQuery } from "../../utils/event-flags";

// The flag bar is fully controlled: it renders the query, emits changes, and
// navigates the playhead across the flagged indices. It never filters events.

const FACETS: ActorFacet[] = [
  { key: "agent:ag1", kind: "agent", label: "frogger" },
  { key: "user:u1", kind: "user", label: "Alice" },
  { key: "role:reviewer", kind: "role", label: "reviewer" },
];

const CARD_FACETS = [{ id: "c1", title: "Ship replay" }];
const EVENT_FACETS = { entityTypes: [{ value: "note", count: 3 }], actions: [{ value: "updated", count: 2 }] };

function setup(
  overrides: Partial<{
    query: FlagQuery;
    facets: ActorFacet[];
    flags: number[];
    frameIndex: number;
    onQueryChange: (q: FlagQuery) => void;
    onSeek: (i: number) => void;
  }> = {},
) {
  const onQueryChange = overrides.onQueryChange ?? vi.fn();
  const onSeek = overrides.onSeek ?? vi.fn();
  renderWithProviders(
    <TimelineFlagBar
      query={overrides.query ?? EMPTY_FLAG_QUERY}
      facets={overrides.facets ?? FACETS}
      flags={overrides.flags ?? []}
      frameIndex={overrides.frameIndex ?? 0}
      onQueryChange={onQueryChange}
      onSeek={onSeek}
    />,
  );
  return { onQueryChange, onSeek };
}

describe("TimelineFlagBar — search input", () => {
  it("emits the typed text through onQueryChange, preserving actor keys", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    setup({
      query: { text: "", actorKeys: new Set(["agent:ag1"]) },
      onQueryChange,
    });
    await user.type(screen.getByTestId("flag-search-input"), "f");
    expect(onQueryChange).toHaveBeenCalledWith({
      text: "f",
      actorKeys: new Set(["agent:ag1"]),
    });
  });

  it("renders the current query text", () => {
    setup({ query: { text: "navbar", actorKeys: new Set() } });
    expect(screen.getByTestId("flag-search-input")).toHaveValue("navbar");
  });
});

describe("TimelineFlagBar — actor chips", () => {
  it("renders one toggle chip per facet with its label", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Filters" }));
    const chips = screen.getAllByTestId("flag-actor-chip");
    expect(chips).toHaveLength(3);
    expect(chips[0]).toHaveTextContent("frogger");
    expect(chips[1]).toHaveTextContent("Alice");
    expect(chips[2]).toHaveTextContent("reviewer");
  });

  it("marks selected chips pressed and toggles membership on click", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    setup({
      query: { text: "x", actorKeys: new Set(["user:u1"]) },
      onQueryChange,
    });
    await user.click(screen.getByRole("button", { name: "Filters (1)" }));
    const chips = screen.getAllByTestId("flag-actor-chip");
    expect(chips[1]).toHaveAttribute("aria-pressed", "true");
    expect(chips[0]).toHaveAttribute("aria-pressed", "false");
    // select an unselected one — added, text preserved
    await user.click(chips[0]!);
    expect(onQueryChange).toHaveBeenCalledWith({
      text: "x",
      actorKeys: new Set(["user:u1", "agent:ag1"]),
    });
    // click the selected one — removed
    await user.click(chips[1]!);
    expect(onQueryChange).toHaveBeenLastCalledWith({
      text: "x",
      actorKeys: new Set(),
    });
  });
});

describe("TimelineFlagBar — match count + navigation", () => {
  it("shows nothing match-related when the query is inactive", () => {
    setup({ query: EMPTY_FLAG_QUERY });
    expect(screen.queryByTestId("flag-count")).toBeNull();
    expect(screen.queryByTestId("flag-next")).toBeNull();
    expect(screen.queryByTestId("flag-clear")).toBeNull();
  });

  it("shows the flagged count when active", () => {
    setup({ query: { text: "fix", actorKeys: new Set() }, flags: [2, 5, 9] });
    expect(screen.getByTestId("flag-count")).toHaveTextContent("3");
  });

  it("shows a no-matches state when active with zero flags, hiding nav", () => {
    setup({ query: { text: "zzz", actorKeys: new Set() }, flags: [] });
    expect(screen.getByTestId("flag-count")).toBeInTheDocument();
    expect(screen.queryByTestId("flag-next")).toBeNull();
    expect(screen.queryByTestId("flag-prev")).toBeNull();
  });

  it("next/prev seek to the wrapped neighbours of the current frame", async () => {
    const user = userEvent.setup();
    const onSeek = vi.fn();
    setup({
      query: { text: "fix", actorKeys: new Set() },
      flags: [2, 5, 9],
      frameIndex: 5,
      onSeek,
    });
    await user.click(screen.getByTestId("flag-next"));
    expect(onSeek).toHaveBeenCalledWith(9);
    await user.click(screen.getByTestId("flag-prev"));
    expect(onSeek).toHaveBeenCalledWith(2);
  });

  it("clear resets the whole query", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    setup({
      query: { text: "fix", actorKeys: new Set(["agent:ag1"]) },
      flags: [1],
      onQueryChange,
    });
    await user.click(screen.getByTestId("flag-clear"));
    expect(onQueryChange).toHaveBeenCalledWith({ text: "", actorKeys: new Set() });
  });
});


describe("TimelineFlagBar — investigation filters", () => {
  it("gives identities distinct, persistent accents while keeping their labels", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    const facets: ActorFacet[] = [
      { key: "user:alice", kind: "user", label: "Alice" },
      { key: "user:bob", kind: "user", label: "Bob" },
    ];
    setup({ facets, onQueryChange });
    await user.click(screen.getByRole("button", { name: "Filters" }));
    const chips = screen.getAllByTestId("flag-actor-chip");
    expect(chips[0]!.style.getPropertyValue("--actor-accent")).not.toBe("");
    expect(chips[0]!.style.getPropertyValue("--actor-accent")).not.toBe(chips[1]!.style.getPropertyValue("--actor-accent"));
    expect(chips[0]).toHaveAccessibleName("Alice");
  });

  it("combines exact card, entity and action filters with existing criteria", async () => {
    const onQueryChange = vi.fn();
    const query = { text: "urgent", actorKeys: new Set(["user:u1"]) };
    renderWithProviders(<TimelineFlagBar query={query} facets={FACETS} flags={[]} frameIndex={0}
      cardFacets={[{ id: "c1", title: "Ship replay" }]}
      eventFacets={{ entityTypes: [{ value: "note", count: 3 }], actions: [{ value: "updated", count: 2 }] }}
      onQueryChange={onQueryChange} onSeek={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Filters (1)" }));
    await user.selectOptions(screen.getByLabelText("Card"), "c1");
    expect(onQueryChange).toHaveBeenLastCalledWith({ ...query, cardId: "c1" });
    await user.selectOptions(screen.getByLabelText("Event type"), "note");
    expect(onQueryChange).toHaveBeenLastCalledWith({ ...query, entityTypes: new Set(["note"]) });
    await user.selectOptions(screen.getByLabelText("Action"), "updated");
    expect(onQueryChange).toHaveBeenLastCalledWith({ ...query, actions: new Set(["updated"]) });
  });
});

describe("TimelineFlagBar — compact disclosure", () => {
  function ControlledFilters({ onSeek = vi.fn() }: { onSeek?: (index: number) => void }) {
    const [query, setQuery] = useState<FlagQuery>({ text: "", actorKeys: new Set() });
    return <TimelineFlagBar query={query} onQueryChange={setQuery} facets={FACETS} cardFacets={CARD_FACETS}
      eventFacets={EVENT_FACETS} flags={[2, 5, 9]} frameIndex={5} onSeek={onSeek} />;
  }

  it("starts with only search and a closed accessible Filters disclosure", () => {
    renderWithProviders(<ControlledFilters />);
    expect(screen.getByRole("searchbox")).toBeVisible();
    const toggle = screen.getByRole("button", { name: "Filters" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(panel).not.toBeNull();
    expect(panel).not.toBeVisible();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Alice" })).toBeNull();
  });

  it("preserves selections when closed and leaves match navigation and reset available", async () => {
    const user = userEvent.setup();
    const onSeek = vi.fn();
    renderWithProviders(<ControlledFilters onSeek={onSeek} />);
    const toggle = screen.getByRole("button", { name: "Filters" });
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.selectOptions(screen.getByRole("combobox", { name: "Card" }), "c1");
    await user.click(screen.getByRole("button", { name: "Alice" }));
    expect(toggle).toHaveAccessibleName("Filters (2)");
    toggle.focus();
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByTestId("flag-count")).toBeVisible();
    expect(screen.getByTestId("flag-count")).toHaveTextContent("3");
    await user.click(screen.getByRole("button", { name: "Next flagged event" }));
    await user.click(screen.getByRole("button", { name: "Previous flagged event" }));
    expect(onSeek).toHaveBeenNthCalledWith(1, 9);
    expect(onSeek).toHaveBeenNthCalledWith(2, 2);
    await user.click(toggle);
    expect(screen.getByRole("combobox", { name: "Card" })).toHaveValue("c1");
    expect(screen.getByRole("button", { name: "Alice" })).toHaveAttribute("aria-pressed", "true");
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Clear flags" }));
    expect(toggle).toHaveAccessibleName("Filters");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("flag-count")).toBeNull();
  });

  it("counts selected secondary criteria without counting the search text", () => {
    setup({ query: { text: "fix", actorKeys: new Set(["user:u1", "agent:ag1"]), cardId: "c1", entityTypes: new Set(["note"]), actions: new Set(["updated"]) } });
    expect(screen.getByRole("button", { name: "Filters (5)" })).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps supplied transport and view controls in the main row around the search", () => {
    renderWithProviders(<TimelineFlagBar query={EMPTY_FLAG_QUERY} facets={FACETS} flags={[]} frameIndex={0}
      transportControls={<button>Play</button>} viewToggle={<button>Dense</button>}
      onQueryChange={vi.fn()} onSeek={vi.fn()} />);
    const search = screen.getByRole("searchbox");
    const play = screen.getByRole("button", { name: "Play" });
    const dense = screen.getByRole("button", { name: "Dense" });
    const mainRow = search.parentElement!.parentElement!;
    expect(mainRow).toContainElement(play);
    expect(mainRow).toContainElement(dense);
    expect(play.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(search.compareDocumentPosition(dense) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps search-only matches compact and shows the explanatory hint only when expanded", async () => {
    const user = userEvent.setup();
    setup({ query: { text: "fix", actorKeys: new Set() }, flags: [1] });
    const toggle = screen.getByRole("button", { name: "Filters" });
    expect(screen.getByTestId("flag-count")).toBeVisible();
    expect(screen.queryByText(/Replay keeps the full board history/)).not.toBeVisible();
    await user.click(toggle);
    expect(screen.getByText(/Replay keeps the full board history/)).toBeVisible();
  });
});
