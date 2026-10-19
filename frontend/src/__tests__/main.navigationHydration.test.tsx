// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import type { QueryClient } from "@tanstack/react-query";
import type { createBrowserRouter } from "react-router-dom";
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, stubReducedMotion, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { meKeys } from "@/lib/query-keys";
import type { Note } from "@/types/note";

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
// Keep actual main/App/AppShell, query ownership, note API and rich editor.
// Transport and initial catalog scheduling are unrelated to profile hydration.
vi.mock("@/providers/WebSocketProvider", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/providers/WebSocketProvider")>(),
  WebSocketProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/shared/InitialCatalog", () => ({ InitialCatalog: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/ThemedToaster", () => ({ ThemedToaster: () => null }));

const owner = { id: "hydration-owner", name: "Hydration Owner", email: "owner@example.test", avatar_url: null };
const workspace = { id: "hydration-workspace", slug: "hydration", name: "Hydration workspace", created_by: owner.id, created_at: "2026-10-18T12:00:00Z", updated_at: "2026-10-18T12:00:00Z" };
const note: Note = {
  id: "hydration-note", workspace_id: workspace.id, board_id: null, card_id: null,
  title: "Persisted authorized note", content: "<p>Persisted authorized note body.</p>", pinned: false,
  kind: "user_note", failure_class: null, findings: null, source_execution_id: null,
  created_by: owner.id, created_at: workspace.created_at, updated_at: workspace.updated_at,
};
const path = `/${workspace.slug}/notes?note=${note.id}`;
const editedTitle = "Unsaved authorized edit before profile hydration";
let releaseIdentity: () => void = () => {};

function serve(holdIdentity: boolean) {
  const identity = new Promise<void>((resolve) => { releaseIdentity = resolve; });
  if (!holdIdentity) releaseIdentity();
  const traffic = { reads: [] as string[], writes: [] as string[], unexpected: [] as string[], identityReturned: 0 };
  server.use(http.all("/api/*", async ({ request }) => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (request.method !== "GET") traffic.writes.push(route);
    else traffic.reads.push(url.pathname);
    let value: unknown;
    if (request.method === "GET") {
      if (url.pathname === "/api/me") {
        await identity;
        traffic.identityReturned += 1;
        return HttpResponse.json(owner);
      }
      const responses: Record<string, unknown> = {
        "/api/auth/modes": { oidc_enabled: false, password_enabled: false, dev_mode: true, companion_enabled: false, rich_capture_enabled: false },
        "/api/auth/setup-status": { needs_setup: false },
        "/api/workspaces": [workspace],
        "/api/workspaces/hydration": workspace,
        "/api/workspaces/hydration/members": [{ user_id: owner.id, role: "owner", name: owner.name, email: owner.email }],
        "/api/workspaces/hydration/boards": [],
        "/api/workspaces/hydration/agents": [],
        "/api/workspaces/hydration/notes": [{ ...Object.fromEntries(Object.entries(note).filter(([key]) => key !== "content")), preview: "Persisted authorized note body." }],
        "/api/workspaces/hydration/notes/hydration-note": note,
        "/api/workspaces/hydration/config/completion-context-impact": { attempts: [] },
        "/api/notifications/unread-count": { count: 0 },
        "/api/notifications": [],
        "/api/workspaces/hydration/approvals": [],
      };
      value = responses[url.pathname];
    }
    if (value === undefined) {
      traffic.unexpected.push(route);
      return HttpResponse.json({ detail: "Unexpected hydration fixture request" }, { status: 400 });
    }
    return HttpResponse.json(value, { headers: { "X-Total-Count": "1" } });
  }));
  return traffic;
}

async function mount() {
  const container = document.createElement("div"); container.id = "root"; document.body.append(container);
  window.history.replaceState({ idx: 0, key: "hydration-origin", usr: null }, "", path);
  await act(async () => { await import("../main"); });
  const title = await screen.findByDisplayValue(note.title);
  expect(screen.getByRole("main")).toBeVisible();
  expect(screen.getByRole("button", { name: "Toggle sidebar" })).toBeVisible();
  await waitFor(() => expect(document.querySelector('[contenteditable="true"]')).toHaveTextContent("Persisted authorized note body."));
  return title;
}

function expectEditedDraft() {
  expect.soft(screen.queryByDisplayValue(editedTitle)).toBeVisible();
  expect.soft(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  expect.soft(document.querySelector('[contenteditable="true"]')).toHaveTextContent("Persisted authorized note body.");
  const warning = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(warning);
  expect.soft(warning.defaultPrevented).toBe(true);
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  stubReducedMotion(true);
});
afterEach(async () => {
  releaseIdentity();
  await act(async () => { owned.roots.splice(0).forEach((root) => root.unmount()); });
  owned.routers.splice(0).forEach((router) => router.dispose());
  owned.clients.splice(0).forEach((client) => client.clear());
  document.getElementById("root")?.remove();
  stubReducedMotion(false);
});

describe("initial identity hydration in the actual note application", () => {
  it("retains a dirty authorized note when a delayed first /me identifies the same authenticated owner", async () => {
    const traffic = serve(true);
    const title = await mount();
    const client = owned.clients[0]!;
    expect(client.getQueryData(meKeys.me())).toBeUndefined();
    expect(traffic.identityReturned).toBe(0);
    expect(traffic.reads).toContain("/api/workspaces/hydration/notes/hydration-note");
    expect(traffic.unexpected).toEqual([]);
    fireEvent.change(title, { target: { value: editedTitle } });
    expectEditedDraft();
    const before = { href: location.href, state: structuredClone(history.state) };

    await act(async () => { releaseIdentity(); });
    await waitFor(() => expect(client.getQueryData(meKeys.me())).toEqual(owner));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(traffic.identityReturned).toBe(1);
    expect(traffic.unexpected).toEqual([]);
    expect(traffic.writes).toEqual([]);
    expect({ href: location.href, state: history.state }).toEqual(before);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expectEditedDraft();
  });

  it("positive control: an already known owner's successful profile refresh preserves the same dirty note", async () => {
    const traffic = serve(false);
    await mount();
    const client = owned.clients[0]!;
    await waitFor(() => expect(client.getQueryData(meKeys.me())).toEqual(owner));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    fireEvent.change(screen.getByDisplayValue(note.title), { target: { value: editedTitle } });
    expectEditedDraft();

    await act(async () => { await client.refetchQueries({ queryKey: meKeys.me(), exact: true }); });
    expect(traffic.identityReturned).toBe(2);
    expect(traffic.unexpected).toEqual([]);
    expect(traffic.writes).toEqual([]);
    expect(location.pathname + location.search).toBe(path);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expectEditedDraft();
  });
});
