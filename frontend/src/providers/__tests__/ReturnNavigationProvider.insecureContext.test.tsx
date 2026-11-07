// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { useState } from "react";
import { render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Link, Outlet, RouterProvider, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, type TestContext } from "vitest";
import { ContextLink, ReturnLink } from "@/components/shared/ContextLink";
import { RouteErrorBoundary } from "@/components/shared/PageErrorBoundary";
import { ThemeProvider } from "@/hooks/use-theme";
import { NavigationGuardProvider } from "@/providers/NavigationGuardProvider";
import { ReturnNavigationProvider, useReturnNavigation } from "@/providers/ReturnNavigationProvider";
import { HandoffDraftProvider } from "@/features/sessions/hooks/use-handoff-drafts";
import { act, createTestQueryClient, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";

const origin = "/private-origin?query=synthetic-confidential-query#selected-private-evidence";
const destination = "/shared-destination";
const inputPaths = [
  "src/providers/__tests__/ReturnNavigationProvider.insecureContext.test.tsx",
  "src/providers/ReturnNavigationProvider.tsx", "src/components/shared/ContextLink.tsx",
  "src/components/shared/PageErrorBoundary.tsx",
];
const hashes = () => Object.fromEntries(inputPaths.map((path) => [path,
  createHash("sha256").update(readFileSync(path)).digest("hex")]));
const originalUUID = Object.getOwnPropertyDescriptor(crypto, "randomUUID");

function removeSecureContextUUID() {
  // Match the missing API surface, retaining the real getRandomValues. This is
  // not a browser-origin simulation; non-loopback HTTP needs its own browser gate.
  Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
  expect(typeof crypto.getRandomValues).toBe("function");
  expect(crypto.randomUUID).toBeUndefined();
}

type Ledger = { operations: { name: string; error: string | null }[]; references: unknown[] };

function Origin({ ledger }: { ledger: Ledger }) {
  const navigation = useReturnNavigation();
  const location = useLocation();
  const [result, setResult] = useState("No revocation requested");
  function revoke() {
    try {
      // Both public operations are supported: discard this reading entry, then
      // tombstone the known-denied pathname even when no current entry remains.
      navigation!.forget();
      navigation!.forget(location.pathname);
      ledger.operations.push({ name: "forget then revoke", error: null });
      setResult("Reading entry revoked");
    } catch (error) {
      ledger.operations.push({ name: "forget then revoke", error: String(error) });
      setResult("Reading entry revocation failed");
    }
  }
  return <main><h1>Private origin</h1>
    <ContextLink id="private-origin-link" to={destination}>Open shared destination</ContextLink>
    <button onClick={revoke}>Revoke current reading entry</button>
    <output aria-label="Revocation result">{result}</output>
  </main>;
}

function Destination() {
  const location = useLocation();
  const step = Number(new URLSearchParams(location.search).get("step") ?? "0");
  return <main><h1>Shared destination {step}</h1>
    <ReturnLink to="/safe-parent" returnLabel="Return to private origin">Safe parent</ReturnLink>
    <Link to={`${destination}?step=${step + 1}`} state={location.state}>Visit another actual entry</Link>
  </main>;
}

function Layout({ ledger }: { ledger: Ledger }) {
  const [owner, setOwner] = useState("owner-a");
  return <>
    <button onClick={() => setOwner((value) => value === "owner-a" ? "owner-b" : "owner-a")}>Change authorized owner</button>
    <RouteErrorBoundary><NavigationGuardProvider><ReturnNavigationProvider ownerId={owner}>
      <HandoffDraftProvider ownerId={owner}><Outlet /></HandoffDraftProvider>
    </ReturnNavigationProvider></NavigationGuardProvider></RouteErrorBoundary>
    <output aria-label="Current owner">{owner}</output>
    <output aria-label="Recorded provider operations">{ledger.operations.length}</output>
  </>;
}

function mount(context: TestContext) {
  const before = hashes();
  const ledger: Ledger = { operations: [], references: [] };
  window.history.replaceState({ idx: 0, key: "raw-router-origin", usr: null }, "", origin);
  const router = createBrowserRouter([{ element: <Layout ledger={ledger} />, children: [
    { path: "/private-origin", element: <Origin ledger={ledger} /> },
    { path: destination, element: <Destination /> },
    { path: "/safe-parent", element: <h1>Safe parent destination</h1> },
  ] }]);
  const client = createTestQueryClient();
  const rendered = render(<QueryClientProvider client={client}><ThemeProvider><RouterProvider router={router} /></ThemeProvider></QueryClientProvider>);
  const ui = within(rendered.container);
  const unsubscribe = router.subscribe((state) => {
    if (state.location.state?.bpReturn) ledger.references.push(state.location.state.bpReturn);
  });
  context.onTestFinished(async () => {
    const after = hashes();
    console.info("A03_INSECURE_RETURN", JSON.stringify({ test: context.task.name, before, after, ...ledger,
      route: router.state.location, text: rendered.container.textContent,
      boundary: "Real browser router/provider; missing API surface only, not a real insecure-origin browser" }));
    rendered.unmount(); unsubscribe(); router.dispose(); await client.cancelQueries(); client.clear();
    expect(after).toEqual(before);
  });
  return { ...rendered, router, ui, ledger };
}

beforeEach(() => { window.localStorage.clear(); stubReducedMotion(true); });
afterEach(() => {
  if (originalUUID) Object.defineProperty(crypto, "randomUUID", originalUUID);
  else Reflect.deleteProperty(crypto, "randomUUID");
  window.localStorage.clear(); stubReducedMotion(false);
});

it("captures opaque private returns without randomUUID and still expires evicted and other-owner references", async (context) => {
  removeSecureContextUUID();
  const fixture = mount(context), user = userEvent.setup();
  // The current candidate reaches its app-wide snapshot effect before this
  // control; the real recovery boundary makes the crash an observable failure.
  expect(fixture.ui.queryByRole("alert")).not.toBeInTheDocument();
  const source = fixture.ui.getByRole("link", { name: "Open shared destination" });
  await user.click(source); context.signal.throwIfAborted();
  const reference = fixture.router.state.location.state?.bpReturn;
  expect(reference).toEqual({ v: 1, originKey: expect.stringMatching(/[\s\S]/), originIdx: 0 });
  expect(reference.originKey).not.toBe("raw-router-origin");
  expect(JSON.stringify(reference)).not.toMatch(/private-origin|confidential|selected-private-evidence/);
  expect(window.location.pathname + window.location.search + window.location.hash).toBe(destination);
  expect(fixture.ui.getByRole("link", { name: "Return to private origin" })).toHaveAttribute("href", origin);
  await user.click(fixture.ui.getByRole("link", { name: "Return to private origin" }));
  await waitFor(() => expect(window.location.pathname + window.location.search + window.location.hash).toBe(origin));
  expect(await fixture.ui.findByRole("link", { name: "Open shared destination" })).toHaveFocus();
  await user.click(fixture.ui.getByRole("link", { name: "Open shared destination" }));
  for (let step = 1; step <= 21; step += 1) {
    await user.click(fixture.ui.getByRole("link", { name: "Visit another actual entry" }));
    context.signal.throwIfAborted();
    await fixture.ui.findByRole("heading", { name: `Shared destination ${step}` });
  }
  // ReturnLink also rejects non-adjacent history independently of eviction.
  // Revisit the genuine adjacent destination to distinguish those two rules.
  await act(async () => { window.history.go(-21); });
  await waitFor(() => expect(window.history.state?.idx).toBe(1));
  await fixture.ui.findByRole("heading", { name: "Shared destination 0" });
  expect(fixture.ui.queryByRole("link", { name: "Return to private origin" })).not.toBeInTheDocument();
  expect(fixture.ui.getByRole("link", { name: "Safe parent" })).toHaveAttribute("href", "/safe-parent");
  // A new authorized origin can issue a different reference, while switching
  // principals invalidates that otherwise-current reference immediately.
  await act(async () => { await fixture.router.navigate(origin); });
  await user.click(fixture.ui.getByRole("link", { name: "Open shared destination" }));
  expect(fixture.router.state.location.state?.bpReturn.originKey).not.toBe(reference.originKey);
  expect(fixture.ui.getByRole("link", { name: "Return to private origin" })).toHaveAttribute("href", origin);
  await user.click(fixture.ui.getByRole("button", { name: "Change authorized owner" }));
  expect(fixture.ui.queryByRole("link", { name: "Return to private origin" })).not.toBeInTheDocument();
  expect(fixture.ui.getByRole("link", { name: "Safe parent" })).toHaveAttribute("href", "/safe-parent");
});

it("can tombstone a discarded current entry without randomUUID, then issue a distinct authorized return", async (context) => {
  const fixture = mount(context), user = userEvent.setup();
  await user.click(fixture.ui.getByRole("link", { name: "Open shared destination" }));
  const original = fixture.router.state.location.state?.bpReturn;
  expect(fixture.ui.getByRole("link", { name: "Return to private origin" })).toHaveAttribute("href", origin);
  await user.click(fixture.ui.getByRole("link", { name: "Return to private origin" }));
  await waitFor(() => expect(fixture.router.state.location.pathname).toBe("/private-origin"));
  const revoke = await fixture.ui.findByRole("button", { name: "Revoke current reading entry" });
  removeSecureContextUUID();
  await user.click(revoke);
  expect(fixture.ui.getByLabelText("Revocation result")).toHaveTextContent("Reading entry revoked");
  expect(fixture.ledger.operations).toEqual([{ name: "forget then revoke", error: null }]);
  await act(async () => { window.history.forward(); });
  await waitFor(() => expect(fixture.router.state.location.pathname).toBe(destination));
  await fixture.ui.findByRole("heading", { name: "Shared destination 0" });
  expect(fixture.router.state.location.state?.bpReturn).toEqual(original);
  expect(fixture.ui.queryByRole("link", { name: "Return to private origin" })).not.toBeInTheDocument();
  expect(fixture.ui.getByRole("link", { name: "Safe parent" })).toHaveAttribute("href", "/safe-parent");
  await user.click(fixture.ui.getByRole("button", { name: "Change authorized owner" }));
  await act(async () => { await fixture.router.navigate(origin); });
  await user.click(fixture.ui.getByRole("link", { name: "Open shared destination" }));
  const fresh = fixture.router.state.location.state?.bpReturn;
  expect(fresh).toMatchObject({ v: 1, originKey: expect.stringMatching(/[\s\S]/) });
  expect(fresh.originKey).not.toBe(original.originKey);
  expect(JSON.stringify(fresh)).not.toMatch(/confidential|private-origin/);
  expect(fixture.ui.getByRole("link", { name: "Return to private origin" })).toHaveAttribute("href", origin);
});
