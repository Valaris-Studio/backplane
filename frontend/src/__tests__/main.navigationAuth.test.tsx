// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { act, screen, userEvent, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { useCurrentUser } from "@/features/notifications/api/use-current-user";
import { useHandoffDraft } from "@/features/sessions/hooks/use-handoff-drafts";
import { makeContent, makeSession } from "@/features/sessions/__tests__/fixtures";

const roots = vi.hoisted(() => [] as Root[]);
vi.mock("react-dom/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-dom/client")>();
  return { ...original, createRoot: (...args: Parameters<typeof original.createRoot>) => {
    const root = original.createRoot(...args); roots.push(root); return root;
  } };
});
// Exercise main's actual identity subscription/provider ownership. Unrelated
// app surfaces and transport are replaced; retries are disabled only to settle
// the final 503 promptly, without changing its query error/data semantics.
vi.mock("@/App", () => ({ App: () => <RetainedHandoffProbe /> }));
vi.mock("@/providers/WebSocketProvider", () => ({ WebSocketProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/ThemedToaster", () => ({ ThemedToaster: () => null }));
vi.mock("@/components/shared/InitialCatalog", () => ({ InitialCatalog: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/lib/should-retry", () => ({ shouldRetry: () => false }));

function RetainedHandoffProbe() {
  const me = useCurrentUser();
  const handoff = useHandoffDraft("acme", "source");
  return <>
    <output aria-label="Current owner">{me.data?.id ?? "No current owner"}</output>
    <output aria-label="Identity refresh">{me.isError ? "Refresh unavailable" : "Identity available"}</output>
    <output aria-label="Retained handoff">{handoff.state.draft?.document ?? "No retained draft"}</output>
    <button onClick={() => handoff.setDraft({ fingerprint: "source-fingerprint", session: makeSession({ id: "source" }),
      bodies: [{ item: makeContent({ id: "source-content", preview: null }), text: "" }], document: "Unpublished reviewed private handoff" })}>Retain handoff</button>
    <button onClick={() => void me.refetch()}>Refresh identity</button>
  </>;
}

afterEach(async () => {
  await act(async () => { roots.splice(0).forEach((root) => root.unmount()); });
  document.getElementById("root")?.remove();
});

it("keeps the same owner's handoff on a 503 refresh and clears it on confirmed denial", async () => {
  let status = 200;
  server.use(http.get("/api/me", () => status === 200
    ? HttpResponse.json({ id: "owner-1", name: "Owner", email: "owner@example.test", avatar_url: null })
    : HttpResponse.json({ detail: "Temporarily unavailable" }, { status })));
  const container = document.createElement("div"); container.id = "root"; document.body.append(container);
  window.history.replaceState({ idx: 0, key: "origin", usr: null }, "", "/acme/sessions/source");
  await act(async () => { await import("../main"); });
  await waitFor(() => expect(screen.getByLabelText("Current owner")).toHaveTextContent("owner-1"));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Retain handoff" }));
  expect(screen.getByLabelText("Retained handoff")).toHaveTextContent("Unpublished reviewed private handoff");
  status = 503;
  await user.click(screen.getByRole("button", { name: "Refresh identity" }));
  await waitFor(() => expect(screen.getByLabelText("Identity refresh")).toHaveTextContent("Refresh unavailable"));
  expect(screen.getByLabelText("Current owner")).toHaveTextContent("owner-1");
  expect(screen.getByLabelText("Retained handoff")).toHaveTextContent("Unpublished reviewed private handoff");
  const warning = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(warning);
  expect(warning.defaultPrevented).toBe(true);
  expect(JSON.stringify(window.history.state)).not.toContain("private handoff");

  status = 403;
  await user.click(screen.getByRole("button", { name: "Refresh identity" }));
  await waitFor(() => expect(screen.getByLabelText("Retained handoff")).toHaveTextContent("No retained draft"));
  const afterDenial = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(afterDenial);
  expect(afterDenial.defaultPrevented).toBe(false);
});
