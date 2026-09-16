// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { fireEvent } from "@testing-library/react";
import { toast } from "sonner";
import i18n from "@/i18n/config";
import {
  renderWithProviders,
  screen,
  stubReducedMotion,
  userEvent,
  waitFor,
  within,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import type {
  BoardLoopConfig,
  BoundLoopTemplate,
} from "@/features/kanban/api/use-board-loop";

// Card 2dbd252b (A) — the bound loop view has no rails. RED phase.
//
// While a board is template-bound the template owns ONLY system_prompt,
// loop_prompt and tools (TEMPLATE_OWNED_FIELDS server-side). The numeric
// guardrails and the enabled flag stay the operator's, yet the bound view
// offered no way to touch them short of "Edit full loop config" — which
// DETACHES the board (PUT template:{}). This file pins the in-place editor:
//
// - a Guardrails section pre-filled from the loop config, on every bound view
// - Save guardrails PUTs the changed rails ONLY (+ expected_version): no
//   `template` key (would re-render or detach), no `loop_landing` (an
//   implicit done-gate auto-relax keys on requested_landing), nothing the
//   template owns
// - `enabled` goes through PATCH /loop/state, gated like BoardLoopDialog
// - the same error surfaces as the dialog: 422 → inline findings, 409 →
//   boardLoop.saveConflict toast; the typed draft survives both
//
// Locator contract the implementation must satisfy:
// - "bound-rails" (section), "bound-save-rails" (button),
//   "bound-rails-enabled" (the enable control)
// - rail inputs labelled with the EXISTING boardLoop.*Label keys

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

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
const STATE_URL = `${LOOP_URL}/state`;
const BINDING_URL = `${LOOP_URL}/binding`;
const STATUS_URL = `${LOOP_URL}/status`;
const TEMPLATE_URL = `/api/workspaces/${SLUG}/loop-templates/coding-loop-v2`;

const RAILS_TITLE_KEY = "boardLoop.templates.bound.rails.title";
const RAILS_HINT_KEY = "boardLoop.templates.bound.rails.hint";
const RAILS_SAVE_KEY = "boardLoop.templates.bound.rails.save";

const BOUND: BoundLoopTemplate = {
  source: "system",
  ref: "coding-loop-v2",
  version: 3,
  drift: { kind: "none" },
};

// Every rail carries a value that is NOT the contract default, so a field
// pre-filled from BOARD_LOOP_DEFAULTS instead of the config cannot pass.
const CONFIG: BoardLoopConfig = {
  enabled: false,
  provider: "",
  model: "mid",
  system_prompt: "RENDERED system prompt",
  loop_prompt: "RENDERED loop prompt",
  tools: ["mcp__valaris__get_card"],
  max_iterations: 12,
  iteration_delay_seconds: 45,
  iteration_timeout_seconds: 1800,
  budget_usd: 33.5,
  max_consecutive_failures: 4,
  max_blocked_on_human: 2,
  starvation_policy: "park",
  // Deliberately the non-default landing: a body that echoes it back would
  // trip the server's auto-relax path, which is exactly what must not happen.
  loop_landing: "merge_queue",
  merge_gate: "none",
  completion_query: null,
  template: BOUND,
  disabled_reason: null,
  version: 7,
  updated_at: "2026-08-17T00:00:00Z",
};

const TEMPLATE_DETAIL = {
  id: "t1",
  slug: "coding-loop-v2",
  source: "system",
  name: "Coding Loop v2",
  version: 3,
  is_system: true,
  is_draft: false,
  profile: { emoji: "🛠️", tagline: "Ship one card per iteration." },
  content: {},
  lineage: null,
  updated_at: "2026-08-17T00:00:00Z",
};

function binding() {
  return {
    template: BOUND,
    slot_values: { REPO_URL: "https://example.test/repo" },
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
  };
}

function status() {
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
  };
}

interface Captured {
  puts: Record<string, unknown>[];
  patches: Record<string, unknown>[];
}

