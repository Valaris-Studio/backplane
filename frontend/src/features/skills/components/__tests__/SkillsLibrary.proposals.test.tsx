// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { Route, Routes } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  waitFor,
  userEvent,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { SkillsLibrary } from "@/features/skills/components/SkillsLibrary";

const SLUG = "acme";
const SKILLS_URL = "/api/workspaces/" + SLUG + "/skills";
const CATALOG_URL = "/api/workspaces/" + SLUG + "/skill-catalog";
const APPROVALS_URL = "/api/workspaces/" + SLUG + "/approvals";

// A skill whose latest version (2) is an agent proposal awaiting a
// skill_publication approval; v1 stays the latest PUBLISHED version.
const DEPLOY_RUNBOOK = {
  id: "skill-1",
  slug: "deploy-runbook",
  name: "Deploy Runbook",
  description: "How to roll a release out safely",
  latest_published_version: 1,
  origin: "workspace",
  updated_at: "2026-08-24T10:00:00Z",
};

const RELEASE_CHECKLIST = {
  id: "skill-2",
  slug: "release-checklist",
  name: "Release Checklist",
  description: "Steps for tagging and shipping a release",
  latest_published_version: 1,
  origin: "workspace",
  updated_at: "2026-08-20T10:00:00Z",
};

const PROPOSAL_APPROVAL = {
  id: "apr-skill-1",
  agent_id: "agent-1",
  agent_name: "loop-bot",
  workspace_id: "ws-1",
  board_id: "board-1",
  category: "skill_publication",
  action_description: "Publish version 2 of skill Deploy Runbook",
  action_payload: { slug: "deploy-runbook", version: 2 },
  risk_score: 60,
  status: "pending",
  decided_by_id: null,
  decided_by_name: null,
  decided_at: null,
  decision_reason: null,
  expires_at: "2026-08-25T00:00:00Z",
  execution_id: null,
  created_at: "2026-08-24T08:00:00Z",
  updated_at: "2026-08-24T08:00:00Z",
};

/**
 * Stubs the skills + approvals REST surface. `approvals` controls which
 * pending skill_publication approvals the workspace reports; `decided`
 * captures POST .../decide traffic so tests assert behavior, not markup.
 */
function stubEndpoints({
  approvals = [PROPOSAL_APPROVAL],
}: { approvals?: (typeof PROPOSAL_APPROVAL)[] } = {}) {
  const decided: { id: string; body: Record<string, unknown> }[] = [];
  // The server's view of the proposal after a decide: the version publishes
  // and the gating approval leaves the pending list — exactly what a refetch
  // must pick up.
  let published = false;
  server.use(
    http.get(SKILLS_URL, () =>
      HttpResponse.json({
        skills: [DEPLOY_RUNBOOK, RELEASE_CHECKLIST],
        count: 2,
      }),
    ),
    http.get(SKILLS_URL + "/deploy-runbook", () =>
      HttpResponse.json({
        ...DEPLOY_RUNBOOK,
        versions: [
          {
            version: 2,
            status: published ? "published" : "proposed",
            content_hash: "hash-dr-2",
            created_at: "2026-08-24T08:00:00Z",
          },
          {
            version: 1,
            status: "published",
            content_hash: "hash-dr-1",
            created_at: "2026-08-10T10:00:00Z",
          },
        ],
      }),
    ),
    http.get(SKILLS_URL + "/release-checklist", () =>
      HttpResponse.json({
        ...RELEASE_CHECKLIST,
        versions: [
          {
            version: 1,
            status: "published",
            content_hash: "hash-rc-1",
            created_at: "2026-08-20T10:00:00Z",
          },
        ],
      }),
    ),
    http.get(SKILLS_URL + "/:skillSlug/versions/:n", ({ params }) =>
      HttpResponse.json({
        files: [
          {
            path: "SKILL.md",
            content: "Body of " + params.skillSlug + " v" + params.n,
          },
        ],
        version: Number(params.n),
        status: "published",
        content_hash: "hash-" + params.skillSlug,
      }),
    ),
    http.get(CATALOG_URL, () => HttpResponse.json({ entries: [] })),
    http.get(APPROVALS_URL, () =>
      HttpResponse.json(published ? [] : approvals),
    ),
    http.post(APPROVALS_URL + "/:id/decide", async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>;
      decided.push({ id: params.id as string, body });
      published = true;
      return HttpResponse.json({
        ...PROPOSAL_APPROVAL,
        status: body.decision,
      });
    }),
  );
  return { decided };
}

