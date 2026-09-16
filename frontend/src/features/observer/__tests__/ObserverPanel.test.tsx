// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import i18n from "@/i18n/config";
import { stubReducedMotion } from "@/test/test-utils";
import type { WebSocketEvent } from "@/lib/websocket";

let lastCallback: ((evt: WebSocketEvent) => void) | null = null;
let mockIsAdmin = true;
let mockIsLoading = false;

vi.mock("@/hooks/use-websocket", () => ({
  useWebSocketEvent: (
    _pattern: string,
    cb: (evt: WebSocketEvent) => void,
  ) => {
    lastCallback = cb;
  },
  useWebSocket: () => ({ status: "connected" as const, subscribe: () => () => {} }),
}));

vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({
    isAdmin: mockIsAdmin,
    role: mockIsAdmin ? "admin" : "member",
    isLoading: mockIsLoading,
    isError: false,
  }),
}));

import { ObserverPanel } from "../components/ObserverPanel";

function makeEvent(type: string, idx = 0): WebSocketEvent {
  return {
    event: type,
    timestamp: new Date().toISOString(),
    event_id: `${type}-${idx}`,
    payload: { idx, title: `payload-${type}-${idx}` },
  };
}

function renderPanel(slug = "ws") {
  return render(
    <I18nextProvider i18n={i18n}>
      <ObserverPanel slug={slug} />
    </I18nextProvider>,
  );
}

/** The docked entry point: the TopBar icon that opens the observer sheet. */
function observerTrigger() {
  return screen.getByTestId("observer-trigger");
}

function openPanel() {
  fireEvent.click(observerTrigger());
}

// Reduced motion gives us GSAP's settled values synchronously, so assertions
// read a fully-shown (or fully-gone) sheet instead of racing its tween.
beforeEach(() => {
  stubReducedMotion(true);
  lastCallback = null;
  mockIsAdmin = true;
  mockIsLoading = false;
  localStorage.clear();
});

afterEach(() => stubReducedMotion(false));

