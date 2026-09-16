// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  renderWithProviders,
  screen,
  waitFor,
  within,
  userEvent,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { LoopTemplateProfileTab } from "../components/LoopTemplateProfileTab";
import { TemplateDraftProvider } from "../hooks/TemplateDraftProvider";

// F9 (card 8d30cf7c) — the profile tab becomes a profile PAGE: an identity
// header that WRITES through the shell's one draft store, and a two-column
// section grid. The role lookup is mocked per-suite: an unmocked one resolves
// to not-admin, which would make every editable assertion vacuously pass by
// rendering the read-only branch.
const adminState = { current: { isAdmin: true } };
vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({
    role: adminState.current.isAdmin ? "admin" : "member",
    isAdmin: adminState.current.isAdmin,
    isLoading: false,
    isError: false,
  }),
}));

// Card eb7d83ab — the "profile page" body. RED phase.
//
// Locator contract the implementation must satisfy:
// - `loop-template-profile-section-<key>` — one per rendered profile section
// - `loop-template-track-record`          — the derived Stat tile row
// - `loop-template-track-record-empty`    — zero-iteration empty state
// - `loop-template-rail-<rail>`           — one row per rails_defaults entry
// - `loop-template-tool-group-<group>`    — read | write | offSwitch

const SLUG = "acme";
const REF = "coding-loop";
const PROFILE_URL = `/api/workspaces/${SLUG}/loop-templates/${REF}/profile`;

const FULL_PROFILE = {
  id: "coding-loop",
  slug: "coding-loop",
  source: "system",
  name: "Coding loop",
  version: 2,
  is_system: true,
  profile: {
    emoji: "🔁",
    tagline: "I loop through a board, one card per fresh session.",
    tags: ["coding", "tdd"],
    what_i_do: ["Short-circuit on the run label.", "Pick the top unblocked card."],
    when_to_use: "A backlog of small, pre-researched cards on ONE repository.",
    when_not_to_use: "Open-ended design work with no gates and no crisp done.",
    needs_from_board: "Typed columns, a run label, a bound git repo.",
    needs_from_runner: "Loop mode, a persistent working directory, a budget cap.",
    how_i_end: "I report objective_complete when no labelled card remains.",
    how_i_learn: "Every run log carries a what-was-wrong section.",
  },
  boards_using: 3,
  versions: [],
  rails_defaults: { max_iterations: 40, budget_usd: 30 },
  tools: ["search_cards", "update_card", "set_board_loop"],
  slots: [
    { name: "RUN_LABEL", kind: "scalar", required: true },
    { name: "REPO_URL", kind: "scalar", required: true },
  ],
  setup_contract: {
    required_column_types: ["active", "done"],
    requires_run_label: true,
    git_repo_bound: true,
  },
  track_record: {
    iterations: 176,
    spent_usd: 115.5,
    duration_seconds_total: 7200,
    last_used_at: "2026-08-16T00:00:00Z",
    boards: [
      { board_id: "b-1", iterations: 100, spent_usd: 70 },
      { board_id: "b-2", iterations: 76, spent_usd: 45.5 },
    ],
    outcomes: {
      worked: 170,
      nothing_ready: 1,
      blocked_on_human: 1,
      objective_complete: 4,
      unknown: 0,
    },
    self_terminations: 4,
  },
};

const DETAIL_URL = `/api/workspaces/${SLUG}/loop-templates/${REF}`;

/**
 * The DRAFT half the header edits. The profile endpoint relays server-computed
 * sections (rails, tools, contract, track record) that the draft does not
 * carry, so the tab reads BOTH — and these fixtures must stay distinguishable
 * or an assertion cannot tell which source a value came from.
 */
function detailBody(over: Record<string, unknown> = {}) {
  return {
    id: REF,
    slug: "coding-loop",
    source: "workspace",
    name: "Coding loop",
    version: 2,
    is_system: false,
    is_draft: false,
    profile: {
      emoji: "🔁",
      tagline: "I loop through a board, one card per fresh session.",
      tags: ["coding", "tdd"],
      what_i_do: ["Short-circuit on the run label."],
      how_i_end: "I report objective_complete when no labelled card remains.",
    },
    content: { system_prompt: "", loop_prompt: "", slots: [] },
    lineage: null,
    updated_at: "2026-08-17T00:00:00Z",
    draft_updated_at: "2026-08-17T00:00:00Z",
    has_unpublished_changes: false,
    ...over,
  };
}

let patches: Record<string, unknown>[] = [];

