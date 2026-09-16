// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Link, Route, Routes } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  waitFor,
  within,
  userEvent,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { createTestQueryClient } from "@/test/test-utils";
import { loopTemplateKeys } from "@/lib/query-keys";

// Card eb7d83ab — the detail SHELL. RED phase.
//
// Locator contract:
// - "loop-template-detail-header"     — emoji/name/version/badges
// - `loop-template-tab-<tab>`         — one nav link per sub-tab
// - "loop-template-detail-duplicate"  — admin only
// - "loop-template-detail-archive"    — admin AND workspace-source only
// - `loop-template-tabpanel-<tab>`    — the mounted tab body

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

import { LoopTemplateDetailPage } from "../components/LoopTemplateDetailPage";

const SLUG = "acme";
const SYSTEM_REF = "coding-loop";
const WORKSPACE_REF = "11111111-1111-4111-8111-111111111111";

const EMPTY_TRACK_RECORD = {
  iterations: 0,
  spent_usd: 0,
  duration_seconds_total: 0,
  last_used_at: null,
  boards: [],
  outcomes: {
    worked: 0,
    nothing_ready: 0,
    blocked_on_human: 0,
    objective_complete: 0,
    unknown: 0,
  },
  self_terminations: 0,
};

const SYSTEM_DETAIL = {
  id: SYSTEM_REF,
  slug: SYSTEM_REF,
  source: "system",
  name: "Coding loop",
  version: 2,
  is_system: true,
  is_draft: false,
  profile: { emoji: "🔁", tagline: "One card per iteration", tags: [] },
  content: {},
  lineage: null,
  updated_at: "2026-08-16T00:00:00Z",
  has_unpublished_changes: false,
};

const WORKSPACE_DETAIL = {
  ...SYSTEM_DETAIL,
  id: WORKSPACE_REF,
  slug: "docs-sweep",
  source: "workspace",
  name: "Docs Sweep",
  version: 4,
  is_system: false,
  profile: { emoji: "📚", tagline: "Audit the docs tree", tags: [] },
  lineage: { system_slug: "coding-loop", system_version: 2 },
  has_unpublished_changes: true,
};

function serve(ref: string, detail: Record<string, unknown>) {
  const base = `/api/workspaces/${SLUG}/loop-templates/${ref}`;
  server.use(
    http.get(base, () => HttpResponse.json(detail)),
    http.get(`${base}/profile`, () =>
      HttpResponse.json({
        id: detail.id,
        slug: detail.slug,
        source: detail.source,
        name: detail.name,
        version: detail.version,
        is_system: detail.is_system,
        profile: detail.profile,
        boards_using: 0,
        versions: [],
        rails_defaults: {},
        tools: [],
        slots: [],
        setup_contract: {},
        track_record: EMPTY_TRACK_RECORD,
      }),
    ),
  );
}

function renderAt(path: string) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/runner/loops/:templateRef/:tab?"
        element={<LoopTemplateDetailPage />}
      />
    </Routes>,
    { routerProps: { initialEntries: [path] } },
  );
}

