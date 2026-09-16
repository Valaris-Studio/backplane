// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import {
  createTestQueryClient,
  renderWithProviders,
  screen,
  waitFor,
  userEvent,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import type { Board } from "@/types/kanban";

// Skill bindings are admin-gated like the freeze section and the done merge
// gate — same mock idiom as BoardSettingsDialog.doneGate.test.tsx.
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

import { BoardSettingsDialog } from "../BoardSettingsDialog";

const SLUG = "acme";
const BOARD_ID = "board-1";
const CONFIG_URL = `/api/workspaces/${SLUG}/config`;
const WORKSPACE_SKILLS_URL = `/api/workspaces/${SLUG}/skills`;
const BOARD_SKILLS_URL = `/api/workspaces/${SLUG}/boards/${BOARD_ID}/skills`;
const BOARD_BINDINGS_URL = `${BOARD_SKILLS_URL}/bindings`;

// The dialog reads RAW bindings, not the effective set: a disabled or
// draft-only binding is absent from the effective set, which made it render
// as "no binding at all" — unchecked, and with no way to remove it.
function binding(overrides: Record<string, unknown> = {}) {
  return {
    skill_id: "skill-1",
    slug: "release-checklist",
    name: "Release Checklist",
    enabled: true,
    pinned_version: null,
    role: null,
    resolved_version: 2,
    ...overrides,
  };
}

