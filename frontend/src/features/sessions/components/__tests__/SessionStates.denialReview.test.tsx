// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCurrentUser } from "@/features/notifications/api/use-current-user";
import { ApiError } from "@/lib/api-error";
import { sessionKeys } from "@/lib/query-keys";
import { renderNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import { act, renderWithProviders, screen, stubReducedMotion, userEvent, waitFor } from "@/test/test-utils";
import en from "@/i18n/locales/en.json";
import { makeSession, stubAuthModes } from "../../__tests__/fixtures";
import { SessionDetailPage } from "../SessionDetailPage";
import { LoadErrorState } from "../SessionStates";

const sessionId = "40000000-0000-4000-8000-000000000403";
const apiPath = `/api/workspaces/acme/sessions/${sessionId}`;
const privateTitle = "Synthetic authorized owner session";

function AccountIdentity() {
  const me = useCurrentUser();
  return <p>{me.data ? `Current account: ${me.data.name}` : "Loading account"}</p>;
}

function mount(initialStatus: number, detail: string) {
  const traffic = { status: initialStatus, detailReads: [] as number[], otherReads: [] as string[], writes: [] as string[], unexpected: [] as string[] };
  let release: (() => void) | undefined;
  let hold = false;
  stubAuthModes(true);
  server.use(
    http.get(apiPath, async () => {
      const status = traffic.status;
      traffic.detailReads.push(status);
      if (hold) await new Promise<void>((resolve) => { release = resolve; });
      return status === 200
        ? HttpResponse.json(makeSession({ id: sessionId, title: privateTitle, coverage: "usage_only", capture_levels: [] }))
        // Both AgentSessionService authorization branches use this generic
        // code. Ordinary membership denial cannot identify the credential.
        : HttpResponse.json({ detail, error_code: "forbidden", error_params: {}, context: null }, { status });
    }),
    http.get("/api/workspaces/acme/boards", () => { traffic.otherReads.push("boards"); return HttpResponse.json([]); }),
    http.get(`${apiPath}/links`, () => { traffic.otherReads.push("links"); return HttpResponse.json({ items: [] }); }),
    http.get(`${apiPath}/usage`, () => { traffic.otherReads.push("usage"); return HttpResponse.json({ items: [], price_table_version: "review" }); }),
    http.get(`${apiPath}/children`, () => { traffic.otherReads.push("children"); return HttpResponse.json({ items: [] }); }),
    http.all("/api/*", ({ request }) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && ["/api/auth/modes", "/api/me"].includes(path)) return;
      if (request.method !== "GET") traffic.writes.push(`${request.method} ${path}`);
      traffic.unexpected.push(`${request.method} ${path}`);
      return HttpResponse.json({ detail: "Outside the denial regression fixture" }, { status: 400 });
    }),
  );
  const rendered = renderNavigationRouter([
    { path: "/:slug/sessions/:sessionId", element: <><AccountIdentity /><SessionDetailPage /></> },
  ], { initialEntries: [`/acme/sessions/${sessionId}`] });
  return { ...rendered, traffic, hold: () => { hold = true; }, release: () => { hold = false; release?.(); } };
}

function assertHonestDenial() {
  expect.soft(screen.queryByText(en.sessions.loadError.agentKey, { exact: true })).not.toBeInTheDocument();
  expect.soft(screen.queryByText(en.sessions.detail.loadError.description, { exact: true })).not.toBeInTheDocument();
  // Constrain the meaning, not a new locale key or a guessed server discriminator.
  expect.soft(screen.queryByText(/(?:access|permission|can(?:not| no longer|'t) read)/i)).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: privateTitle })).not.toBeInTheDocument();
}

beforeEach(() => stubReducedMotion(true));
afterEach(() => stubReducedMotion(false));

describe("Session denial explains current authority without guessing the credential", () => {
  it.each(["Synthetic session access denied", "Not a member of this workspace"])("offers explicit reauthorization for a human 403: %s", async (detail) => {
    const fixture = mount(403, detail);
    try {
      await screen.findByText("Current account: Me");
      await screen.findByRole("heading", { name: en.sessions.detail.loadError.title });
      assertHonestDenial();
      expect(fixture.traffic.detailReads).toEqual([403]);
      expect(fixture.traffic.otherReads).toEqual([]);
      expect(fixture.traffic.writes).toEqual([]);
      const retry = screen.getByRole("button", { name: en.sessions.loadError.retry });
      fixture.traffic.status = 200;
      fixture.hold();
      await userEvent.click(retry);
      await waitFor(() => expect(fixture.traffic.detailReads).toEqual([403, 200]));
      expect(retry).not.toBeDisabled();
      expect(retry).toHaveAttribute("aria-disabled", "true");
      expect(retry).toHaveAttribute("aria-busy", "true");
      expect(retry).toHaveFocus();
      await userEvent.keyboard("{Enter} ");
      expect(fixture.traffic.detailReads).toEqual([403, 200]);
      expect(screen.queryByRole("heading", { name: privateTitle })).not.toBeInTheDocument();
      fixture.release();
      expect(await screen.findByRole("heading", { name: privateTitle })).toBeVisible();
      expect(fixture.traffic.unexpected).toEqual([]);
      expect(fixture.traffic.writes).toEqual([]);
    } finally { fixture.release(); }
  });

  it("removes an already authorized title on current 403 and does not revive it while a deliberate retry is held", async () => {
    const fixture = mount(200, "Not a member of this workspace");
    try {
      await screen.findByRole("heading", { name: privateTitle });
      fixture.traffic.status = 403;
      await act(async () => { await fixture.client.refetchQueries({ queryKey: sessionKeys.detail("acme", sessionId), exact: true }); });
      await screen.findByRole("heading", { name: en.sessions.detail.loadError.title });
      assertHonestDenial();
      const readsBeforeRetry = fixture.traffic.otherReads.length;
      fixture.traffic.status = 200;
      fixture.hold();
      await userEvent.click(screen.getByRole("button", { name: en.sessions.loadError.retry }));
      await waitFor(() => expect(fixture.traffic.detailReads).toEqual([200, 403, 200]));
      expect(screen.queryByRole("heading", { name: privateTitle })).not.toBeInTheDocument();
      expect(fixture.traffic.otherReads).toHaveLength(readsBeforeRetry);
      fixture.release();
      expect(await screen.findByRole("heading", { name: privateTitle })).toBeVisible();
      expect(fixture.traffic.unexpected).toEqual([]);
      expect(fixture.traffic.writes).toEqual([]);
    } finally { fixture.release(); }
  });

  it("keeps transient outage copy and the supplied retry action without claiming an authorization cause", async () => {
    const retry = vi.fn();
    renderWithProviders(<LoadErrorState error={new ApiError("Synthetic outage", 503)}
      title={en.sessions.detail.loadError.title} description={en.sessions.detail.loadError.description} onRetry={retry} />);
    expect(screen.getByText(en.sessions.detail.loadError.description, { exact: true })).toBeVisible();
    expect(screen.queryByText(en.sessions.loadError.agentKey, { exact: true })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: en.sessions.loadError.retry }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
