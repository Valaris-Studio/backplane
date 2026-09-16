// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  waitFor,
  within,
  userEvent,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";

// Authoring controls (New skill / New version / Publish) are admin-gated like
// board skill bindings — same mock idiom as BoardSettingsDialog.skills.test.tsx.
// The library itself stays member-visible; only the new controls are gated.
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
}

// A skill whose LATEST version by number (3) is a draft while the latest
// PUBLISHED version is 2 — this is exactly the state where "pre-fill from the
// latest version" and "pre-fill from the latest published" diverge, so the
// fixtures can pin the former.
const DEPLOY_RUNBOOK: SkillFixture = {
  id: "skill-1",
  slug: "deploy-runbook",
  name: "Deploy Runbook",
  description: "How to roll a release out safely",
  latest_published_version: 2,
  origin: null,
  updated_at: "2026-08-24T10:00:00Z",
};

const CREATED_SKILL: SkillFixture = {
  id: "skill-9",
  slug: "release-notes",
  name: "Release Notes",
  description: "Draft release notes for each tag",
  latest_published_version: null,
  origin: null,
  updated_at: "2026-08-24T12:00:00Z",
};

const VERSION_FILES: Record<number, { path: string; content: string }[]> = {
  3: [
    { path: "SKILL.md", content: "Draft body v3 of the runbook" },
    { path: "references/checklist.md", content: "Check the feature flags" },
  ],
  2: [{ path: "SKILL.md", content: "Published body v2 of the runbook" }],
  1: [{ path: "SKILL.md", content: "Rejected body v1 of the runbook" }],
};

const NEW_SKILL_MD = [
  "---",
  "name: Release Notes",
  "description: Draft release notes for each tag",
  "---",
  "",
  "Write the notes before tagging.",
].join("\n");

interface ErrorOutcome {
  status: number;
  detail: string;
  error_code: string;
}

/**
 * Stubs the skills REST surface incl. the authoring endpoints. Returns
 * observation captures so tests assert on traffic (POST bodies, publish
 * targets, list refetches) without pinning markup. `createSkillOutcome` /
 * `createVersionOutcome` steer the POST responses per test.
 */
function stubAuthoringEndpoints({
  createSkillOutcome = "created",
  createVersionOutcome = "created",
}: {
  createSkillOutcome?: "created" | "exists" | ErrorOutcome;
  createVersionOutcome?: "created" | ErrorOutcome;
} = {}) {
  const observed = {
    listFetches: 0,
    skillPosts: [] as Record<string, unknown>[],
    versionPosts: [] as Record<string, unknown>[],
    publishPosts: [] as string[],
  };
  let liveSkills = [DEPLOY_RUNBOOK];
  const liveVersions = [
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
  ];

  function errorJson(outcome: ErrorOutcome) {
    // House error shape — what the axios interceptor turns into an ApiError.
    return HttpResponse.json(
      {
        detail: outcome.detail,
        error_code: outcome.error_code,
        error_params: {},
        context: null,
      },
      { status: outcome.status },
    );
  }

  server.use(
    http.get(SKILLS_URL, () => {
      observed.listFetches += 1;
      return HttpResponse.json({ skills: liveSkills, count: liveSkills.length });
    }),
    http.get(SKILLS_URL + "/deploy-runbook", () =>
      HttpResponse.json({ ...DEPLOY_RUNBOOK, versions: [...liveVersions] }),
    ),
    http.get(SKILLS_URL + "/deploy-runbook/versions/:n", ({ params }) => {
      const n = Number(params.n);
      return HttpResponse.json({
        files: VERSION_FILES[n] ?? [],
        version: n,
        status: liveVersions.find((v) => v.version === n)?.status ?? "draft",
        content_hash: "hash-dr-" + n,
      });
    }),
    http.post(SKILLS_URL, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      observed.skillPosts.push(body);
      if (createSkillOutcome === "exists") {
        // Idempotent-on-slug: the backend returns the EXISTING skill with 200
        // and does not create a version.
        return HttpResponse.json(DEPLOY_RUNBOOK, { status: 200 });
      }
      if (createSkillOutcome !== "created") return errorJson(createSkillOutcome);
      liveSkills = [...liveSkills, CREATED_SKILL];
      return HttpResponse.json(CREATED_SKILL, { status: 201 });
    }),
    http.post(SKILLS_URL + "/deploy-runbook/versions", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      observed.versionPosts.push(body);
      if (createVersionOutcome !== "created")
        return errorJson(createVersionOutcome);
      const draft = {
        version: 4,
        status: "draft",
        content_hash: "hash-dr-4",
        created_at: "2026-08-24T12:00:00Z",
      };
      liveVersions.unshift(draft);
      return HttpResponse.json({ id: "ver-4", ...draft }, { status: 201 });
    }),
    http.post(
      SKILLS_URL + "/deploy-runbook/versions/:n/publish",
      ({ params }) => {
        observed.publishPosts.push(params.n as string);
        const target = liveVersions.find(
          (v) => v.version === Number(params.n),
        );
        if (target) target.status = "published";
        return HttpResponse.json({ id: "ver-" + params.n, ...target });
      },
    ),
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