/** A successful PUT answers with the merged config at the next version. */
function savedConfig(body: Record<string, unknown>): BoardLoopConfig {
  return { ...CONFIG, ...body, version: 8 } as BoardLoopConfig;
}

function baseHandlers(captured: Captured) {
  return [
    http.get(BINDING_URL, () => HttpResponse.json(binding())),
    http.get(STATUS_URL, () => HttpResponse.json(status())),
    http.get(TEMPLATE_URL, () => HttpResponse.json(TEMPLATE_DETAIL)),
    http.put(LOOP_URL, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      captured.puts.push(body);
      return HttpResponse.json(savedConfig(body));
    }),
    http.patch(STATE_URL, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      captured.patches.push(body);
      return HttpResponse.json({ ...CONFIG, enabled: body.enabled });
    }),
  ];
}

function capture(): Captured {
  const captured: Captured = { puts: [], patches: [] };
  server.use(...baseHandlers(captured));
  return captured;
}

/** A PUT that fails with `status` and `detail`, registered ahead of the base. */
function failPut(captured: Captured, statusCode: number, detail: unknown) {
  server.use(
    http.put(LOOP_URL, async ({ request }) => {
      captured.puts.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(
        { detail, error_code: statusCode === 422 ? "validation_error" : "conflict" },
        { status: statusCode },
      );
    }),
  );
}

const noop = () => {};

function boundElement(config: BoardLoopConfig, onDetached: () => void = noop) {
  return (
    <Routes>
      <Route
        path="/:slug/boards/:boardId"
        element={
          <TemplateBoundView
            slug={SLUG}
            boardUuid={BOARD_UUID}
            template={BOUND}
            config={config}
            expectedVersion={config.version}
            onDetached={onDetached}
            onChangeTemplate={noop}
          />
        }
      />
    </Routes>
  );
}

function renderBound(
  props: Partial<{ config: BoardLoopConfig; onDetached: () => void }> = {},
) {
  const config = props.config ?? CONFIG;
  const view = renderWithProviders(boundElement(config, props.onDetached), {
    routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}`] },
  });
  return {
    ...view,
    // Same wrapper, same query client: what the panel does when GET /loop
    // refetches and hands the view a new config object.
    rerenderWith: (next: BoardLoopConfig) =>
      view.rerender(boundElement(next, props.onDetached)),
  };
}

const railInput = (labelKey: string) =>
  screen.getByLabelText(i18n.t(labelKey)) as HTMLInputElement;

/**
 * Set a rail's raw string in one change event. `user.type` feeds a number
 * input one character at a time, and jsdom sanitizes the intermediate "1e"
 * or "2." to "" — the value under test would never arrive.
 */
const setRail = (labelKey: string, value: string) =>
  fireEvent.change(railInput(labelKey), { target: { value } });

beforeEach(() => {
  adminState.current.role = "admin";
  stubReducedMotion(true);
  const policyUrl = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/completion/policy`;
  const resolution = { override: null, workspace_policy: null, effective_policy: null, origin: "legacy", policy_hash: null, capabilities: {}, incompatibilities: [] };
  server.use(
    http.get(policyUrl, () => HttpResponse.json(resolution)),
    http.post(`${policyUrl}/preview`, () => HttpResponse.json(resolution)),
  );
  vi.mocked(toast.error).mockClear();
});
afterEach(() => stubReducedMotion(false));

