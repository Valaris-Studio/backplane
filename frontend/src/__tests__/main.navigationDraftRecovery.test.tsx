// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Root } from "react-dom/client";
import type { QueryClient } from "@tanstack/react-query";
import { Link, useLocation, type createBrowserRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { act, screen, userEvent, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { useCurrentUser } from "@/features/notifications/api/use-current-user";
import { useHandoffDraft, type HandoffForm } from "@/features/sessions/hooks/use-handoff-drafts";
import type { ExcerptNoteDraft } from "@/features/sessions/utils/excerpt-note";
import { makeContent, makeSession } from "@/features/sessions/__tests__/fixtures";
import i18n from "@/i18n/config";

const owned = vi.hoisted(() => ({
  roots: [] as Root[], clients: [] as QueryClient[],
  routers: [] as ReturnType<typeof createBrowserRouter>[],
}));
vi.mock("react-dom/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-dom/client")>();
  return { ...original, createRoot: (...args: Parameters<typeof original.createRoot>) => {
    const root = original.createRoot(...args); owned.roots.push(root); return root;
  } };
});
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...original, QueryClient: class extends original.QueryClient {
    constructor(...args: ConstructorParameters<typeof original.QueryClient>) {
      super(...args); owned.clients.push(this);
    }
  } };
});
vi.mock("react-router-dom", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-router-dom")>();
  return { ...original, createBrowserRouter: (...args: Parameters<typeof original.createBrowserRouter>) => {
    const router = original.createBrowserRouter(...args); owned.routers.push(router); return router;
  } };
});
// Only the page is replaced. Main's real router, boundaries, identity cache,
// handoff store, navigation guards and other providers retain their placement.
vi.mock("@/App", () => ({ App: RecoveryRouteProbe }));

const origin = "/documentation";
const retryId = "40000000-0000-4000-8000-000000000001";
const draft: ExcerptNoteDraft = {
  fingerprint: "retained-recovery-source",
  session: makeSession({ id: "source-session" }),
  bodies: [{ item: makeContent({ id: "source-content", preview: null }), text: "Private source body" }],
  document: "Private reviewed handoff document",
};
const form: HandoffForm = {
  open: false, slug: "acme", boardId: "board", cardId: "", title: "Private reviewed title",
  content: draft.document, reviewedDestination: {
    workspace: { id: "workspace", slug: "acme", name: "Shared workspace" },
    board: { id: "board", name: "Shared board" },
  },
  request: { slug: "acme", boardId: "board", payload: {
    title: "Private reviewed title", content: draft.document, client_request_id: retryId,
    excerpt_source: { workspace_id: "workspace", session_id: "source-session", items: [{ content_id: "source-content", sha256: "a".repeat(64) }] },
  } },
  hadUnknownOutcome: true, hasSentRequest: true, pending: false, error: null,
};

function RecoveryRouteProbe() {
  const location = useLocation();
  const me = useCurrentUser();
  const handoff = useHandoffDraft("acme", "source-session");
  if (location.pathname === "/") {
    throw new TypeError("Failed to fetch dynamically imported module: https://example.test/assets/Home-stale.js?token=synthetic-private-token");
  }
  if (location.pathname !== origin) return <main><h1>Healthy other route</h1></main>;
  return <main>
    <h1>Retained handoff recovery source</h1>
    <output aria-label="Current owner">{me.data?.id ?? "Unknown owner"}</output>
    <output aria-label="Retained document">{handoff.state.draft?.document ?? "No draft"}</output>
    <output aria-label="Retained request">{JSON.stringify(handoff.state.form?.request ?? null)}</output>
    <output aria-label="Retained unknown outcome">{String(handoff.state.form?.hadUnknownOutcome ?? false)}</output>
    <button onClick={() => {
      handoff.setDraft(draft);
      handoff.setForm(draft, form);
    }}>Retain an already attempted handoff</button>
    <Link to="/documentation/help">Open healthy other route</Link>
    <Link to="/">Open root page with stale chunk</Link>
  </main>;
}

function unloadWarns() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

afterEach(async () => {
  await act(async () => { owned.roots.splice(0).forEach((root) => root.unmount()); });
  owned.routers.splice(0).forEach((router) => router.dispose());
  owned.clients.splice(0).forEach((client) => client.clear());
  document.getElementById("root")?.remove();
  vi.restoreAllMocks();
});

it("retains the exact unknown-outcome handoff through root-page fallback and an actual browser-router POP", async () => {
  const writes: string[] = [];
  server.use(http.all("/api/*", ({ request }) => {
    if (request.method === "GET" && new URL(request.url).pathname === "/api/me") {
      return HttpResponse.json({ id: "recovery-owner", name: "Owner", email: "owner@example.test", avatar_url: null });
    }
    writes.push(`${request.method} ${new URL(request.url).pathname}`);
    return HttpResponse.json({ detail: "No publication or additional request is expected" }, { status: 400 });
  }));
  await i18n.changeLanguage("en");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const container = document.createElement("div"); container.id = "root"; document.body.append(container);
  window.history.replaceState({ idx: 0, key: "recovery-origin", usr: null }, "", origin);
  await act(async () => { await import("../main"); });
  await waitFor(() => expect(screen.getByLabelText("Current owner")).toHaveTextContent("recovery-owner"));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Retain an already attempted handoff" }));
  const requestBefore = screen.getByLabelText("Retained request").textContent;
  expect(JSON.parse(requestBefore!)).toEqual(form.request);
  expect(unloadWarns()).toBe(true);

  // Healthy in-app departure is a positive control for the same store fixture.
  await user.click(screen.getByRole("link", { name: "Open healthy other route" }));
  expect(screen.getByRole("heading", { name: "Healthy other route" })).toBeVisible();
  expect(unloadWarns()).toBe(true);
  await act(async () => { await owned.routers[0]!.navigate(-1); });
  expect(screen.getByLabelText("Retained request").textContent).toBe(requestBefore);
  const originKey = history.state.key;

  await user.click(screen.getByRole("link", { name: "Open root page with stale chunk" }));
  expect(await screen.findByRole("heading", { name: i18n.t("pageRecovery.title") })).toBeVisible();
  expect(screen.getByText(i18n.t("pageRecovery.unsavedWarning"))).toBeVisible();
  expect(location.pathname).toBe("/");
  expect(document.body.textContent).not.toContain("synthetic-private-token");
  expect.soft(unloadWarns()).toBe(true);

  await act(async () => { await owned.routers[0]!.navigate(-1); });
  await screen.findByRole("heading", { name: "Retained handoff recovery source" });
  expect(location.pathname).toBe(origin);
  expect(history.state.key).toBe(originKey);
  expect.soft(screen.getByLabelText("Retained document")).toHaveTextContent(draft.document);
  expect.soft(screen.getByLabelText("Retained request").textContent).toBe(requestBefore);
  expect.soft(screen.getByLabelText("Retained unknown outcome")).toHaveTextContent("true");
  expect.soft(unloadWarns()).toBe(true);
  expect(writes).toEqual([]);
  const serialized = JSON.stringify({ href: location.href, state: history.state, local: { ...localStorage }, session: { ...sessionStorage } });
  expect(serialized).not.toContain(draft.document);
  expect(serialized).not.toContain(retryId);
});