describe("ObserverPanel (docked top-bar surface)", () => {
  it("does not render for non-admins", () => {
    mockIsAdmin = false;
    const { container } = renderPanel();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing while the admin check is still resolving", () => {
    // Anti-flicker: on reload both /api/me and useMembers fetch cold, so
    // isAdmin is briefly false. Rendering the icon then yanking it away reads
    // as a glitch — render nothing until the role is known, then decide once.
    mockIsLoading = true;
    const { container } = renderPanel();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows only the trigger icon until it is clicked — no floating surface", () => {
    renderPanel();
    expect(observerTrigger()).toBeInTheDocument();
    expect(screen.queryByTestId("observer-expanded")).toBeNull();

    openPanel();
    expect(screen.getByTestId("observer-expanded")).toBeInTheDocument();
  });

  it("closes the panel when the trigger is clicked again", async () => {
    renderPanel();
    openPanel();
    expect(screen.getByTestId("observer-expanded")).toBeInTheDocument();

    fireEvent.click(observerTrigger());
    // The sheet unmounts on the exit tween's completion, not synchronously.
    await waitFor(() => {
      expect(screen.queryByTestId("observer-expanded")).toBeNull();
    });
  });

  it("exposes aria-expanded on the trigger so the disclosure is announced", () => {
    renderPanel();
    expect(observerTrigger()).toHaveAttribute("aria-expanded", "false");
    openPanel();
    expect(observerTrigger()).toHaveAttribute("aria-expanded", "true");
  });

  it("labels the trigger from the i18n catalog, including the unread count", () => {
    renderPanel();
    expect(observerTrigger()).toHaveAccessibleName(/observer/i);

    act(() => {
      lastCallback?.(makeEvent("card.created", 1));
    });
    expect(observerTrigger()).toHaveAccessibleName(/1/);
  });

  it("badges the trigger with unreadCount and clears it once the panel opens", () => {
    renderPanel();
    act(() => {
      lastCallback?.(makeEvent("card.created", 1));
      lastCallback?.(makeEvent("agent.tick", 2));
    });
    expect(screen.getByTestId("observer-unread-badge")).toHaveTextContent("2");

    openPanel();
    expect(screen.queryByTestId("observer-unread-badge")).toBeNull();
  });

  it("never renders the old floating collapsed pill", () => {
    renderPanel();
    expect(screen.queryByTestId("observer-collapsed")).toBeNull();
    openPanel();
    expect(screen.queryByTestId("observer-collapsed")).toBeNull();
  });

  it("does not position the panel with inline left/top coordinates", () => {
    // The docked surface is laid out by the sheet, never by persisted x/y.
    // An inline `left:`/`top:` style is the signature of the deleted
    // free-floating implementation.
    renderPanel();
    openPanel();
    const style = screen.getByTestId("observer-expanded").getAttribute("style") ?? "";
    expect(style).not.toMatch(/(^|;)\s*(left|top)\s*:/);
  });

  it("purges the stale observer.position entry left by the floating panel", () => {
    localStorage.setItem("observer.position", JSON.stringify({ x: 200, y: 100 }));
    renderPanel();
    expect(localStorage.getItem("observer.position")).toBeNull();
  });

  it("filters by namespace chip selection", () => {
    renderPanel();
    act(() => {
      lastCallback?.(makeEvent("card.created", 1));
      lastCallback?.(makeEvent("agent.tick", 2));
      lastCallback?.(makeEvent("approval.requested", 3));
    });

    openPanel();

    const list = screen.getByTestId("observer-event-list");
    expect(list.querySelectorAll("li").length).toBe(3);

    fireEvent.click(screen.getByRole("button", { name: /^card$/i, pressed: false }));
    expect(list.querySelectorAll("li").length).toBe(1);
    expect(list.textContent).toContain("card.created");
  });

  it("toggles pause / resume label", () => {
    renderPanel();
    openPanel();

    // RichTooltip wraps the button in a role="button" span, so two elements
    // match /pause/i — filter to the one with an aria-label.
    const pauseBtn = screen.getByLabelText(/^pause$/i);
    expect(pauseBtn).toBeInTheDocument();
    fireEvent.click(pauseBtn);

    expect(screen.getByLabelText(/^resume$/i)).toBeInTheDocument();
  });

  it("renders the empty state when no events", () => {
    renderPanel();
    openPanel();
    expect(screen.getByText(/no events yet/i)).toBeInTheDocument();
  });

  it("clears events with the clear button", () => {
    renderPanel();
    act(() => {
      lastCallback?.(makeEvent("card.created", 1));
      lastCallback?.(makeEvent("agent.tick", 2));
    });
    openPanel();
    expect(screen.getByTestId("observer-event-list").querySelectorAll("li").length).toBe(2);

    fireEvent.click(screen.getByLabelText(/clear/i));
    expect(screen.getByText(/no events yet/i)).toBeInTheDocument();
  });

  it("dedupes incoming events by event_id (reconnect replay safety)", () => {
    // Regression: WS reconnect re-delivers a recent window of events; the
    // backend debouncer also occasionally re-emits on publish retry. Without
    // dedup, the duplicate lands in the list and React throws "two children
    // with the same key". Identical event_id → second delivery is dropped.
    renderPanel();
    const evt = makeEvent("card.moved", 7);
    act(() => {
      lastCallback?.(evt);
      lastCallback?.(evt);
      lastCallback?.(evt);
    });
    openPanel();
    expect(screen.getByTestId("observer-event-list").querySelectorAll("li").length).toBe(1);
  });

  it("renders tooltip triggers for the intro, pause, and clear controls", () => {
    renderPanel();
    openPanel();
    // RichTooltip wraps each control in a role=button span; the presence of
    // aria-describedby on every tooltip target is the contract that keeps
    // hover text discoverable for screen readers.
    const title = screen.getByRole("heading", { level: 2, name: /observer/i });
    expect(title.parentElement).toHaveAttribute("aria-describedby");

    const pause = screen.getByLabelText(/^pause$/i);
    expect(pause.parentElement).toHaveAttribute("aria-describedby");

    const clear = screen.getByLabelText(/^clear$/i);
    expect(clear.parentElement).toHaveAttribute("aria-describedby");
  });

  it("surfaces the 'firehose' intro copy in the hover tooltip over the title", async () => {
    renderPanel();
    openPanel();
    const title = screen.getByRole("heading", { level: 2, name: /observer/i });
    fireEvent.mouseEnter(title.parentElement!);
    const tooltip = await screen.findByRole("tooltip");
    // RichTooltip key ui.tooltips.chrome.observerPanel.intro summary
    expect(tooltip).toHaveTextContent(/firehose of platform events/i);
  });
});

