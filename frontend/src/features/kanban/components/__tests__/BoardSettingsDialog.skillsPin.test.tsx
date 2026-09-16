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
// gate — same mock idiom as BoardSettingsDialog.skills.test.tsx.
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

// The pin options come from the skill DETAIL, filtered to published versions:
// v3 is draft and v1 archived on release-checklist, so only v2 is pinnable.
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
};

const RELEASE_TOGGLE = { name: /release checklist/i };

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

// The pin control may be the house Select (a button trigger with a listbox
// popup) or a native select (role=combobox) — pin the accessible name
// ("Pinned version", skills.boardSection.pinLabel), not the widget.
function queryPinTriggers() {
  return [
    ...screen.queryAllByRole("button", { name: /pinned version/i }),
    ...screen.queryAllByRole("combobox", { name: /pinned version/i }),
  ];
}

async function findOnlyPinTrigger() {
  return waitFor(() => {
    const triggers = queryPinTriggers();
    expect(triggers).toHaveLength(1);
    return triggers[0]!;
  });
}

function captureBindingPut() {
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
        skill_id: "skill-1",
        slug: "release-checklist",
        name: "Release Checklist",
        description: "Steps for tagging and shipping a release",
        version: 2,
        content_hash: "hash-rc-2",
        enabled: (captured.body.enabled as boolean) ?? true,
        pinned_version: (captured.body.pinned_version as number | null) ?? null,
        role: null,
      });
    }),
  );
  return captured;
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
          SKILL_DETAILS["release-checklist"],
          SKILL_DETAILS["incident-triage"],
        ],
        count: 2,
      }),
    ),
    http.get(`${WORKSPACE_SKILLS_URL}/:skillSlug`, ({ params }) => {
      const detail = SKILL_DETAILS[params.skillSlug as string];
      if (!detail) return new HttpResponse(null, { status: 404 });
      return HttpResponse.json(detail);
    }),
    // Only release-checklist is bound to this board (enabled, unpinned,
    // resolving to v2); incident-triage stays unbound.
    http.get(BOARD_BINDINGS_URL, () =>
      HttpResponse.json({ bindings: [binding()] }),
    ),
  );
});

describe("BoardSettingsDialog — per-board version pin", () => {
  it("bound rows get a pin selector listing latest-published plus only PUBLISHED versions; unbound rows get none", async () => {
    const user = userEvent.setup();
    renderDialog();

    await findToggle(RELEASE_TOGGLE);
    // Exactly one pin control: release-checklist is the only bound skill.
    const trigger = await findOnlyPinTrigger();
    // Unpinned binding → the control shows the latest-published sentinel.
    expect(trigger).toHaveTextContent(/latest published/i);

    await user.click(trigger);
    expect(
      screen.getByRole("option", { name: /latest published/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^v2$/i })).toBeInTheDocument();
    // v3 is draft and v1 archived: neither is a pinnable target.
    expect(
      screen.queryByRole("option", { name: /^v3$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /^v1$/i }),
    ).not.toBeInTheDocument();
  });

  it("choosing a version PUTs that pinned_version with the current enabled state", async () => {
    const captured = captureBindingPut();
    const user = userEvent.setup();
    renderDialog();

    await user.click(await findOnlyPinTrigger());
    await user.click(screen.getByRole("option", { name: /^v2$/i }));

    await waitFor(() => expect(captured.calls).toBe(1));
    expect(captured.slug).toBe("release-checklist");
    expect(captured.body).toMatchObject({ enabled: true, pinned_version: 2 });
  });

  it("choosing latest-published PUTs an EXPLICIT pinned_version null (unpin, not no-change)", async () => {
    server.use(
      http.get(BOARD_BINDINGS_URL, () =>
        HttpResponse.json({
          bindings: [binding({ pinned_version: 2, resolved_version: 2 })],
        }),
      ),
    );
    const captured = captureBindingPut();
    const user = userEvent.setup();
    renderDialog();

    const trigger = await findOnlyPinTrigger();
    // A pinned binding surfaces its pin, not the latest sentinel.
    await waitFor(() => expect(trigger).toHaveTextContent(/v2/i));
    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: /latest published/i }));

    await waitFor(() => expect(captured.calls).toBe(1));
    expect(captured.slug).toBe("release-checklist");
    // Omitted key means "unchanged" server-side — unpinning REQUIRES the key
    // to be present with an explicit null.
    expect(captured.body).toHaveProperty("pinned_version");
    expect(captured.body!.pinned_version).toBeNull();
    expect(captured.body).toMatchObject({ enabled: true });
  });

  // Pin-preservation contract — this test passes against current code BY
  // DESIGN (a guard pin, per the card): the enable toggle must OMIT
  // pinned_version entirely, because the server treats an omitted key as
  // "unchanged". That omission is what lets a pin survive disable/enable
  // cycles; a refactor that starts echoing the pin (or null) in this payload
  // would silently unpin on every toggle.
  it("toggling enabled sends a body WITHOUT the pinned_version key", async () => {
    server.use(
      http.get(BOARD_BINDINGS_URL, () =>
        HttpResponse.json({
          bindings: [binding({ pinned_version: 2, resolved_version: 2 })],
        }),
      ),
    );
    const captured = captureBindingPut();
    const user = userEvent.setup();
    renderDialog();

    await user.click(await findToggle(RELEASE_TOGGLE));

    await waitFor(() => expect(captured.calls).toBe(1));
    expect(captured.slug).toBe("release-checklist");
    expect(captured.body).toMatchObject({ enabled: false });
    expect(captured.body).not.toHaveProperty("pinned_version");
  });

  it("shows the resolved version for a bound row", async () => {
    renderDialog();

    await findToggle(RELEASE_TOGGLE);
    // The raw-bindings endpoint reports resolved_version: 2 — the version the
    // effective set would materialize. Exactly one caption: incident-triage
    // is unbound and must not fabricate one.
    expect(await screen.findByText(/resolves to v2/i)).toBeInTheDocument();
    expect(screen.getAllByText(/resolves to v2/i)).toHaveLength(1);
  });

  it("renders no resolved caption when resolved_version is null (draft-only skill stays honest)", async () => {
    server.use(
      http.get(BOARD_BINDINGS_URL, () =>
        HttpResponse.json({
          bindings: [binding({ resolved_version: null })],
        }),
      ),
      // Nothing published on this skill: only a draft exists, so nothing can
      // resolve and nothing can be pinned.
      http.get(`${WORKSPACE_SKILLS_URL}/release-checklist`, () =>
        HttpResponse.json({
          ...SKILL_DETAILS["release-checklist"],
          latest_published_version: null,
          versions: [
            {
              version: 1,
              status: "draft",
              content_hash: "hash-rc-1",
              created_at: "2026-08-10T10:00:00Z",
            },
          ],
        }),
      ),
    );
    const { queryClient } = renderDialog();

    await findToggle(RELEASE_TOGGLE);
    // Let every query settle so the absence assertions can't pass while the
    // section is still loading.
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));

    expect(screen.queryByText(/resolves to/i)).not.toBeInTheDocument();
    // No bogus rendering of the null either.
    expect(screen.queryByText(/vnull/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/resolves to v\s*$/i)).not.toBeInTheDocument();
  });
});

