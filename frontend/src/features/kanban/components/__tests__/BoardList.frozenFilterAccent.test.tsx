// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import type { Board } from "@/types/kanban";
import { FROZEN_ACCENT_CLASS } from "../../lib/frozen-theme";

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, useParams: () => ({ slug: "acme" }) };
});

vi.mock("@/features/visuals/components/WaveBackground", () => ({
  __esModule: true,
  WaveBackground: () => <div data-testid="wave-bg" />,
}));

const FROZEN: Board = {
  id: "zulu",
  slug: "zulu",
  name: "Zulu",
  description: "",
  tags: [],
  workspace_id: "ws-1",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  card_count: 0,
  column_count: 0,
  last_activity_at: null,
  is_frozen: true,
};

// A thawed board keeps the list non-empty once the filter hides FROZEN, so the
// engaged state still renders board cards instead of the frozen empty state.
const THAWED: Board = { ...FROZEN, id: "alpha", slug: "alpha", name: "Alpha", is_frozen: false };

vi.mock("../../api/use-boards", () => ({
  useBoards: () => ({ data: [FROZEN, THAWED], isLoading: false }),
  useCreateBoard: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { BoardList } from "../BoardList";

const ACCENT_CLASSES = FROZEN_ACCENT_CLASS.split(" ");

// jsdom resolves no Tailwind class to a computed colour, so nothing here can
// read back a rendered hue. These assert the exact class list on the exact
// element whose className the fix manipulates — the available signal. The
// blue-vs-gray difference itself needs a human look.

beforeEach(() => {
  window.localStorage.clear();
});

describe("BoardList — frozen filter wears the frozen accent, not the brand green", () => {
  it("tints the engaged filter with the same ice-blue classes the frozen card's badge uses", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BoardList />);

    // The frozen card's badge is read from the DEFAULT render, where frozen
    // boards are still visible; the toggle's accent is read after engaging the
    // filter, since the accent now lives on the engaged state only. Both reads
    // must resolve to the same shared constant.
    // The toggle's own aria-label also says "frozen", so the badge has to be
    // resolved from inside a board card rather than by page-wide label — and
    // from the FROZEN card specifically, since a thawed card's same-slot badge
    // is the freshness dot.
    const frozenCard = Array.from(
      document.querySelectorAll("[data-board-card]"),
    ).find((el) => el.textContent?.includes(FROZEN.name));
    expect(frozenCard).toBeDefined();
    const badge = frozenCard!.querySelector('[aria-label*="rozen"]')!;
    expect(badge).not.toBeNull();

    await user.click(screen.getByRole("button", { name: /hide frozen boards/i }));
    const toggle = screen.getAllByRole("button", {
      name: /show frozen boards/i,
    })[0]!;

    // Both surfaces resolve to the SAME shared constant — that is the guarantee
    // the card asks for, not merely "the filter happens to be blue today".
    for (const cls of ACCENT_CLASSES) {
      expect(toggle.className).toContain(cls);
      expect(badge.getAttribute("class") ?? "").toContain(cls);
    }
  });

  it("no longer paints the filter with the green primary token", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BoardList />);

    // `text-primary` was applied ONLY in the hidden state, so asserting on the
    // default render would pass regardless of the fix.
    await user.click(screen.getByRole("button", { name: /hide frozen boards/i }));

    const hidden = screen.getAllByRole("button", {
      name: /show frozen boards/i,
    })[0]!;
    expect(hidden.className.split(/\s+/)).not.toContain("text-primary");
  });

  it("rests at neutral gray while the filter is doing nothing", () => {
    renderWithProviders(<BoardList />);

    // Default render shows frozen boards, so the filter is NOT engaged.
    const resting = screen.getByRole("button", { name: /hide frozen boards/i });

    expect(resting.className).toContain("text-muted-foreground");
    for (const cls of ACCENT_CLASSES) {
      expect(resting.className).not.toContain(cls);
    }
  });

  it("wears the ice-blue accent only while the filter is engaged", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BoardList />);

    await user.click(screen.getByRole("button", { name: /hide frozen boards/i }));

    // The all-frozen empty state adds a second "Show frozen boards" control;
    // the header toggle is the first one.
    const engaged = screen.getAllByRole("button", {
      name: /show frozen boards/i,
    })[0]!;
    for (const cls of ACCENT_CLASSES) {
      expect(engaged.className).toContain(cls);
    }
    expect(engaged.className).not.toContain("text-muted-foreground");
  });

  it("anchors the accent to aria-pressed, not to the raw showFrozen flag", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BoardList />);

    await user.click(screen.getByRole("button", { name: /hide frozen boards/i }));

    // `aria-pressed` is inverted relative to `showFrozen`: pressed means frozen
    // boards are HIDDEN, i.e. the filter is actually filtering. Pinning colour
    // to that attribute stops a later refactor from flipping the hue off its
    // semantic anchor while both individually still look reasonable.
    const engaged = screen.getAllByRole("button", {
      name: /show frozen boards/i,
    })[0]!;
    expect(engaged.getAttribute("aria-pressed")).toBe("true");
    for (const cls of ACCENT_CLASSES) {
      expect(engaged.className).toContain(cls);
    }
  });

  it("animates the hue change so the toggle reads as a switch, not a repaint", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BoardList />);

    const resting = screen.getByRole("button", { name: /hide frozen boards/i });
    expect(resting.className).toContain("transition-colors");

    await user.click(resting);

    const engaged = screen.getAllByRole("button", {
      name: /show frozen boards/i,
    })[0]!;
    expect(engaged.className).toContain("transition-colors");
  });

  it("no longer dims either state with opacity — hue carries the on/off signal", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BoardList />);

    const resting = screen.getByRole("button", { name: /hide frozen boards/i });
    expect(resting.className).not.toContain("opacity-70");

    await user.click(resting);

    const engaged = screen.getAllByRole("button", {
      name: /show frozen boards/i,
    })[0]!;
    expect(engaged.className).not.toContain("opacity-70");
  });
});
