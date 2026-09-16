// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { WorkspaceSkillsPage } from "@/pages/WorkspaceSkillsPage";

const SLUG = "acme";

function stubSkillEndpoints() {
  server.use(
    http.get(`/api/workspaces/${SLUG}/skills`, () =>
      HttpResponse.json({
        skills: [
          {
            id: "skill-1",
            slug: "release-checklist",
            name: "Release Checklist",
            description: "Steps for tagging and shipping a release",
            latest_published_version: 2,
            origin: "workspace",
            updated_at: "2026-08-20T10:00:00Z",
          },
          {
            id: "skill-2",
            slug: "incident-triage",
            name: "Incident Triage",
            description: "How to route production incidents",
            latest_published_version: 1,
            origin: "catalog",
            updated_at: "2026-08-21T10:00:00Z",
          },
        ],
        count: 2,
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/skill-catalog`, () =>
      HttpResponse.json({ entries: [] }),
    ),
  );
}

function renderPage() {
  renderWithProviders(
    <Routes>
      <Route path="/:slug/skills" element={<WorkspaceSkillsPage />} />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/skills`] } },
  );
}

describe("Workspace Skills page", () => {
  it("mounts at /:slug/skills and lists the workspace's skills", async () => {
    stubSkillEndpoints();
    renderPage();

    expect(await screen.findByText("Release Checklist")).toBeInTheDocument();
    expect(screen.getByText("Incident Triage")).toBeInTheDocument();
  });

  it("renders a skills heading", async () => {
    stubSkillEndpoints();
    renderPage();

    expect(
      await screen.findByRole("heading", { name: /skills/i }),
    ).toBeInTheDocument();
  });
});
