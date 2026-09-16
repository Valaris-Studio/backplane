// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  stubReducedMotion,
  userEvent,
  waitFor,
  within,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import type { BoundLoopTemplate } from "@/features/kanban/api/use-board-loop";

const adminState = { current: { role: "admin" as string | null } };
vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({
    role: adminState.current.role,
    isAdmin:
      adminState.current.role === "admin" || adminState.current.role === "owner",
    isLoading: false,
    isError: false,
  }),
}));

import { TemplateBoundView } from "../loop-template/TemplateBoundView";

const SLUG = "acme";
const BOARD_ID = "ops-board";
const BOARD_UUID = "0b7c1e2a-4c1d-4a9a-9c2e-2f6d8f3a1b11";

const LOOP_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/loop`;
const BINDING_URL = `${LOOP_URL}/binding`;
const DIFF_URL = `${LOOP_URL}/binding/diff`;
const STATUS_URL = `${LOOP_URL}/status`;
const TEMPLATE_URL = `/api/workspaces/${SLUG}/loop-templates/coding-loop-v2`;

const BOUND: BoundLoopTemplate = {
  source: "system",
  ref: "coding-loop-v2",
  version: 3,
  drift: { kind: "none" },
};

const TEMPLATE_DETAIL = {
  id: "t1",
  slug: "coding-loop-v2",
  source: "system",
  name: "Coding Loop v2",
  version: 4,
  is_system: true,
  is_draft: false,
  profile: { emoji: "🛠️", tagline: "Ship one card per iteration." },
  content: {},
  lineage: null,
  updated_at: "2026-08-17T00:00:00Z",
};

function binding(overrides: Record<string, unknown> = {}) {
  return {
    template: { source: "system", ref: "coding-loop-v2", version: 3, drift: { kind: "none" } },
    slot_values: { REPO_URL: "https://example.test/repo", BRANCH: "main" },
    rendered_at: "2026-08-17T00:00:00Z",
    rendered_hash: "abc123",
    drift: {
      kind: "none",
      bound_version: 3,
      current_version: 3,
      new_required_slots: [],
      removed_slots: [],
      prompt_changed: false,
    },
    diff_available: false,
    ...overrides,
  };
}

const DRIFTED = binding({
  drift: {
    kind: "template_newer",
    bound_version: 3,
    current_version: 4,
    new_required_slots: [],
    removed_slots: [],
    prompt_changed: true,
  },
  diff_available: true,
});

function status(overrides: Record<string, unknown> = {}) {
  return {
    state: "off",
    enabled: false,
    disabled_reason: null,
    actionable: false,
    has_inflight_iteration: false,
    last_iteration_at: null,
    last_iteration_status: null,
    bound_agent_count: 1,
    alive_agent_count: 1,
    spent_usd: 0,
    budget_usd: null,
    ...overrides,
  };
}

function baseHandlers(
  bindingBody: Record<string, unknown> = binding(),
  statusBody: Record<string, unknown> = status(),
) {
  return [
    http.get(BINDING_URL, () => HttpResponse.json(bindingBody)),
    http.get(STATUS_URL, () => HttpResponse.json(statusBody)),
    http.get(TEMPLATE_URL, () => HttpResponse.json(TEMPLATE_DETAIL)),
    // Field names mirror LoopTemplateProfileRead exactly — `rails_defaults`,
    // not `rails`: the profile tab iterates them with Object.entries and a
    // loosely-shaped fixture crashes the sheet rather than failing an assertion.
    http.get(`/api/workspaces/${SLUG}/loop-templates/coding-loop-v2/profile`, () =>
      HttpResponse.json({
        ...TEMPLATE_DETAIL,
        boards_using: 1,
        versions: [],
        rails_defaults: {},
        tools: [],
        slots: [],
        setup_contract: {},
        track_record: { runs: 0, outcomes: {} },
      }),
    ),
  ];
}

const noop = () => {};

function renderBound(
  props: Partial<{
    template: BoundLoopTemplate;
    expectedVersion: number;
    onDetached: () => void;
    onChangeTemplate: () => void;
  }> = {},
) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId"
        element={
          <TemplateBoundView
            slug={SLUG}
            boardUuid={BOARD_UUID}
            template={props.template ?? BOUND}
            expectedVersion={props.expectedVersion ?? 7}
            onDetached={props.onDetached ?? noop}
            onChangeTemplate={props.onChangeTemplate ?? noop}
          />
        }
      />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}`] } },
  );
}

