// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { useEffect, useState } from "react";
import { fireEvent } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { expect, it } from "vitest";
import { act, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { renderBrowserNavigationRouter } from "@/test/navigation-router";
import { ContextLink, ReturnLink } from "@/components/shared/ContextLink";
import { useReturnNavigation } from "@/providers/ReturnNavigationProvider";
import { useOwnerSessionFilters } from "@/features/sessions/hooks/use-owner-session-filters";

const sourcePaths = [
  "src/lib/__tests__/navigation-return.replaceRetention.test.tsx",
  "src/providers/ReturnNavigationProvider.tsx", "src/components/shared/ContextLink.tsx",
  "src/features/sessions/hooks/use-owner-session-filters.ts", "src/test/navigation-router.tsx",
];
const hashes = () => Object.fromEntries(sourcePaths.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
const HOME_QUERY = "owner-only workspace choice";
const SELECTED = "home-session-selected";

function HomeFixture() {
  const navigation = useReturnNavigation();
  const [query, setQuery] = useState(() => navigation?.readView<string>("home-workspace-query") ?? "");
  const [selected, setSelected] = useState(() => navigation?.readView<string>("home-selected-session") ?? "none");
  useEffect(() => { navigation?.writeView("home-workspace-query", query); }, [navigation, query]);
  useEffect(() => { navigation?.writeView("home-selected-session", selected); }, [navigation, selected]);
  return <main>
    <h1>Home origin fixture</h1>
    <label>Home workspace filter<input value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    <button type="button" onClick={() => setSelected(SELECTED)}>Select the source session</button>
    <output aria-label="Selected Home session">{selected}</output>
    <article id="home-reading-anchor" data-return-anchor>
      <ContextLink id="home-open-discovery" to="/-/sessions?state=ended&sort=started">Open owner discovery</ContextLink>
    </article>
  </main>;
}

function OwnerFiltersFixture() {
  const { query, update, clear } = useOwnerSessionFilters();
  const location = useLocation();
  return <main>
    <h1>Owner discovery filter fixture</h1>
    <label>Owner metadata search<input value={query.q ?? ""} onChange={(event) => update({ q: event.target.value })} /></label>
    <button type="button" onClick={clear}>Clear owner filters</button>
    <output aria-label="Owner filter state">{JSON.stringify(query)}</output>
    <output aria-label="Actual router location">{location.key}:{location.search}</output>
    <ReturnLink to="/fallback" returnLabel="Return to Home">Home fallback</ReturnLink>
  </main>;
}

it("keeps the Home origin, selection and focus through more than twenty real owner-filter REPLACEs in one browser-history entry", async (context) => {
  const before = hashes();
  const unexpected: string[] = [];
  const transitions: { action: string; key: string; pathname: string; search: string; index: unknown; length: number }[] = [];
  const checkpoints: unknown[] = [];
  server.use(http.all("*", ({ request }) => {
    unexpected.push(`${request.method} ${new URL(request.url).pathname}`);
    return HttpResponse.json({ detail: "The real filter/navigation seam has no HTTP dependency" }, { status: 500 });
  }));
  const fixture = renderBrowserNavigationRouter([
    { path: "/", element: <HomeFixture /> },
    { path: "/-/sessions", element: <OwnerFiltersFixture /> },
    { path: "/fallback", element: <h1>Canonical fallback fixture</h1> },
  ], "/?workspace-sort=name");
  const ui = within(fixture.container);
  const unsubscribe = fixture.router.subscribe((state) => transitions.push({ action: state.historyAction,
    key: state.location.key, pathname: state.location.pathname, search: state.location.search,
    index: window.history.state?.idx, length: window.history.length }));
  const capture = (name: string) => checkpoints.push({ name, location: fixture.router.state.location,
    index: window.history.state?.idx, length: window.history.length, text: fixture.container.textContent,
    focusId: document.activeElement?.id });
  context.onTestFinished(async () => {
    const after = hashes(); capture("final");
    console.info("A03_REPLACE_RETURN_RETENTION", JSON.stringify({ before, after, transitions, checkpoints, unexpected,
      boundary: "Real browser-history router/provider and actual owner-filter hook with visible fixture components; not full App/browser layout acceptance" }));
    unsubscribe(); fixture.unmount(); fixture.router.dispose(); await fixture.client.cancelQueries(); fixture.client.clear();
    expect(after).toEqual(before); expect(unexpected).toEqual([]);
  });
  const user = userEvent.setup();
  await user.type(ui.getByRole("textbox", { name: "Home workspace filter" }), HOME_QUERY); context.signal.throwIfAborted();
  await user.click(ui.getByRole("button", { name: "Select the source session" })); context.signal.throwIfAborted();
  expect(ui.getByRole("status", { name: "Selected Home session" })).toHaveTextContent(SELECTED);
  const origin = { ...fixture.router.state.location };
  const source = ui.getByRole("link", { name: "Open owner discovery" });
  act(() => source.focus()); expect(source).toHaveFocus(); capture("home-before-departure");
  await user.click(source); context.signal.throwIfAborted();
  await ui.findByRole("heading", { name: "Owner discovery filter fixture" }); context.signal.throwIfAborted();
  const originalReturn = fixture.router.state.location.state?.bpReturn;
  expect(originalReturn).toEqual({ v: 1, originKey: expect.stringMatching(/[\s\S]/), originIdx: 0 });
  expect(ui.getByRole("link", { name: "Return to Home" })).toHaveAttribute("href", origin.pathname + origin.search);
  expect(window.history.state.idx).toBe(1);
  const destinationHistoryLength = window.history.length;
  const search = ui.getByRole("textbox", { name: "Owner metadata search" });

  // Each independent edit settles in the actual URL before the next one.
  // This exercises committed REPLACE entries, not batched local typing state.
  for (let index = 0; index < 24; index += 1) {
    const value = `distinct-filter-${index}`;
    fireEvent.change(search, { target: { value } });
    await waitFor(() => {
      expect(new URLSearchParams(fixture.router.state.location.search).get("q")).toBe(value);
      expect(search).toHaveValue(value);
    });
    context.signal.throwIfAborted();
    expect(window.history.state.idx).toBe(1); expect(window.history.length).toBe(destinationHistoryLength);
    expect(fixture.router.state.location.state?.bpReturn).toEqual(originalReturn);
  }
  await user.click(ui.getByRole("button", { name: "Clear owner filters" })); context.signal.throwIfAborted();
  await waitFor(() => {
    expect(fixture.router.state.location.search).toBe("");
    expect(ui.getByRole("status", { name: "Owner filter state" })).toHaveTextContent('{"root_only":true,"sort":"recent"}');
  }); context.signal.throwIfAborted();
  const replacedKeys = new Set(transitions.filter((transition) => transition.action === "REPLACE" && transition.pathname === "/-/sessions").map((transition) => transition.key));
  expect(replacedKeys.size).toBeGreaterThan(20);
  expect(window.history.state.idx).toBe(1); expect(window.history.length).toBe(destinationHistoryLength);
  expect(JSON.stringify(fixture.router.state.location.state)).not.toContain(HOME_QUERY);
  // The same visible link exists even when its origin was evicted. Avoid a
  // missing-selector failure; preserve the actual unavailable/fallback state.
  const returnLink = ui.getByRole("link", { name: /^(Return to Home|Home fallback)$/ });
  expect.soft(returnLink).toHaveAccessibleName("Return to Home");
  expect.soft(ui.queryByText("The previous view is no longer available. Use the parent page to continue.", { exact: true })).not.toBeInTheDocument();
  capture("after-twenty-four-replaces-and-clear");

  // Native Back reaches the original entry even if the provider lost its
  // snapshot. The decisive failures then concern lost view state and focus.
  await act(async () => { window.history.back(); });
  await waitFor(() => expect(fixture.router.state.location).toMatchObject({ key: origin.key, pathname: origin.pathname, search: origin.search }));
  await ui.findByRole("heading", { name: "Home origin fixture" });
  context.signal.throwIfAborted();
  const restored = ui.getByRole("link", { name: "Open owner discovery" });
  expect.soft(ui.getByRole("textbox", { name: "Home workspace filter" })).toHaveValue(HOME_QUERY);
  expect.soft(ui.getByRole("status", { name: "Selected Home session" })).toHaveTextContent(SELECTED);
  expect.soft(restored).toHaveFocus();
  expect(restored.closest("[data-return-anchor]")).toHaveAttribute("id", "home-reading-anchor");
  expect(window.history.state.idx).toBe(0); capture("native-back-restoration-oracle");
});