function getDialog() {
  return within(screen.getByRole("dialog"));
}

async function openNewSkillDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", { name: /new skill/i }),
  );
  return getDialog();
}

async function selectDeployRunbook(
  user: ReturnType<typeof userEvent.setup>,
) {
  await user.click(await screen.findByText("Deploy Runbook"));
  // Version history rendered ⇒ detail loaded.
  await screen.findByText("v3");
}

beforeEach(() => {
  adminState.current.role = "admin";
});

describe("SkillsLibrary — authoring admin gating", () => {
  it("shows a New skill action to workspace admins", async () => {
    stubAuthoringEndpoints();
    renderLibrary();

    expect(
      await screen.findByRole("button", { name: /new skill/i }),
    ).toBeInTheDocument();
  });

  it("hides New skill, New version, and Publish from plain members", async () => {
    adminState.current.role = "member";
    stubAuthoringEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    // Members keep the read-only library, including a skill WITH a draft
    // version selected — the strongest spot for a stray Publish to leak.
    await selectDeployRunbook(user);

    expect(
      screen.queryByRole("button", { name: /new skill/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /new version/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^publish$/i }),
    ).not.toBeInTheDocument();
  });
});

describe("SkillsLibrary — new skill dialog", () => {
  it("creates a skill: POSTs slug + SKILL.md, closes the dialog, and shows the new skill after refetch", async () => {
    const observed = stubAuthoringEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    await screen.findByText("Deploy Runbook");
    const listFetchesBeforeCreate = observed.listFetches;

    const dialog = await openNewSkillDialog(user);
    await user.type(dialog.getByLabelText(/slug/i), "release-notes");
    const contentArea = dialog.getByLabelText(/skill\.md/i);
    await user.click(contentArea);
    await user.paste(NEW_SKILL_MD);
    await user.click(dialog.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      expect(observed.skillPosts).toHaveLength(1);
    });
    // Frontmatter is authoritative server-side: the body carries slug + files
    // ONLY — no name/description fields.
    expect(observed.skillPosts[0]).toEqual({
      slug: "release-notes",
      files: [{ path: "SKILL.md", content: NEW_SKILL_MD }],
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    // Invalidation refetches the workspace list, which now contains the
    // created skill.
    await waitFor(() => {
      expect(observed.listFetches).toBeGreaterThan(listFetchesBeforeCreate);
    });
    expect(await screen.findByText("Release Notes")).toBeInTheDocument();
  });

  it("includes an added additional file with its relative path in the POST body", async () => {
    const observed = stubAuthoringEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    const dialog = await openNewSkillDialog(user);
    await user.type(dialog.getByLabelText(/slug/i), "release-notes");
    const contentArea = dialog.getByLabelText(/skill\.md/i);
    await user.click(contentArea);
    await user.paste(NEW_SKILL_MD);

    await user.click(dialog.getByRole("button", { name: /add file/i }));
    await user.type(
      dialog.getByLabelText(/path/i),
      "references/links.md",
    );
    // The newly added file's content area is the last textbox in the dialog.
    const boxes = dialog.getAllByRole("textbox");
    const extraContent = boxes[boxes.length - 1]!;
    await user.click(extraContent);
    await user.paste("Link to the changelog");

    await user.click(dialog.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      expect(observed.skillPosts).toHaveLength(1);
    });
    expect(observed.skillPosts[0]).toEqual({
      slug: "release-notes",
      files: [
        { path: "SKILL.md", content: NEW_SKILL_MD },
        { path: "references/links.md", content: "Link to the changelog" },
      ],
    });
  });

  it("reports an already-existing slug honestly instead of pretending it created one", async () => {
    stubAuthoringEndpoints({ createSkillOutcome: "exists" });
    const user = userEvent.setup();
    renderLibrary();

    const dialog = await openNewSkillDialog(user);
    await user.type(dialog.getByLabelText(/slug/i), "deploy-runbook");
    const contentArea = dialog.getByLabelText(/skill\.md/i);
    await user.click(contentArea);
    await user.paste(NEW_SKILL_MD);
    await user.click(dialog.getByRole("button", { name: /create/i }));

    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
  });

  it("surfaces a 422 validation error inside the dialog and keeps it open", async () => {
    stubAuthoringEndpoints({
      createSkillOutcome: {
        status: 422,
        detail: "A skill bundle needs exactly one root SKILL.md",
        error_code: "validation_error",
      },
    });
    const user = userEvent.setup();
    renderLibrary();

    const dialog = await openNewSkillDialog(user);
    await user.type(dialog.getByLabelText(/slug/i), "release-notes");
    const contentArea = dialog.getByLabelText(/skill\.md/i);
    await user.click(contentArea);
    await user.paste("no frontmatter here");
    await user.click(dialog.getByRole("button", { name: /create/i }));

    // Card 958fe45b: the SERVER DETAIL must render verbatim — it is the
    // user-actionable copy ("what to fix"). The generic validation_error
    // catalog string collapsing every failure mode is the bug this pins.
    expect(
      await getDialog().findByText(
        "A skill bundle needs exactly one root SKILL.md",
      ),
    ).toBeInTheDocument();
    expect(
      getDialog().queryByText(/Some information is invalid/),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(getDialog().getByLabelText(/slug/i)).toBeInTheDocument();
  });

  it("falls back to the localized catalog string when the server sends no usable detail", async () => {
    stubAuthoringEndpoints({
      createSkillOutcome: {
        status: 422,
        detail: "",
        error_code: "validation_error",
      },
    });
    const user = userEvent.setup();
    renderLibrary();

    const dialog = await openNewSkillDialog(user);
    await user.type(dialog.getByLabelText(/slug/i), "release-notes");
    await user.click(dialog.getByRole("button", { name: /create/i }));

    expect(
      await getDialog().findByText(/Some information is invalid/),
    ).toBeInTheDocument();
  });
});

describe("SkillsLibrary — new version dialog", () => {
  it("pre-fills from the LATEST version's files (draft v3, not latest published v2)", async () => {
    stubAuthoringEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    await selectDeployRunbook(user);
    await user.click(
      screen.getByRole("button", { name: /new version/i }),
    );

    // Both v3 files pre-filled as editable values: the SKILL.md content, and
    // the additional file's relative path + content.
    expect(
      await screen.findByDisplayValue(/Draft body v3 of the runbook/),
    ).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("references/checklist.md"),
    ).toBeInTheDocument();
    expect(
      screen.getByDisplayValue(/Check the feature flags/),
    ).toBeInTheDocument();
    // The latest-published body must NOT be what the editor starts from.
    expect(
      screen.queryByDisplayValue(/Published body v2 of the runbook/),
    ).not.toBeInTheDocument();
  });

  it("POSTs the edited files to /versions and shows the new draft after refetch", async () => {
    const observed = stubAuthoringEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    await selectDeployRunbook(user);
    await user.click(
      screen.getByRole("button", { name: /new version/i }),
    );

    const contentArea = await screen.findByDisplayValue(
      /Draft body v3 of the runbook/,
    );
    await user.type(contentArea, " plus the rollback step");
    await user.click(getDialog().getByRole("button", { name: /create/i }));

    await waitFor(() => {
      expect(observed.versionPosts).toHaveLength(1);
    });
    const files = observed.versionPosts[0]!.files as {
      path: string;
      content: string;
    }[];
    expect(files).toHaveLength(2);
    const skillMd = files.find((f) => f.path === "SKILL.md");
    expect(skillMd?.content).toMatch(
      /Draft body v3 of the runbook.*plus the rollback step/s,
    );
    expect(files.find((f) => f.path === "references/checklist.md")).toEqual({
      path: "references/checklist.md",
      content: "Check the feature flags",
    });

    // Invalidation refetches the detail — the new draft v4 appears in the
    // version history.
    expect(await screen.findByText("v4")).toBeInTheDocument();
  });

  it("surfaces a 413 bundle-too-large error readably and keeps the dialog open", async () => {
    stubAuthoringEndpoints({
      createVersionOutcome: {
        status: 413,
        detail: "Bundle exceeds 524288 bytes",
        error_code: "payload_too_large",
      },
    });
    const user = userEvent.setup();
    renderLibrary();

    await selectDeployRunbook(user);
    await user.click(
      screen.getByRole("button", { name: /new version/i }),
    );
    await screen.findByDisplayValue(/Draft body v3 of the runbook/);
    await user.click(getDialog().getByRole("button", { name: /create/i }));

    // Card 958fe45b: the server detail (with the concrete byte limit) must
    // render verbatim, not the generic payload_too_large catalog string.
    expect(
      await getDialog().findByText("Bundle exceeds 524288 bytes"),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByDisplayValue(/Draft body v3 of the runbook/),
    ).toBeInTheDocument();
  });
});

