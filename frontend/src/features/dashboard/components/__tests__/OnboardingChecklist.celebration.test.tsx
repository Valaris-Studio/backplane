// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  renderWithProviders,
  screen,
  waitFor,
  within,
  userEvent,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";

// Stage-B port of the FirstRunPanel celebration contract onto the
// OnboardingChecklist (this file supersedes FirstRunPanel.celebration.test.tsx
// once FirstRunPanel is deleted). Unlike the old panel, done-state arrives
// over the wire, so every false→true transition here is driven by a real msw
// round-trip: submit the channels mini-form → summary refetch → row flips.
//
// Contract carried forward verbatim:
// - celebrate only a false→true transition within the session (no ceremony
//   for steps already done at mount);
// - gsap tweens numbers only — icon pop scale 0.3→1 back.out(2.2), ring fade
//   opacity 1→0; the ring's color-mix() boxShadow stays static CSS (never
//   string-tweened) and autoAlpha is never used;
// - reduced motion: zero tweens, state still flips instantly;
// - final step: the checklist holds through the celebration before the
//   all-done swap; reduced motion and already-done mounts swap instantly.

const { fromToSpy, setSpy } = vi.hoisted(() => ({
  fromToSpy: vi.fn((..._args: unknown[]) => ({ kill: vi.fn() })),
  setSpy: vi.fn(),
}));

// The step modals are house Dialogs, which drive their enter/exit with
// gsap.timeline() — stub it as a chainable no-op that completes immediately, so
// opening a modal never touches the fromTo spies this suite asserts on.
vi.mock("gsap", () => {
  function makeTimeline({ onComplete }: { onComplete?: () => void } = {}) {
    const timeline = {
      to: () => timeline,
      set: () => timeline,
      kill: () => {},
    };
    onComplete?.();
    return timeline;
  }
  return {
    gsap: {
      fromTo: fromToSpy,
      to: vi.fn(() => ({ kill: vi.fn() })),
      set: setSpy,
      timeline: vi.fn(makeTimeline),
    },
  };
});

import { OnboardingChecklist } from "../OnboardingChecklist";

const SLUG = "acme";

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

const ownerMember = {
  user_id: "u1",
  email: "owner@acme.dev",
  name: "Owner",
  role: "owner",
  joined_at: "2026-07-31T00:00:00Z",
};

const secondMember = {
  user_id: "u2",
  email: "dana@acme.dev",
  name: "Dana",
  role: "member",
  joined_at: "2026-07-31T00:00:00Z",
};

const definitionFixture = {
  id: "def-1",
  board_id: "b1",
  scope: "board",
  content: { objectives: [{ text: "Ship the first release", priority: null }] },
  created_at: "2026-07-31T00:00:00Z",
  updated_at: "2026-07-31T00:00:00Z",
};

const repoFixture = {
  id: "repo-1",
  name: "alpha",
  url: "https://github.com/acme/alpha",
  provider: "github",
};

interface Scenario {
  hasBoard?: boolean;
  noteCount?: number;
  channelDone?: boolean;
  members?: (typeof ownerMember)[];
  hasDefinition?: boolean;
  hasRepo?: boolean;
}

