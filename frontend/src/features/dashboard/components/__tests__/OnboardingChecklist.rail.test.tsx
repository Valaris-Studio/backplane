// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  renderWithProviders,
  screen,
  waitFor,
  within,
  userEvent,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";

// Rail refactor: the wizard's card grid became a single-line TIMELINE RAIL of
// six pills, and step content stays in a portaled modal so opening a step
// never resizes or shifts the dashboard beneath it. Two visual contracts ride
// along:
// - the six pills sit on one aligned six-column line;
// - every step's icon gets the SAME treatment regardless of state — the
//   done/skipped signal is the status icon and the pill's tint, never a
//   recolored step glyph.
import { OnboardingChecklist } from "../OnboardingChecklist";

const SLUG = "acme";

const STEP_IDS = ["board", "context", "notes", "members", "channels", "repos"];

const boardAlpha = {
  id: "b1",
  slug: "alpha",
  name: "Alpha",
  description: "",
  tags: [],
  workspace_id: "ws-1",
  created_at: "2026-07-31T00:00:00Z",
  updated_at: "2026-07-31T00:00:00Z",
};

const soloMember = {
  id: "m1",
  user_id: "u1",
  email: "owner@acme.dev",
  role: "owner",
  created_at: "2026-07-31T00:00:00Z",
};

const definitionFixture = {
  id: "def-1",
  board_id: "b1",
  scope: "board",
  content: { objectives: [{ text: "Ship the first release", priority: null }] },
  created_at: "2026-07-31T00:00:00Z",
  updated_at: "2026-07-31T00:00:00Z",
};

interface WorkspaceState {
  boardCount?: number;
  channelCount?: number;
  boards?: unknown[];
  hasDefinition?: boolean;
}