describe("TemplateBoundView — guardrails section", () => {
  it("renders the Guardrails section pre-filled from the loop config", async () => {
    capture();
    renderBound();

    const section = await screen.findByTestId("bound-rails");
    expect(within(section).getByText(i18n.t(RAILS_TITLE_KEY))).toBeInTheDocument();
    expect(within(section).getByText(i18n.t(RAILS_HINT_KEY))).toBeInTheDocument();
    expect(
      within(section).getByRole("button", { name: i18n.t(RAILS_SAVE_KEY) }),
    ).toBeInTheDocument();
    // The keys must be REAL: a missing key renders its own name, which the
    // assertions above would happily match.
    for (const key of [RAILS_TITLE_KEY, RAILS_HINT_KEY, RAILS_SAVE_KEY]) {
      expect(i18n.exists(key), `${key} missing from en`).toBe(true);
    }

    expect(railInput("boardLoop.maxIterationsLabel")).toHaveValue(12);
    expect(railInput("boardLoop.delayLabel")).toHaveValue(45);
    expect(railInput("boardLoop.timeoutLabel")).toHaveValue(1800);
    expect(railInput("boardLoop.budgetLabel")).toHaveValue(33.5);
    expect(railInput("boardLoop.failuresLabel")).toHaveValue(4);
    expect(railInput("boardLoop.blockedOnHumanLabel")).toHaveValue(2);
  });

  it("reflects config.enabled on the enable control", async () => {
    capture();
    renderBound({ config: { ...CONFIG, enabled: true } });

    const control = await screen.findByTestId("bound-rails-enabled");
    expect(control).toBeChecked();
    expect(screen.getByText(i18n.t("boardLoop.enableLabel"))).toBeInTheDocument();
  });

  it("carries the dialog's min constraint on every rail input", async () => {
    capture();
    renderBound();

    await screen.findByTestId("bound-rails");
    // Same floors as BoardLoopDialog's NumberFields — the two editors write
    // the same columns, so they must refuse the same values.
    expect(railInput("boardLoop.maxIterationsLabel")).toHaveAttribute("min", "1");
    expect(railInput("boardLoop.delayLabel")).toHaveAttribute("min", "0");
    expect(railInput("boardLoop.timeoutLabel")).toHaveAttribute("min", "1");
    expect(railInput("boardLoop.budgetLabel")).toHaveAttribute("min", "0.01");
    expect(railInput("boardLoop.failuresLabel")).toHaveAttribute("min", "1");
    expect(railInput("boardLoop.blockedOnHumanLabel")).toHaveAttribute("min", "0");
  });
});

