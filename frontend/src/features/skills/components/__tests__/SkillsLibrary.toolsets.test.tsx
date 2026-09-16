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
import i18n from "@/i18n/config";
import { SkillsLibrary } from "@/features/skills/components/SkillsLibrary";

// MCP #3 — skills declare their toolsets. The library shows the declared hand
// as one chip per toolset id (raw id text, e.g. "cards") on every list item
// and again in the detail header, and the detail surfaces the backend's
// guidance-vs-hand lint (`lint_warnings`: tools the playbook names outside its
// declared toolsets) as an inline note.
//
// Pinned shapes the implementer must match:
//   data-testid="skill-toolset-chip"   one per toolset id, text = the raw id
//   data-testid="skill-lint-warnings"  the inline note (absent when no warnings)
//   i18n key skills.detail.lintWarnings — the note's copy (interpolates the
//   offending tool names; the static prefix before the first `{{` must render)

const SLUG = "acme";
const SKILLS_URL = "/api/workspaces/" + SLUG + "/skills";
const CATALOG_URL = "/api/workspaces/" + SLUG + "/skill-catalog";
const CHIP = "skill-toolset-chip";
const LINT_NOTE = "skill-lint-warnings";

const RELEASE_CHECKLIST = {
  id: "skill-1",
  slug: "release-checklist",
  name: "Release Checklist",
  description: "Steps for tagging and shipping a release",
  latest_published_version: 2,
  origin: null,
  updated_at: "2026-08-20T10:00:00Z",
  archived_at: null,
  toolsets: ["cards", "notes"],
};

const INCIDENT_TRIAGE = {
  id: "skill-2",
  slug: "incident-triage",
  name: "Incident Triage",
  description: "How to route production incidents",
  latest_published_version: 1,
  origin: "catalog:incident-triage@1",
  updated_at: "2026-08-21T10:00:00Z",
  archived_at: null,
  toolsets: [] as string[],
};

const VERSIONS = {
  "release-checklist": [
    {
      version: 2,
      status: "published",
      content_hash: "hash-rc-2",
      created_at: "2026-08-20T10:00:00Z",
    },
  ],
  "incident-triage": [
    {
      version: 1,
      status: "published",
      content_hash: "hash-it-1",
      created_at: "2026-08-21T10:00:00Z",
    },
  ],
};

const CATALOG_RELEASE_NOTES = {
  catalog_id: "release-notes",
  catalog_version: 1,
  name: "Release Notes",
  description: "Turning a merged board column into a changelog",
  toolsets: ["cards", "notes"],
};

// Predates the toolsets field (older backend): renders, no chips.
const CATALOG_UNDECLARED = {
  catalog_id: "undeclared-legacy",
  catalog_version: 1,
  name: "Undeclared Legacy",
  description: "Stored before skills declared a hand",
};

function stubSkillEndpoints({
  lintWarnings = {} as Record<string, string[] | undefined>,
  catalogEntries = [] as Array<Record<string, unknown>>,
} = {}) {
  const skills = [RELEASE_CHECKLIST, INCIDENT_TRIAGE];
  server.use(
    http.get(SKILLS_URL, () =>
      HttpResponse.json({ skills, count: skills.length }),
    ),
    http.get(SKILLS_URL + "/:skillSlug", ({ params }) => {
      const skillSlug = params.skillSlug as string;
      const skill = skills.find((s) => s.slug === skillSlug);
      if (!skill) return new HttpResponse(null, { status: 404 });
      const warnings = lintWarnings[skillSlug];
      return HttpResponse.json({
        ...skill,
        versions: VERSIONS[skillSlug as keyof typeof VERSIONS],
        // Omit the key entirely when the scenario says "absent": the UI must
        // treat a missing field like an empty list, not crash on undefined.
        ...(warnings === undefined ? {} : { lint_warnings: warnings }),
      });
    }),
    http.get(SKILLS_URL + "/:skillSlug/versions/:n", ({ params }) =>
      HttpResponse.json({
        files: [{ path: "SKILL.md", content: "Body of " + params.skillSlug }],
        version: Number(params.n),
        status: "published",
        content_hash: "hash-" + (params.skillSlug as string),
        toolsets: [],
      }),
    ),
    http.get(CATALOG_URL, () => HttpResponse.json({ entries: catalogEntries })),
  );
}

function renderLibrary() {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/skills" element={<SkillsLibrary />} />
    </Routes>,
    { routerProps: { initialEntries: ["/" + SLUG + "/skills"] } },
  );
}

// The list row is the <li> around the skill's name button; the detail header
// is everything NOT inside a list row (the h2 + its badges). Chips are told
// apart by that containment so the test does not pin the header's markup.
function listRow(name: string) {
  const row = screen.getByText(name, { selector: "button *" }).closest("li");
  expect(row, `no list row for ${name}`).not.toBeNull();
  return row as HTMLElement;
}

