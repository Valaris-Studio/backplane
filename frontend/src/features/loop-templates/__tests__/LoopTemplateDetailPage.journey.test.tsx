// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  waitFor,
  userEvent,
  act,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";

// Card T2 — ONE detail-page session, not one component.
//
// Every other loop-template suite mounts a single tab in isolation, and all of
// them passed while the four-store bug (F2) and the dropped debounce (F3) were
// live: no test ever switched tabs, so no test ever crossed the seam where the
// work was lost. These three journeys cross it on purpose.
//
// The premise is the debounce window. AUTOSAVE_DEBOUNCE_MS is 800 and REAL
// timers are used here deliberately: a synchronous `click` on the next tab
// lands microseconds after the keystroke, comfortably inside 800 ms, so the
// edit is genuinely still pending when the route changes. Fake timers would
// also work but need `advanceTimers` wiring through userEvent and would let a
// mis-set clock quietly satisfy the premise for the wrong reason.

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
import {
  TemplateDraftProvider,
  useTemplateDraftContext,
} from "../hooks/TemplateDraftProvider";
import type { TemplateDraftStore } from "../hooks/useTemplateDraft";

const SLUG = "acme";
const REF = "11111111-1111-4111-8111-111111111111";
const BASE = `/api/workspaces/${SLUG}/loop-templates/${REF}`;

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

interface RecordedPatch {
  name?: string;
  content?: { slots?: { name: string; label?: string }[] };
  expected_updated_at?: string | null;
}

/** Every request the journey cares about, in the order the page issued it. */
let calls: { method: "PATCH" | "POST"; body: unknown }[];
let detail: Record<string, unknown>;

function patches(): RecordedPatch[] {
  return calls
    .filter((call) => call.method === "PATCH")
    .map((call) => call.body as RecordedPatch);
}

function slotLabelsIn(patch: RecordedPatch | undefined): string[] {
  return (patch?.content?.slots ?? []).map((slot) => slot.label ?? "");
}