describe("LoopTemplateDetailPage", () => {
  beforeEach(() => {
    adminState.current.role = "admin";
    serve(SYSTEM_REF, SYSTEM_DETAIL);
    serve(WORKSPACE_REF, WORKSPACE_DETAIL);
  });

  it("loads a SYSTEM ref and shows its identity in the header", async () => {
    renderAt(`/${SLUG}/runner/loops/${SYSTEM_REF}`);

    const header = await screen.findByTestId("loop-template-detail-header");
    expect(header).toHaveTextContent("Coding loop");
    expect(header).toHaveTextContent("🔁");
    expect(header).toHaveTextContent("v2");
  });

  it("loads a WORKSPACE ref (uuid) and shows its own name, not the system one", async () => {
    renderAt(`/${SLUG}/runner/loops/${WORKSPACE_REF}`);

    const header = await screen.findByTestId("loop-template-detail-header");
    expect(header).toHaveTextContent("Docs Sweep");
    expect(header).toHaveTextContent("v4");
    expect(header).not.toHaveTextContent("Coding loop");
  });

  it("defaults to the profile tab when no tab segment is given", async () => {
    renderAt(`/${SLUG}/runner/loops/${SYSTEM_REF}`);

    await waitFor(() =>
      expect(
        screen.getByTestId("loop-template-tabpanel-profile"),
      ).toBeInTheDocument(),
    );
  });

  it("deep-links straight into the rails tab", async () => {
    renderAt(`/${SLUG}/runner/loops/${SYSTEM_REF}/rails`);

    await waitFor(() =>
      expect(
        screen.getByTestId("loop-template-tabpanel-rails"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("loop-template-tabpanel-profile"),
    ).not.toBeInTheDocument();
  });

  it("falls back to profile for an unknown tab segment", async () => {
    renderAt(`/${SLUG}/runner/loops/${SYSTEM_REF}/not-a-tab`);

    await waitFor(() =>
      expect(
        screen.getByTestId("loop-template-tabpanel-profile"),
      ).toBeInTheDocument(),
    );
  });

  it("links every sub-tab as a ROUTE, so tabs are deep-linkable not local state", async () => {
    renderAt(`/${SLUG}/runner/loops/${SYSTEM_REF}`);

    for (const tab of [
      "profile",
      "prompts",
      "slots",
      "rails",
      "contract",
      "versions",
      "sharing",
    ]) {
      const link = await screen.findByTestId(`loop-template-tab-${tab}`);
      expect(link).toHaveAttribute(
        "href",
        `/${SLUG}/runner/loops/${SYSTEM_REF}/${tab}`,
      );
    }
  });

  it("hides Archive for a SYSTEM template — code-defined templates have no row to archive", async () => {
    renderAt(`/${SLUG}/runner/loops/${SYSTEM_REF}`);

    await screen.findByTestId("loop-template-detail-header");
    expect(
      screen.queryByTestId("loop-template-detail-archive"),
    ).not.toBeInTheDocument();
    // Duplicate is still offered: duplicating a system template is how you
    // get an editable workspace copy.
    expect(
      screen.getByTestId("loop-template-detail-duplicate"),
    ).toBeInTheDocument();
  });

  it("offers Archive for a WORKSPACE template when the viewer is admin", async () => {
    renderAt(`/${SLUG}/runner/loops/${WORKSPACE_REF}`);

    await waitFor(() =>
      expect(
        screen.getByTestId("loop-template-detail-archive"),
      ).toBeInTheDocument(),
    );
  });

  // Devops UX round 2 (#2): a stray click next to Publish/Duplicate must not
  // silently archive — the button opens a confirm dialog, and only the
  // dialog's confirm fires the POST.
  it("archives only after the confirm dialog is accepted", async () => {
    const archived = vi.fn();
    server.use(
      http.post(
        `/api/workspaces/${SLUG}/loop-templates/${WORKSPACE_REF}/archive`,
        () => {
          archived();
          return HttpResponse.json({});
        },
      ),
    );
    renderAt(`/${SLUG}/runner/loops/${WORKSPACE_REF}`);

    await userEvent.click(
      await screen.findByTestId("loop-template-detail-archive"),
    );
    expect(archived).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/keeps serving boards already bound/i),
    ).toBeInTheDocument();

    // Both the header action and the dialog confirm are named "Archive" —
    // scope to the dialog.
    const dialog = screen.getByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Archive" }),
    );
    await waitFor(() => expect(archived).toHaveBeenCalledTimes(1));
  });

  it("hides every mutation for a NON-admin viewer", async () => {
    adminState.current.role = "member";
    renderAt(`/${SLUG}/runner/loops/${WORKSPACE_REF}`);

    await screen.findByTestId("loop-template-detail-header");
    expect(
      screen.queryByTestId("loop-template-detail-duplicate"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("loop-template-detail-archive"),
    ).not.toBeInTheDocument();
  });

  it("shows the unpublished-changes pill only when the template has a divergent draft", async () => {
    renderAt(`/${SLUG}/runner/loops/${WORKSPACE_REF}`);
    await waitFor(() =>
      expect(
        screen.getByTestId("loop-template-draft-pill"),
      ).toBeInTheDocument(),
    );
  });

  it("hides the unpublished-changes pill when draft and published agree", async () => {
    renderAt(`/${SLUG}/runner/loops/${SYSTEM_REF}`);

    await screen.findByTestId("loop-template-detail-header");
    expect(
      screen.queryByTestId("loop-template-draft-pill"),
    ).not.toBeInTheDocument();
  });

  it("duplicating navigates to the new template's own detail page", async () => {
    const created = { ...WORKSPACE_DETAIL, id: "22222222-2222-4222-8222-222222222222" };
    server.use(
      http.post(
        `/api/workspaces/${SLUG}/loop-templates/${SYSTEM_REF}/duplicate`,
        () => HttpResponse.json(created),
      ),
    );
    serve(created.id, created);

    renderAt(`/${SLUG}/runner/loops/${SYSTEM_REF}`);
    await userEvent.click(
      await screen.findByTestId("loop-template-detail-duplicate"),
    );

    await waitFor(() =>
      expect(screen.getByTestId("loop-template-detail-header")).toHaveTextContent(
        "Docs Sweep",
      ),
    );
  });

  // Card 21c48146 (F1) — Publish was a fully-tested component with no
  // production call site. These tests prove REACHABILITY from the shell, which
  // the action's own suite structurally cannot.

  it("offers Publish in the header for an admin on a WORKSPACE template", async () => {
    renderAt(`/${SLUG}/runner/loops/${WORKSPACE_REF}`);

    const header = await screen.findByTestId("loop-template-detail-header");
    await waitFor(() =>
      expect(screen.getByTestId("loop-template-publish-open")).toBeInTheDocument(),
    );
    expect(header).toContainElement(
      screen.getByTestId("loop-template-publish-open"),
    );

    await userEvent.click(screen.getByTestId("loop-template-publish-open"));
    expect(
      await screen.findByTestId("loop-template-publish-confirm"),
    ).toBeInTheDocument();
  });

  it("hides Publish for a SYSTEM template — code-defined templates have no row to publish", async () => {
    renderAt(`/${SLUG}/runner/loops/${SYSTEM_REF}`);

    await screen.findByTestId("loop-template-detail-header");
    // Duplicate still renders, so a missing Publish is the gate and not a
    // header that failed to reach its actions at all.
    expect(
      screen.getByTestId("loop-template-detail-duplicate"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("loop-template-publish-open"),
    ).not.toBeInTheDocument();
  });

  it("hides Publish for a NON-admin viewer", async () => {
    adminState.current.role = "member";
    renderAt(`/${SLUG}/runner/loops/${WORKSPACE_REF}`);

    await screen.findByTestId("loop-template-detail-header");
    expect(
      screen.queryByTestId("loop-template-publish-open"),
    ).not.toBeInTheDocument();
  });

  it("places Publish BEFORE Duplicate and Archive so the primary action leads the tab order", async () => {
    renderAt(`/${SLUG}/runner/loops/${WORKSPACE_REF}`);

    const header = await screen.findByTestId("loop-template-detail-header");
    await waitFor(() =>
      expect(screen.getByTestId("loop-template-publish-open")).toBeInTheDocument(),
    );
    const order = Array.from(
      header.querySelectorAll<HTMLElement>("[data-testid]"),
    )
      .map((element) => element.dataset.testid)
      .filter((id): id is string => !!id && id.startsWith("loop-template-"))
      .filter((id) =>
        [
          "loop-template-publish-open",
          "loop-template-detail-duplicate",
          "loop-template-detail-archive",
        ].includes(id),
      );
    expect(order).toEqual([
      "loop-template-publish-open",
      "loop-template-detail-duplicate",
      "loop-template-detail-archive",
    ]);
  });

  it("navigates to the tab that owns a 422 finding — the real route, not a spy", async () => {
    server.use(
      http.post(
        `/api/workspaces/${SLUG}/loop-templates/${WORKSPACE_REF}/publish`,
        () =>
          HttpResponse.json(
            {
              detail: [
                {
                  field: "slots.RUN_LABEL",
                  code: "slot_missing_default",
                  message: "RUN_LABEL has no default",
                },
              ],
            },
            { status: 422 },
          ),
      ),
      http.get(`/api/workspaces/${SLUG}/loop-templates`, () =>
        HttpResponse.json({ templates: [], meta: { runner_vars: ["BoardID"] } }),
      ),
    );

    renderAt(`/${SLUG}/runner/loops/${WORKSPACE_REF}`);
    await userEvent.click(
      await screen.findByTestId("loop-template-publish-open"),
    );
    await userEvent.click(
      await screen.findByTestId("loop-template-publish-confirm"),
    );

    await userEvent.click(await screen.findByTestId("loop-template-finding-0"));

    // `slots.RUN_LABEL` is owned by the slots tab: the shell must actually be
    // on that ROUTE, which is what proves onNavigateToTab used the nav's own
    // route shape rather than a segment `resolveTab` silently swallows.
    await waitFor(() =>
      expect(
        screen.getByTestId("loop-template-tabpanel-slots"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("loop-template-tabpanel-profile"),
    ).not.toBeInTheDocument();
  });

  it("settles the header after a 200 publish — version advances and the draft pill clears", async () => {
    // The header reads the draft=true detail entry; this serves a CHANGED
    // detail after publish so a stale header is visible as a stale version.
    //
    // The settling mechanism is the action's own `loopTemplateKeys.all(slug)`
    // invalidation, which IS a prefix of `detail(slug, ref, true)` — verified
    // by mutation: removing it leaves this test red. The shell therefore does
    // NOT add a second refetch path (card Deliverable).
    let published = false;
    const base = `/api/workspaces/${SLUG}/loop-templates/${WORKSPACE_REF}`;
    const publishBodies: Record<string, unknown>[] = [];
    server.use(
      http.get(base, () =>
        HttpResponse.json(
          published
            ? { ...WORKSPACE_DETAIL, version: 5, has_unpublished_changes: false }
            : WORKSPACE_DETAIL,
        ),
      ),
      http.post(`${base}/publish`, async ({ request }) => {
        publishBodies.push((await request.json()) as Record<string, unknown>);
        published = true;
        return HttpResponse.json({ ...WORKSPACE_DETAIL, version: 5 });
      }),
    );

    renderAt(`/${SLUG}/runner/loops/${WORKSPACE_REF}`);
    const header = await screen.findByTestId("loop-template-detail-header");
    await waitFor(() => expect(header).toHaveTextContent("v4"));
    expect(screen.getByTestId("loop-template-draft-pill")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("loop-template-publish-open"));
    await userEvent.click(
      await screen.findByTestId("loop-template-publish-confirm"),
    );

    await waitFor(() => expect(header).toHaveTextContent("v5"));
    expect(
      screen.queryByTestId("loop-template-draft-pill"),
    ).not.toBeInTheDocument();
    // The optimistic lock is the version the header itself displayed, not a
    // coerced 0 — publishing against the wrong version is what a 409 is for.
    expect(publishBodies).toEqual([
      { expected_version: 4, note: null },
    ]);
  });

  it("locks publish against the header's own version — a never-published draft sends null, not 0", async () => {
    const FIRST_PUBLISH = {
      ...WORKSPACE_DETAIL,
      version: null,
      has_unpublished_changes: true,
    };
    const base = `/api/workspaces/${SLUG}/loop-templates/${WORKSPACE_REF}`;
    const publishBodies: Record<string, unknown>[] = [];
    server.use(
      http.get(base, () => HttpResponse.json(FIRST_PUBLISH)),
      http.post(`${base}/publish`, async ({ request }) => {
        publishBodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ...FIRST_PUBLISH, version: 1 });
      }),
    );

    renderAt(`/${SLUG}/runner/loops/${WORKSPACE_REF}`);
    await userEvent.click(
      await screen.findByTestId("loop-template-publish-open"),
    );
    await userEvent.click(
      await screen.findByTestId("loop-template-publish-confirm"),
    );

    await waitFor(() =>
      expect(publishBodies).toEqual([{ expected_version: null, note: null }]),
    );
  });

  it("keeps the dialog open on a 409 so the conflict is not lost behind the header", async () => {
    server.use(
      http.post(
        `/api/workspaces/${SLUG}/loop-templates/${WORKSPACE_REF}/publish`,
        () =>
          HttpResponse.json({ detail: "stale_version" }, { status: 409 }),
      ),
    );

    renderAt(`/${SLUG}/runner/loops/${WORKSPACE_REF}`);
    await userEvent.click(
      await screen.findByTestId("loop-template-publish-open"),
    );
    await userEvent.click(
      await screen.findByTestId("loop-template-publish-confirm"),
    );

    expect(
      await screen.findByTestId("loop-template-publish-conflict"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("loop-template-publish-confirm"),
    ).toBeInTheDocument();
  });

  it("mounts the prompts tab body on the prompts route (card 199bf1ec)", async () => {
    // The shell shipped `prompts` as a comingSoon placeholder; this pins that
    // the real editor is what the route now resolves to.
    serve(WORKSPACE_REF, WORKSPACE_DETAIL);
    server.use(
      http.get(`/api/workspaces/${SLUG}/loop-templates`, () =>
        HttpResponse.json({ templates: [], meta: { runner_vars: ["BoardID"] } }),
      ),
    );

    renderAt(`/${SLUG}/runner/loops/${WORKSPACE_REF}/prompts`);

    expect(
      await screen.findByTestId("loop-template-prompts-tab"),
    ).toBeInTheDocument();
    expect(await screen.findByTestId("loop-template-loop_prompt")).toBeInTheDocument();
  });
});

// Card e5ecad48 (F2) — ONE draft store at the shell + the save-status
// indicator. These cases need a harness the older `serve()` cannot give:
// a PATCH endpoint, a draft/published split, and a countable request log.
describe("LoopTemplateDetailPage draft store (card e5ecad48)", () => {
  let patches: Record<string, unknown>[];

  const DRAFT_DETAIL = {
    ...WORKSPACE_DETAIL,
    content: { system_prompt: "sys", loop_prompt: "loop", slots: [] },
    draft_updated_at: "2026-08-17T11:30:00Z",
  };

  /** A template whose draft is editable, with PATCHes recorded. */
  function serveEditable(
    ref: string,
    detail: Record<string, unknown>,
    patchResponder?: () => Response,
  ) {
    const base = `/api/workspaces/${SLUG}/loop-templates/${ref}`;
    serve(ref, detail);
    server.use(
      http.get(base, () => HttpResponse.json(detail)),
      http.patch(base, async ({ request }) => {
        patches.push((await request.json()) as Record<string, unknown>);
        return patchResponder
          ? patchResponder()
          : HttpResponse.json({
              ...detail,
              draft_updated_at: "2026-08-17T12:00:00Z",
            });
      }),
      http.get(`/api/workspaces/${SLUG}/loop-templates`, () =>
        HttpResponse.json({ templates: [], meta: { runner_vars: ["BoardID"] } }),
      ),
    );
  }

  const status = () => screen.getByTestId("loop-template-save-status");

  beforeEach(() => {
    patches = [];
    adminState.current.role = "admin";
    serveEditable(WORKSPACE_REF, DRAFT_DETAIL);
  });

  it("renames through the shared draft store, carrying the lock token", async () => {
    // AC5 + AC6. A rename that PATCHed directly would work on screen and still
    // be wrong: it would bypass `expected_updated_at`, so a concurrent editor
    // would be silently overwritten instead of getting a conflict. Assert the
    // TOKEN, not just that some request carried the new name.
    const user = userEvent.setup();
    renderAt(`/${SLUG}/runner/loops/${WORKSPACE_REF}`);

    await user.click(await screen.findByTestId("loop-template-rename"));
    const field = await screen.findByTestId("loop-template-name-input");
    await user.clear(field);
    await user.type(field, "Renamed Loop");
    await user.tab();

    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    expect(patches[0]).toMatchObject({
      name: "Renamed Loop",
      expected_updated_at: DRAFT_DETAIL.draft_updated_at,
    });
  });

  it("shows the renamed value in the header without waiting for a refetch", async () => {
    const user = userEvent.setup();
    renderAt(`/${SLUG}/runner/loops/${WORKSPACE_REF}`);

    await user.click(await screen.findByTestId("loop-template-rename"));
    const field = await screen.findByTestId("loop-template-name-input");
    await user.clear(field);
    await user.type(field, "Renamed Loop");
    await user.tab();

    await waitFor(() =>
      expect(screen.getByTestId("loop-template-detail-header")).toHaveTextContent(
        "Renamed Loop",
      ),
    );
  });

  it("renames from the PROFILE header and the shell <h1> follows (F9 AC3)", async () => {
    // The two surfaces share ONE store, so the shell heading updates with no
    // refetch. A second write path would render the new name only in the
    // header that owns it — which is what this asserts against.
    const user = userEvent.setup();
    renderAt(`/${SLUG}/runner/loops/${WORKSPACE_REF}/profile`);

    const field = await screen.findByTestId("loop-template-profile-name-input");
    await user.clear(field);
    await user.type(field, "Renamed From Profile");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1 }),
      ).toHaveTextContent("Renamed From Profile"),
    );
    // ...and it is the SHARED store, so the rename carries the one lock token.
    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    expect(patches[patches.length - 1]).toMatchObject({
      name: "Renamed From Profile",
      expected_updated_at: DRAFT_DETAIL.draft_updated_at,
    });
  });

  it("offers NO rename affordance on a system template", async () => {
    // System templates are CODE-defined: there is no row to PATCH, so the
    // affordance must be absent rather than present-and-failing.
    serveEditable(SYSTEM_REF, { ...SYSTEM_DETAIL, content: {} });
    renderAt(`/${SLUG}/runner/loops/${SYSTEM_REF}`);

    await screen.findByTestId("loop-template-detail-header");
    expect(screen.queryByTestId("loop-template-rename")).not.toBeInTheDocument();
  });

  it("offers NO rename affordance to a non-admin", async () => {
    adminState.current.role = "member";
    renderAt(`/${SLUG}/runner/loops/${WORKSPACE_REF}`);

    await screen.findByTestId("loop-template-detail-header");
    expect(screen.queryByTestId("loop-template-rename")).not.toBeInTheDocument();
  });

  it("keeps a prompts edit across a round trip through the slots tab, with ONE patch", async () => {
    const user = userEvent.setup();
    renderAt(`/${SLUG}/runner/loops/${WORKSPACE_REF}/prompts`);

    const field = await screen.findByTestId("loop-template-loop_prompt");
    await user.clear(field);
    await user.type(field, "SURVIVES");

    // A real route change through the shell's own nav: the prompts tab
    // UNMOUNTS. With four stores its draft died here; with one shell-level
    // store it is still in memory.
    await user.click(screen.getByTestId("loop-template-tab-slots"));
    expect(
      await screen.findByTestId("loop-template-slots-tab"),
    ).toBeInTheDocument();

    await user.click(screen.getByTestId("loop-template-tab-prompts"));
    await waitFor(() =>
      expect(screen.getByTestId("loop-template-loop_prompt")).toHaveValue(
        "SURVIVES",
      ),
    );

    // Request count, not just the rendered value: two stores would each have
    // flushed their own snapshot of the same edit.
    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      expected_updated_at: DRAFT_DETAIL.draft_updated_at,
    });
  });

  it("walks saved -> unsaved -> saving -> saved through the header indicator", async () => {
    let release: (() => void) | undefined;
    serveEditable(WORKSPACE_REF, DRAFT_DETAIL, () => {
      return new Promise<Response>((resolve) => {
        release = () =>
          resolve(
            HttpResponse.json({
              ...DRAFT_DETAIL,
              draft_updated_at: "2026-08-17T12:00:00Z",
            }),
          );
      }) as unknown as Response;
    });

    const user = userEvent.setup();
    renderAt(`/${SLUG}/runner/loops/${WORKSPACE_REF}/prompts`);

    const field = await screen.findByTestId("loop-template-loop_prompt");
    expect(status()).toHaveAttribute("data-state", "saved");

    await user.type(field, "x");
    await waitFor(() => expect(status()).toHaveAttribute("data-state", "unsaved"));

    await waitFor(
      () => expect(status()).toHaveAttribute("data-state", "saving"),
      { timeout: 3000 },
    );

    await waitFor(() => expect(release).toBeDefined());
    release?.();
    await waitFor(() => expect(status()).toHaveAttribute("data-state", "saved"));
  });

  it("latches conflict on a 409 and clears it through the indicator's Reload", async () => {
    let conflicting = true;
    serveEditable(WORKSPACE_REF, DRAFT_DETAIL, () =>
      conflicting
        ? HttpResponse.json({ detail: "stale" }, { status: 409 })
        : HttpResponse.json(DRAFT_DETAIL),
    );

    const user = userEvent.setup();
    renderAt(`/${SLUG}/runner/loops/${WORKSPACE_REF}/prompts`);

    const field = await screen.findByTestId("loop-template-loop_prompt");
    await user.type(field, "x");

    await waitFor(
      () => expect(status()).toHaveAttribute("data-state", "conflict"),
      { timeout: 3000 },
    );

    conflicting = false;
    await user.click(screen.getByTestId("loop-template-save-status-reload"));
    await waitFor(() => expect(status()).toHaveAttribute("data-state", "saved"));
  });

  it("mounts a FRESH store when the route moves to a different template", async () => {
    const OTHER_REF = "22222222-2222-4222-8222-222222222222";
    const OTHER_DETAIL = {
      ...DRAFT_DETAIL,
      id: OTHER_REF,
      name: "Other loop",
      content: { system_prompt: "other sys", loop_prompt: "other loop", slots: [] },
    };
    serveEditable(OTHER_REF, OTHER_DETAIL);

    const user = userEvent.setup();
    // A LIVE ref change with BOTH templates already in cache. Priming matters:
    // on a cold cache the shell's `!template` gate renders a Skeleton and tears
    // the provider subtree down anyway, so the `key` would never be the thing
    // under test. Warm, the shell never unmounts and only the `key` can stop B
    // from inheriting A's store.
    const client = createTestQueryClient();
    for (const [ref, detail] of [
      [WORKSPACE_REF, DRAFT_DETAIL],
      [OTHER_REF, OTHER_DETAIL],
    ] as const) {
      client.setQueryData(loopTemplateKeys.detail(SLUG, ref, true), detail);
    }
    renderWithProviders(
      <>
        <Link
          to={`/${SLUG}/runner/loops/${OTHER_REF}/prompts`}
          data-testid="loop-template-goto-other"
        >
          go
        </Link>
        <Routes>
          <Route
            path="/:slug/runner/loops/:templateRef/:tab?"
            element={<LoopTemplateDetailPage />}
          />
        </Routes>
      </>,
      {
        queryClient: client,
        routerProps: {
          initialEntries: [`/${SLUG}/runner/loops/${WORKSPACE_REF}/prompts`],
        },
      },
    );

    const field = await screen.findByTestId("loop-template-loop_prompt");
    await user.type(field, "dirty-A");
    await waitFor(() => expect(status()).toHaveAttribute("data-state", "unsaved"));

    // The shell's own nav cannot reach another template, so drive the router
    // the way the library page does — a Link rendered inside the same tree.
    await user.click(screen.getByTestId("loop-template-goto-other"));

    // Leaving a DIRTY template is exactly what card 0cbf1049's guard stops, so
    // this isolation test has to answer the prompt before it can cross over.
    await user.click(await screen.findByTestId("unsaved-changes-discard"));

    // Template B must not inherit A's dirty state or A's draft content.
    await waitFor(() =>
      expect(screen.getByTestId("loop-template-loop_prompt")).toHaveValue(
        "other loop",
      ),
    );
    expect(status()).toHaveAttribute("data-state", "saved");
  });
});