// Skill details keyed by slug: the version-pin selector enumerates a bound
// skill's PUBLISHED versions from this endpoint, so every workspace skill in
// the fixtures must answer it.
const SKILL_DETAILS: Record<string, Record<string, unknown>> = {
  "release-checklist": {
    id: "skill-1",
    slug: "release-checklist",
    name: "Release Checklist",
    description: "Steps for tagging and shipping a release",
    latest_published_version: 2,
    origin: null,
    updated_at: "2026-08-20T10:00:00Z",
    versions: [
      {
        version: 3,
        status: "draft",
        content_hash: "hash-rc-3",
        created_at: "2026-08-22T10:00:00Z",
      },
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
  },
  "incident-triage": {
    id: "skill-2",
    slug: "incident-triage",
    name: "Incident Triage",
    description: "How to route production incidents",
    latest_published_version: 1,
    origin: "catalog:incident-triage@1",
    updated_at: "2026-08-21T10:00:00Z",
    versions: [
      {
        version: 1,
        status: "published",
        content_hash: "hash-it-1",
        created_at: "2026-08-21T10:00:00Z",
      },
    ],
  },
  "postmortem-writer": {
    id: "skill-3",
    slug: "postmortem-writer",
    name: "Postmortem Writer",
    description: "Guidance for writing blameless postmortems",
    latest_published_version: 1,
    origin: "catalog:postmortem-writer@3",
    updated_at: "2026-08-22T10:00:00Z",
    versions: [
      {
        version: 1,
        status: "published",
        content_hash: "hash-pw-1",
        created_at: "2026-08-22T10:00:00Z",
      },
    ],
  },
};

const RELEASE_TOGGLE = { name: /release checklist/i };
const INCIDENT_TOGGLE = { name: /incident triage/i };

function makeBoard(): Board {
  return {
    id: BOARD_ID,
    slug: null,
    name: "Ops Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    is_frozen: false,
    enforce_done_merge_gate: null,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  } as Board;
}

function renderDialog(queryClient = createTestQueryClient()) {
  const view = renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId/*"
        element={
          <BoardSettingsDialog board={makeBoard()} open onOpenChange={() => {}} />
        }
      />
    </Routes>,
    {
      routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}/kanban`] },
      queryClient,
    },
  );
  return { view, queryClient };
}

// The per-skill binding control may be a Switch (role=switch) or a Checkbox
// (role=checkbox) — pin the accessible name + checked state, not the widget.
function queryToggle(
  scope: { queryByRole: ReturnType<typeof renderWithProviders>["queryByRole"] },
  query: { name: RegExp },
) {
  return (
    scope.queryByRole("switch", query) ?? scope.queryByRole("checkbox", query)
  );
}

async function findToggle(query: { name: RegExp }) {
  return waitFor(() => {
    const toggle = queryToggle(screen, query);
    expect(toggle).toBeInTheDocument();
    return toggle!;
  });
}

beforeEach(() => {
  adminState.current.role = "admin";
  server.use(
    http.get(CONFIG_URL, () =>
      HttpResponse.json({
        max_rework_attempts: 3,
        card_cooldown_hours: 1,
        commit_message_template: "",
        pr_description_template: "",
        pipeline_config: null,
        version: 1,
        enforce_done_merge_gate: true,
      }),
    ),
    http.get(WORKSPACE_SKILLS_URL, () =>
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
    http.get(`${WORKSPACE_SKILLS_URL}/:skillSlug`, ({ params }) => {
      const detail = SKILL_DETAILS[params.skillSlug as string];
      if (!detail) return new HttpResponse(null, { status: 404 });
      return HttpResponse.json(detail);
    }),
    // Only release-checklist is bound to this board, enabled.
    http.get(BOARD_BINDINGS_URL, () =>
      HttpResponse.json({ bindings: [binding()] }),
    ),
  );
});

describe("BoardSettingsDialog — skills section", () => {
  it("lists workspace skills with per-skill controls reflecting current bindings", async () => {
    renderDialog();

    expect(await screen.findByText(/^skills$/i)).toBeInTheDocument();
    expect(await findToggle(RELEASE_TOGGLE)).toBeChecked();
    expect(await findToggle(INCIDENT_TOGGLE)).not.toBeChecked();
  });

  it("enabling an unbound skill PUTs {enabled: true} to that skill's binding endpoint", async () => {
    const captured = {
      calls: 0,
      slug: null as string | null,
      body: null as Record<string, unknown> | null,
    };
    server.use(
      http.put(`${BOARD_SKILLS_URL}/:skillSlug`, async ({ request, params }) => {
        captured.calls += 1;
        captured.slug = params.skillSlug as string;
        captured.body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          skill_id: "skill-2",
          slug: "incident-triage",
          name: "Incident Triage",
          description: "How to route production incidents",
          version: 1,
          content_hash: "hash-it-1",
          enabled: true,
          pinned_version: null,
          role: null,
        });
      }),
    );
    const user = userEvent.setup();
    renderDialog();

    await user.click(await findToggle(INCIDENT_TOGGLE));

    await waitFor(() => expect(captured.calls).toBe(1));
    expect(captured.slug).toBe("incident-triage");
    expect(captured.body).toMatchObject({ enabled: true });
  });

  it("unbinding a bound skill DELETEs its binding", async () => {
    const captured = { calls: 0, slug: null as string | null };
    server.use(
      http.delete(`${BOARD_SKILLS_URL}/:skillSlug`, ({ params }) => {
        captured.calls += 1;
        captured.slug = params.skillSlug as string;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderDialog();

    // Only the bound skill offers a remove/unbind affordance.
    await findToggle(RELEASE_TOGGLE);
    await user.click(
      await screen.findByRole("button", { name: /remove|unbind/i }),
    );

    await waitFor(() => expect(captured.calls).toBe(1));
    expect(captured.slug).toBe("release-checklist");
  });

  it("renders a DISABLED binding as unchecked but still removable", async () => {
    // The regression: reading the effective set, a disabled binding was
    // absent, so it rendered identically to an unbound skill — unchecked AND
    // with no Remove button, leaving no way to undo the bind.
    server.use(
      http.get(BOARD_BINDINGS_URL, () =>
        HttpResponse.json({ bindings: [binding({ enabled: false })] }),
      ),
    );
    renderDialog();

    expect(await findToggle(RELEASE_TOGGLE)).not.toBeChecked();
    expect(
      await screen.findByRole("button", { name: /remove|unbind/i }),
    ).toBeInTheDocument();
  });

  it("a plain member gets no operable binding controls, while an admin does with the identical query", async () => {
    adminState.current.role = "member";
    const { view: memberView, queryClient } = renderDialog();

    // Anchor on the dialog form being truly rendered, then let queries settle
    // so the absence assertion can't pass while the section is still loading.
    await memberView.findByRole("button", { name: /^save$/i });
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));

    // "Disabled or absent" both satisfy the gate — a present-but-operable
    // control is the only failure.
    const memberToggle = queryToggle(memberView, RELEASE_TOGGLE);
    if (memberToggle) {
      expect(memberToggle).toBeDisabled();
    }
    const memberRemove = memberView.queryByRole("button", {
      name: /remove|unbind/i,
    });
    if (memberRemove) {
      expect(memberRemove).toBeDisabled();
    }
    memberView.unmount();

    // Positive control with the IDENTICAL queries: if the control's role/name
    // drifts, this half goes red instead of the member half passing vacuously.
    adminState.current.role = "admin";
    renderDialog();
    const adminToggle = await findToggle(RELEASE_TOGGLE);
    expect(adminToggle).toBeEnabled();
  });
});
describe("BoardSettingsDialog — binding state captions", () => {
  // Tri-state legibility: unbound / bound-disabled / bound-enabled must be
  // three DISTINGUISHABLE renderings, without changing the semantics (the
  // checkbox still disables, Remove still unbinds).
  it("captions the enabled binding's row as bound and leaves the unbound row uncaptioned", async () => {
    renderDialog();

    expect(await findToggle(RELEASE_TOGGLE)).toBeChecked();
    // Exactly one caption: release-checklist is the only binding, so the
    // unbound incident-triage row must contribute no state caption.
    await waitFor(() => {
      expect(screen.getAllByText(/^bound$/i)).toHaveLength(1);
    });
    expect(
      screen.queryByText(/bound\s*·\s*disabled/i),
    ).not.toBeInTheDocument();
  });

  it("captions a DISABLED binding as bound-but-disabled, distinct from unbound", async () => {
    server.use(
      http.get(BOARD_BINDINGS_URL, () =>
        HttpResponse.json({ bindings: [binding({ enabled: false })] }),
      ),
    );
    renderDialog();

    expect(await findToggle(RELEASE_TOGGLE)).not.toBeChecked();
    expect(
      await screen.findByText(/bound\s*·\s*disabled/i),
    ).toBeInTheDocument();
    // One state, one label: the plain "bound" caption must not also render.
    expect(screen.queryByText(/^bound$/i)).not.toBeInTheDocument();
    // Semantics unchanged: the disabled binding is still removable.
    expect(
      screen.getByRole("button", { name: /remove|unbind/i }),
    ).toBeInTheDocument();
  });

  it("renders one caption per bound row when enabled and disabled bindings coexist", async () => {
    server.use(
      http.get(WORKSPACE_SKILLS_URL, () =>
        HttpResponse.json({
          skills: [
            SKILL_DETAILS["release-checklist"],
            SKILL_DETAILS["incident-triage"],
            // A third, unbound skill: proves captions track binding state,
            // not mere list membership.
            SKILL_DETAILS["postmortem-writer"],
          ],
          count: 3,
        }),
      ),
      http.get(BOARD_BINDINGS_URL, () =>
        HttpResponse.json({
          bindings: [
            binding(),
            binding({
              skill_id: "skill-2",
              slug: "incident-triage",
              name: "Incident Triage",
              enabled: false,
              resolved_version: 1,
            }),
          ],
        }),
      ),
    );
    renderDialog();

    await findToggle(RELEASE_TOGGLE);
    expect(await screen.findByText(/^bound$/i)).toBeInTheDocument();
    expect(screen.getByText(/bound\s*·\s*disabled/i)).toBeInTheDocument();
    expect(screen.getAllByText(/^bound$/i)).toHaveLength(1);
    expect(screen.getAllByText(/bound\s*·\s*disabled/i)).toHaveLength(1);
  });
});