function installHandlers() {
  calls = [];
  detail = {
    id: REF,
    slug: "docs-sweep",
    source: "workspace",
    name: "Docs Sweep",
    version: 4,
    is_system: false,
    is_draft: false,
    profile: { emoji: "📚", tagline: "Audit the docs tree", tags: [] },
    // One slot, deliberately with an EMPTY label: the journey types the label
    // and asserts that exact string reaches the wire, so the fixture must not
    // already contain anything resembling it.
    content: {
      system_prompt: "You are an agent.",
      loop_prompt: "Do <<TARGET>>.",
      slots: [{ name: "TARGET", kind: "string", required: true, label: "" }],
    },
    lineage: null,
    updated_at: "2026-08-16T00:00:00Z",
    draft_updated_at: "2026-08-16T00:00:00Z",
    has_unpublished_changes: false,
  };

  server.use(
    // The editor asks for the DRAFT half (`?draft=true`); the same handler
    // serves both so a stray paramless read cannot silently 404 into a
    // permanent loading shell.
    http.get(BASE, () => HttpResponse.json(detail)),
    http.get(`${BASE}/profile`, () =>
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
    http.get(`${BASE}/versions`, () => HttpResponse.json([])),
    // A real server APPLIES the patch. Echoing the fixture back instead would
    // make "the value survived a round-trip" pass even if the body were empty,
    // which is precisely the vacuity this journey exists to rule out.
    http.patch(BASE, async ({ request }) => {
      const body = (await request.json()) as RecordedPatch;
      calls.push({ method: "PATCH", body });
      detail = {
        ...detail,
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.content === undefined ? {} : { content: body.content }),
        draft_updated_at: `2026-08-16T00:00:0${calls.length}Z`,
        has_unpublished_changes: true,
      };
      return HttpResponse.json(detail);
    }),
    http.post(`${BASE}/publish`, async ({ request }) => {
      const body = await request.json();
      calls.push({ method: "POST", body });
      detail = {
        ...detail,
        version: (detail.version as number) + 1,
        has_unpublished_changes: false,
      };
      return HttpResponse.json(detail);
    }),
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

/** The slot row's collapsed half hides `label`; open it before typing. */
async function openSlotEditor(user: ReturnType<typeof userEvent.setup>) {
  const disclosure = await screen.findByTestId(
    "loop-template-slot-disclosure-TARGET",
  );
  await user.click(disclosure);
  return screen.findByTestId("loop-template-slot-label");
}

describe("loop-template detail page — journey 1: a tab switch loses no edits", () => {
  beforeEach(() => {
    adminState.current.role = "admin";
    installHandlers();
  });

  it("carries a still-pending slot edit across a tab navigation and round-trips it", async () => {
    const user = userEvent.setup();
    renderAt(`/${SLUG}/runner/loops/${REF}/slots`);

    const label = await openSlotEditor(user);
    await user.type(label, "Sweep target");

    // Nothing has been sent yet: this is the window the bug lived in. If this
    // ever fails, the debounce premise is gone and every assertion below is
    // measuring something other than what this test claims to measure.
    expect(patches()).toHaveLength(0);

    await user.click(screen.getByTestId("loop-template-tab-rails"));

    // The URL-driven remount really happened — the slots panel is gone.
    await waitFor(() =>
      expect(screen.getByTestId("loop-template-tabpanel-rails")).toBeTruthy(),
    );
    expect(screen.queryByTestId("loop-template-tabpanel-slots")).toBeNull();
    expect(screen.queryByTestId("loop-template-slot-label")).toBeNull();

    // The edit lands. Asserting the BODY, not a "Saved" indicator: the store
    // can render "saved" off local state while having sent nothing.
    await waitFor(() => expect(patches().length).toBeGreaterThan(0));
    await waitFor(() =>
      expect(slotLabelsIn(patches().at(-1))).toEqual(["Sweep target"]),
    );

    // …and it round-trips. `gcTime: 0` drops the unmounted tab's query, so
    // coming back to Slots is a genuine refetch against the mutated fixture —
    // proof the save was PERSISTED, not merely fired.
    await user.click(screen.getByTestId("loop-template-tab-slots"));
    const reopened = await openSlotEditor(user);
    await waitFor(() =>
      expect((reopened as HTMLInputElement).value).toBe("Sweep target"),
    );
  });

  it("keeps the one shared lock token across tabs — no patch replays a spent token", async () => {
    const user = userEvent.setup();
    renderAt(`/${SLUG}/runner/loops/${REF}/slots`);

    const label = await openSlotEditor(user);
    await user.type(label, "First");
    await user.click(screen.getByTestId("loop-template-tab-rails"));
    await waitFor(() => expect(patches().length).toBeGreaterThan(0));

    // Back to Slots, edit again. Four independent stores each held their own
    // `expected_updated_at`, so the second tab's first save replayed the token
    // it hydrated with and the server answered 409 on a template only one
    // person was editing. One store means the token advances monotonically.
    await user.click(screen.getByTestId("loop-template-tab-slots"));
    const reopened = await openSlotEditor(user);
    await user.clear(reopened);
    await user.type(reopened, "Second");
    await waitFor(() =>
      expect(slotLabelsIn(patches().at(-1))).toEqual(["Second"]),
    );

    const tokens = patches().map((patch) => patch.expected_updated_at);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(tokens.at(-1)).not.toBe(tokens[0]);
  });
});

describe("loop-template detail page — journey 2: publish from the header", () => {
  beforeEach(() => {
    adminState.current.role = "admin";
    installHandlers();
  });

  it("publishes with the version the header shows and reflects the bump", async () => {
    const user = userEvent.setup();
    renderAt(`/${SLUG}/runner/loops/${REF}/slots`);

    // The header states the version the publish must lock against; reading it
    // off the screen rather than the fixture is what makes the assertion below
    // a claim about the UI's own promise.
    const header = await screen.findByTestId("loop-template-detail-header");
    expect(header.textContent).toContain("v4");

    await user.click(await screen.findByTestId("loop-template-publish-open"));
    await user.click(await screen.findByTestId("loop-template-publish-confirm"));

    await waitFor(() =>
      expect(calls.some((call) => call.method === "POST")).toBe(true),
    );
    const publish = calls.find((call) => call.method === "POST")
      ?.body as { expected_version?: number };
    expect(publish.expected_version).toBe(4);

    await waitFor(() =>
      expect(
        screen.getByTestId("loop-template-detail-header").textContent,
      ).toContain("v5"),
    );
  });

  it("lands a pending slot edit BEFORE the publish, so v5 cannot snapshot a stale draft", async () => {
    const user = userEvent.setup();
    renderAt(`/${SLUG}/runner/loops/${REF}/slots`);

    const label = await openSlotEditor(user);
    await user.type(label, "Pending when published");
    expect(patches()).toHaveLength(0);

    await user.click(await screen.findByTestId("loop-template-publish-open"));
    await user.click(await screen.findByTestId("loop-template-publish-confirm"));

    await waitFor(() =>
      expect(calls.some((call) => call.method === "POST")).toBe(true),
    );

    // Ordering, not merely presence: a publish that overtakes the autosave
    // freezes a version WITHOUT the edit the operator just made, and the UI
    // shows no error at all — the loss is only visible in the published copy.
    const patchIndex = calls.findIndex((call) => call.method === "PATCH");
    const publishIndex = calls.findIndex((call) => call.method === "POST");
    expect(patchIndex).toBeGreaterThanOrEqual(0);
    expect(patchIndex).toBeLessThan(publishIndex);
    expect(slotLabelsIn(calls[patchIndex]?.body as RecordedPatch)).toEqual([
      "Pending when published",
    ]);
  });
});

describe("loop-template detail page — journey 3: a non-admin gets a read-only page", () => {
  beforeEach(() => {
    adminState.current.role = "member";
    installHandlers();
  });

  it("hides every mutating action and sends no PATCH when a member types", async () => {
    const user = userEvent.setup();
    renderAt(`/${SLUG}/runner/loops/${REF}/slots`);

    await screen.findByTestId("loop-template-detail-header");
    expect(screen.queryByTestId("loop-template-publish-open")).toBeNull();
    expect(screen.queryByTestId("loop-template-detail-duplicate")).toBeNull();
    expect(screen.queryByTestId("loop-template-detail-archive")).toBeNull();

    // F6: `readOnlyReason` is "role" for a member, so the editor is present
    // (a member may READ the template) but every control is disabled.
    const label = await openSlotEditor(user);
    expect((label as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByTestId("loop-template-slot-name") as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByTestId("loop-template-slot-add")).toBeNull();

    await user.type(label, "should not save");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(calls).toHaveLength(0);
  });

  it("refuses the write in the STORE, not only in the disabled attribute", async () => {
    // The assertion above passes for a weak reason: typing into a disabled
    // input is a DOM no-op, so it would still pass with `setField`'s and
    // `persist`'s readOnly guards both deleted. Those guards are the layer
    // that matters — the unmount flush and `beforeunload` reach `persist()`
    // with no user gesture at all — so they need an assertion that reaches
    // them. Rendering the store directly is the only input that does.
    // `latest` is re-assigned on EVERY render. Holding one captured snapshot
    // instead would read `dirty` from the object built before the write, which
    // is false whether the guard held or not — the assertion would pass with
    // both guards deleted and prove nothing.
    let latest!: TemplateDraftStore;
    function CaptureStore() {
      latest = useTemplateDraftContext();
      return <span data-testid="store-ready" />;
    }
    renderWithProviders(
      <TemplateDraftProvider slug={SLUG} templateRef={REF}>
        <CaptureStore />
      </TemplateDraftProvider>,
    );
    await waitFor(() => expect(latest.draft).not.toBeNull());

    expect(latest.readOnly).toBe(true);
    expect(latest.readOnlyReason).toBe("role");

    // Drive the setter the way the unmount flush would, bypassing the DOM.
    await act(async () => {
      latest.setField("content.slots", [{ name: "TARGET", label: "forced" }]);
    });
    expect(latest.dirty).toBe(false);
    expect(latest.draft?.content).toEqual(
      expect.objectContaining({
        slots: [{ name: "TARGET", kind: "string", required: true, label: "" }],
      }),
    );

    // …and prove the second guard independently: even a store told to flush
    // sends nothing, so a member who navigates away cannot PATCH on the way out.
    await act(async () => {
      await latest.flush();
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(calls).toHaveLength(0);
  });
});