describe("TemplateBoundView — saving guardrails", () => {
  it("PUTs EXACTLY the edited rails plus expected_version", async () => {
    const captured = capture();
    const user = userEvent.setup();
    renderBound();

    await screen.findByTestId("bound-rails");
    const iterations = railInput("boardLoop.maxIterationsLabel");
    await user.clear(iterations);
    await user.type(iterations, "40");
    const budget = railInput("boardLoop.budgetLabel");
    await user.clear(budget);
    await user.type(budget, "55.5");
    await user.click(screen.getByTestId("bound-save-rails"));

    await waitFor(() => expect(captured.puts).toHaveLength(1));
    // Exact equality is the whole pin: no `template` (re-render / detach), no
    // `loop_landing` (auto-relax trigger), no `merge_gate`, no prompts or
    // tools (template-owned), and the four untouched rails absent so the
    // server's merge keeps them.
    expect(captured.puts[0]).toEqual({
      max_iterations: 40,
      budget_usd: 55.5,
      expected_version: 7,
    });
  });

  it("keeps Save guardrails disabled until a rail actually changes", async () => {
    capture();
    const user = userEvent.setup();
    renderBound();

    const save = await screen.findByTestId("bound-save-rails");
    expect(save).toBeDisabled();

    await user.type(railInput("boardLoop.failuresLabel"), "1");
    expect(screen.getByTestId("bound-save-rails")).toBeEnabled();
  });

  it("shows the invalid-numbers finding and sends nothing when a rail is emptied", async () => {
    const captured = capture();
    const user = userEvent.setup();
    renderBound();

    await screen.findByTestId("bound-rails");
    await user.clear(railInput("boardLoop.timeoutLabel"));
    await user.click(screen.getByTestId("bound-save-rails"));

    expect(
      await screen.findByText(i18n.t("boardLoop.invalidNumbers")),
    ).toBeInTheDocument();
    expect(captured.puts).toHaveLength(0);
  });

  it("stays bound after a successful save — never a detach, never a re-render", async () => {
    const captured = capture();
    const onDetached = vi.fn();
    const user = userEvent.setup();
    renderBound({ onDetached });

    await screen.findByTestId("bound-rails");
    const blocked = railInput("boardLoop.blockedOnHumanLabel");
    await user.clear(blocked);
    await user.type(blocked, "0");
    await user.click(screen.getByTestId("bound-save-rails"));

    await waitFor(() => expect(captured.puts).toHaveLength(1));
    expect(captured.puts.some((body) => "template" in body)).toBe(false);
    expect(onDetached).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("bound-version")).toHaveTextContent("v3");
    expect(screen.getByText("Coding Loop v2")).toBeInTheDocument();
  });

  it("takes the saved values as the new baseline after a successful save", async () => {
    const captured = capture();
    const user = userEvent.setup();
    const { rerenderWith } = renderBound();

    await screen.findByTestId("bound-rails");
    setRail("boardLoop.maxIterationsLabel", "40");
    await user.click(screen.getByTestId("bound-save-rails"));
    await waitFor(() => expect(captured.puts).toHaveLength(1));
    // The panel's refetch delivers what the server now holds.
    rerenderWith(savedConfig(captured.puts[0]!));

    await waitFor(() =>
      expect(screen.getByTestId("bound-save-rails")).toBeDisabled(),
    );
    expect(railInput("boardLoop.maxIterationsLabel")).toHaveValue(40);
    // A draft still keyed to the OLD baseline would read "40 ≠ 12" as dirty
    // and PUT the same value twice.
    await user.click(screen.getByTestId("bound-save-rails"));
    expect(captured.puts).toHaveLength(1);
  });
});

describe("TemplateBoundView — the draft survives a config resync", () => {
  it("keeps a dirty rail when the config prop changes identity", async () => {
    capture();
    const { rerenderWith } = renderBound();

    await screen.findByTestId("bound-rails");
    setRail("boardLoop.maxIterationsLabel", "40");
    // Any WS refetch (a teammate flipping enabled, a runner iteration bumping
    // updated_at) hands the view a new object; blindly resyncing from it
    // would wipe the operator's typing mid-edit.
    rerenderWith({ ...CONFIG, enabled: true, version: 8 });

    expect(railInput("boardLoop.maxIterationsLabel")).toHaveValue(40);
    expect(screen.getByTestId("bound-save-rails")).toBeEnabled();
  });

  it("keeps a dirty rail across an enabled toggle while the flag itself follows", async () => {
    const captured = capture();
    const user = userEvent.setup();
    const { rerenderWith } = renderBound();

    await screen.findByTestId("bound-rails");
    setRail("boardLoop.maxIterationsLabel", "40");
    await user.click(screen.getByTestId("bound-rails-enabled"));
    await waitFor(() => expect(captured.patches).toHaveLength(1));
    rerenderWith({ ...CONFIG, enabled: true, version: 8 });

    // `enabled` is NOT part of the rails draft: it renders from the config.
    await waitFor(() =>
      expect(screen.getByTestId("bound-rails-enabled")).toBeChecked(),
    );
    expect(railInput("boardLoop.maxIterationsLabel")).toHaveValue(40);
    expect(screen.getByTestId("bound-save-rails")).toBeEnabled();
  });
});

