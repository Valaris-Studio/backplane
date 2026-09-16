// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  waitFor,
  userEvent,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";

// Soft-archive actions (Archive / Unarchive) are admin-gated like the
// authoring controls; the library itself — including the Show archived
// toggle — stays member-visible since the list GET is member-accessible.
const adminState = { current: { role: null as string | null } };
vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({
    role: adminState.current.role,
    isAdmin:
      adminState.current.role === "admin" ||
      adminState.current.role === "owner",
    isLoading: false,
    isError: false,
  }),
}));

import { SkillsLibrary } from "@/features/skills/components/SkillsLibrary";

const SLUG = "acme";
const SKILLS_URL = "/api/workspaces/" + SLUG + "/skills";
const CATALOG_URL = "/api/workspaces/" + SLUG + "/skill-catalog";
const APPROVALS_URL = "/api/workspaces/" + SLUG + "/approvals";

interface SkillFixture {
  id: string;
  slug: string;
  name: string;
  description: string;
  latest_published_version: number | null;
  origin: string | null;
  updated_at: string;
  archived_at: string | null;
}

const LIVE_SKILL: SkillFixture = {
  id: "skill-1",
  slug: "deploy-runbook",
  name: "Deploy Runbook",
  description: "How to roll a release out safely",
  latest_published_version: 2,
  origin: null,
  updated_at: "2026-08-24T10:00:00Z",
  archived_at: null,
};

// Version 5 on purpose: unique among all fixtures, so "v5" appearing is an
// unambiguous "the ARCHIVED skill's detail finished loading" signal even in
// tests that select Deploy Runbook (v1–v3) first.
const ARCHIVED_SKILL: SkillFixture = {
  id: "skill-2",
  slug: "legacy-playbook",
  name: "Legacy Playbook",
  description: "The old incident process we retired",
  latest_published_version: 5,
  origin: null,
  updated_at: "2026-08-18T10:00:00Z",
  archived_at: "2026-08-20T09:00:00Z",
};

const VERSIONS_BY_SLUG: Record<
  string,
  { version: number; status: string; content_hash: string; created_at: string }[]
> = {
  "deploy-runbook": [
    {
      version: 3,
      status: "draft",
      content_hash: "hash-dr-3",
      created_at: "2026-08-24T10:00:00Z",
    },
    {
      version: 2,
      status: "published",
      content_hash: "hash-dr-2",
      created_at: "2026-08-20T10:00:00Z",
    },
    {
      version: 1,
      status: "rejected",
      content_hash: "hash-dr-1",
      created_at: "2026-08-10T10:00:00Z",
    },
  ],
  // All statuses here stay non-"archived" so the "Archived" strings the tests
  // count can only come from the skill-level badge, never a version status.
  "legacy-playbook": [
    {
      version: 5,
      status: "published",
      content_hash: "hash-lp-5",
      created_at: "2026-08-18T10:00:00Z",
    },
  ],
};

/**
 * Stubs the skills surface with one live + one archived skill and a mutable
 * archived-state map, so archive/unarchive POSTs change what subsequent GETs
 * serve (the invalidation-refetch the UI relies on). Returns traffic captures:
 * every list GET's `include_archived` param and each archive/unarchive POST's
 * skill slug.
 */