describe("SkillsLibrary — publish from the version history", () => {
  function versionRow(label: string) {
    const row = screen.getByText(label).closest("li");
    if (!row) throw new Error('version row not found for "' + label + '"');
    return within(row);
  }

  it("offers Publish only on draft versions and publishes via POST .../versions/{n}/publish", async () => {
    const observed = stubAuthoringEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    await selectDeployRunbook(user);

    // Exactly one Publish control: v3 (draft) has it; v2 (published) and
    // v1 (rejected) must not.
    expect(
      screen.getAllByRole("button", { name: /^publish$/i }),
    ).toHaveLength(1);
    expect(
      versionRow("v3").getByRole("button", { name: /^publish$/i }),
    ).toBeInTheDocument();
    expect(
      versionRow("v2").queryByRole("button", { name: /^publish$/i }),
    ).not.toBeInTheDocument();
    expect(
      versionRow("v1").queryByRole("button", { name: /^publish$/i }),
    ).not.toBeInTheDocument();

    await user.click(
      versionRow("v3").getByRole("button", { name: /^publish$/i }),
    );

    await waitFor(() => {
      expect(observed.publishPosts).toEqual(["3"]);
    });
    // Invalidation refetches the detail: the v3 row's status badge flips
    // draft → Published inline.
    await waitFor(() => {
      expect(
        versionRow("v3").getByText(/^published$/i),
      ).toBeInTheDocument();
    });
  });

  it("never offers edit-in-place on a published version", async () => {
    stubAuthoringEndpoints();
    const user = userEvent.setup();
    renderLibrary();

    await selectDeployRunbook(user);

    // Immutability rail: a published version row exposes no edit affordance
    // and no editable field — new content only ever arrives as a NEW draft.
    const publishedRow = versionRow("v2");
    expect(
      publishedRow.queryByRole("button", { name: /edit/i }),
    ).not.toBeInTheDocument();
    expect(publishedRow.queryByRole("textbox")).not.toBeInTheDocument();
    // Nor anywhere in the detail pane.
    expect(
      screen.queryByRole("button", { name: /edit/i }),
    ).not.toBeInTheDocument();
  });
});