beforeEach(() => {
  adminState.current.role = "admin";
  stubReducedMotion(true);
  server.use(
    http.get(POLICY_URL, () => HttpResponse.json(policyResolution)),
    http.post(`${POLICY_URL}/preview`, () => HttpResponse.json(previewResolution())),
  );
});
afterEach(() => stubReducedMotion(false));

describe("TemplateBoundView — which half of the template it reads", () => {
  it("reads the PUBLISHED half, never a teammate's in-progress draft", async () => {
    // A bound board RUNS this template, so it must show what is published.
    // The manager's editor shares useLoopTemplateDetail and passes draft=true
    // (card 1847716e); this pins that the shared default stayed `false` here —
    // otherwise an unpublished edit would silently describe a running board.
    const seen: (string | null)[] = [];
    // The probe goes FIRST: msw resolves with the earliest matching handler,
    // so appending it after baseHandlers()' TEMPLATE_URL never runs it.
    server.use(
      http.get(TEMPLATE_URL, ({ request }) => {
        seen.push(new URL(request.url).searchParams.get("draft"));
        return HttpResponse.json(TEMPLATE_DETAIL);
      }),
      ...baseHandlers(),
    );

    renderBound();

    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen).not.toContain("true");
  });
});

describe("TemplateBoundView — header and profile sheet", () => {
  it("renders the template name, bound version and tagline from the slim ref", async () => {
    server.use(...baseHandlers());
    renderBound();

    expect(await screen.findByText("Coding Loop v2")).toBeInTheDocument();
    // v3 is what the BOARD runs; the catalog's v4 must not be shown as current.
    expect(screen.getByTestId("bound-version")).toHaveTextContent("v3");
    expect(
      await screen.findByText("Ship one card per iteration."),
    ).toBeInTheDocument();
  });

  it("opens the profile sheet on View profile and closes it again", async () => {
    server.use(...baseHandlers());
    const user = userEvent.setup();
    renderBound();

    await user.click(await screen.findByTestId("bound-view-profile"));
    expect(await screen.findByTestId("loop-template-sheet-title")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByTestId("loop-template-sheet-title")).not.toBeInTheDocument(),
    );
  });
});

