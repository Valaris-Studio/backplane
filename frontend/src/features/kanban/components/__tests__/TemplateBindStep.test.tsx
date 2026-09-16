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

// Card 198b13f7 (p3-07a) — TemplateBindStep. RED phase.
//
// The bind step is where a template meets THIS board: a fit checklist with the
// three server-allowed one-click fixes, a slot form generated from the
// template's SlotSpec catalog (autofill pre-filled and labelled with its
// source), variant radios, and a Save that PUTs the canonical template body.
//
// Direction pins asserted here:
// - rails are saved as EXPLICIT values (template defaults copied in), never
//   left for the server to fill at read time.
// - Fix buttons exist ONLY for fix_ids the report advertised.

const adminState = { current: { role: "admin" as string | null } };
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

import { TemplateBindStep } from "../loop-template/TemplateBindStep";

const SLUG = "acme";
const BOARD_ID = "ops-board";
const BOARD_UUID = "0b7c1e2a-4c1d-4a9a-9c2e-2f6d8f3a1b11";
const REF = "coding-loop-v2";

const DETAIL_URL = `/api/workspaces/${SLUG}/loop-templates/${REF}`;
const FIT_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/loop-templates/${REF}/fit`;
const FIT_APPLY_URL = `${FIT_URL}/apply`;
const LOOP_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/loop`;

// The template's authored catalog. `kind` values are the backend's SlotKind
// literals; RAILS_DEFAULTS is what the Direction requires be copied into the
// PUT rather than relied upon server-side.
const SLOTS = [
  {
    name: "OBJECTIVE",
    kind: "block",
    required: true,
    label: "Objective",
    help: "What this loop is for.",
  },
  {
    name: "REPO_URL",
    kind: "scalar",
    required: true,
    label: "Repo URL",
    autofill: "board.git_repo",
  },
  {
    name: "RUN_LABEL",
    kind: "scalar",
    required: false,
    label: "Run label",
  },
  {
    name: "DEFINITION_KEYS",
    kind: "list",
    required: false,
    label: "Definition keys",
    autofill: "definition",
  },
  {
    name: "DEPTH",
    kind: "variant",
    label: "Depth",
    variants: [
      {
        id: "shallow",
        label: "Shallow",
        fills: { REVIEW_DEPTH: "skim" },
        tools_extra: [],
      },
      {
        id: "deep",
        label: "Deep",
        fills: { REVIEW_DEPTH: "line-by-line" },
        tools_extra: ["mcp__valaris__get_card_verdict"],
      },
    ],
  },
];

const TEMPLATE_DETAIL = {
  id: REF,
  slug: REF,
  source: "system",
  name: "Coding loop",
  version: 3,
  is_system: true,
  is_draft: false,
  profile: { emoji: "🛠️", tagline: "Work the board." },
  content: {
    system_prompt: "System <<OBJECTIVE>> <<REPO_URL>>",
    loop_prompt: "Loop <<RUN_LABEL>> <<REVIEW_DEPTH>> <<DEFINITION_KEYS>>",
    slots: SLOTS,
    tools: ["mcp__valaris__get_card"],
    rails_defaults: { max_iterations: 40, budget_usd: 30 },
  },
  lineage: null,
  updated_at: null,
};

const FIT_OK = {
  template: { ref: REF, name: "Coding loop", version: 3 },
  checks: [
    {
      id: "column:done",
      requirement: "A done-typed column",
      status: "ok",
      evidence: "Column 'Done' is done-typed",
      fix_id: null,
    },
    {
      id: "column:active",
      requirement: "An active-typed column",
      status: "missing",
      evidence: "No column is active-typed",
      fix_id: "create_column:active",
    },
    {
      id: "definition:north_star",
      requirement: "definition.north_star",
      status: "warn",
      evidence: "absent from the board definition",
      fix_id: "definition_stub:north_star",
    },
  ],
  autofill: {
    REPO_URL: {
      value: "git@github.com:acme/ops.git",
      source: "board.git_repo",
    },
    // `loop_template_fit` hands DEFINITION_KEYS a list[str]; the bind form must
    // carry it to the wire as an array rather than flattening it to "a,b".
    DEFINITION_KEYS: {
      value: ["loop_charter", "note_conventions"],
      source: "definition",
    },
  },
  board_frozen: false,
  completion_query_matches_run_label: null,
};