// Review-round guards: loading/error windows and editor affordances the first
// TDD pass left open (silent publish failures, prefill race, stuck flows).
describe("SkillsLibrary — authoring review-round guards", () => {
  it("disables New version until the skill detail has loaded (prefill source unknown before that)", async () => {
    const user = userEvent.setup();
    stubAuthoringEndpoints();
    let releaseDetail: () => void = () => {};
    const detailGate = new Promise<void>((resolve) => {
      releaseDetail = resolve;
    });
    server.use(
      http.get(SKILLS_URL + "/deploy-runbook", async () => {
        await detailGate;
        return HttpResponse.json({
          ...DEPLOY_RUNBOOK,
          versions: [
            {
              version: 3,
              status: "draft",
              content_hash: "hash-dr-3",
              created_at: "2026-08-24T10:00:00Z",
            },
          ],
        });
      }),
    );
    renderLibrary();

    await user.click(await screen.findByText("Deploy Runbook"));
    const newVersion = await screen.findByRole("button", {
      name: /new version/i,
    });
    // Detail still in flight: opening now would prefill from nothing and
    // draft v4 from an empty editor.
    expect(newVersion).toBeDisabled();

    releaseDetail();
    await waitFor(() => expect(newVersion).not.toBeDisabled());
  });

  it("surfaces a publish failure instead of failing silently", async () => {
    const user = userEvent.setup();
    stubAuthoringEndpoints();
    server.use(
      http.post(SKILLS_URL + "/deploy-runbook/versions/:n/publish", () =>
        HttpResponse.json(
          {
            detail: "version was rejected by another decision",
            error_code: "conflict",
            error_params: {},
            context: null,
          },
          { status: 409 },
        ),
      ),
    );
    renderLibrary();
    await selectDeployRunbook(user);

    await user.click(screen.getByRole("button", { name: /^publish$/i }));

    // errors.conflict via resolveApiErrorMessage — the same catalog every
    // other surfaced ApiError uses.
    expect(
      await screen.findByText(/this item changed|went wrong/i),
    ).toBeInTheDocument();
    // The row is honest: still a draft, still publishable.
    expect(
      screen.getByRole("button", { name: /^publish$/i }),
    ).not.toBeDisabled();
  });

  it("surfaces a draft-source fetch failure and does not hang the New version flow", async () => {
    const user = userEvent.setup();
    stubAuthoringEndpoints();
    server.use(
      http.get(SKILLS_URL + "/deploy-runbook/versions/:n", () =>
        HttpResponse.json(
          {
            detail: "boom",
            error_code: "internal_error",
            error_params: {},
            context: null,
          },
          { status: 500 },
        ),
      ),
    );
    renderLibrary();
    await selectDeployRunbook(user);

    await user.click(screen.getByRole("button", { name: /new version/i }));

    expect(
      await screen.findByText(/unexpected error/i),
    ).toBeInTheDocument();
    // No half-open editor: the dialog never mounts off a failed prefill.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("lets the author remove a prefilled extra file before submitting", async () => {
    const user = userEvent.setup();
    const observed = stubAuthoringEndpoints();
    renderLibrary();
    await selectDeployRunbook(user);

    await user.click(screen.getByRole("button", { name: /new version/i }));
    const dialog = getDialog();
    // Prefill carries the v3 extra file; dropping a file from the bundle must
    // be possible in the editor (emptying its fields would just 422).
    expect(
      dialog.getByDisplayValue("references/checklist.md"),
    ).toBeInTheDocument();

    await user.click(dialog.getByRole("button", { name: /remove file/i }));
    expect(
      dialog.queryByDisplayValue("references/checklist.md"),
    ).not.toBeInTheDocument();

    await user.click(dialog.getByRole("button", { name: /create/i }));
    await waitFor(() => expect(observed.versionPosts).toHaveLength(1));
    expect(observed.versionPosts[0]).toEqual({
      files: [{ path: "SKILL.md", content: "Draft body v3 of the runbook" }],
    });
  });

  it("keeps the create submit disabled until a slug is entered", async () => {
    const user = userEvent.setup();
    stubAuthoringEndpoints();
    renderLibrary();

    const dialog = await openNewSkillDialog(user);
    const submit = dialog.getByRole("button", { name: /create/i });
    expect(submit).toBeDisabled();

    await user.type(dialog.getByLabelText(/slug/i), "release-notes");
    expect(submit).not.toBeDisabled();
  });
});