describe("TemplateBoundView — number parsing and floors", () => {
  it("parses exponent notation as the whole number it denotes", async () => {
    const captured = capture();
    const user = userEvent.setup();
    renderBound();

    await screen.findByTestId("bound-rails");
    setRail("boardLoop.maxIterationsLabel", "1e3");
    await user.click(screen.getByTestId("bound-save-rails"));

    await waitFor(() => expect(captured.puts).toHaveLength(1));
    // parseInt("1e3") is 1 — a loop capped at ONE iteration instead of a
    // thousand. Number() + Number.isInteger is the contract.
    expect(captured.puts[0]!.max_iterations).toBe(1000);
  });

  it("rejects a fractional count with the invalid-numbers finding", async () => {
    const captured = capture();
    const user = userEvent.setup();
    renderBound();

    await screen.findByTestId("bound-rails");
    setRail("boardLoop.maxIterationsLabel", "2.5");
    await user.click(screen.getByTestId("bound-save-rails"));

    expect(
      await screen.findByText(i18n.t("boardLoop.invalidNumbers")),
    ).toBeInTheDocument();
    expect(captured.puts).toHaveLength(0);
  });

  it("refuses a zero budget client-side", async () => {
    const captured = capture();
    const user = userEvent.setup();
    renderBound();

    await screen.findByTestId("bound-rails");
    setRail("boardLoop.budgetLabel", "0");
    await user.click(screen.getByTestId("bound-save-rails"));

    expect(
      await screen.findByText(i18n.t("boardLoop.invalidNumbers")),
    ).toBeInTheDocument();
    expect(captured.puts).toHaveLength(0);
  });

  it("refuses a negative blocked-on-human cap client-side", async () => {
    const captured = capture();
    const user = userEvent.setup();
    renderBound();

    await screen.findByTestId("bound-rails");
    setRail("boardLoop.blockedOnHumanLabel", "-1");
    await user.click(screen.getByTestId("bound-save-rails"));

    expect(
      await screen.findByText(i18n.t("boardLoop.invalidNumbers")),
    ).toBeInTheDocument();
    expect(captured.puts).toHaveLength(0);
  });
});

describe("TemplateBoundView — save errors mirror the dialog", () => {
  it("toasts saveConflict on 409 and keeps the typed value", async () => {
    const captured = capture();
    failPut(captured, 409, {
      error_code: "stale_version",
      message: "expected version 7, current is 8",
    });
    const user = userEvent.setup();
    renderBound();

    await screen.findByTestId("bound-rails");
    setRail("boardLoop.maxIterationsLabel", "40");
    await user.click(screen.getByTestId("bound-save-rails"));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(i18n.t("boardLoop.saveConflict")),
    );
    expect(toast.error).not.toHaveBeenCalledWith(i18n.t("boardLoop.saveError"));
    // The refetch re-syncs the baseline; the operator's typing must not go
    // with it — the toast tells them to re-apply, not re-type.
    expect(railInput("boardLoop.maxIterationsLabel")).toHaveValue(40);
  });

  it("shows a 422 out_of_bounds finding inline and keeps the typed value", async () => {
    const captured = capture();
    failPut(captured, 422, [
      {
        code: "out_of_bounds",
        field: "budget_usd",
        message: "must be greater than 0",
        value: 55.5,
      },
    ]);
    const user = userEvent.setup();
    renderBound();

    await screen.findByTestId("bound-rails");
    setRail("boardLoop.budgetLabel", "55.5");
    await user.click(screen.getByTestId("bound-save-rails"));

    const finding = await within(screen.getByTestId("bound-rails")).findByRole(
      "alert",
    );
    expect(finding).toHaveTextContent("must be greater than 0");
    expect(toast.error).not.toHaveBeenCalled();
    expect(railInput("boardLoop.budgetLabel")).toHaveValue(55.5);
  });
});