describe("LoopTemplateDetailPage no lost edits (card 0cbf1049)", () => {
  let patches: Record<string, unknown>[];

  const DRAFT_DETAIL = {
    ...WORKSPACE_DETAIL,
    content: { system_prompt: "sys", loop_prompt: "loop", slots: [] },
    draft_updated_at: "2026-08-17T11:30:00Z",
  };

  function serveEditable(ref: string, detail: Record<string, unknown>) {
    const base = `/api/workspaces/${SLUG}/loop-templates/${ref}`;
    serve(ref, detail);
    server.use(
      http.get(base, () => HttpResponse.json(detail)),
      http.patch(base, async ({ request }) => {
        patches.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({
          ...detail,
          draft_updated_at: "2026-08-17T12:00:00Z",
        });
      }),
      http.get(`/api/workspaces/${SLUG}/loop-templates`, () =>
        HttpResponse.json({ templates: [], meta: { runner_vars: ["BoardID"] } }),
      ),
    );
  }

  /** The shell plus somewhere else to navigate TO. */
  function renderWithExit(ref = WORKSPACE_REF) {
    return renderWithProviders(
      <>
        <Link to={`/${SLUG}/runner/loops`} data-testid="leave-the-template">
          leave
        </Link>
        <Routes>
          <Route
            path="/:slug/runner/loops/:templateRef/:tab?"
            element={<LoopTemplateDetailPage />}
          />
          <Route
            path="/:slug/runner/loops"
            element={<div data-testid="loop-template-library-stub" />}
          />
        </Routes>
      </>,
      {
        routerProps: {
          initialEntries: [`/${SLUG}/runner/loops/${ref}/prompts`],
        },
      },
    );
  }

  beforeEach(() => {
    patches = [];
    adminState.current.role = "admin";
    serveEditable(WORKSPACE_REF, DRAFT_DETAIL);
    serveEditable(SYSTEM_REF, { ...DRAFT_DETAIL, ...SYSTEM_DETAIL, content: DRAFT_DETAIL.content });
  });

  it("PATCHes the typed value when the tab switch beats the 800ms debounce", async () => {
    // AC1. The shell-level store already keeps the draft in memory across the
    // switch; what this pins is that the value reaches the SERVER — assert the
    // request body, not the rendered field.
    const user = userEvent.setup();
    renderAt(`/${SLUG}/runner/loops/${WORKSPACE_REF}/prompts`);

    const field = await screen.findByTestId("loop-template-loop_prompt");
    await user.clear(field);
    await user.type(field, "BEATS THE DEBOUNCE");
    await user.click(screen.getByTestId("loop-template-tab-rails"));

    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    expect(patches.at(-1)).toMatchObject({
      content: expect.objectContaining({ loop_prompt: "BEATS THE DEBOUNCE" }),
    });
  });

  it("prompts instead of leaving when in-app navigation abandons a dirty draft", async () => {
    const user = userEvent.setup();
    renderWithExit();

    const field = await screen.findByTestId("loop-template-loop_prompt");
    await user.type(field, "x");

    await user.click(screen.getByTestId("leave-the-template"));

    expect(await screen.findByTestId("unsaved-changes-prompt")).toBeInTheDocument();
    // "Keep editing" is the whole point: the route must NOT have changed.
    expect(
      screen.queryByTestId("loop-template-library-stub"),
    ).not.toBeInTheDocument();
  });

  it("cancels the anchor's own default navigation, not just React Router's", async () => {
    // stopPropagation alone keeps the Link's handler from running, so the
    // in-app route holds — but the browser would still follow the href and do
    // a FULL page load, which jsdom never performs and no route assertion can
    // see. preventDefault is the only thing that stops it.
    const user = userEvent.setup();
    renderWithExit();

    const field = await screen.findByTestId("loop-template-loop_prompt");
    await user.type(field, "x");

    const link = screen.getByTestId("leave-the-template");
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    link.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
  });

  it("Keep editing dismisses the prompt and stays on the template", async () => {
    const user = userEvent.setup();
    renderWithExit();

    const field = await screen.findByTestId("loop-template-loop_prompt");
    await user.type(field, "x");
    await user.click(screen.getByTestId("leave-the-template"));
    await screen.findByTestId("unsaved-changes-prompt");

    await user.click(screen.getByTestId("unsaved-changes-keep-editing"));

    await waitFor(() =>
      expect(
        screen.queryByTestId("unsaved-changes-prompt"),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("loop-template-library-stub"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("loop-template-loop_prompt")).toBeInTheDocument();
  });

  it("Discard leaves the template WITHOUT flushing the draft", async () => {
    const user = userEvent.setup();
    renderWithExit();

    const field = await screen.findByTestId("loop-template-loop_prompt");
    await user.clear(field);
    await user.type(field, "THROWN AWAY");
    await user.click(screen.getByTestId("leave-the-template"));
    await screen.findByTestId("unsaved-changes-prompt");

    await user.click(screen.getByTestId("unsaved-changes-discard"));

    expect(
      await screen.findByTestId("loop-template-library-stub"),
    ).toBeInTheDocument();
    // Discard means discard: the abandoned text must never reach the server.
    expect(
      patches.some((body) =>
        JSON.stringify(body).includes("THROWN AWAY"),
      ),
    ).toBe(false);
  });

  it("Save flushes the draft and then leaves", async () => {
    const user = userEvent.setup();
    renderWithExit();

    const field = await screen.findByTestId("loop-template-loop_prompt");
    await user.clear(field);
    await user.type(field, "SAVED ON THE WAY OUT");
    await user.click(screen.getByTestId("leave-the-template"));
    await screen.findByTestId("unsaved-changes-prompt");

    await user.click(screen.getByTestId("unsaved-changes-save"));

    await waitFor(() =>
      expect(
        patches.some((body) =>
          JSON.stringify(body).includes("SAVED ON THE WAY OUT"),
        ),
      ).toBe(true),
    );
    expect(
      await screen.findByTestId("loop-template-library-stub"),
    ).toBeInTheDocument();
    // Exactly one: navigating first would unmount the store mid-request and
    // its unmount flush would send the same body a second time.
    expect(
      patches.filter((body) =>
        JSON.stringify(body).includes("SAVED ON THE WAY OUT"),
      ),
    ).toHaveLength(1);
  });

  it("stays put when the flush the prompt asked for CONFLICTS", async () => {
    // The reachable difference between awaiting the flush and navigating
    // straight away: a 409 latches conflict, and leaving would strand the
    // operator elsewhere with the work unsaved and the banner behind them.
    const base = `/api/workspaces/${SLUG}/loop-templates/${WORKSPACE_REF}`;
    server.use(
      http.patch(base, () => HttpResponse.json({ detail: "stale" }, { status: 409 })),
    );

    const user = userEvent.setup();
    renderWithExit();

    const field = await screen.findByTestId("loop-template-loop_prompt");
    await user.clear(field);
    await user.type(field, "LOSES A RACE");
    await user.click(screen.getByTestId("leave-the-template"));
    await screen.findByTestId("unsaved-changes-prompt");

    await user.click(screen.getByTestId("unsaved-changes-save"));

    await waitFor(() =>
      expect(screen.getByTestId("loop-template-save-status")).toHaveAttribute(
        "data-state",
        "conflict",
      ),
    );
    expect(
      screen.queryByTestId("loop-template-library-stub"),
    ).not.toBeInTheDocument();
  });

  it("a clean draft leaves immediately with no prompt", async () => {
    const user = userEvent.setup();
    renderWithExit();

    await screen.findByTestId("loop-template-loop_prompt");
    await user.click(screen.getByTestId("leave-the-template"));

    expect(
      await screen.findByTestId("loop-template-library-stub"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("unsaved-changes-prompt"),
    ).not.toBeInTheDocument();
  });

  it("a read-only SYSTEM template never prompts — there is nothing to save", async () => {
    const user = userEvent.setup();
    renderWithExit(SYSTEM_REF);

    await screen.findByTestId("loop-template-loop_prompt");
    await user.click(screen.getByTestId("leave-the-template"));

    expect(
      await screen.findByTestId("loop-template-library-stub"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("unsaved-changes-prompt"),
    ).not.toBeInTheDocument();
  });

  it("binds NO document listener at all while the template is read-only", async () => {
    // The dirty check alone would already keep the prompt away — a read-only
    // store refuses setField, so it can never be dirty. This pins the separate
    // promise the guard makes: a system template costs no capture-phase
    // listener on every click in the app.
    const add = vi.spyOn(document, "addEventListener");
    renderWithExit(SYSTEM_REF);
    await screen.findByTestId("loop-template-loop_prompt");

    const captureClicks = add.mock.calls.filter(
      ([type, , options]) => type === "click" && options === true,
    );
    expect(captureClicks).toHaveLength(0);
    add.mockRestore();
  });

  it("binds the capture-phase listener for an EDITABLE template", async () => {
    // The other half of the pair: without it the assertion above would pass on
    // a guard that never registers anything for anyone.
    const add = vi.spyOn(document, "addEventListener");
    renderWithExit();
    await screen.findByTestId("loop-template-loop_prompt");

    const captureClicks = add.mock.calls.filter(
      ([type, , options]) => type === "click" && options === true,
    );
    expect(captureClicks).toHaveLength(1);
    add.mockRestore();
  });
});

// Card 2c18790f (F6) — the shell says WHY editing is off, once, above the
// tabs. The four per-tab notices all read "System templates are defined in
// code", which becomes a flat lie the moment a MEMBER opens a WORKSPACE
// template: nothing about that template is code-defined, and the remedy is a
// role, not a duplicate.
describe("LoopTemplateDetailPage read-only reason (card 2c18790f)", () => {
  beforeEach(() => {
    serve(SYSTEM_REF, SYSTEM_DETAIL);
    serve(WORKSPACE_REF, WORKSPACE_DETAIL);
  });

  it("tells a MEMBER on a workspace template that it is their ROLE", async () => {
    adminState.current.role = "member";
    renderAt(`/${SLUG}/runner/loops/${WORKSPACE_REF}`);

    const banner = await screen.findByTestId("loop-template-readonly-banner");
    expect(banner).toHaveAttribute("data-reason", "role");
    expect(banner).toHaveTextContent(/only workspace admins can edit/i);
    // The system remedy would send them to Duplicate, which is not the fix.
    expect(banner).not.toHaveTextContent(/built-in|defined in code/i);
  });

  it("tells anyone on a SYSTEM template that it is a built-in template", async () => {
    adminState.current.role = "admin";
    renderAt(`/${SLUG}/runner/loops/${SYSTEM_REF}`);

    const banner = await screen.findByTestId("loop-template-readonly-banner");
    expect(banner).toHaveAttribute("data-reason", "system");
    expect(banner).toHaveTextContent(/built-in template/i);
    expect(banner).not.toHaveTextContent(/only workspace admins/i);
  });

  it("shows the SYSTEM reason to a member on a system template, not the role one", async () => {
    // Both conditions hold at once. Naming the role would be actively
    // misleading: promoting this member to admin still would not let them
    // edit a code-defined template.
    adminState.current.role = "member";
    renderAt(`/${SLUG}/runner/loops/${SYSTEM_REF}`);

    const banner = await screen.findByTestId("loop-template-readonly-banner");
    expect(banner).toHaveAttribute("data-reason", "system");
  });

  it("shows NO banner to an admin on a workspace template", async () => {
    adminState.current.role = "admin";
    renderAt(`/${SLUG}/runner/loops/${WORKSPACE_REF}`);

    await screen.findByTestId("loop-template-detail-header");
    expect(
      screen.queryByTestId("loop-template-readonly-banner"),
    ).not.toBeInTheDocument();
  });
});
