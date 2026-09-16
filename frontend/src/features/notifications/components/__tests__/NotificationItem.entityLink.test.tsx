// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { useLocation } from "react-router-dom";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { NotificationItem } from "../NotificationItem";
import type { NotificationRead } from "../../api/notifications-api";

/**
 * Contract-boundary regression for card fb7c6ac2 — "every notification carries a
 * link to its affected entity".
 *
 * `linkToRoute` was always correct and unit-tested; the dead end came from the
 * BACKEND emitting partial links ({kind, card_id} with no board_id/workspace_slug),
 * which `linkToRoute` correctly refuses to resolve. Both sides' unit tests passed
 * while the seam between them was broken, so these tests assert on the link shape
 * the backend NOW produces (see backend test_link_resolvability.py) reaching a
 * real navigation — not on the resolver in isolation.
 */

const BOARD_ID = "11111111-1111-1111-1111-111111111111";
const CARD_ID = "22222222-2222-2222-2222-222222222222";

function makeNotification(
  link: NotificationRead["link"],
  overrides: Partial<NotificationRead> = {},
): NotificationRead {
  return {
    id: "n1",
    recipient_user_id: "u1",
    workspace_id: "w1",
    board_id: BOARD_ID,
    category: "card_participant_changed",
    actor_id: "u2",
    is_agent_actor: false,
    entity_type: "card",
    entity_id: CARD_ID,
    params: { actor_name: "Jordan", card: "Ship the thing" },
    link,
    read_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">{`${location.pathname}${location.search}`}</div>
  );
}

function renderItem(notification: NotificationRead, slug?: string) {
  const onNavigate = vi.fn();
  const onMarkRead = vi.fn();
  // renderWithProviders already supplies the MemoryRouter — nesting a second
  // one throws "You cannot render a <Router> inside another <Router>".
  renderWithProviders(
    <>
      <NotificationItem
        notification={notification}
        slug={slug}
        onMarkRead={onMarkRead}
        onNavigate={onNavigate}
      />
      <LocationProbe />
    </>,
    { routerProps: { initialEntries: ["/inbox"] } },
  );
  return { onNavigate, onMarkRead };
}

describe("NotificationItem entity links", () => {
  it("navigates to the affected card for a backend-enriched card link", async () => {
    // Exactly the shape generate_for_event._resolvable_link now stores.
    const { onNavigate } = renderItem(
      makeNotification({
        kind: "card",
        workspace_slug: "acme",
        board_id: BOARD_ID,
        card_id: CARD_ID,
      }),
    );

    await userEvent.click(screen.getByRole("button", { name: /Jordan|Ship/ }));

    expect(screen.getByTestId("location")).toHaveTextContent(
      `/acme/boards/${BOARD_ID}?card=${CARD_ID}`,
    );
    expect(onNavigate).toHaveBeenCalled();
  });

  it("shows the open CTA once the link is resolvable", () => {
    renderItem(
      makeNotification({
        kind: "card",
        workspace_slug: "acme",
        board_id: BOARD_ID,
        card_id: CARD_ID,
      }),
    );
    expect(screen.getByText("Open")).toBeInTheDocument();
  });

  it("hides the CTA and does not navigate for the OLD partial link shape", async () => {
    // The pre-fix producer payload: no board_id, no workspace_slug. Pinned as a
    // regression so a producer that stops enriching is caught here, not in prod.
    // A workspace-scoped inbox slug is supplied deliberately — it is the MISSING
    // board_id alone that makes the old shape unresolvable.
    const { onNavigate } = renderItem(
      makeNotification({ kind: "card", card_id: CARD_ID }),
      "acme",
    );

    expect(screen.queryByText("Open")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Jordan|Ship/ }));
    expect(screen.getByTestId("location")).toHaveTextContent("/inbox");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("routes a rollup row to its OWN workspace, not the inbox scope", async () => {
    // The link's own slug must WIN over the inbox scope, not merely fill in for
    // it. Passing a DIFFERENT fallback ("acme") is what discriminates: with
    // slug=undefined both precedence orders agree and the test proves nothing.
    renderItem(
      makeNotification({
        kind: "card",
        workspace_slug: "other",
        board_id: BOARD_ID,
        card_id: CARD_ID,
      }),
      "acme",
    );

    await userEvent.click(screen.getByRole("button", { name: /Jordan|Ship/ }));
    expect(screen.getByTestId("location")).toHaveTextContent(
      `/other/boards/${BOARD_ID}?card=${CARD_ID}`,
    );
  });

  it("falls back to the inbox scope when the link carries no slug", async () => {
    // The other half of the precedence rule — a slug-less link is still
    // resolvable inside a workspace-scoped inbox.
    renderItem(
      makeNotification({ kind: "card", board_id: BOARD_ID, card_id: CARD_ID }),
      "acme",
    );

    await userEvent.click(screen.getByRole("button", { name: /Jordan|Ship/ }));
    expect(screen.getByTestId("location")).toHaveTextContent(
      `/acme/boards/${BOARD_ID}?card=${CARD_ID}`,
    );
  });

  it("navigates a linkless-producer event to its workspace", async () => {
    // workspace_member has no per-entity destination; the workspace beats a dead
    // end. The backend now stores {kind:"workspace", workspace_slug} rather than null.
    renderItem(
      makeNotification(
        { kind: "workspace", workspace_slug: "acme" },
        { category: "workspace_member", entity_type: "member" },
      ),
    );

    await userEvent.click(screen.getByRole("button", { name: /Jordan|added/i }));
    expect(screen.getByTestId("location")).toHaveTextContent("/acme");
  });

  it("still navigates when the target card was since deleted", async () => {
    // AC4 / BP-005: the link stays valid — BoardView strips an unresolvable
    // ?card= and leaves the user on the board (see BoardView.cardDeepLink.test).
    // The notification's job is to land them there, never to 500 or dead-end.
    const { onNavigate } = renderItem(
      makeNotification({
        kind: "card",
        workspace_slug: "acme",
        board_id: BOARD_ID,
        card_id: "deleted-card-id",
      }),
    );

    await userEvent.click(screen.getByRole("button", { name: /Jordan|Ship/ }));

    expect(screen.getByTestId("location")).toHaveTextContent(
      `/acme/boards/${BOARD_ID}?card=deleted-card-id`,
    );
    expect(onNavigate).toHaveBeenCalled();
  });
});