function stubArchiveEndpoints() {
  const archivedAt: Record<string, string | null> = {
    [LIVE_SKILL.slug]: LIVE_SKILL.archived_at,
    [ARCHIVED_SKILL.slug]: ARCHIVED_SKILL.archived_at,
  };
  const fixtures: Record<string, SkillFixture> = {
    [LIVE_SKILL.slug]: LIVE_SKILL,
    [ARCHIVED_SKILL.slug]: ARCHIVED_SKILL,
  };
  const observed = {
    listIncludeArchivedParams: [] as (string | null)[],
    archivePosts: [] as string[],
    unarchivePosts: [] as string[],
  };

  function skillRow(slug: string) {
    return { ...fixtures[slug]!, archived_at: archivedAt[slug] ?? null };
  }

  server.use(
    http.get(SKILLS_URL, ({ request }) => {
      const includeArchived = new URL(request.url).searchParams.get(
        "include_archived",
      );
      observed.listIncludeArchivedParams.push(includeArchived);
      const rows = [LIVE_SKILL.slug, ARCHIVED_SKILL.slug]
        .map(skillRow)
        .filter((row) => includeArchived === "true" || row.archived_at === null);
      return HttpResponse.json({ skills: rows, count: rows.length });
    }),
    http.get(SKILLS_URL + "/:skillSlug", ({ params }) => {
      const slug = params.skillSlug as string;
      if (!fixtures[slug]) return new HttpResponse(null, { status: 404 });
      return HttpResponse.json({
        ...skillRow(slug),
        versions: VERSIONS_BY_SLUG[slug] ?? [],
      });
    }),
    http.get(SKILLS_URL + "/:skillSlug/versions/:n", ({ params }) => {
      const slug = params.skillSlug as string;
      const n = Number(params.n);
      const meta = (VERSIONS_BY_SLUG[slug] ?? []).find(
        (v) => v.version === n,
      );
      return HttpResponse.json({
        files: [
          { path: "SKILL.md", content: "Body v" + n + " of " + slug },
        ],
        version: n,
        status: meta?.status ?? "draft",
        content_hash: "hash-" + slug + "-" + n,
      });
    }),
    // Contract with the backend slice: both endpoints return the skill
    // detail (SkillRead) with the flipped archived_at.
    http.post(SKILLS_URL + "/:skillSlug/archive", ({ params }) => {
      const slug = params.skillSlug as string;
      observed.archivePosts.push(slug);
      archivedAt[slug] = "2026-08-24T12:00:00Z";
      return HttpResponse.json({
        ...skillRow(slug),
        versions: VERSIONS_BY_SLUG[slug] ?? [],
      });
    }),
    http.post(SKILLS_URL + "/:skillSlug/unarchive", ({ params }) => {
      const slug = params.skillSlug as string;
      observed.unarchivePosts.push(slug);
      archivedAt[slug] = null;
      return HttpResponse.json({
        ...skillRow(slug),
        versions: VERSIONS_BY_SLUG[slug] ?? [],
      });
    }),
    http.get(CATALOG_URL, () => HttpResponse.json({ entries: [] })),
    http.get(APPROVALS_URL, () => HttpResponse.json([])),
  );
  return observed;
}

function renderLibrary() {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/skills" element={<SkillsLibrary />} />
    </Routes>,
    { routerProps: { initialEntries: ["/" + SLUG + "/skills"] } },
  );
}

// Clicking the toggle's visible label works whether it lands as a checkbox,
// switch, or button — the tests pin the t() string, not the widget.
async function toggleShowArchived(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByText("Show archived"));
}

async function selectSkill(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  versionLabel: string,
) {
  await user.click(await screen.findByText(name));
  // Version history rendered => detail loaded.
  await screen.findByText(versionLabel);
}

beforeEach(() => {
  adminState.current.role = "admin";
});