function handlers(overrides: Parameters<typeof server.use> = []) {
  return [
    http.get(DETAIL_URL, () => HttpResponse.json(TEMPLATE_DETAIL)),
    http.get(FIT_URL, () => HttpResponse.json(FIT_OK)),
    http.post(FIT_URL, () => HttpResponse.json({ ...FIT_OK, checks: FIT_OK.checks.map((check) => ({ ...check, status: "ok" })) })),
    http.post(FIT_URL.replace(/\/fit$/, "/preview"), () => HttpResponse.json({ findings: [], missing_required: [] })),
    ...overrides,
  ];
}

function renderBind(onBound = vi.fn()) {
  renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId"
        element={
          <TemplateBindStep
            slug={SLUG}
            boardUuid={BOARD_UUID}
            templateRef={REF}
            source="system"
            expectedVersion={4}
            onBound={onBound}
            onCancel={() => {}}
          />
        }
      />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}`] } },
  );
  return onBound;
}

beforeEach(() => {
  adminState.current.role = "admin";
});

describe("TemplateBindStep — fit checklist", () => {
  it("renders one row per check with its status and evidence", async () => {
    server.use(...handlers());
    renderBind();

    expect(await screen.findByText("A done-typed column")).toBeVisible();
    expect(screen.getByText("No column is active-typed")).toBeVisible();
    const rows = await screen.findAllByTestId(/^fit-check-/);
    expect(rows).toHaveLength(3);
  });

  it("offers Fix ONLY for checks that advertised a fix_id", async () => {
    server.use(...handlers());
    renderBind();

    await screen.findByText("A done-typed column");
    // ok + no fix_id -> no button; the UI never invents a fix the server did
    // not offer.
    expect(screen.queryByTestId("fit-fix-column:done")).toBeNull();
    expect(screen.getByTestId("fit-fix-column:active")).toBeEnabled();
    expect(screen.getByTestId("fit-fix-definition:north_star")).toBeEnabled();
  });

  it("posts {fix_ids:[id]} and re-renders from the refreshed report", async () => {
    const posted: unknown[] = [];
    server.use(
      ...handlers(),
      http.post(FIT_APPLY_URL, async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json({
          ...FIT_OK,
          checks: FIT_OK.checks.map((c) =>
            c.id === "column:active"
              ? {
                  ...c,
                  status: "ok",
                  evidence: "Column 'Active' created",
                  fix_id: null,
                }
              : c,
          ),
          applied: [
            {
              fix_id: "create_column:active",
              outcome: "applied",
              detail: "Created column 'Active'",
            },
          ],
        });
      }),
    );
    renderBind();

    await userEvent.click(await screen.findByTestId("fit-fix-column:active"));

    await waitFor(() =>
      expect(posted).toEqual([{ fix_ids: ["create_column:active"] }]),
    );
    // The refreshed report is what redraws — the row must lose its Fix button.
    await waitFor(() =>
      expect(screen.queryByTestId("fit-fix-column:active")).toBeNull(),
    );
    expect(await screen.findByText("Column 'Active' created")).toBeVisible();
  });

  it("renders the server's detail for an APPLIED fix beside the row", async () => {
    // B7 AC3. `apply` re-runs `check` from scratch, so the refreshed checklist
    // and the `applied` array describe the same request at DIFFERENT instants.
    // The outcome is history; the checklist is now. Rendering only the
    // checklist (today's behaviour) throws the server's answer away.
    server.use(
      ...handlers(),
      http.post(FIT_APPLY_URL, () =>
        HttpResponse.json({
          ...FIT_OK,
          checks: FIT_OK.checks.map((c) =>
            c.id === "column:active"
              ? { ...c, status: "ok", evidence: "now ok", fix_id: null }
              : c,
          ),
          applied: [
            {
              fix_id: "create_column:active",
              outcome: "applied",
              detail: "Created column 'Active' at position 2048",
            },
          ],
        }),
      ),
    );
    renderBind();

    await userEvent.click(await screen.findByTestId("fit-fix-column:active"));

    const outcome = await screen.findByTestId("fit-outcome-column:active");
    // The DETAIL is the payload — a generic "done" would leave the operator
    // exactly as uninformed as the silence this card removes.
    expect(outcome).toHaveTextContent("Created column 'Active' at position 2048");
    expect(outcome).toHaveAttribute("data-outcome", "applied");
  });

  it("shows skipped_already_satisfied as a SUCCESS, distinct from rejected", async () => {
    // B7 AC4. A double-click or a retry is not a failure. Collapsing this into
    // the rejected rendering would teach operators to distrust a working fix.
    server.use(
      ...handlers(),
      http.post(FIT_APPLY_URL, () =>
        HttpResponse.json({
          ...FIT_OK,
          applied: [
            {
              fix_id: "create_column:active",
              outcome: "skipped_already_satisfied",
              detail: "Column 'Active' already exists",
            },
          ],
        }),
      ),
    );
    renderBind();

    await userEvent.click(await screen.findByTestId("fit-fix-column:active"));

    const outcome = await screen.findByTestId("fit-outcome-column:active");
    expect(outcome).toHaveAttribute("data-outcome", "skipped_already_satisfied");
    expect(outcome).toHaveTextContent("Column 'Active' already exists");
    // Asserted on the variant function's own output: `cn`/tailwind-merge would
    // dedupe a conflicting utility, so a rendered className can never prove
    // exclusivity.
    expect(outcome).not.toHaveAttribute("data-outcome", "rejected");
  });

  it("surfaces the server's reason when a fix is REJECTED", async () => {
    // B7 AC5 — the headline bug: today the operator clicks, the fix is refused
    // for a stated reason, and nothing on screen connects the two.
    server.use(
      ...handlers(),
      http.post(FIT_APPLY_URL, () =>
        HttpResponse.json({
          ...FIT_OK,
          applied: [
            {
              fix_id: "definition_stub:north_star",
              outcome: "rejected",
              detail: "no run label",
            },
          ],
        }),
      ),
    );
    renderBind();

    await userEvent.click(
      await screen.findByTestId("fit-fix-definition:north_star"),
    );

    const outcome = await screen.findByTestId(
      "fit-outcome-definition:north_star",
    );
    expect(outcome).toHaveAttribute("data-outcome", "rejected");
    expect(outcome).toHaveTextContent("no run label");
    // The outcome is scoped to the row whose fix ran; an unrelated row must not
    // inherit it. Keying by check `id` instead of `fix_id` is what would break
    // this (the two namespaces differ).
    expect(screen.queryByTestId("fit-outcome-column:active")).toBeNull();
  });

  it("renders a visible error when the apply request itself fails", async () => {
    // B7 AC6. Without this branch the click is indistinguishable from a
    // no-op: the checklist silently keeps its stale rows.
    server.use(
      ...handlers(),
      http.post(FIT_APPLY_URL, () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );
    renderBind();

    await userEvent.click(await screen.findByTestId("fit-fix-column:active"));

    expect(await screen.findByTestId("fit-apply-error")).toBeVisible();
    // The row keeps its button: the fix did not run, so it is still offered.
    expect(screen.getByTestId("fit-fix-column:active")).toBeEnabled();
  });

  it('labels the repair button "Auto-fix", not "Fix"', async () => {
    // B7 AC7. "Fix" reads like a verb aimed at the operator; the button runs a
    // server-side repair.
    server.use(...handlers());
    renderBind();

    expect(await screen.findByTestId("fit-fix-column:active")).toHaveTextContent(
      "Auto-fix",
    );
  });

  it("keeps the outcome on the seed-note row, whose fix_id shares no tail with it", async () => {
    // The regression this pins: check ids and fix ids are DIFFERENT namespaces.
    // `column:active`/`create_column:active` happen to share a tail, so a
    // heuristic that matches on it looks correct — until `pinned_note:seed`,
    // whose fix is the bare `seed_note_skeleton`, shares nothing at all. The
    // seed note is the very row this card exists to fix.
    const seedFit = {
      ...FIT_OK,
      checks: [
        {
          id: "pinned_note:seed",
          requirement: "A pinned seed note naming the run",
          status: "missing",
          evidence: "no pinned note names the run",
          fix_id: "seed_note_skeleton",
        },
      ],
    };
    server.use(
      http.get(DETAIL_URL, () => HttpResponse.json(TEMPLATE_DETAIL)),
      http.get(FIT_URL, () => HttpResponse.json(seedFit)),
      http.post(FIT_APPLY_URL, () =>
        HttpResponse.json({
          ...seedFit,
          // The fix SUCCEEDED, so the refreshed report withdraws the fix_id —
          // the row now has no key of its own to look the outcome up by.
          checks: [
            {
              ...seedFit.checks[0],
              status: "ok",
              evidence: "loop-9 seed batch — 23 cards",
              fix_id: null,
            },
          ],
          applied: [
            {
              fix_id: "seed_note_skeleton",
              outcome: "applied",
              detail: "Created 'loop-9 seed batch — 23 cards'",
            },
          ],
        }),
      ),
    );
    renderBind();

    await userEvent.click(await screen.findByTestId("fit-fix-pinned_note:seed"));

    const outcome = await screen.findByTestId("fit-outcome-pinned_note:seed");
    expect(outcome).toHaveAttribute("data-outcome", "applied");
    expect(outcome).toHaveTextContent("Created 'loop-9 seed batch — 23 cards'");
  });

  it("disables every Fix when the board is frozen", async () => {
    server.use(
      http.get(DETAIL_URL, () => HttpResponse.json(TEMPLATE_DETAIL)),
      http.get(FIT_URL, () =>
        HttpResponse.json({ ...FIT_OK, board_frozen: true }),
      ),
    );
    renderBind();

    await screen.findByText("A done-typed column");
    expect(screen.getByTestId("fit-fix-column:active")).toBeDisabled();
    expect(screen.getByTestId("fit-fix-definition:north_star")).toBeDisabled();
  });
});

describe("TemplateBindStep — slot form", () => {
  it("pre-fills autofilled slots and names the source they came from", async () => {
    server.use(...handlers());
    renderBind();

    const repo = await screen.findByLabelText(/Repo URL/);
    expect(repo).toHaveValue("git@github.com:acme/ops.git");
    // The hint is what makes an autofilled value trustworthy rather than
    // mysterious — it must name the SOURCE, not merely say "autofilled".
    expect(screen.getByTestId("slot-source-REPO_URL")).toHaveTextContent(
      "board.git_repo",
    );
  });

  it("renders each slot kind with its matching control", async () => {
    server.use(...handlers());
    renderBind();

    // block -> textarea, scalar -> input
    expect((await screen.findByLabelText(/Objective/)).tagName).toBe(
      "TEXTAREA",
    );
    expect(screen.getByLabelText(/Repo URL/).tagName).toBe("INPUT");
  });

  it("blocks Save when a required slot is empty and flags the field", async () => {
    server.use(...handlers());
    const onBound = renderBind();
    await screen.findByLabelText(/Objective/);

    await userEvent.click(screen.getByTestId("bind-save"));

    expect(await screen.findByTestId("slot-error-OBJECTIVE")).toBeVisible();
    expect(onBound).not.toHaveBeenCalled();
  });
});

describe("TemplateBindStep — variants", () => {
  it("opens on the first variant so its sub-slots are never left unrendered", async () => {
    server.use(...handlers());
    renderBind();

    // An unselected variant saves "" for the slot, which leaves the text it
    // fills as a literal <<REVIEW_DEPTH>> — the backend rejects that at render
    // time, so the default must be a real option, not empty.
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /Shallow/ })).toBeChecked(),
    );
    expect(screen.getByRole("radio", { name: /Deep/ })).not.toBeChecked();
  });

  it("groups variant options as a labelled radio group", async () => {
    server.use(...handlers());
    renderBind();

    const group = await screen.findByRole("radiogroup", { name: /Depth/ });
    expect(group).toBeVisible();
    expect(screen.getByRole("radio", { name: /Shallow/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Deep/ })).toBeInTheDocument();
  });

  it("shows which sub-slots the selected variant fills", async () => {
    server.use(...handlers());
    renderBind();

    await userEvent.click(await screen.findByRole("radio", { name: /Deep/ }));

    expect(await screen.findByTestId("variant-fills-DEPTH")).toHaveTextContent(
      "REVIEW_DEPTH",
    );
  });
});

describe("TemplateBindStep — save", () => {
  it("PUTs the canonical template body with explicit rails and expected_version", async () => {
    const puts: Record<string, unknown>[] = [];
    server.use(
      ...handlers(),
      http.put(LOOP_URL, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        puts.push(body);
        return HttpResponse.json({ ...body, version: 5 });
      }),
    );
    const onBound = renderBind();

    await userEvent.type(
      await screen.findByLabelText(/Objective/),
      "Ship the backlog",
    );
    await userEvent.click(screen.getByRole("radio", { name: /Deep/ }));
    await userEvent.click(screen.getByTestId("bind-save"));

    await waitFor(() => expect(puts).toHaveLength(1));
    const body = puts[0]!;

    expect(body.template).toEqual({
      source: "system",
      ref: REF,
      version: 3,
      slot_values: {
        OBJECTIVE: "Ship the backlog",
        REPO_URL: "git@github.com:acme/ops.git",
        RUN_LABEL: "",
        DEFINITION_KEYS: ["loop_charter", "note_conventions"],
        DEPTH: "deep",
      },
    });
    expect(body.expected_version).toBe(4);
    // Direction: rails ship as EXPLICIT values copied from the template
    // defaults, so the runner-visible config is complete without a server-side
    // read-time fill.
    expect(body.max_iterations).toBe(40);
    expect(body.budget_usd).toBe(30);
    // Template-owned fields must NOT be sent alongside a template ref — the
    // backend answers 422 for template+raw. `tools` is one of them: the server
    // renders content.tools plus the chosen variant's tools_extra from the
    // binding itself, so the "Deep" grant arrives without the client sending it.
    expect(body).not.toHaveProperty("system_prompt");
    expect(body).not.toHaveProperty("loop_prompt");
    expect(body).not.toHaveProperty("tools");

    await waitFor(() => expect(onBound).toHaveBeenCalled());
  });

  it("sends an autofilled list slot as an ARRAY, not a flattened string", async () => {
    // AC5. The backend renders a `list` slot by joining its items; a string
    // arrives as one item (or, before the contract, as nothing at all), so the
    // WIRE TYPE is the assertion — not what the prompt happens to look like.
    const puts: Record<string, unknown>[] = [];
    server.use(
      ...handlers(),
      http.put(LOOP_URL, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        puts.push(body);
        return HttpResponse.json({ ...body, version: 5 });
      }),
    );
    renderBind();

    await userEvent.type(
      await screen.findByLabelText(/Objective/),
      "Ship the backlog",
    );
    await userEvent.click(screen.getByTestId("bind-save"));

    await waitFor(() => expect(puts).toHaveLength(1));
    const sent = (puts[0]!.template as Record<string, unknown>)
      .slot_values as Record<string, unknown>;

    expect(sent.DEFINITION_KEYS).toEqual(["loop_charter", "note_conventions"]);
    expect(Array.isArray(sent.DEFINITION_KEYS)).toBe(true);
  });

  it("splits an edited list slot on newlines so one line is one item", async () => {
    // The textarea IS the list editor (F8 owns a richer one); a line is an
    // item, and blank lines are not items.
    const puts: Record<string, unknown>[] = [];
    server.use(
      ...handlers(),
      http.put(LOOP_URL, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        puts.push(body);
        return HttpResponse.json({ ...body, version: 5 });
      }),
    );
    renderBind();

    await userEvent.type(
      await screen.findByLabelText(/Objective/),
      "Ship the backlog",
    );
    const keys = screen.getByLabelText(/Definition keys/);
    await userEvent.clear(keys);
    await userEvent.type(keys, "north_star{enter}{enter}guiding_principles");
    await userEvent.click(screen.getByTestId("bind-save"));

    await waitFor(() => expect(puts).toHaveLength(1));
    const sent = (puts[0]!.template as Record<string, unknown>)
      .slot_values as Record<string, unknown>;

    expect(sent.DEFINITION_KEYS).toEqual(["north_star", "guiding_principles"]);
  });

  it("sends an emptied list slot as an empty array, not as [\"\"]", async () => {
    // `[]` is the answer "no keys" and the backend accepts it; `[""]` would
    // render a stray separator.
    const puts: Record<string, unknown>[] = [];
    server.use(
      ...handlers(),
      http.put(LOOP_URL, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        puts.push(body);
        return HttpResponse.json({ ...body, version: 5 });
      }),
    );
    renderBind();

    await userEvent.type(
      await screen.findByLabelText(/Objective/),
      "Ship the backlog",
    );
    await userEvent.clear(screen.getByLabelText(/Definition keys/));
    await userEvent.click(screen.getByTestId("bind-save"));

    await waitFor(() => expect(puts).toHaveLength(1));
    const sent = (puts[0]!.template as Record<string, unknown>)
      .slot_values as Record<string, unknown>;

    expect(sent.DEFINITION_KEYS).toEqual([]);
  });

  it("maps a 422 slot field path onto the offending slot row", async () => {
    server.use(
      ...handlers(),
      http.put(LOOP_URL, () =>
        HttpResponse.json(
          {
            detail: [
              {
                loc: ["body", "template", "slot_values", "OBJECTIVE"],
                msg: "slot value exceeds 16384 bytes",
              },
            ],
          },
          { status: 422 },
        ),
      ),
    );
    renderBind();

    await userEvent.type(await screen.findByLabelText(/Objective/), "x");
    await userEvent.click(screen.getByTestId("bind-save"));

    expect(await screen.findByTestId("slot-error-OBJECTIVE")).toHaveTextContent(
      /16384 bytes/,
    );
  });

  it("maps a render finding (field/message shape) onto the offending slot row", async () => {
    // Render findings are the OTHER 422 shape: `{code, field, message,
    // params}` from validate_template, not Pydantic's `{loc, msg}`. Before
    // this the operator saw the generic saveFailed line for every one.
    server.use(
      ...handlers(),
      http.put(LOOP_URL, () =>
        HttpResponse.json(
          {
            detail: [
              {
                code: "list_slot_expects_array",
                field: "slot_values.DEFINITION_KEYS",
                message:
                  "DEFINITION_KEYS is a list slot and expects an array of strings",
                severity: "error",
                params: { slot: "DEFINITION_KEYS" },
              },
            ],
          },
          { status: 422 },
        ),
      ),
    );
    renderBind();

    await userEvent.type(await screen.findByLabelText(/Objective/), "x");
    await userEvent.click(screen.getByTestId("bind-save"));

    expect(
      await screen.findByTestId("slot-error-DEFINITION_KEYS"),
    ).toHaveTextContent(/expects an array/);
  });
});