// The retired /:slug/events "Event Inspector" page was the same WS stream at a
// bigger size. Its four unique affordances now live here (card 43fcab09):
// whole-bus capture behind an "other" chip, text search, event_id on the row,
// and a shown/total/cap counter.
describe("ObserverPanel absorbs the Event Inspector's affordances", () => {
  function rows() {
    return screen.getByTestId("observer-event-list").querySelectorAll("li");
  }

  it("buffers an event from an unknown namespace and surfaces an 'other' chip", () => {
    renderPanel();
    act(() => {
      lastCallback?.(makeEvent("card.created", 1));
      lastCallback?.(makeEvent("workspace.updated", 2));
    });
    openPanel();

    // Default view stays agentic-only: the unknown-namespace event is buffered
    // but not shown until the operator asks for it.
    expect(screen.getByTestId("observer-event-list").textContent).not.toContain(
      "workspace.updated",
    );

    const otherChip = screen.getByRole("button", { name: /^other$/i });
    fireEvent.click(otherChip);
    expect(screen.getByTestId("observer-event-list").textContent).toContain(
      "workspace.updated",
    );
  });

  it("hides the 'other' chip until non-agentic traffic has actually been seen", () => {
    // Paired with the test above: that one proves the chip appears for unknown
    // traffic, this one proves it is derived from the buffer rather than always
    // rendered. Neither is meaningful alone.
    renderPanel();
    act(() => {
      lastCallback?.(makeEvent("card.created", 1));
    });
    openPanel();
    expect(screen.queryByRole("button", { name: /^other$/i })).toBeNull();

    act(() => {
      lastCallback?.(makeEvent("workspace.updated", 2));
    });
    expect(
      screen.getByRole("button", { name: /^other$/i }),
    ).toBeInTheDocument();
  });

  it("keeps the default view agentic-only while still buffering the rest", () => {
    // Without the counter assertion this test cannot tell "the unknown event
    // was buffered and filtered out of the default view" (the new behavior)
    // from "the unknown event was discarded by the hook" (the old behavior) —
    // both render exactly one row.
    renderPanel();
    act(() => {
      lastCallback?.(makeEvent("card.created", 1));
      lastCallback?.(makeEvent("workspace.updated", 2));
    });
    openPanel();
    expect(rows().length).toBe(1);
    expect(screen.getByTestId("observer-counts").textContent).toMatch(/\b2\b/);
  });

  it("filters rows by a search term matching the event type", () => {
    renderPanel();
    act(() => {
      lastCallback?.(makeEvent("card.created", 1));
      lastCallback?.(makeEvent("agent.tick", 2));
    });
    openPanel();
    expect(rows().length).toBe(2);

    fireEvent.change(screen.getByLabelText(/search events by type or id/i), {
      target: { value: "agent." },
    });
    expect(rows().length).toBe(1);
    expect(screen.getByTestId("observer-event-list").textContent).toContain(
      "agent.tick",
    );
  });

  it("filters rows by a search term matching the event id", () => {
    renderPanel();
    act(() => {
      lastCallback?.(makeEvent("card.created", 1));
      lastCallback?.(makeEvent("card.moved", 2));
    });
    openPanel();

    fireEvent.change(screen.getByLabelText(/search events by type or id/i), {
      target: { value: "card.moved-2" },
    });
    expect(rows().length).toBe(1);
    expect(screen.getByTestId("observer-event-list").textContent).toContain(
      "card.moved",
    );
  });

  it("renders the event id on each row", () => {
    // The id is deliberately unlike the event type and the payload summary:
    // makeEvent's default `${type}-${idx}` id is a substring-collision with
    // both, which would make this assertion pass without the row ever printing
    // an id.
    renderPanel();
    act(() => {
      lastCallback?.({
        event: "card.created",
        timestamp: new Date().toISOString(),
        event_id: "zz9-plural-z-alpha",
        payload: { idx: 7 },
      });
    });
    openPanel();
    expect(screen.getByTestId("observer-event-list").textContent).toContain(
      "zz9-plural-z-alpha",
    );
  });

  it("renders the shown/total counter reflecting filtered vs buffered counts", () => {
    renderPanel();
    act(() => {
      lastCallback?.(makeEvent("card.created", 1));
      lastCallback?.(makeEvent("agent.tick", 2));
      lastCallback?.(makeEvent("workspace.updated", 3));
    });
    openPanel();

    // 3 buffered (whole bus), 2 shown (agentic default view).
    const counter = screen.getByTestId("observer-counts");
    expect(counter.textContent).toMatch(/2/);
    expect(counter.textContent).toMatch(/3/);

    fireEvent.change(screen.getByLabelText(/search events by type or id/i), {
      target: { value: "card." },
    });
    expect(screen.getByTestId("observer-counts").textContent).toMatch(/1/);
  });
});