function installWorkspaceHandlers(state: WorkspaceState = {}) {
  server.use(
    http.get(`/api/workspaces/${SLUG}/summary`, () =>
      HttpResponse.json({
        board_count: state.boardCount ?? 0,
        card_count: 0,
        note_count: 0,
        channel_count: state.channelCount ?? 0,
        recent_activity: [],
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/boards`, () =>
      HttpResponse.json(state.boards ?? []),
    ),
    http.get(`/api/workspaces/${SLUG}/members`, () =>
      HttpResponse.json([soloMember]),
    ),
    http.get(`/api/workspaces/${SLUG}/boards/:boardId/definitions`, () =>
      state.hasDefinition
        ? HttpResponse.json(definitionFixture)
        : HttpResponse.json({ detail: "Not found" }, { status: 404 }),
    ),
    http.get(`/api/workspaces/${SLUG}/boards/:boardId/git-repos`, () =>
      HttpResponse.json([]),
    ),
    http.get(`/api/workspaces/${SLUG}/resources`, () => HttpResponse.json([])),
  );
}

function stubMatchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

beforeEach(() => {
  window.localStorage.clear();
  stubMatchMedia(true);
});

afterEach(() => stubMatchMedia(false));

function renderChecklist() {
  return renderWithProviders(<OnboardingChecklist slug={SLUG} />);
}

function stepEl(container: HTMLElement, id: string) {
  return container.querySelector<HTMLElement>(
    `[data-onboarding-step="${id}"]`,
  )!;
}

function modalEl() {
  return document.querySelector<HTMLElement>("[data-onboarding-modal]");
}

describe("OnboardingChecklist — single-line timeline rail", () => {
  it("lays the six steps out on one aligned six-column line", async () => {
    installWorkspaceHandlers();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });

    const firstStep = stepEl(container, "board");
    const rail = firstStep.parentElement!;
    expect(rail.tagName).toBe("OL");
    expect(rail.className).toContain("grid-cols-6");

    // Every step is a direct child of that one rail — a nested wrapper would
    // break the pills' alignment against the progress line behind them.
    for (const id of STEP_IDS) {
      expect(stepEl(container, id).parentElement).toBe(rail);
    }
    expect(rail.children).toHaveLength(STEP_IDS.length);
  });

  it("gives every step icon the same treatment across done, empty and skipped", async () => {
    installWorkspaceHandlers({
      boardCount: 1,
      channelCount: 1,
      boards: [boardAlpha],
      hasDefinition: true,
    });
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });
    await waitFor(() =>
      expect(stepEl(container, "board").getAttribute("data-step-state")).toBe(
        "done",
      ),
    );

    // Skip one step (now from inside its modal) so all three states are on
    // screen at once.
    await user.click(within(stepEl(container, "notes")).getByRole("button"));
    await user.click(within(modalEl()!).getByText("Skip"));
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(stepEl(container, "notes").getAttribute("data-step-state")).toBe(
        "skipped",
      ),
    );

    const states = new Set<string>();
    const iconClasses = new Set<string>();
    for (const id of STEP_IDS) {
      const step = stepEl(container, id);
      states.add(step.getAttribute("data-step-state")!);
      const tile = step.querySelector<SVGElement>("[data-step-icon]")!;
      expect(tile, `step "${id}" has no icon glyph`).not.toBeNull();
      // Drop lucide's per-icon identity class (lucide-kanban, lucide-users…)
      // so what remains is purely the STYLING each state applies.
      iconClasses.add(
        tile
          .getAttribute("class")!
          .split(/\s+/)
          .filter((c) => c !== "lucide" && !c.startsWith("lucide-"))
          .join(" "),
      );
    }

    expect(states.size).toBeGreaterThanOrEqual(3);
    // One class string across every state — the owner's "inconsistent icons"
    // complaint, encoded.
    expect(iconClasses.size).toBe(1);
    const [onlyClass] = [...iconClasses];
    // The pill's own container carries the state tint; the step glyph itself
    // inherits it and is never recolored per state.
    expect(onlyClass).toContain("text-current");
    expect(onlyClass).not.toContain("text-success");
    expect(onlyClass).not.toContain("bg-success");
  });
});

// Owner feedback (2026-08-03, on 7621015): a bare popover full of form controls
// read badly. Each rail pill now opens a MODAL that TEACHES the step first —
// icon + title, a why-it-matters intro, a few bullets, a drawn illustration —
// and only then offers the same mini-form.
describe("OnboardingChecklist — step content lives in a didactic modal", () => {
  it("opens the step's modal in a body portal, never inside the rail", async () => {
    installWorkspaceHandlers();
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });
    expect(modalEl()).toBeNull();

    const boardStep = stepEl(container, "board");
    await user.click(within(boardStep).getByRole("button"));

    const modal = modalEl()!;
    expect(modal).not.toBeNull();
    const input = within(modal).getByPlaceholderText("Board name");
    // The card itself never grows to hold the content.
    expect(boardStep.contains(input)).toBe(false);
    expect(document.body.contains(input)).toBe(true);
    expect(modal.getAttribute("role")).toBe("dialog");
  });

  it("teaches before it asks: icon, title, intro, bullets and an illustration precede the form", async () => {
    installWorkspaceHandlers();
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });
    await user.click(within(stepEl(container, "board")).getByRole("button"));

    const modal = modalEl()!;
    // Same consistent icon treatment as the cards.
    const icon = modal.querySelector<HTMLElement>("[data-step-icon]")!;
    expect(icon).not.toBeNull();
    expect(icon.className).toContain("bg-primary/10");
    expect(icon.className).toContain("text-primary");

    // A why-it-matters paragraph beyond the card's one-line hint.
    const intro = modal.querySelector<HTMLElement>("[data-step-intro]")!;
    expect(intro).not.toBeNull();
    expect(intro.textContent!.length).toBeGreaterThan(40);
    expect(intro.textContent).not.toBe(
      "A board holds your cards, with To Do, In Progress, Blocked and Done columns ready from the start.",
    );

    // Two or three takeaway bullets.
    const bullets = modal.querySelectorAll("[data-step-bullet]");
    expect(bullets.length).toBeGreaterThanOrEqual(2);
    expect(bullets.length).toBeLessThanOrEqual(3);
    for (const bullet of bullets) expect(bullet.textContent).toBeTruthy();

    // A drawn (never binary) illustration, hidden from assistive tech.
    const illustration = modal.querySelector<HTMLElement>(
      "[data-step-illustration]",
    )!;
    expect(illustration).not.toBeNull();
    expect(illustration.getAttribute("aria-hidden")).toBe("true");
    expect(illustration.querySelector("img")).toBeNull();

    // The form comes last, under its own "do it now" heading.
    expect(modal.querySelector("[data-step-form-heading]")).not.toBeNull();
    const form = within(modal).getByPlaceholderText("Board name");
    expect(
      illustration.compareDocumentPosition(form) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("gives every step its own didactic intro, bullets and illustration", async () => {
    installWorkspaceHandlers();
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });

    const seenIntros = new Set<string>();
    for (const id of STEP_IDS) {
      const card = stepEl(container, id);
      // The rail pill is the step's whole open affordance.
      await user.click(within(card).getByRole("button"));
      const modal = modalEl();
      expect(modal, `step "${id}" opened no modal`).not.toBeNull();

      const intro = modal!.querySelector<HTMLElement>("[data-step-intro]");
      expect(intro, `step "${id}" has no intro`).not.toBeNull();
      expect(intro!.textContent!.length).toBeGreaterThan(40);
      // Per-step copy, not one shared blurb.
      expect(seenIntros.has(intro!.textContent!)).toBe(false);
      seenIntros.add(intro!.textContent!);

      expect(
        modal!.querySelectorAll("[data-step-bullet]").length,
        `step "${id}" has no bullets`,
      ).toBeGreaterThanOrEqual(2);
      expect(
        modal!.querySelector("[data-step-illustration]"),
        `step "${id}" has no illustration`,
      ).not.toBeNull();

      await user.keyboard("{Escape}");
      await waitFor(() => expect(modalEl()).toBeNull());
    }
    expect(seenIntros.size).toBe(STEP_IDS.length);
  });

  it("keeps only one step's modal open at a time", async () => {
    installWorkspaceHandlers();
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });
    await user.click(within(stepEl(container, "board")).getByRole("button"));
    expect(
      within(modalEl()!).getByPlaceholderText("Board name"),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(modalEl()).toBeNull());
    await user.click(
      within(stepEl(container, "channels")).getByRole("button"),
    );

    expect(document.querySelectorAll("[data-onboarding-modal]")).toHaveLength(1);
    expect(
      within(modalEl()!).getByPlaceholderText("Channel name"),
    ).toBeInTheDocument();
    expect(
      within(modalEl()!).queryByPlaceholderText("Board name"),
    ).toBeNull();
  });

  it("closes the modal on a second card click, on Escape, and on the overlay", async () => {
    installWorkspaceHandlers();
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });
    const boardStep = stepEl(container, "board");
    const trigger = within(boardStep).getByRole("button");

    await user.click(trigger);
    expect(modalEl()).not.toBeNull();
    await user.click(trigger);
    await waitFor(() => expect(modalEl()).toBeNull());

    await user.click(trigger);
    expect(modalEl()).not.toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(modalEl()).toBeNull());

    // The house Dialog dismisses on its overlay — the wizard inherits that.
    await user.click(trigger);
    const modal = modalEl()!;
    expect(modal).not.toBeNull();
    await user.click(modal.parentElement!.previousElementSibling as HTMLElement);
    await waitFor(() => expect(modalEl()).toBeNull());
  });

  // Rail refactor (owner decision): every pill opens, including done and
  // skipped ones — the pill carries no controls, so the modal is the only
  // place a step's status, explanation and skip/revisit can live.
  it("opens a done step's modal without offering to skip it", async () => {
    installWorkspaceHandlers({ channelCount: 1 });
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Channel/ });
    const channelsStep = stepEl(container, "channels");
    await waitFor(() =>
      expect(channelsStep.getAttribute("data-step-state")).toBe("done"),
    );

    await user.click(within(channelsStep).getByRole("button"));
    const modal = modalEl()!;
    expect(modal).not.toBeNull();
    expect(within(modal).getByText("Done")).toBeInTheDocument();
    // A done step offers no way back to pending.
    expect(within(modal).queryByText("Skip")).toBeNull();
    expect(within(modal).queryByText("Revisit")).toBeNull();
  });

  it("skips from inside the modal and offers revisit on the way back", async () => {
    installWorkspaceHandlers();
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Channel/ });
    const channelsStep = stepEl(container, "channels");
    // The pill itself carries no controls — only its state.
    expect(within(channelsStep).queryByText("Skip")).toBeNull();

    await user.click(within(channelsStep).getByRole("button"));
    await user.click(within(modalEl()!).getByText("Skip"));
    await waitFor(() =>
      expect(channelsStep.getAttribute("data-step-state")).toBe("skipped"),
    );

    // Reopening a skipped step offers the way back.
    await user.click(within(channelsStep).getByRole("button"));
    await user.click(within(modalEl()!).getByText("Revisit"));
    await waitFor(() =>
      expect(channelsStep.getAttribute("data-step-state")).toBe("empty"),
    );
  });
});

// Owner feedback: the dotted progress line read well on light but was barely
// visible on dark. Dark's --color-border is a DARK gray (oklch .308) against a
// dark canvas where light's is near-white (oklch .89), so the same alpha lands
// very differently. Both halves of the line carry an explicit dark variant.
describe("OnboardingChecklist rail — progress line visibility per theme", () => {
  it("gives the dotted track and its fill a dark-mode treatment", async () => {
    installWorkspaceHandlers({ boardCount: 1, boards: [boardAlpha] });
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });

    const progress = container.querySelector<HTMLElement>("[data-rail-progress]")!;
    expect(progress).not.toBeNull();
    const fill = progress.querySelector<HTMLElement>(
      "[data-rail-progress-fill]",
    )!;
    // The track is the fill's only sibling — the unfilled dotted baseline.
    const track = Array.from(progress.children).find(
      (child) => child !== fill,
    ) as HTMLElement;
    expect(track).toBeDefined();

    // The track stays dotted in both themes — visibility comes from alpha and
    // a brighter token, never from a thicker or solid line.
    expect(track.className).toContain("border-dotted");
    expect(track.className).toContain("dark:border-");
    expect(fill.className).toContain("border-dotted");
    expect(fill.className).toContain("dark:border-primary/70");

    // Light mode keeps the subtler original values.
    expect(track.className).toContain("border-border/65");
    expect(fill.className).toContain("border-primary/40");
  });
});