describe("TemplateBoundView — drift banner", () => {
  it("hides the banner when drift kind is none", async () => {
    server.use(...baseHandlers());
    renderBound();

    expect(await screen.findByText("Coding Loop v2")).toBeInTheDocument();
    expect(screen.queryByTestId("bound-drift")).not.toBeInTheDocument();
  });

  it("shows the banner naming the newer version for template_newer", async () => {
    server.use(...baseHandlers(DRIFTED));
    renderBound();

    const banner = await screen.findByTestId("bound-drift");
    expect(banner).toHaveTextContent("v4");
  });

  it("names a system bump as a platform update, not a teammate's publish", async () => {
    server.use(
      ...baseHandlers(
        binding({
          drift: {
            kind: "system_bumped",
            bound_version: 3,
            current_version: 4,
            new_required_slots: [],
            removed_slots: [],
            prompt_changed: true,
          },
          diff_available: true,
        }),
      ),
    );
    renderBound();

    const banner = await screen.findByTestId("bound-drift");
    // The two kinds differ in WHO moved the template — a deploy versus a
    // person — which is the whole reason the backend keeps them apart.
    expect(banner).toHaveTextContent(/platform update/i);
    expect(banner).toHaveTextContent("v4");
  });

  it("names a workspace publish without blaming a platform update", async () => {
    server.use(...baseHandlers(DRIFTED));
    renderBound();

    const banner = await screen.findByTestId("bound-drift");
    expect(banner).not.toHaveTextContent(/platform update/i);
  });

  it("warns about changed slots without offering a version to move to", async () => {
    server.use(
      ...baseHandlers(
        binding({
          drift: {
            kind: "slots_changed",
            bound_version: 3,
            current_version: 3,
            new_required_slots: ["REVIEWER"],
            removed_slots: [],
            prompt_changed: false,
          },
          diff_available: true,
        }),
      ),
    );
    renderBound();

    expect(await screen.findByTestId("bound-drift")).toHaveTextContent(/slots changed/i);
  });

  it("tells the operator a raw edit happened behind the binding", async () => {
    server.use(
      ...baseHandlers(
        binding({
          drift: {
            kind: "raw_edited",
            bound_version: 3,
            current_version: 3,
            new_required_slots: [],
            removed_slots: [],
            prompt_changed: false,
          },
          // The template never moved, so there is nothing to diff — the copy
          // must stand on its own rather than deferring to a Review panel.
          diff_available: false,
        }),
      ),
    );
    renderBound();

    const banner = await screen.findByTestId("bound-drift");
    expect(banner).toHaveTextContent(/edited directly/i);
    // The two version-bump kinds are the ones that offer an Update; this one
    // describes the board's own config, so borrowing their copy would tell the
    // operator a newer version exists when none does.
    expect(banner).not.toHaveTextContent(/available/i);
    expect(banner).not.toHaveTextContent(/platform update/i);
  });

  it("tells the operator the binding row itself is corrupt", async () => {
    server.use(
      ...baseHandlers(
        binding({
          drift: {
            kind: "binding_corrupt",
            bound_version: 3,
            current_version: null,
            new_required_slots: [],
            removed_slots: [],
            prompt_changed: false,
          },
          diff_available: false,
        }),
      ),
    );
    renderBound();

    const banner = await screen.findByTestId("bound-drift");
    expect(banner).toHaveTextContent(/cannot be resolved/i);
    expect(banner).not.toHaveTextContent(/platform update/i);
  });

  it("offers no Review button for a kind with nothing to diff", async () => {
    // A Review button that opens an empty panel is worse than no button: it
    // tells the operator there is a comparison to make.
    server.use(
      ...baseHandlers(
        binding({
          drift: {
            kind: "raw_edited",
            bound_version: 3,
            current_version: 3,
            new_required_slots: [],
            removed_slots: [],
            prompt_changed: false,
          },
          diff_available: false,
        }),
      ),
    );
    renderBound();

    await screen.findByTestId("bound-drift");
    expect(screen.queryByTestId("bound-drift-review")).not.toBeInTheDocument();
  });

  it("renders the backend's unified diff when the operator reviews", async () => {
    server.use(
      ...baseHandlers(DRIFTED),
      http.get(DIFF_URL, () =>
        HttpResponse.json({
          system_prompt: [
            "--- system_prompt (bound)",
            "+++ system_prompt (current)",
            "@@ -1,2 +1,2 @@",
            " unchanged context line",
            "-you are a careful agent",
            "+you are a meticulous agent",
          ].join("\n"),
          loop_prompt: "",
          slots_delta: { added: ["REVIEWER"], removed: ["LEGACY_FLAG"] },
        }),
      ),
    );
    const user = userEvent.setup();
    renderBound();

    await user.click(await screen.findByTestId("bound-drift-review"));

    const diff = await screen.findByTestId("bound-diff-system_prompt");
    expect(diff).toHaveTextContent("you are a meticulous agent");
    expect(diff).toHaveTextContent("you are a careful agent");
    // The ---/+++ file headers are difflib bookkeeping, not prompt content.
    expect(diff).not.toHaveTextContent("system_prompt (bound)");
    // An unchanged prompt is an empty string on the wire: render nothing
    // rather than an empty diff box implying the prompt was emptied.
    expect(screen.queryByTestId("bound-diff-loop_prompt")).not.toBeInTheDocument();
    expect(await screen.findByText(/REVIEWER/)).toBeInTheDocument();
    expect(await screen.findByText(/LEGACY_FLAG/)).toBeInTheDocument();
  });

  it("keeps Update behind the review step so it is never a one-click re-render", async () => {
    server.use(
      ...baseHandlers(DRIFTED),
      http.get(DIFF_URL, () =>
        HttpResponse.json({
          system_prompt: "@@ -1 +1 @@\n-a\n+b",
          loop_prompt: "",
          slots_delta: { added: [], removed: [] },
        }),
      ),
    );
    const user = userEvent.setup();
    renderBound();

    await screen.findByTestId("bound-drift");
    expect(screen.queryByTestId("bound-update")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("bound-drift-review"));
    expect(await screen.findByTestId("bound-update")).toBeInTheDocument();
    // Review is consumed by opening the diff — leaving it alongside Update
    // would offer a second, meaningless click on a step already taken.
    expect(screen.queryByTestId("bound-drift-review")).not.toBeInTheDocument();
  });
});