describe("SkillsLibrary — show archived toggle", () => {
  it("defaults to hiding archived skills: toggle present but OFF, no archived rows, no Archived badge, no include_archived=true request", async () => {
    const observed = stubArchiveEndpoints();
    renderLibrary();

    await screen.findByText("Deploy Runbook");
    expect(screen.getByText("Show archived")).toBeInTheDocument();
    expect(screen.queryByText("Legacy Playbook")).not.toBeInTheDocument();
    expect(screen.queryByText("Archived")).not.toBeInTheDocument();
    // Every list fetch so far asked for the default (live-only) view.
    expect(observed.listIncludeArchivedParams.length).toBeGreaterThan(0);
    expect(
      observed.listIncludeArchivedParams.every((p) => p !== "true"),
    ).toBe(true);
  });

  it("turning the toggle ON fetches with include_archived=true and shows the archived row; OFF hides it again", async () => {
    const observed = stubArchiveEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    await screen.findByText("Deploy Runbook");
    await toggleShowArchived(user);

    await waitFor(() => {
      expect(observed.listIncludeArchivedParams).toContain("true");
    });
    expect(await screen.findByText("Legacy Playbook")).toBeInTheDocument();

    // Two states of the same list must not share a cache entry: flipping the
    // toggle back OFF must drop the archived row again.
    await toggleShowArchived(user);
    await waitFor(() => {
      expect(screen.queryByText("Legacy Playbook")).not.toBeInTheDocument();
    });
  });

  it("marks the archived skill with an Archived badge on its row and in the detail pane once selected", async () => {
    stubArchiveEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    await toggleShowArchived(user);
    await screen.findByText("Legacy Playbook");
    // Row badge, before anything is selected.
    expect(screen.getAllByText("Archived").length).toBeGreaterThanOrEqual(1);

    await selectSkill(user, "Legacy Playbook", "v5");
    // Row badge + detail-pane badge.
    await waitFor(() => {
      expect(screen.getAllByText("Archived").length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("SkillsLibrary — archive / unarchive actions", () => {
  it("lets an admin archive a live skill: POSTs to /archive and the skill leaves the default (toggle OFF) list on refetch", async () => {
    const observed = stubArchiveEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    await selectSkill(user, "Deploy Runbook", "v3");
    await user.click(screen.getByRole("button", { name: /^archive$/i }));

    await waitFor(() => {
      expect(observed.archivePosts).toEqual(["deploy-runbook"]);
    });
    // Soft-archive, toggle OFF: the invalidation-refetch now excludes the
    // skill, so its row (and with it the detail pane) disappears entirely.
    await waitFor(() => {
      expect(screen.queryByText("Deploy Runbook")).not.toBeInTheDocument();
    });
  });

  it("lets an admin unarchive an archived skill: POSTs to /unarchive and the Archived badge clears on refetch", async () => {
    const observed = stubArchiveEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    await toggleShowArchived(user);
    await selectSkill(user, "Legacy Playbook", "v5");
    await user.click(screen.getByRole("button", { name: /^unarchive$/i }));

    await waitFor(() => {
      expect(observed.unarchivePosts).toEqual(["legacy-playbook"]);
    });
    // The skill is live again: no badge anywhere, row still listed.
    await waitFor(() => {
      expect(screen.queryByText("Archived")).not.toBeInTheDocument();
    });
    expect(screen.getAllByText("Legacy Playbook").length).toBeGreaterThan(0);
  });

  it("offers neither Archive nor Unarchive to plain members, on live and archived skills alike", async () => {
    adminState.current.role = "member";
    stubArchiveEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    // The toggle itself is member-visible — members may SEE archived skills,
    // they just cannot change archive state.
    await toggleShowArchived(user);

    await selectSkill(user, "Deploy Runbook", "v3");
    expect(
      screen.queryByRole("button", { name: /^archive$/i }),
    ).not.toBeInTheDocument();

    await selectSkill(user, "Legacy Playbook", "v5");
    expect(
      screen.queryByRole("button", { name: /^unarchive$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^archive$/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps an archived skill's detail reachable: archiving with the toggle ON shows the badge and version history stays rendered", async () => {
    const observed = stubArchiveEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    await toggleShowArchived(user);
    await selectSkill(user, "Deploy Runbook", "v3");
    // Toggle ON lists the already-archived Legacy Playbook, whose row badge is
    // the ONLY one — the still-live Deploy Runbook contributes none, row or
    // detail.
    expect(screen.getAllByText("Archived")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /^archive$/i }));

    await waitFor(() => {
      expect(observed.archivePosts).toEqual(["deploy-runbook"]);
    });
    // Toggle ON keeps the archived row listed, the selection alive, and the
    // detail pane rendering — now with the Archived badge...
    await waitFor(() => {
      expect(screen.getAllByText("Archived").length).toBeGreaterThanOrEqual(2);
    });
    // ...and the full version history still reachable (archive is skill-level
    // only; versions are untouched).
    expect(screen.getByText("v3")).toBeInTheDocument();
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
  });
});