function serveProfile(
  overrides: Record<string, unknown> = {},
  detailOver: Record<string, unknown> = {},
) {
  const detail = detailBody(detailOver);
  server.use(
    http.get(PROFILE_URL, () =>
      HttpResponse.json({ ...FULL_PROFILE, ...overrides }),
    ),
    http.get(DETAIL_URL, () => HttpResponse.json(detail)),
    http.patch(DETAIL_URL, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      patches.push(body);
      return HttpResponse.json({ ...detail, ...body });
    }),
  );
}

function renderTab() {
  return renderWithProviders(
    <TemplateDraftProvider slug={SLUG} templateRef={REF}>
      <LoopTemplateProfileTab slug={SLUG} templateRef={REF} />
    </TemplateDraftProvider>,
  );
}

/** The profile bag from the most recent autosaved PATCH. */
async function lastProfilePatch(): Promise<Record<string, unknown>> {
  await waitFor(() => expect(patches.length).toBeGreaterThan(0));
  return patches[patches.length - 1]?.profile as Record<string, unknown>;
}

describe("LoopTemplateProfileTab", () => {
  beforeEach(() => {
    patches = [];
    adminState.current.isAdmin = true;
    serveProfile();
  });

  it("renders every stored prose section that has content", async () => {
    renderTab();

    await waitFor(() =>
      expect(
        screen.getByTestId("loop-template-profile-section-when_to_use"),
      ).toBeInTheDocument(),
    );

    for (const key of [
      "what_i_do",
      "when_to_use",
      "when_not_to_use",
      "needs_from_board",
      "needs_from_runner",
      "how_i_end",
      "how_i_learn",
    ]) {
      expect(
        screen.getByTestId(`loop-template-profile-section-${key}`),
      ).toBeInTheDocument();
    }

    // The prose is RELAYED from the endpoint, not restated in the frontend.
    expect(
      screen.getByText(
        "A backlog of small, pre-researched cards on ONE repository.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Short-circuit on the run label."),
    ).toBeInTheDocument();
  });

  it("hides sections the template left empty — no blank headings", async () => {
    serveProfile({
      profile: {
        emoji: "📚",
        tagline: "Audit the docs tree",
        what_i_do: [],
        when_to_use: "",
        how_i_end: "I stop when the sweep is clean.",
      },
    });
    renderTab();

    await waitFor(() =>
      expect(
        screen.getByTestId("loop-template-profile-section-how_i_end"),
      ).toBeInTheDocument(),
    );

    expect(
      screen.queryByTestId("loop-template-profile-section-when_to_use"),
    ).not.toBeInTheDocument();
    // An empty ARRAY must hide its section too, not render an empty list.
    expect(
      screen.queryByTestId("loop-template-profile-section-what_i_do"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("loop-template-profile-section-needs_from_board"),
    ).not.toBeInTheDocument();
  });

  it("shows the derived track-record numbers from the endpoint", async () => {
    renderTab();

    const record = await screen.findByTestId("loop-template-track-record");

    expect(record).toHaveTextContent("176");
    expect(record).toHaveTextContent("4"); // self-terminations
    expect(record).toHaveTextContent("3"); // boards using
    expect(record).toHaveTextContent("115.5");
    expect(
      screen.queryByTestId("loop-template-track-record-empty"),
    ).not.toBeInTheDocument();
  });

  it("shows the empty state instead of zero tiles when nothing has run", async () => {
    // boards_using is deliberately NON-zero: a board can be BOUND to a
    // template that has never executed an iteration, and "has it ever run?"
    // is the iteration count, not the binding count.
    serveProfile({
      boards_using: 2,
      track_record: {
        iterations: 0,
        spent_usd: 0,
        duration_seconds_total: 0,
        last_used_at: null,
        boards: [],
        outcomes: {
          worked: 0,
          nothing_ready: 0,
          blocked_on_human: 0,
          objective_complete: 0,
          unknown: 0,
        },
        self_terminations: 0,
      },
    });
    renderTab();

    await waitFor(() =>
      expect(
        screen.getByTestId("loop-template-track-record-empty"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("loop-template-track-record"),
    ).not.toBeInTheDocument();
  });

  it("keeps the track record after every board detached — history survives unbinding", async () => {
    // The track record is derived from stamped executions, not from live
    // bindings, so detaching the last board must NOT erase the history.
    serveProfile({ boards_using: 0 });
    renderTab();

    const record = await screen.findByTestId("loop-template-track-record");
    expect(record).toHaveTextContent("176");
    expect(
      screen.queryByTestId("loop-template-track-record-empty"),
    ).not.toBeInTheDocument();
  });

  it("gives every rails row a RichTooltip trigger", async () => {
    renderTab();

    const rail = await screen.findByTestId("loop-template-rail-max_iterations");

    expect(rail).toHaveTextContent("max_iterations");
    expect(rail).toHaveTextContent("40");
    // The tooltip PANEL content lands in p3-09; this card ships the trigger.
    const trigger = rail.querySelector('[aria-haspopup="dialog"]');
    expect(trigger).not.toBeNull();

    expect(
      screen.getByTestId("loop-template-rail-budget_usd"),
    ).toHaveTextContent("30");
  });

  it("groups the tool grant and keeps set_board_loop in off-switch", async () => {
    renderTab();

    const offSwitch = await screen.findByTestId(
      "loop-template-tool-group-offSwitch",
    );
    expect(offSwitch).toHaveTextContent("set_board_loop");

    expect(
      screen.getByTestId("loop-template-tool-group-read"),
    ).toHaveTextContent("search_cards");
    expect(
      screen.getByTestId("loop-template-tool-group-write"),
    ).toHaveTextContent("update_card");
    // set_board_loop is a MUTATION by name shape, so the off-switch rule has
    // to beat the write rule — assert it is not double-listed.
    expect(
      screen.getByTestId("loop-template-tool-group-write"),
    ).not.toHaveTextContent("set_board_loop");
  });

  it("renders the setup contract as a checklist and the slot count", async () => {
    renderTab();

    const contract = await screen.findByTestId("loop-template-setup-contract");
    expect(contract).toHaveTextContent("active");
    expect(contract).toHaveTextContent("done");

    expect(screen.getByTestId("loop-template-slot-count")).toHaveTextContent(
      "2",
    );
  });
});

describe("LoopTemplateProfileTab — profile header (F9)", () => {
  beforeEach(() => {
    patches = [];
    adminState.current.isAdmin = true;
    serveProfile();
  });

  it("renders an identity header with the emoji avatar, name, tagline and tags", async () => {
    renderTab();

    const header = await screen.findByTestId("loop-template-profile-header");

    // The emoji is a meaningful identity element, so it carries an accessible
    // label rather than aria-hidden.
    const avatar = within(header).getByTestId("loop-template-profile-emoji");
    expect(avatar).toHaveTextContent("🔁");
    expect(avatar).not.toHaveAttribute("aria-hidden");

    expect(
      within(header).getByTestId("loop-template-profile-name-input"),
    ).toHaveValue("Coding loop");
    expect(
      within(header).getByTestId("loop-template-profile-tagline-input"),
    ).toHaveValue("I loop through a board, one card per fresh session.");
    expect(header).toHaveTextContent("coding");
    expect(header).toHaveTextContent("tdd");
  });

  it("picks an emoji from the first-party grid and autosaves profile.emoji", async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(
      await screen.findByTestId("loop-template-profile-emoji-trigger"),
    );
    const picker = await screen.findByTestId("loop-template-profile-emoji-picker");
    // A curated grid, not a dependency: assert a specific option exists.
    await user.click(within(picker).getByTestId("loop-template-profile-emoji-option-🧭"));

    const profile = await lastProfilePatch();
    expect(profile.emoji).toBe("🧭");
    // The rest of the stored bag must survive an emoji write.
    expect(profile.tagline).toBe(
      "I loop through a board, one card per fresh session.",
    );
    expect(profile.tags).toEqual(["coding", "tdd"]);
    expect(profile.how_i_end).toBe(
      "I report objective_complete when no labelled card remains.",
    );
  });

  it("accepts a pasted emoji the grid lacks, capped to ONE grapheme", async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(
      await screen.findByTestId("loop-template-profile-emoji-trigger"),
    );
    const custom = await screen.findByTestId(
      "loop-template-profile-emoji-custom",
    );
    // A family emoji is one grapheme built from FIVE code points joined by
    // ZWJs. `slice(0, 1)` splits a surrogate pair; `[...v][0]` keeps only the
    // first woman. Paste it whole and commit — the field must store all five.
    await user.clear(custom);
    await user.click(custom);
    await user.paste("👩‍👩‍👧");
    await user.tab();

    await waitFor(async () =>
      expect((await lastProfilePatch()).emoji).toBe("👩‍👩‍👧"),
    );

    // Two glyphs pasted together still store exactly ONE.
    await user.clear(custom);
    await user.paste("🧭🚀");
    await user.tab();
    await waitFor(async () =>
      expect((await lastProfilePatch()).emoji).toBe("🧭"),
    );
  });

  it("autosaves the tagline through the shared draft store", async () => {
    const user = userEvent.setup();
    renderTab();

    const tagline = await screen.findByTestId(
      "loop-template-profile-tagline-input",
    );
    await user.clear(tagline);
    await user.type(tagline, "Sweeps docs");

    await waitFor(async () =>
      expect((await lastProfilePatch()).tagline).toBe("Sweeps docs"),
    );
  });

  it("renders a read-only header on a SYSTEM template — no picker, no inputs", async () => {
    serveProfile({}, { is_system: true });
    renderTab();

    const header = await screen.findByTestId("loop-template-profile-header");
    expect(header).toHaveTextContent("Coding loop");
    expect(header).toHaveTextContent(
      "I loop through a board, one card per fresh session.",
    );

    expect(
      screen.queryByTestId("loop-template-profile-emoji-trigger"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("loop-template-profile-name-input"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("loop-template-profile-tagline-input"),
    ).not.toBeInTheDocument();
    // The emoji still READS — read-only means uneditable, not invisible.
    expect(
      screen.getByTestId("loop-template-profile-emoji"),
    ).toHaveTextContent("🔁");
  });

  it("renders a read-only header for a NON-ADMIN on a workspace template", async () => {
    adminState.current.isAdmin = false;
    serveProfile();
    renderTab();

    const header = await screen.findByTestId("loop-template-profile-header");
    expect(header).toHaveTextContent("Coding loop");
    expect(
      screen.queryByTestId("loop-template-profile-emoji-trigger"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("loop-template-profile-name-input"),
    ).not.toBeInTheDocument();
  });

  it("falls back to a placeholder glyph when profile.emoji is absent", async () => {
    serveProfile({}, { profile: { tagline: "No face yet", tags: [] } });
    renderTab();

    const avatar = await screen.findByTestId("loop-template-profile-emoji");
    // Not empty: an avatar with no content collapses to a bare circle.
    expect(avatar.textContent?.trim()).not.toBe("");
  });

  it("lays the sections out in a responsive TWO-column grid, not a single stack", async () => {
    renderTab();

    const grid = await screen.findByTestId("loop-template-profile-sections");
    // jsdom does not run layout or media queries, so the responsive breakpoint
    // is unobservable at runtime; assert the style PROPERTY the fix applies —
    // the utility classes a browser resolves into the two columns.
    expect(grid.className).toContain("grid");
    expect(grid.className).toContain("grid-cols-1");
    expect(grid.className).toContain("md:grid-cols-2");
    expect(grid.className).not.toContain("space-y-3");

    // The header and the track record are full-bleed rows, not grid cells.
    const record = screen.getByTestId("loop-template-track-record");
    expect(record.className).toContain("md:col-span-2");
    // Every prose section IS inside the grid.
    expect(
      within(grid).getByTestId("loop-template-profile-section-when_to_use"),
    ).toBeInTheDocument();
  });

  it("renders read-only with NO draft store — the sheet reuses this body outside the shell", async () => {
    // The board dialog's profile SHEET mounts the tab with no template open to
    // edit. Throwing there would crash a read-only viewer; falling back to a
    // private store would resurrect the four-store bug F2 closed. It must
    // degrade to read-only, showing the RELAYED values.
    renderWithProviders(
      <LoopTemplateProfileTab slug={SLUG} templateRef={REF} />,
    );

    const header = await screen.findByTestId("loop-template-profile-header");
    expect(header).toHaveTextContent("Coding loop");
    expect(within(header).getByTestId("loop-template-profile-emoji"))
      .toHaveTextContent("🔁");
    expect(
      screen.queryByTestId("loop-template-profile-emoji-trigger"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("loop-template-profile-name-input"),
    ).not.toBeInTheDocument();
    // No PATCH can be issued from a surface with no store.
    expect(patches).toHaveLength(0);
  });

  it("keeps the relayed sections coming from the PROFILE endpoint, not the draft", async () => {
    // The draft's profile bag deliberately omits when_to_use while the profile
    // endpoint has it: if the tab derived prose from the draft this goes blank.
    renderTab();

    const section = await screen.findByTestId(
      "loop-template-profile-section-when_to_use",
    );
    expect(section).toHaveTextContent(
      "A backlog of small, pre-researched cards on ONE repository.",
    );
    expect(
      screen.getByTestId("loop-template-rail-max_iterations"),
    ).toHaveTextContent("40");
  });
});