describe("TemplateBoundView — update flow", () => {
  const diffHandler = http.get(DIFF_URL, () =>
    HttpResponse.json({
      system_prompt: "@@ -1 +1 @@\n-a\n+b",
      loop_prompt: "",
      slots_delta: { added: [], removed: [] },
    }),
  );

  it("PUTs the NEW version with the existing slot values", async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      ...baseHandlers(DRIFTED),
      diffHandler,
      http.put(LOOP_URL, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderBound({ expectedVersion: 7 });

    await user.click(await screen.findByTestId("bound-drift-review"));
    await waitFor(() => expect(screen.getByTestId("bound-update")).toBeEnabled());
    await user.click(await screen.findByTestId("bound-update"));

    await waitFor(() => expect(body).toBeDefined());
    expect(body?.template).toEqual({
      source: "system",
      ref: "coding-loop-v2",
      version: 4,
      slot_values: { REPO_URL: "https://example.test/repo", BRANCH: "main" },
    });
    expect(body?.expected_version).toBe(7);
  });

  it("prompts for a newly-required slot BEFORE the PUT and sends the typed value", async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      ...baseHandlers(
        binding({
          drift: {
            kind: "template_newer",
            bound_version: 3,
            current_version: 4,
            new_required_slots: ["REVIEWER"],
            removed_slots: [],
            prompt_changed: true,
          },
          diff_available: true,
        }),
      ),
      diffHandler,
      http.put(LOOP_URL, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderBound();

    await user.click(await screen.findByTestId("bound-drift-review"));
    await waitFor(() => expect(screen.getByTestId("bound-update")).toBeEnabled());
    await user.click(await screen.findByTestId("bound-update"));

    // The PUT must NOT have fired yet: the new required slot has no value.
    const input = await screen.findByTestId("bound-new-slot-REVIEWER");
    expect(body).toBeUndefined();

    await user.type(input, "seba");
    await waitFor(() => expect(screen.getByTestId("bound-new-slots-submit")).toBeEnabled());
    await user.click(screen.getByTestId("bound-new-slots-submit"));

    await waitFor(() => expect(body).toBeDefined());
    expect(
      (body?.template as { slot_values: Record<string, string> }).slot_values
        .REVIEWER,
    ).toBe("seba");
  });

  it("maps a 422 new_required_slots_unfilled onto the same prompt", async () => {
    server.use(
      ...baseHandlers(DRIFTED),
      diffHandler,
      http.put(LOOP_URL, () =>
        HttpResponse.json(
          {
            detail: [
              {
                code: "new_required_slots_unfilled",
                field: "template.slot_values",
                message: "adds required slots",
                value: ["ESCALATION_CONTACT"],
              },
            ],
            error_code: "validation_error",
          },
          { status: 422 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderBound();

    await user.click(await screen.findByTestId("bound-drift-review"));
    await waitFor(() => expect(screen.getByTestId("bound-update")).toBeEnabled());
    await user.click(await screen.findByTestId("bound-update"));

    // The server discovered a slot the drift payload did not list.
    expect(
      await screen.findByTestId("bound-new-slot-ESCALATION_CONTACT"),
    ).toBeInTheDocument();
  });
});

describe("TemplateBoundView — slot value editing", () => {
  it("PUTs the SAME version with the edited slot values and expected_version", async () => {
    let body: Record<string, unknown> | undefined;
    // DRIFTED on purpose: with an undrifted binding the bound version and the
    // catalog's are both 3, so "saved the bound version" would pass even if
    // the code sent the catalog's. Only a gap between them can prove it.
    server.use(
      ...baseHandlers(DRIFTED),
      http.put(LOOP_URL, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderBound({ expectedVersion: 7 });

    const input = await screen.findByTestId("bound-slot-BRANCH");
    await user.clear(input);
    await user.type(input, "develop");
    await waitFor(() => expect(screen.getByTestId("bound-save-slots")).toBeEnabled());
    await user.click(screen.getByTestId("bound-save-slots"));

    await waitFor(() => expect(body).toBeDefined());
    expect(body?.template).toEqual({
      source: "system",
      ref: "coding-loop-v2",
      // The bound version, NOT the catalog's newer one: saving slot values is
      // a re-render, never a silent upgrade.
      version: 3,
      slot_values: { REPO_URL: "https://example.test/repo", BRANCH: "develop" },
    });
    expect(body?.expected_version).toBe(7);
  });

  it("keeps Save disabled until a value actually changes", async () => {
    server.use(...baseHandlers());
    const user = userEvent.setup();
    renderBound();

    const save = await screen.findByTestId("bound-save-slots");
    expect(save).toBeDisabled();

    await user.type(await screen.findByTestId("bound-slot-BRANCH"), "x");
    await waitFor(() => expect(screen.getByTestId("bound-save-slots")).toBeEnabled());
  });

  it("warns before discarding dirty slot edits on detach", async () => {
    server.use(...baseHandlers());
    const user = userEvent.setup();
    renderBound();

    await user.type(await screen.findByTestId("bound-slot-BRANCH"), "x");
    await user.click(screen.getByTestId("bound-detach"));

    expect(await screen.findByTestId("bound-unsaved-warning")).toBeInTheDocument();
  });
});

describe("TemplateBoundView — running notice", () => {
  it("shows the next-iteration notice only while the loop is running", async () => {
    server.use(...baseHandlers(binding(), status({ state: "running", enabled: true })));
    renderBound();

    expect(await screen.findByTestId("bound-running-notice")).toBeInTheDocument();
  });

  it("hides the notice when the loop is off", async () => {
    server.use(...baseHandlers());
    renderBound();

    expect(await screen.findByText("Coding Loop v2")).toBeInTheDocument();
    expect(screen.queryByTestId("bound-running-notice")).not.toBeInTheDocument();
  });

  it("surfaces disabled_reason when the backend supplies one", async () => {
    server.use(
      ...baseHandlers(
        binding(),
        status({ state: "off", disabled_reason: "budget exhausted" }),
      ),
    );
    renderBound();

    expect(await screen.findByTestId("bound-disabled-reason")).toHaveTextContent(
      "budget exhausted",
    );
  });
});

describe("TemplateBoundView — detach and change", () => {
  it("PUTs template:{} after confirming and reports the detach upward", async () => {
    let body: Record<string, unknown> | undefined;
    const onDetached = vi.fn();
    server.use(
      ...baseHandlers(),
      http.put(LOOP_URL, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderBound({ onDetached, expectedVersion: 7 });

    await user.click(await screen.findByTestId("bound-detach"));
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: /unlink and edit/i }),
    );

    await waitFor(() => expect(body).toBeDefined());
    expect(body?.template).toEqual({});
    expect(body?.expected_version).toBe(7);
    await waitFor(() => expect(onDetached).toHaveBeenCalled());
  });

  it("does not PUT when the detach confirm is dismissed", async () => {
    let called = false;
    server.use(
      ...baseHandlers(),
      http.put(LOOP_URL, () => {
        called = true;
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    renderBound();

    await user.click(await screen.findByTestId("bound-detach"));
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByTestId("bound-unsaved-warning")).not.toBeInTheDocument(),
    );
    expect(called).toBe(false);
  });

  it("routes Change template through the existing clobber-confirm copy", async () => {
    const onChangeTemplate = vi.fn();
    server.use(...baseHandlers());
    const user = userEvent.setup();
    renderBound({ onChangeTemplate });

    await user.click(await screen.findByTestId("bound-change"));

    // Asserted through the COPY, not a testid: the AC is that the existing
    // clobber-confirm wording is reused rather than new wording invented, and
    // only the rendered text can prove that.
    expect(
      await screen.findByText(/will replace the current prompts/i),
    ).toBeInTheDocument();
    expect(onChangeTemplate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Replace" }));
    expect(onChangeTemplate).toHaveBeenCalled();
  });
});

const POLICY_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/completion/policy`;
const policyResolution = { override: null, workspace_policy: null, effective_policy: null, origin: "legacy", policy_hash: null, capabilities: {}, incompatibilities: [] };
const previewResolution = (findings: { code: string; field: string; message: string }[] = []) => ({
  ...policyResolution,
  template_preview: { system_prompt: "Rendered", loop_prompt: "Run", tools: [], findings },
});
const structuralFinding = { code: "branch_constraint_conflict", field: "slot_values.BRANCH", message: "Default and integration branches must differ." };
const actionDiff = http.get(DIFF_URL, () => HttpResponse.json({ system_prompt: "-old\n+new", loop_prompt: "", slots_delta: { added: [], removed: [] } }));

async function changeBranch(value: string) {
  const input = await screen.findByTestId("bound-slot-BRANCH");
  // One edit models paste without creating irrelevant intermediate proposals.
  fireEvent.change(input, { target: { value } });
}

function actionHandlers(puts: unknown[]) {
  return [
    ...baseHandlers(DRIFTED),
    actionDiff,
    http.get(POLICY_URL, () => HttpResponse.json(policyResolution)),
    http.post(`${POLICY_URL}/preview`, () => HttpResponse.json(previewResolution())),
    http.put(LOOP_URL, async ({ request }) => { puts.push(await request.json()); return HttpResponse.json({}); }),
  ];
}

describe("TemplateBoundView — action-specific proposed binding gates", () => {
  it.each(["slots", "update"] as const)("holds %s for its current slots and target version, ignoring a stale successful preview", async (action) => {
    const puts: unknown[] = [];
    const pending: { body: { policy: unknown; template: { version: number; slot_values: { BRANCH: string } }; loop_config?: unknown }; resolve: (response: Response) => void }[] = [];
    server.use(...actionHandlers(puts));
    server.use(http.post(`${POLICY_URL}/preview`, async ({ request }) => {
      const body = await request.json() as typeof pending[number]["body"];
      if (!body.loop_config && ["candidate-a", "candidate-b"].includes(body.template?.slot_values.BRANCH)) {
        return new Promise<Response>((resolve) => pending.push({ body, resolve }));
      }
      return HttpResponse.json(previewResolution());
    }));
    renderBound();
    if (action === "update") await userEvent.click(await screen.findByTestId("bound-drift-review"));
    await changeBranch("candidate-a");
    const button = await screen.findByTestId(action === "slots" ? "bound-save-slots" : "bound-update");
    expect(button).toBeDisabled();
    const version = action === "slots" ? 3 : 4;
    await waitFor(() => expect(pending.some(({ body }) => body.template.version === version && body.template.slot_values.BRANCH === "candidate-a")).toBe(true));
    await changeBranch("candidate-b");
    await waitFor(() => expect(pending.some(({ body }) => body.template.version === version && body.template.slot_values.BRANCH === "candidate-b")).toBe(true));
    pending.filter(({ body }) => body.template.slot_values.BRANCH === "candidate-a").forEach(({ resolve }) => resolve(HttpResponse.json(previewResolution())));
    expect(button).toBeDisabled();
    pending.filter(({ body }) => body.template.slot_values.BRANCH === "candidate-b").forEach(({ resolve }) => resolve(HttpResponse.json(previewResolution([structuralFinding]))));
    expect((await screen.findAllByText(structuralFinding.message, { exact: false }))[0]).toBeVisible();
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(puts).toEqual([]);
    expect(screen.getByTestId("bound-slot-BRANCH")).toHaveValue("candidate-b");
  });

  it.each(["slots", "update"] as const)("shows a structural 422 from %s and preserves the edited value", async (action) => {
    const puts: unknown[] = [];
    server.use(...actionHandlers(puts));
    server.use(http.put(LOOP_URL, async ({ request }) => {
      puts.push(await request.json());
      return HttpResponse.json({ detail: [structuralFinding] }, { status: 422 });
    }));
    renderBound();
    if (action === "update") await userEvent.click(await screen.findByTestId("bound-drift-review"));
    await changeBranch("integration");
    const button = await screen.findByTestId(action === "slots" ? "bound-save-slots" : "bound-update");
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(structuralFinding.message);
    expect(screen.getByTestId("bound-slot-BRANCH")).toHaveValue("integration");
    expect(puts).toHaveLength(1);
  });

  it.each(["slots", "update"] as const)("shows a 409 from %s with recovery guidance and preserves the edited value", async (action) => {
    const puts: unknown[] = [];
    server.use(...actionHandlers(puts));
    server.use(http.put(LOOP_URL, async ({ request }) => {
      puts.push(await request.json());
      return HttpResponse.json({ detail: "Published version changed" }, { status: 409 });
    }));
    renderBound();
    if (action === "update") await userEvent.click(await screen.findByTestId("bound-drift-review"));
    await changeBranch("integration");
    const button = await screen.findByTestId(action === "slots" ? "bound-save-slots" : "bound-update");
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(/refresh|reload/i);
    expect(screen.getByTestId("bound-slot-BRANCH")).toHaveValue("integration");
    expect(puts).toHaveLength(1);
  });

  it("keeps an exact-version preview failure visible and blocks Update", async () => {
    const puts: unknown[] = [];
    server.use(...actionHandlers(puts));
    server.use(http.post(`${POLICY_URL}/preview`, async ({ request }) => {
      const body = await request.json() as { template?: { version: number } };
      return body.template?.version === 4
        ? HttpResponse.json({ detail: "Published version changed" }, { status: 409 })
        : HttpResponse.json(previewResolution());
    }));
    renderBound();
    await userEvent.click(await screen.findByTestId("bound-drift-review"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/refresh|reload/i);
    expect(screen.getByTestId("bound-update")).toBeDisabled();
    expect(screen.getByRole("button", { name: /retry|refresh|reload/i })).toBeVisible();
    expect(puts).toEqual([]);
  });
});
