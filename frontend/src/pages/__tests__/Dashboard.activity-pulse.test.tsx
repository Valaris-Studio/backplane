// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen } from "@/test/test-utils";
import i18n from "@/i18n/config";
import type { DashboardSummary } from "@/types/dashboard";
import type { Activity } from "@/types/activity";

// Spy on gsap so we can assert WHICH elements get pulsed. Single-element
// fromTo calls = the live pulse; array-target calls = the mount stagger.
const { fromToSpy } = vi.hoisted(() => ({
  // `progress` returns the tween so cleanup can chain progress(1).kill(), the
  // real GSAP contract the entrance cleanups rely on.
  fromToSpy: vi.fn((..._args: unknown[]) => {
    const tween = {
      kill: vi.fn(),
      targets: vi.fn(() => []),
      progress: vi.fn(() => tween),
    };
    return tween;
  }),
}));

vi.mock("gsap", () => ({
  gsap: {
    fromTo: fromToSpy,
    to: vi.fn(() => ({ kill: vi.fn() })),
    set: vi.fn(),
    ticker: { add: vi.fn(), remove: vi.fn() },
    utils: {
      toArray: (selector: string, scope?: Element) =>
        Array.from((scope ?? document).querySelectorAll(selector)),
    },
  },
}));

function makeActivity(
  id: string,
  summary: string,
  overrides: Partial<Activity> = {},
): Activity {
  return {
    id,
    workspace_id: "ws1",
    board_id: null,
    actor_id: "u1",
    actor_name: "Ada",
    actor_email: "ada@example.com",
    agent_id: null,
    entity_type: "card",
    entity_id: "c1",
    action: "moved",
    summary,
    changes: null,
    via_api_key: null,
    entity_title: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

let summaryData: DashboardSummary;

vi.mock("@/features/dashboard/api/use-dashboard", () => ({
  useDashboardSummary: () => ({ data: summaryData, isLoading: false }),
}));

vi.mock("@/features/agents/hooks/useAgentMetrics", () => ({
  useAgentMetrics: () => ({ data: [] }),
  useExecutions: () => ({ data: [] }),
  useInFlightExecutions: () => ({ data: [] }),
}));

import { Dashboard } from "../Dashboard";

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

function setSummary(activities: Activity[]) {
  summaryData = {
    board_count: 1,
    card_count: 2,
    note_count: 0,
    channel_count: 0,
    recent_activity: activities,
  };
}

// A FRESH element each call — reusing one JSX reference lets React bail out
// of the subtree on rerender, hiding the data change from the component.
function dashboardUi() {
  return (
    <Routes>
      <Route path="/:slug" element={<Dashboard />} />
    </Routes>
  );
}

function renderDashboard() {
  return renderWithProviders(dashboardUi(), {
    routerProps: { initialEntries: ["/acme"] },
  });
}

/** fromTo calls whose target is a single activity item element. */
function pulseCallsFor(attr: string) {
  return fromToSpy.mock.calls.filter(([target]) => {
    return (
      target instanceof HTMLElement &&
      (target.hasAttribute(attr) || target.closest(`[${attr}]`) !== null)
    );
  });
}

beforeEach(async () => {
  fromToSpy.mockClear();
  stubMatchMedia(false);
  await i18n.changeLanguage("en");
});

describe("Dashboard — recent-activity live pulse", () => {
  it("does not pulse items present on first data render (mount stagger owns the entrance)", () => {
    setSummary([makeActivity("a1", "first"), makeActivity("a2", "second")]);
    renderDashboard();

    expect(pulseCallsFor("data-activity-id")).toHaveLength(0);
    expect(pulseCallsFor("data-activity-glow")).toHaveLength(0);
  });

  it("pulses only newly arrived activity items, with plain opacity and a glow-overlay fade", () => {
    setSummary([makeActivity("a1", "first"), makeActivity("a2", "second")]);
    const { rerender, container } = renderDashboard();
    fromToSpy.mockClear();

    setSummary([
      makeActivity("a3", "brand new"),
      makeActivity("a1", "first"),
      makeActivity("a2", "second"),
    ]);
    rerender(dashboardUi());

    const itemCalls = fromToSpy.mock.calls.filter(
      ([target]) =>
        target instanceof HTMLElement && target.hasAttribute("data-activity-id"),
    );
    expect(itemCalls).toHaveLength(1);
    const [itemEl, itemFrom] = itemCalls[0]! as [
      HTMLElement,
      Record<string, unknown>,
    ];
    expect(itemEl.getAttribute("data-activity-id")).toBe("a3");
    // Entrance must use plain opacity — autoAlpha sets visibility:hidden,
    // which drops the item from the accessibility tree mid-animation.
    expect(itemFrom).toMatchObject({ opacity: 0 });
    expect(itemFrom).not.toHaveProperty("autoAlpha");

    const glowCalls = fromToSpy.mock.calls.filter(
      ([target]) =>
        target instanceof HTMLElement &&
        target.hasAttribute("data-activity-glow"),
    );
    expect(glowCalls).toHaveLength(1);
    const [glowEl, glowFrom, glowTo] = glowCalls[0]! as [
      HTMLElement,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(glowEl.closest('[data-activity-id="a3"]')).not.toBeNull();
    // The glow decays by fading a STATIC overlay — gsap must never
    // string-tween a color-mix()/var() boxShadow.
    expect(glowFrom).toMatchObject({ opacity: 1 });
    expect(glowTo).toMatchObject({ opacity: 0 });

    // The mount stagger (array-target fromTo) must NOT retrigger on refetch.
    const arrayCalls = fromToSpy.mock.calls.filter(([target]) =>
      Array.isArray(target),
    );
    expect(arrayCalls).toHaveLength(0);

    // Existing items stay untouched.
    for (const [target] of itemCalls) {
      const el = target as HTMLElement;
      expect(["a1", "a2"]).not.toContain(el.getAttribute("data-activity-id"));
    }
    expect(container.textContent).toContain("brand new");
  });

  it("renders the glow overlay statically hidden so existing items never show it", () => {
    setSummary([makeActivity("a1", "first")]);
    const { container } = renderDashboard();

    const glow = container.querySelector("[data-activity-glow]");
    expect(glow).not.toBeNull();
    expect(glow!.getAttribute("aria-hidden")).toBe("true");
    expect(glow!.className).toContain("opacity-0");
    expect(glow!.className).toContain("pointer-events-none");
  });

  it("skips both tweens under reduced motion — new items still appear", () => {
    stubMatchMedia(true);
    setSummary([makeActivity("a1", "first")]);
    const { rerender, container } = renderDashboard();
    fromToSpy.mockClear();

    setSummary([makeActivity("a2", "quiet arrival"), makeActivity("a1", "first")]);
    rerender(dashboardUi());

    expect(pulseCallsFor("data-activity-id")).toHaveLength(0);
    expect(pulseCallsFor("data-activity-glow")).toHaveLength(0);
    expect(container.textContent).toContain("quiet arrival");
  });

  it("renders known messages in the active locale and unknown keys as exact summaries", async () => {
    await i18n.changeLanguage("pt-BR");
    const unknownSummary = "  future -- summary <raw>  ";
    setSummary([
      makeActivity("known", "legacy moved summary", {
        message_key: "activity.card.moved",
        message_params: {
          card_title: "Launch",
          from_column_name: "Backlog",
          from_column_known: true,
          to_column_name: "Review",
        },
      }),
      makeActivity("unknown", unknownSummary, {
        message_key: "activity.card.future_operation",
        message_params: { card_title: "Launch" },
      }),
    ]);
    const { container } = renderDashboard();

    expect(
      screen.getByText("moveu 'Launch' de 'Backlog' para 'Review'"),
    ).toBeInTheDocument();
    expect(container.textContent).toContain(unknownSummary);
    expect(screen.queryByText("legacy moved summary")).not.toBeInTheDocument();
  });
});