// Mutable channel count: the channels mini-form POST bumps it, so the
// wizard's summary refetch observes the flip.
function installScenario(scenario: Scenario = {}) {
  const state = { channelCount: scenario.channelDone ? 1 : 0 };
  server.use(
    http.get(`/api/workspaces/${SLUG}/summary`, () =>
      HttpResponse.json({
        board_count: scenario.hasBoard ? 1 : 0,
        card_count: 0,
        note_count: scenario.noteCount ?? 0,
        channel_count: state.channelCount,
        recent_activity: [],
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/boards`, () =>
      HttpResponse.json(scenario.hasBoard ? [boardAlpha] : []),
    ),
    http.get(`/api/workspaces/${SLUG}/members`, () =>
      HttpResponse.json(scenario.members ?? [ownerMember]),
    ),
    http.get(`/api/workspaces/${SLUG}/boards/:boardId/definitions`, () =>
      scenario.hasDefinition
        ? HttpResponse.json(definitionFixture)
        : HttpResponse.json({ detail: "Not found" }, { status: 404 }),
    ),
    http.get(`/api/workspaces/${SLUG}/boards/:boardId/git-repos`, () =>
      HttpResponse.json(scenario.hasRepo ? [repoFixture] : []),
    ),
    http.get(`/api/workspaces/${SLUG}/resources`, () => HttpResponse.json([])),
    http.post(`/api/workspaces/${SLUG}/channels`, () => {
      state.channelCount += 1;
      return HttpResponse.json(
        {
          id: "ch-1",
          workspace_id: "ws-1",
          name: "general",
          channel_type: "other",
          contact_value: "",
          description: "",
          metadata_json: null,
        },
        { status: 201 },
      );
    }),
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

function iconCalls() {
  return fromToSpy.mock.calls.filter(
    ([target]) =>
      target instanceof Element && target.hasAttribute("data-step-status-icon"),
  );
}

function ringCalls() {
  return fromToSpy.mock.calls.filter(
    ([target]) =>
      target instanceof Element &&
      target.hasAttribute("data-step-celebration-ring"),
  );
}

function stepOf(target: unknown) {
  return (target as Element)
    .closest("[data-onboarding-step]")
    ?.getAttribute("data-onboarding-step");
}

beforeEach(() => {
  fromToSpy.mockClear();
  setSpy.mockClear();
  window.localStorage.clear();
  stubMatchMedia(false);
});

function renderChecklist() {
  return renderWithProviders(<OnboardingChecklist slug={SLUG} />);
}

function channelsRow(container: HTMLElement) {
  return container.querySelector<HTMLElement>(
    '[data-onboarding-step="channels"]',
  )!;
}

function modalEl() {
  return document.querySelector<HTMLElement>("[data-onboarding-modal]")!;
}

// Opens the channels step from its rail pill and submits the prefilled
// "general" mini-form from the modal — the wire-driven false→true transition
// used across this suite. The celebration ring stays on the PILL, so the tween
// assertions must survive content living in a portal.
async function completeChannelsStep(
  user: ReturnType<typeof userEvent.setup>,
  container: HTMLElement,
) {
  const card = channelsRow(container);
  await user.click(within(card).getByRole("button"));
  await user.click(
    within(modalEl()).getByRole("button", { name: "Create channel" }),
  );
  await waitFor(() =>
    expect(card.getAttribute("data-step-state")).toBe("done"),
  );
  return card;
}

describe("OnboardingChecklist — step completion celebration", () => {
  it("does not celebrate steps that are already done at mount", async () => {
    installScenario({
      hasBoard: true,
      noteCount: 1,
      channelDone: true,
      hasDefinition: true,
    });
    renderChecklist();

    await screen.findByRole("button", { name: /Board/ });
    expect(iconCalls()).toHaveLength(0);
    expect(ringCalls()).toHaveLength(0);
  });

  it("pops the icon and fades the static ring exactly once when a step flips done over the wire", async () => {
    installScenario({ hasBoard: true });
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Channel/ });
    fromToSpy.mockClear();

    await completeChannelsStep(user, container);

    await waitFor(() => expect(iconCalls()).toHaveLength(1));
    const [iconEl, iconFrom, iconTo] = iconCalls()[0]! as [
      Element,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(stepOf(iconEl)).toBe("channels");
    expect(iconFrom).toMatchObject({ scale: 0.3 });
    expect(iconTo).toMatchObject({ scale: 1, ease: "back.out(2.2)" });

    expect(ringCalls()).toHaveLength(1);
    const [ringEl, ringFrom, ringTo] = ringCalls()[0]! as [
      Element,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(stepOf(ringEl)).toBe("channels");
    expect(ringFrom).toMatchObject({ opacity: 1 });
    expect(ringTo).toMatchObject({ opacity: 0 });

    // The ring's color-mix() boxShadow is static CSS — gsap must only ever
    // tween numbers, and never autoAlpha (drops content from the a11y tree).
    for (const [, from, to] of fromToSpy.mock.calls) {
      expect(from).not.toHaveProperty("boxShadow");
      expect(to).not.toHaveProperty("boxShadow");
      expect(from).not.toHaveProperty("autoAlpha");
      expect(to).not.toHaveProperty("autoAlpha");
    }
  });

  it("renders each ring overlay statically hidden and out of the a11y tree", async () => {
    installScenario();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });
    const rings = container.querySelectorAll("[data-step-celebration-ring]");
    expect(rings.length).toBeGreaterThanOrEqual(6);
    for (const ring of rings) {
      expect(ring.getAttribute("aria-hidden")).toBe("true");
      expect(ring.className).toContain("opacity-0");
      expect(ring.className).toContain("pointer-events-none");
    }
  });

  it("does not re-fire on re-renders where done stays true", async () => {
    installScenario({ hasBoard: true });
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Channel/ });
    await completeChannelsStep(user, container);
    await waitFor(() => expect(iconCalls()).toHaveLength(1));
    fromToSpy.mockClear();

    // Force re-renders without a done transition: toggle another row open
    // and closed again.
    const notesRow = container.querySelector<HTMLElement>(
      '[data-onboarding-step="notes"]',
    )!;
    await user.click(
      within(notesRow).getByRole("button"),
    );
    await user.click(
      within(notesRow).getByRole("button"),
    );

    expect(iconCalls()).toHaveLength(0);
    expect(ringCalls()).toHaveLength(0);
  });

  it("skips tweens under reduced motion — the step still flips to done instantly", async () => {
    stubMatchMedia(true);
    installScenario({ hasBoard: true });
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Channel/ });
    fromToSpy.mockClear();

    const row = await completeChannelsStep(user, container);

    expect(row.getAttribute("data-step-state")).toBe("done");
    expect(iconCalls()).toHaveLength(0);
    expect(ringCalls()).toHaveLength(0);
  });

  it("holds the checklist visible for the final step's celebration before the all-done swap", async () => {
    // Everything except channels done at mount; completing channels is the
    // final flip.
    installScenario({
      hasBoard: true,
      noteCount: 1,
      members: [ownerMember, secondMember],
      hasDefinition: true,
      hasRepo: true,
    });
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Channel/ });
    fromToSpy.mockClear();

    await completeChannelsStep(user, container);

    // The final celebration must run while the steps are still mounted —
    // the all-done view may only replace them after the hold.
    expect(screen.queryByText("Your workspace is ready")).toBeNull();
    expect(screen.getByRole("button", { name: /Channel/ })).toBeInTheDocument();
    await waitFor(() => expect(iconCalls()).toHaveLength(1));

    expect(
      await screen.findByText("Your workspace is ready", undefined, {
        timeout: 3000,
      }),
    ).toBeInTheDocument();
  });

  it("swaps to the all-done view immediately under reduced motion", async () => {
    stubMatchMedia(true);
    installScenario({
      hasBoard: true,
      noteCount: 1,
      members: [ownerMember, secondMember],
      hasDefinition: true,
      hasRepo: true,
    });
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Channel/ });
    const card = channelsRow(container);
    await user.click(within(card).getByRole("button"));
    await user.click(
      within(modalEl()).getByRole("button", { name: "Create channel" }),
    );

    // Default waitFor timeout (1s) is shorter than the 1.1s hold — reaching
    // the all-done view this fast proves there was no hold.
    expect(
      await screen.findByText("Your workspace is ready"),
    ).toBeInTheDocument();
    expect(iconCalls()).toHaveLength(0);
    expect(ringCalls()).toHaveLength(0);
  });

  it("renders the all-done view without ceremony when everything was done at mount", async () => {
    installScenario({
      hasBoard: true,
      noteCount: 1,
      channelDone: true,
      members: [ownerMember, secondMember],
      hasDefinition: true,
      hasRepo: true,
    });
    renderChecklist();

    expect(
      await screen.findByText("Your workspace is ready"),
    ).toBeInTheDocument();
    expect(iconCalls()).toHaveLength(0);
    expect(ringCalls()).toHaveLength(0);
  });
});