describe("TemplateBindStep — proposed published fit", () => {
  it("checks the exact edited slots and published version before binding, holding Save during the request", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const proposed: Record<string, unknown>[] = [];
    server.use(...handlers());
    server.use(http.post(FIT_URL, async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
      proposed.push(body);
      if ((body.slot_values as Record<string, unknown>).OBJECTIVE === "Ship accepted work") await pending;
      return HttpResponse.json({ ...FIT_OK, checks: [] });
    }));
    renderBind();
    await userEvent.type(await screen.findByLabelText(/Objective/), "Ship accepted work");
    await waitFor(() => expect(proposed).toContainEqual(expect.objectContaining({ slot_values: expect.objectContaining({ OBJECTIVE: "Ship accepted work" }), draft: false, version: 3, loop_config: expect.objectContaining({ max_iterations: 40 }) })));
    expect(screen.getByTestId("bind-save")).toBeDisabled();
    release();
    await waitFor(() => expect(screen.getByTestId("bind-save")).toBeEnabled());
  });

  it("blocks a proposed incompatible fit and an unavailable fit instead of saving existing board values", async () => {
    server.use(...handlers());
    server.use(http.post(FIT_URL, () => HttpResponse.json({ ...FIT_OK, checks: [{ id: "branch", status: "missing", requirement: "Compatible landing", evidence: "Choose a branch compatible with the landing policy" }] })));
    const onBound = renderBind();
    await userEvent.type(await screen.findByLabelText(/Objective/), "Proposed work");
    expect(await screen.findByText("Choose a branch compatible with the landing policy")).toBeVisible();
    expect(screen.getByTestId("bind-save")).toBeDisabled();
    expect(onBound).not.toHaveBeenCalled();
    server.use(http.post(FIT_URL, () => new HttpResponse(null, { status: 503 })));
    await userEvent.type(screen.getByLabelText(/Objective/), " changed");
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.getByTestId("bind-save")).toBeDisabled();
  });
});