// Review-round race guards: the three per-row controls (checkbox, pin select,
// Remove) must share one "mutating" state. Otherwise a click landing between
// a mutation settling and the bindings refetch landing can echo stale state
// (pin PUT re-sending a pre-toggle `enabled`) or resurrect a just-removed
// binding (toggle upserting during an in-flight DELETE).
describe("BoardSettingsDialog — skills row mutation guards", () => {
  it("disables the row's toggle and pin selector while an unbind is in flight", async () => {
    const user = userEvent.setup();
    let releaseDelete: () => void = () => {};
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    let unbound = false;
    server.use(
      http.delete(`${BOARD_SKILLS_URL}/:skillSlug`, async () => {
        await deleteGate;
        unbound = true;
        return new HttpResponse(null, { status: 204 });
      }),
      // The refetch after the DELETE must observe the removal, or the row
      // (and its Remove button) would just re-render from stale fixtures.
      http.get(BOARD_BINDINGS_URL, () =>
        HttpResponse.json({ bindings: unbound ? [] : [binding()] }),
      ),
    );
    renderDialog();

    const toggle = await findToggle(RELEASE_TOGGLE);
    const trigger = await findOnlyPinTrigger();
    await user.click(screen.getByRole("button", { name: /^remove$/i }));

    await waitFor(() => expect(toggle).toBeDisabled());
    expect(trigger).toBeDisabled();

    releaseDelete();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /^remove$/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps row controls disabled until the bindings refetch lands after a toggle", async () => {
    const user = userEvent.setup();
    server.use(
      http.put(`${BOARD_SKILLS_URL}/:skillSlug`, () =>
        HttpResponse.json({
          skill_id: "skill-1",
          slug: "release-checklist",
          name: "Release Checklist",
          description: "Steps for tagging and shipping a release",
          version: 2,
          content_hash: "hash-rc-2",
          enabled: false,
          pinned_version: null,
          role: null,
        }),
      ),
    );
    // First GET resolves normally; the post-mutation refetch hangs until
    // released, opening the stale-echo window the guard must cover.
    let releaseRefetch: () => void = () => {};
    const refetchGate = new Promise<void>((resolve) => {
      releaseRefetch = resolve;
    });
    let bindingsServed = 0;
    server.use(
      http.get(BOARD_BINDINGS_URL, async () => {
        bindingsServed += 1;
        if (bindingsServed > 1) await refetchGate;
        return HttpResponse.json({
          bindings: [binding({ enabled: bindingsServed === 1 })],
        });
      }),
    );
    const { queryClient } = renderDialog();

    const toggle = await findToggle(RELEASE_TOGGLE);
    const trigger = await findOnlyPinTrigger();
    await user.click(toggle);

    // PUT has settled but the refetch is gated: the row still renders the
    // pre-toggle cache, so a pin sent now would echo enabled=true. The
    // controls must stay disabled for the whole window.
    await waitFor(() => expect(bindingsServed).toBeGreaterThan(1));
    expect(trigger).toBeDisabled();
    expect(toggle).toBeDisabled();

    releaseRefetch();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    await waitFor(() => expect(trigger).not.toBeDisabled());
    expect(toggle).not.toBeDisabled();
  });
});
