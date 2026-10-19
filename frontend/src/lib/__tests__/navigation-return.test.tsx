// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { Link } from "react-router-dom";
import { ReturnLink } from "@/components/shared/ContextLink";
import { EntityLink } from "@/components/shared/EntityLink";
import { act, screen, userEvent, waitFor } from "@/test/test-utils";
import { renderBrowserNavigationRouter } from "@/test/navigation-router";

const origin = "/acme/sessions/private-session?sort=source&channel=reply#content-selected-item";
const canonicalNote = "/team/boards/board-1/notes?note=note-17";
function Origin() {
  return <article id="content-selected-item" aria-label="Selected source item">
    <h1>Source investigation</h1>
    <EntityLink type="note" slug="team" boardId="board-1" id="note-17">Read handoff</EntityLink>
  </article>;
}
function mount(initialEntries = [origin]) {
  return renderBrowserNavigationRouter([
    { path: "/acme/sessions/:sessionId", element: <Origin /> },
    { path: "/team/boards/board-1/notes", element: <h1>Shared note</h1> },
  ], initialEntries[0]!);
}
afterEach(() => vi.restoreAllMocks());

describe("shared entity navigation", () => {
  it("restores the same origin entry, selection and focus on browser Back then permits Forward", async () => {
    const { router } = mount();
    const original = router.state.location;
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "Read handoff" }));
    expect(router.state.location.pathname + router.state.location.search).toBe(canonicalNote);
    await act(async () => { await router.navigate(-1); });

    await waitFor(() => expect(router.state.location).toMatchObject({ key: original.key, pathname: original.pathname, search: original.search, hash: original.hash }));
    const link = screen.getByRole("link", { name: "Read handoff" });
    expect(link.closest("article")).toHaveAttribute("id", "content-selected-item");
    expect(link).toBeVisible();
    expect(link).toHaveFocus();
    await act(async () => { await router.navigate(1); });
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe(canonicalNote));
  });

  it("keeps shared href and serialized destination state free of private source metadata", async () => {
    const { router } = mount();
    const link = screen.getByRole("link", { name: "Read handoff" });
    expect(link).toHaveAttribute("href", canonicalNote);
    await userEvent.click(link);
    expect(router.state.location.pathname + router.state.location.search + router.state.location.hash).toBe(canonicalNote);
    const state = JSON.stringify(router.state.location.state);
    expect(state).not.toMatch(/private-session|source&channel|selected-item|Source investigation/);
    expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain("private-session");
  });

  it.each(["ctrlKey", "metaKey"])("preserves the ordinary href and leaves %s clicks to the browser", (modifier) => {
    const { router } = mount();
    const original = router.state.location;
    const link = screen.getByRole("link", { name: "Read handoff" });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, [modifier]: true });
    fireEvent(link, event);
    expect(event.defaultPrevented).toBe(false);
    expect(link).toHaveAttribute("href", canonicalNote);
    expect(router.state.location).toEqual(original);
  });
});


describe("continuous return capture and safe fallback", () => {
  it("restores focus after an ordinary same-app link and browser Back without a ContextLink click", async () => {
    const { router } = renderBrowserNavigationRouter([
      { path: "/ordinary-origin", element: <main><h1>Origin</h1><Link id="ordinary-source" to="/ordinary-target">Ordinary source link</Link></main> },
      { path: "/ordinary-target", element: <h1>Target</h1> },
    ], "/ordinary-origin?sort=recent");
    await userEvent.click(screen.getByRole("link", { name: "Ordinary source link" }));
    await act(async () => { await router.navigate(-1); });
    await waitFor(() => expect(router.state.location.pathname).toBe("/ordinary-origin"));
    expect(screen.getByRole("link", { name: "Ordinary source link" })).toHaveFocus();
  });

  it("uses the canonical parent when the origin is no longer the immediately previous entry", async () => {
    const { router } = renderBrowserNavigationRouter([
      { path: "/acme/sessions/:sessionId", element: <Origin /> },
      { path: "/team/boards/board-1/notes", element: <ReturnLink to="/team/boards/board-1">Return</ReturnLink> },
    ], origin);
    await userEvent.click(screen.getByRole("link", { name: "Read handoff" }));
    const reference = router.state.location.state;
    await act(async () => { await router.navigate(canonicalNote + "&panel=details", { state: reference }); });
    expect(screen.getByRole("link", { name: "Return" })).toHaveAttribute("href", "/team/boards/board-1");
    expect(screen.getByText(/previous view.*no longer available/i)).toBeVisible();
  });
});