describe("TemplateBoundView — enable control", () => {
  it("discloses the new budget epoch before re-enabling a bound loop", async () => {
    capture();
    renderBound();
    expect(await screen.findByText(/Enabling or re-enabling starts a new budget epoch/)).toBeVisible();
  });

  it("toggles through PATCH /loop/state with {enabled, reason: ''} and never PUTs /loop", async () => {
    const captured = capture();
    const user = userEvent.setup();
    renderBound();

    await user.click(await screen.findByTestId("bound-rails-enabled"));

    await waitFor(() => expect(captured.patches).toHaveLength(1));
    expect(captured.patches[0]).toEqual({ enabled: true, reason: "" });
    expect(captured.puts).toHaveLength(0);
  });

  it("is disabled with the prompt-required hint while the stored loop_prompt is empty", async () => {
    capture();
    // Enabling an empty loop_prompt 422s server-side; the dialog withholds the
    // toggle and says why, and the bound view must gate identically.
    renderBound({ config: { ...CONFIG, enabled: false, loop_prompt: "" } });

    const control = await screen.findByTestId("bound-rails-enabled");
    expect(control).toBeDisabled();
    expect(
      screen.getByText(i18n.t("boardLoop.enableRequiresPrompt")),
    ).toBeInTheDocument();
  });
});

describe("TemplateBoundView — member (non-admin) gating", () => {
  it("locks the rails and Save for a plain member but keeps the toggle, like the dialog", async () => {
    adminState.current.role = "member";
    capture();
    renderBound();

    await screen.findByTestId("bound-rails");
    // PUT /loop is admin-only; the dialog disables Save off the same hook.
    // Locking the inputs too is the honest version of that: a field you can
    // type into but never save is a trap.
    expect(screen.getByTestId("bound-save-rails")).toBeDisabled();
    expect(railInput("boardLoop.maxIterationsLabel")).toBeDisabled();
    expect(railInput("boardLoop.delayLabel")).toBeDisabled();
    expect(railInput("boardLoop.timeoutLabel")).toBeDisabled();
    expect(railInput("boardLoop.budgetLabel")).toBeDisabled();
    expect(railInput("boardLoop.failuresLabel")).toBeDisabled();
    expect(railInput("boardLoop.blockedOnHumanLabel")).toBeDisabled();
    // PATCH /loop/state is member-level (get_workspace_member server-side)
    // and BoardLoopDialog pins the toggle as available to members — the
    // bound view must not take that capability away.
    expect(screen.getByTestId("bound-rails-enabled")).toBeEnabled();
  });
});

it("previews and explicitly applies a policy with the same published template binding and proposed model", async () => {
  const captured = capture();
  const policyUrl = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/completion/policy`;
  const proposals: Record<string, unknown>[] = [];
  const resolution = (policy: unknown) => ({ override: policy, workspace_policy: null, effective_policy: policy, origin: policy ? "board" : "legacy", policy_hash: null, capabilities: {}, incompatibilities: [], changes: [] });
  server.use(
    http.get(policyUrl, () => HttpResponse.json(resolution(null))),
    http.post(`${policyUrl}/preview`, async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
      proposals.push(body);
      return HttpResponse.json({ ...resolution(body.policy), template_preview: { system_prompt: "Reviewed platform completion contract", loop_prompt: "Use authorized landing", tools: ["mcp__valaris__request_landing"], findings: [] } });
    }),
  );
  renderWithProviders(boundElement(CONFIG), { routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}`] } });
  await userEvent.click(await screen.findByRole("button", { name: "Agent-managed" }));
  await userEvent.type(screen.getByLabelText(i18n.t("boardLoop.providerLabel")), "custom-provider");
  const model = screen.getByLabelText(i18n.t("boardLoop.modelLabel"));
  await userEvent.clear(model);
  await userEvent.type(model, "exact-model");
  await waitFor(() => expect(proposals).toContainEqual(expect.objectContaining({
    policy: expect.objectContaining({ landing_actor: "agent" }),
    loop_config: expect.objectContaining({ provider: "custom-provider", model: "exact-model" }),
    template: { source: "system", ref: BOUND.ref, version: 3, slot_values: binding().slot_values },
  })));
  expect(captured.puts).toHaveLength(0);
  await userEvent.click(await screen.findByText("Template instructions after applying policy"));
  expect(screen.getByText("Reviewed platform completion contract")).toBeVisible();
  await waitFor(() => expect(screen.getByRole("button", { name: "Apply policy and refresh binding" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "Apply policy and refresh binding" }));
  await waitFor(() => expect(captured.puts).toHaveLength(1));
  expect(captured.puts[0]).toMatchObject({
    completion_policy: expect.objectContaining({ landing_actor: "agent" }),
    template: { source: "system", ref: BOUND.ref, version: 3, slot_values: binding().slot_values },
    provider: "custom-provider", model: "exact-model", expected_version: 7,
  });
  expect(captured.puts[0]).not.toHaveProperty("system_prompt");
  expect(captured.puts[0]).not.toHaveProperty("loop_prompt");
  expect(captured.puts[0]).not.toHaveProperty("tools");
});

