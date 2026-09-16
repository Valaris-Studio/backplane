// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { Route, Routes } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  waitFor,
  within,
  userEvent,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { SkillsLibrary } from "@/features/skills/components/SkillsLibrary";

const SLUG = "acme";
const SKILLS_URL = "/api/workspaces/" + SLUG + "/skills";
const CATALOG_URL = "/api/workspaces/" + SLUG + "/skill-catalog";

// Mirrors the backend contract: origin is null for workspace-native skills or
// "catalog:{catalog_id}@{catalog_version}" as written by catalog activation —
// never the bare string "catalog".
interface SkillFixture {
  id: string;
  slug: string;
  name: string;
  description: string;
  latest_published_version: number | null;
  origin: string | null;
  updated_at: string;
}

interface CatalogEntryFixture {
  catalog_id: string;
  catalog_version: number;
  name: string;
  description: string;
}

const RELEASE_CHECKLIST: SkillFixture = {
  id: "skill-1",
  slug: "release-checklist",
  name: "Release Checklist",
  description: "Steps for tagging and shipping a release",
  latest_published_version: 2,
  origin: null,
  updated_at: "2026-08-20T10:00:00Z",
};

const INCIDENT_TRIAGE: SkillFixture = {
  id: "skill-2",
  slug: "incident-triage",
  name: "Incident Triage",
  description: "How to route production incidents",
  latest_published_version: 1,
  origin: "catalog:incident-triage@1",
  updated_at: "2026-08-21T10:00:00Z",
};

const POSTMORTEM_ENTRY: CatalogEntryFixture = {
  catalog_id: "postmortem-writer",
  catalog_version: 3,
  name: "Postmortem Writer",
  description: "Guidance for writing blameless postmortems",
};

const SKILL_BODIES: Record<string, string> = {
  "release-checklist": "Tag the release before announcing it",
  "incident-triage": "Page the on-call before filing the report",
};

/**
 * Stubs the whole skills REST surface. Returns observation counters so tests
 * can assert on traffic (which version was fetched, that activate POSTed,
 * that the list was refetched after invalidation) without pinning markup.
 */