function chipTexts(scope: HTMLElement) {
  return within(scope)
    .queryAllByTestId(CHIP)
    .map((chip) => chip.textContent?.trim());
}

function detailChipTexts() {
  return screen
    .queryAllByTestId(CHIP)
    .filter((chip) => chip.closest("li") === null)
    .map((chip) => chip.textContent?.trim());
}

function lintCopyPrefix() {
  const key = "skills.detail.lintWarnings";
  const value = i18n.t(key);
  expect(value, `${key} is missing from en.json`).not.toBe(key);
  return (value.split("{{")[0] ?? "").trim();
}

describe("SkillsLibrary — toolset chips on list items", () => {
  it("renders one chip per declared toolset id, in declaration order", async () => {
    stubSkillEndpoints();
    renderLibrary();

    await screen.findByText("Release Checklist");
    expect(chipTexts(listRow("Release Checklist"))).toEqual(["cards", "notes"]);
  });

  it("renders no chip for a skill with an empty declaration", async () => {
    stubSkillEndpoints();
    renderLibrary();

    await screen.findByText("Incident Triage");
    expect(chipTexts(listRow("Incident Triage"))).toEqual([]);
  });
});

describe("SkillsLibrary — toolset chips in the detail header", () => {
  it("repeats the selected skill's toolsets outside the list", async () => {
    stubSkillEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    await user.click(await screen.findByText("Release Checklist"));
    await screen.findByText(/Body of release-checklist/);

    await waitFor(() => {
      expect(detailChipTexts()).toEqual(["cards", "notes"]);
    });
  });

  it("shows no detail chips for a skill with an empty declaration", async () => {
    stubSkillEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    await user.click(await screen.findByText("Incident Triage"));
    await screen.findByText(/Body of incident-triage/);

    expect(detailChipTexts()).toEqual([]);
  });
});

describe("SkillsLibrary — guidance-vs-hand lint note", () => {
  it("renders the lint note with the i18n copy and the offending tool name", async () => {
    stubSkillEndpoints({
      lintWarnings: { "release-checklist": ["delete_workspace"] },
    });
    const user = userEvent.setup();
    renderLibrary();

    await user.click(await screen.findByText("Release Checklist"));

    const note = await screen.findByTestId(LINT_NOTE);
    expect(note).toHaveTextContent("delete_workspace");
    expect(note).toHaveTextContent(lintCopyPrefix());
  });

  it("renders no note when lint_warnings is empty", async () => {
    stubSkillEndpoints({ lintWarnings: { "release-checklist": [] } });
    const user = userEvent.setup();
    renderLibrary();

    await user.click(await screen.findByText("Release Checklist"));
    await screen.findByText(/Body of release-checklist/);

    expect(screen.queryByTestId(LINT_NOTE)).not.toBeInTheDocument();
  });

  it("renders no note when lint_warnings is absent from the payload", async () => {
    stubSkillEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    await user.click(await screen.findByText("Incident Triage"));
    await screen.findByText(/Body of incident-triage/);

    expect(screen.queryByTestId(LINT_NOTE)).not.toBeInTheDocument();
  });
});

describe("SkillsLibrary — toolset chips on catalog entries", () => {
  async function openCatalogTab() {
    const user = userEvent.setup();
    renderLibrary();
    await screen.findByText("Release Checklist");
    const tabLabel = i18n.t("skills.tabs.fromCatalog");
    expect(tabLabel, "skills.tabs.fromCatalog is missing from en.json").not.toBe(
      "skills.tabs.fromCatalog",
    );
    await user.click(screen.getByRole("button", { name: tabLabel }));
  }

  async function catalogRow(name: string) {
    const row = (await screen.findByText(name)).closest("li");
    expect(row, `no catalog row for ${name}`).not.toBeNull();
    return row as HTMLElement;
  }

  it("renders one chip per declared toolset id under the entry", async () => {
    stubSkillEndpoints({ catalogEntries: [CATALOG_RELEASE_NOTES] });
    await openCatalogTab();

    expect(chipTexts(await catalogRow("Release Notes"))).toEqual(["cards", "notes"]);
  });

  it("renders no chip for an entry whose payload has no toolsets field", async () => {
    stubSkillEndpoints({
      catalogEntries: [CATALOG_RELEASE_NOTES, CATALOG_UNDECLARED],
    });
    await openCatalogTab();

    expect(chipTexts(await catalogRow("Undeclared Legacy"))).toEqual([]);
    expect(chipTexts(await catalogRow("Release Notes"))).toEqual(["cards", "notes"]);
  });
});