it("blocks a template rebind with structural findings even when the board retains legacy policy", async () => {
  const captured = capture();
  const policyUrl = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/completion/policy`;
  const resolution = { override: null, workspace_policy: null, effective_policy: null, origin: "legacy", policy_hash: null, capabilities: {}, incompatibilities: [], changes: [] };
  server.use(
    http.get(policyUrl, () => HttpResponse.json(resolution)),
    http.post(`${policyUrl}/preview`, () => HttpResponse.json({ ...resolution, template_preview: { system_prompt: "Published instructions", loop_prompt: "Missing source binding", tools: [], findings: [{ code: "missing_slot", field: "slot_values", message: "Select the required source repository" }] } })),
  );
  renderWithProviders(boundElement(CONFIG), { routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}`] } });
  await userEvent.click(await screen.findByText("Template instructions after applying policy"));
  expect(screen.getByRole("alert")).toHaveTextContent("Select the required source repository");
  expect(screen.getByRole("button", { name: "Apply policy and refresh binding" })).toBeDisabled();
  expect(captured.puts).toHaveLength(0);
});

it("previews Save slots using saved policy and config while keeping other drafts out of its PUT", async () => {
  const captured = capture();
  const policyUrl = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/completion/policy`;
  const proposals: Record<string, unknown>[] = [];
  const resolution = { override: null, workspace_policy: null, effective_policy: null, origin: "legacy", policy_hash: null, capabilities: {}, incompatibilities: [] };
  server.use(
    http.get(policyUrl, () => HttpResponse.json(resolution)),
    http.post(`${policyUrl}/preview`, async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
      proposals.push(body);
      return HttpResponse.json({ ...resolution, incompatibilities: body.policy ? [{ code: "unsupported_provider", message: "Draft policy cannot run here" }] : [], template_preview: { system_prompt: "Rendered", loop_prompt: "Run", tools: [], findings: [] } });
    }),
  );
  renderBound();
  await userEvent.click(await screen.findByRole("button", { name: "Agent-managed" }));
  fireEvent.change(screen.getByLabelText(i18n.t("boardLoop.providerLabel")), { target: { value: "unsaved-provider" } });
  fireEvent.change(screen.getByLabelText(i18n.t("boardLoop.modelLabel")), { target: { value: "unsaved-model" } });
  setRail("boardLoop.maxIterationsLabel", "40");
  fireEvent.change(screen.getByTestId("bound-slot-REPO_URL"), { target: { value: "https://example.test/changed" } });
  const proposedTemplate = { source: "system", ref: BOUND.ref, version: 3, slot_values: { REPO_URL: "https://example.test/changed" } };
  await waitFor(() => expect(proposals).toContainEqual({ policy: null, template: proposedTemplate }));
  const save = screen.getByTestId("bound-save-slots");
  await waitFor(() => expect(save).toBeEnabled());
  await userEvent.click(save);
  await waitFor(() => expect(captured.puts).toEqual([{ template: proposedTemplate, expected_version: 7 }]));
  expect(screen.getByLabelText(i18n.t("boardLoop.providerLabel"))).toHaveValue("unsaved-provider");
  expect(railInput("boardLoop.maxIterationsLabel")).toHaveValue(40);
});
