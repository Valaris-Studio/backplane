// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { SLUG, stubAuthModes } from "../../__tests__/fixtures";
import { MySessionsPage } from "../MySessionsPage";
import { SessionDetailPage } from "../SessionDetailPage";

function renderAt(path: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/sessions" element={<MySessionsPage />} />
      <Route path="/:slug/sessions/:sessionId" element={<SessionDetailPage />} />
    </Routes>,
    { routerProps: { initialEntries: [path] } },
  );
}

describe("My sessions — capture off on this server", () => {
  it("explains in the shell that capture is off and never calls the session API", async () => {
    stubAuthModes(false);
    const sessionCalls = vi.fn();
    server.use(
      http.get(`/api/workspaces/${SLUG}/sessions`, () => {
        sessionCalls();
        return HttpResponse.json({ items: [], next_cursor: null });
      }),
    );

    renderAt(`/${SLUG}/sessions`);

    expect(await screen.findByRole("heading", { name: "Session capture is off here" })).toBeInTheDocument();
    expect(screen.getByText(/Whoever runs it can turn capture on/)).toBeInTheDocument();
    expect(sessionCalls).not.toHaveBeenCalled();
  });

  it("shows the same state on a direct visit to a session", async () => {
    stubAuthModes(false);
    renderAt(`/${SLUG}/sessions/abc`);
    expect(await screen.findByRole("heading", { name: "Session capture is off here" })).toBeInTheDocument();
  });
});

describe("My sessions — loading, empty and error scaffolding", () => {
  it("shows skeleton rows while the first page loads", async () => {
    stubAuthModes(true);
    server.use(http.get(`/api/workspaces/${SLUG}/sessions`, () => new Promise(() => {})));
    renderAt(`/${SLUG}/sessions`);
    expect(await screen.findByTestId("sessions-skeleton")).toBeInTheDocument();
  });

  it("teaches the first run when nothing has been captured yet", async () => {
    stubAuthModes(true);
    server.use(
      http.get(`/api/workspaces/${SLUG}/sessions`, () => HttpResponse.json({ items: [], next_cursor: null })),
    );
    renderAt(`/${SLUG}/sessions`);
    expect(await screen.findByRole("heading", { name: "See what your agents did" })).toBeInTheDocument();
  });

  it("says the sessions are safe and offers a retry when the server does not answer", async () => {
    stubAuthModes(true);
    let attempts = 0;
    server.use(
      http.get(`/api/workspaces/${SLUG}/sessions`, () => {
        attempts += 1;
        return attempts === 1
          ? HttpResponse.json({ detail: "boom" }, { status: 500 })
          : HttpResponse.json({ items: [], next_cursor: null });
      }),
    );
    renderAt(`/${SLUG}/sessions`);

    expect(await screen.findByRole("heading", { name: "Couldn't load your sessions" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2));
  });

  it("tells an agent key it cannot read captured sessions", async () => {
    stubAuthModes(true);
    server.use(
      http.get(`/api/workspaces/${SLUG}/sessions`, () =>
        HttpResponse.json({ detail: "forbidden" }, { status: 403 }),
      ),
    );
    renderAt(`/${SLUG}/sessions`);
    expect(await screen.findByText("Agent keys can't read captured sessions.")).toBeInTheDocument();
  });
});