// Owner feedback 2026-08-25: the bare "Path" input gave no clue that it wants
// a bundle-relative path referenced from SKILL.md — the constraints only
// surfaced as a post-submit 422. Guidance must be visible up front.
describe("SkillsLibrary — authoring field guidance", () => {
  it("shows format placeholders on the slug and file-path inputs", async () => {
    const user = userEvent.setup();
    stubAuthoringEndpoints();
    renderLibrary();

    const dialog = await openNewSkillDialog(user);
    expect(dialog.getByLabelText(/slug/i)).toHaveAttribute(
      "placeholder",
      "my-skill-name",
    );

    await user.click(dialog.getByRole("button", { name: /add file/i }));
    expect(dialog.getByLabelText(/path/i)).toHaveAttribute(
      "placeholder",
      "references/checklist.md",
    );
  });

  it("explains that extra-file paths are bundle-relative and referenced from SKILL.md", async () => {
    const user = userEvent.setup();
    stubAuthoringEndpoints();
    renderLibrary();

    const dialog = await openNewSkillDialog(user);
    await user.click(dialog.getByRole("button", { name: /add file/i }));

    expect(
      dialog.getByText(/relative path inside the skill bundle/i),
    ).toBeInTheDocument();
    expect(
      dialog.getByText(/reference it from SKILL\.md/i),
    ).toBeInTheDocument();
  });
});