function stubSkillEndpoints({
  skills = [RELEASE_CHECKLIST, INCIDENT_TRIAGE],
  entries = [POSTMORTEM_ENTRY],
}: { skills?: SkillFixture[]; entries?: CatalogEntryFixture[] } = {}) {
  const observed = {
    listFetches: 0,
    versionRequests: [] as string[],
    activatePosts: [] as string[],
  };
  let liveSkills = [...skills];
  server.use(
    http.get(SKILLS_URL, () => {
      observed.listFetches += 1;
      return HttpResponse.json({
        skills: liveSkills,
        count: liveSkills.length,
      });
    }),
    http.get(SKILLS_URL + "/release-checklist", () =>
      HttpResponse.json({
        ...RELEASE_CHECKLIST,
        versions: [
          {
            version: 2,
            status: "published",
            content_hash: "hash-rc-2",
            created_at: "2026-08-20T10:00:00Z",
          },
          {
            version: 1,
            status: "archived",
            content_hash: "hash-rc-1",
            created_at: "2026-08-10T10:00:00Z",
          },
        ],
      }),
    ),
    http.get(SKILLS_URL + "/incident-triage", () =>
      HttpResponse.json({
        ...INCIDENT_TRIAGE,
        versions: [
          {
            version: 1,
            status: "published",
            content_hash: "hash-it-1",
            created_at: "2026-08-21T10:00:00Z",
          },
        ],
      }),
    ),
    http.get(SKILLS_URL + "/:skillSlug/versions/:n", ({ params }) => {
      const skillSlug = params.skillSlug as string;
      observed.versionRequests.push(skillSlug + "@" + params.n);
      return HttpResponse.json({
        files: [{ path: "SKILL.md", content: SKILL_BODIES[skillSlug] ?? "" }],
        version: Number(params.n),
        status: "published",
        content_hash: "hash-" + skillSlug,
      });
    }),
    http.get(CATALOG_URL, () => HttpResponse.json({ entries })),
    http.post(CATALOG_URL + "/:catalogId/activate", ({ params }) => {
      observed.activatePosts.push(params.catalogId as string);
      const activated = {
        id: "skill-3",
        slug: "postmortem-writer",
        name: "Postmortem Writer",
        description: POSTMORTEM_ENTRY.description,
        latest_published_version: 1,
        origin: "catalog:postmortem-writer@3",
        updated_at: "2026-08-24T10:00:00Z",
      };
      liveSkills = [...liveSkills, activated];
      return HttpResponse.json(
        {
          ...activated,
          versions: [
            {
              version: 1,
              status: "published",
              content_hash: "hash-pw-1",
              created_at: "2026-08-24T10:00:00Z",
            },
          ],
        },
        { status: 201 },
      );
    }),
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

// The filter input may be a plain textbox or a type="search" input — accept
// either so the test pins behavior, not markup.
function getSearchInput() {
  return screen.queryByRole("searchbox") ?? screen.getByRole("textbox");
}

describe("SkillsLibrary — workspace skill list", () => {
  it("lists every workspace skill with its name and description", async () => {
    stubSkillEndpoints();
    renderLibrary();

    expect(await screen.findByText("Release Checklist")).toBeInTheDocument();
    expect(screen.getByText("Incident Triage")).toBeInTheDocument();
    expect(
      screen.getByText("Steps for tagging and shipping a release"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("How to route production incidents"),
    ).toBeInTheDocument();
  });

  it("filters the list as the user types in the search input", async () => {
    stubSkillEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    // Select the skill that will SURVIVE the filter first, so a detail pane
    // echoing the selected skill's name can't keep the filtered-out one alive.
    await user.click(await screen.findByText("Incident Triage"));
    await user.type(getSearchInput(), "incident");

    await waitFor(() => {
      expect(screen.queryByText("Release Checklist")).not.toBeInTheDocument();
    });
    expect(screen.getAllByText("Incident Triage").length).toBeGreaterThan(0);
  });

  it("shows an empty state when the workspace has no skills", async () => {
    stubSkillEndpoints({ skills: [] });
    renderLibrary();

    expect(await screen.findByText(/no skills/i)).toBeInTheDocument();
  });
});

describe("SkillsLibrary — skill detail", () => {
  it("selecting a skill shows its version history and the latest published SKILL.md content", async () => {
    const observed = stubSkillEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    await user.click(await screen.findByText("Release Checklist"));

    expect(
      await screen.findByText(/Tag the release before announcing it/),
    ).toBeInTheDocument();
    // Version history renders every version's status — scoped to the version
    // rows so page chrome (e.g. the "Show archived" toggle) can't satisfy or
    // break the match.
    expect(screen.getByText(/^v2$/).closest("li")).toHaveTextContent(
      /published/i,
    );
    expect(screen.getByText(/^v1$/).closest("li")).toHaveTextContent(
      /archived/i,
    );
    // The content shown must come from the LATEST PUBLISHED version (2).
    expect(observed.versionRequests).toContain("release-checklist@2");
  });

  it("shows catalog provenance for a catalog-originated skill and not for a workspace-native one", async () => {
    stubSkillEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    await user.click(await screen.findByText("Incident Triage"));
    await screen.findByText(/Page the on-call before filing the report/);
    // Exact-match badge: the "From catalog" tab label must NOT satisfy this.
    expect(screen.getByText(/^catalog$/i)).toBeInTheDocument();

    await user.click(screen.getByText("Release Checklist"));
    await screen.findByText(/Tag the release before announcing it/);
    expect(screen.queryByText(/^catalog$/i)).not.toBeInTheDocument();
  });
});

describe("SkillsLibrary — catalog activation", () => {
  it("activating a catalog entry POSTs to the activate endpoint and refreshes the library", async () => {
    const observed = stubSkillEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    await screen.findByText("Release Checklist");
    const listFetchesBeforeActivate = observed.listFetches;

    await user.click(screen.getByText(/from catalog/i));
    await screen.findByText("Postmortem Writer");
    expect(
      screen.getByText("Guidance for writing blameless postmortems"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /activate/i }));

    await waitFor(() => {
      expect(observed.activatePosts).toEqual(["postmortem-writer"]);
    });
    // Invalidation must refetch the workspace list, which now contains the
    // activated skill.
    await waitFor(() => {
      expect(observed.listFetches).toBeGreaterThan(listFetchesBeforeActivate);
    });
    expect(screen.getAllByText("Postmortem Writer").length).toBeGreaterThan(0);
  });
});

describe("SkillsLibrary — catalog activated state", () => {
  // Row-scoped queries: each catalog entry renders as a list item, so scoping
  // to the entry's <li> keeps one row's badge from satisfying another row's
  // assertion.
  async function findCatalogRow(name: string) {
    const label = await screen.findByText(name);
    const row = label.closest("li");
    if (!row) throw new Error('catalog entry row not found for "' + name + '"');
    return within(row);
  }

  it("marks a catalog entry as Activated with a disabled button when a workspace skill shares its slug", async () => {
    // Activation copies slug = catalog_id, so slug identity alone must mark
    // the entry — this skill's origin is null (workspace-native shape).
    stubSkillEndpoints({
      skills: [RELEASE_CHECKLIST],
      entries: [
        {
          catalog_id: "release-checklist",
          catalog_version: 2,
          name: "Release Checklist",
          description: "Steps for tagging and shipping a release",
        },
      ],
    });
    const user = userEvent.setup();
    renderLibrary();

    await user.click(await screen.findByText(/from catalog/i));
    const row = await findCatalogRow("Release Checklist");

    expect(row.getByText(/^activated$/i)).toBeInTheDocument();
    expect(row.getByRole("button", { name: /activate/i })).toBeDisabled();
  });

  it("marks a catalog entry as Activated when a workspace skill's origin references it", async () => {
    // Slug differs from the catalog_id — only the origin
    // "catalog:{catalog_id}@{version}" prefix links skill to entry.
    stubSkillEndpoints({
      skills: [
        {
          id: "skill-7",
          slug: "postmortem-writer-legacy",
          name: "Postmortem Writer (legacy import)",
          description: "Guidance for writing blameless postmortems",
          latest_published_version: 1,
          origin: "catalog:postmortem-writer@3",
          updated_at: "2026-08-22T10:00:00Z",
        },
      ],
    });
    const user = userEvent.setup();
    renderLibrary();

    await user.click(await screen.findByText(/from catalog/i));
    const row = await findCatalogRow("Postmortem Writer");

    expect(row.getByText(/^activated$/i)).toBeInTheDocument();
    expect(row.getByRole("button", { name: /activate/i })).toBeDisabled();
  });

  it("keeps non-activated entries operable while activated ones are marked, and near-miss origins do not match", async () => {
    const observed = stubSkillEndpoints({
      skills: [
        RELEASE_CHECKLIST,
        {
          id: "skill-8",
          slug: "postmortem-writer-extended",
          name: "Postmortem Writer Extended",
          description: "A different catalog lineage",
          latest_published_version: 1,
          // Shares the "catalog:postmortem-writer" text prefix but is a
          // DIFFERENT catalog id — it must NOT mark the postmortem-writer
          // entry (the "@" delimiter is load-bearing in the matcher).
          origin: "catalog:postmortem-writer-extended@1",
          updated_at: "2026-08-22T10:00:00Z",
        },
      ],
      entries: [
        {
          catalog_id: "release-checklist",
          catalog_version: 2,
          name: "Release Checklist",
          description: "Steps for tagging and shipping a release",
        },
        POSTMORTEM_ENTRY,
      ],
    });
    const user = userEvent.setup();
    renderLibrary();

    await user.click(await screen.findByText(/from catalog/i));

    const activatedRow = await findCatalogRow("Release Checklist");
    expect(activatedRow.getByText(/^activated$/i)).toBeInTheDocument();
    expect(
      activatedRow.getByRole("button", { name: /activate/i }),
    ).toBeDisabled();

    const freshRow = await findCatalogRow("Postmortem Writer");
    expect(freshRow.queryByText(/^activated$/i)).not.toBeInTheDocument();
    const activateButton = freshRow.getByRole("button", {
      name: /^activate$/i,
    });
    expect(activateButton).toBeEnabled();

    await user.click(activateButton);
    await waitFor(() => {
      expect(observed.activatePosts).toEqual(["postmortem-writer"]);
    });
  });

  it("shows the Activated state after activating, without a reload", async () => {
    stubSkillEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    await user.click(await screen.findByText(/from catalog/i));
    const row = await findCatalogRow("Postmortem Writer");
    await user.click(row.getByRole("button", { name: /^activate$/i }));

    // Query invalidation refetches the workspace list; the catalog row must
    // flip to Activated with no reload or tab switch.
    await waitFor(() => {
      const freshRow = screen.getByText("Postmortem Writer").closest("li");
      expect(freshRow).not.toBeNull();
      expect(within(freshRow!).getByText(/^activated$/i)).toBeInTheDocument();
      expect(
        within(freshRow!).getByRole("button", { name: /activate/i }),
      ).toBeDisabled();
    });
  });
});