function renderLibrary() {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/skills" element={<SkillsLibrary />} />
    </Routes>,
    { routerProps: { initialEntries: ["/" + SLUG + "/skills"] } },
  );
}

async function openSkill(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByText(name));
}

describe("SkillsLibrary — pending skill proposals", () => {
  it("shows a pending-proposal banner with Approve and Reject controls when a matching approval exists", async () => {
    stubEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    await openSkill(user, "Deploy Runbook");

    // Detail pane surfaces the proposal awaiting review.
    expect(await screen.findByText(/pending/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /approve/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reject/i })).toBeInTheDocument();
  });

  it("approving the proposal POSTs the matching approval's decide endpoint with decision approved", async () => {
    const { decided } = stubEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    await openSkill(user, "Deploy Runbook");

    await user.click(await screen.findByRole("button", { name: /approve/i }));

    await waitFor(() => expect(decided).toHaveLength(1));
    expect(decided[0]!.id).toBe("apr-skill-1");
    expect(decided[0]!.body.decision).toBe("approved");
  });

  it("rejecting the proposal POSTs the matching approval's decide endpoint with decision rejected", async () => {
    const { decided } = stubEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    await openSkill(user, "Deploy Runbook");

    await user.click(await screen.findByRole("button", { name: /reject/i }));

    await waitFor(() => expect(decided).toHaveLength(1));
    expect(decided[0]!.id).toBe("apr-skill-1");
    expect(decided[0]!.body.decision).toBe("rejected");
  });

  it("shows no proposal banner for a skill without a matching pending approval", async () => {
    // The workspace has a pending skill_publication approval — but for a slug
    // that is not this skill, so nothing here may light up.
    stubEndpoints({
      approvals: [
        {
          ...PROPOSAL_APPROVAL,
          id: "apr-other",
          action_description: "Publish version 3 of skill Unrelated",
          action_payload: { slug: "some-other-skill", version: 3 },
        },
      ],
    });
    const user = userEvent.setup();
    renderLibrary();

    await openSkill(user, "Release Checklist");

    // Settle the detail pane before asserting absence.
    expect(
      await screen.findByText(/Body of release-checklist v1/),
    ).toBeInTheDocument();

    expect(screen.queryByText(/pending/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /reject/i })).toBeNull();
  });

  it("refetches the skill after deciding so the banner clears and the version reads Published", async () => {
    // The decide happens on THIS screen, so the skills queries it renders from
    // are the ones that go stale — without a callsite invalidation the version
    // renders "proposed" forever.
    stubEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    await openSkill(user, "Deploy Runbook");
    expect(await screen.findByText("Proposed")).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: /approve/i }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /approve/i })).toBeNull(),
    );
    await waitFor(() => expect(screen.queryByText("Proposed")).toBeNull());
    expect(screen.getAllByText("Published").length).toBeGreaterThan(0);
  });

  it("names the proposed version in the banner so coexisting proposals are distinguishable", async () => {
    stubEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    await openSkill(user, "Deploy Runbook");

    // The approval's payload version (2), not the skill's published version.
    expect(await screen.findByText(/version 2/i)).toBeInTheDocument();
  });

  it("sends a non-empty decision reason so the stored approval explains where it came from", async () => {
    const { decided } = stubEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    await openSkill(user, "Deploy Runbook");
    await user.click(await screen.findByRole("button", { name: /approve/i }));

    await waitFor(() => expect(decided).toHaveLength(1));
    expect(decided[0]!.body.reason).toBeTruthy();
  });

  it("renders a proposed version in the history with its own translated status label", async () => {
    stubEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    await openSkill(user, "Deploy Runbook");

    expect(await screen.findByText(/Body of deploy-runbook v1/)).toBeInTheDocument();
    // Translated label (capitalized), not the raw enum value fallback —
    // "proposed" must be a first-class status alongside Published/Archived.
    expect(screen.getByText("Proposed")).toBeInTheDocument();
    expect(screen.getByText("Published")).toBeInTheDocument();
  });
});
