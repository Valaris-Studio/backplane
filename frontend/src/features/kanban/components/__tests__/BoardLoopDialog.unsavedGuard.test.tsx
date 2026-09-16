// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent } from "@testing-library/react";
import { act, createTestQueryClient } from "@/test/test-utils";
import { boardLoopKeys } from "@/lib/query-keys";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import pt from "@/i18n/locales/pt-BR.json";
import { Route, Routes } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  stubReducedMotion,
  userEvent,
  waitFor,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import type { BoardDetail } from "@/types/kanban";

vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({
    role: "admin",
    isAdmin: true,
    isLoading: false,
    isError: false,
  }),
}));

import { BoardLoopDialog } from "../BoardLoopDialog";

const SLUG = "acme";
const BOARD_ID = "ops-board";
const BOARD_UUID = "0b7c1e2a-4c1d-4a9a-9c2e-2f6d8f3a1b11";

const LOOP_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/loop`;
const EXECUTIONS_URL = `/api/workspaces/${SLUG}/executions`;
const CONFIG_URL = `/api/workspaces/${SLUG}/config`;
const GIT_REPOS_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/git-repos`;

function makeBoard(): BoardDetail {
  return {
    id: BOARD_UUID,
    slug: BOARD_ID,
    name: "Ops Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    is_frozen: false,
    enforce_done_merge_gate: false,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    columns: [],
  } as BoardDetail;
}

function makeLoop() {
  return {
    enabled: false,
    provider: "",
    model: "mid",
    system_prompt: "",
    loop_prompt: "keep going",
    tools: [],
    max_iterations: 25,
    iteration_delay_seconds: 30,
    iteration_timeout_seconds: 3600,
    budget_usd: 20.0,
    max_consecutive_failures: 3,
    max_blocked_on_human: 3,
    starvation_policy: "park",
    loop_landing: "human",
    merge_gate: "forge_ci",
    completion_query: null,
    budget_epoch: null,
    disabled_reason: null,
    version: 7,
    updated_at: "2026-07-30T12:00:00Z",
  };
}

function renderDialog(queryClient = createTestQueryClient()) {
  const onOpenChange = vi.fn();
  const element = (open = true, board = makeBoard()) => <Routes>
    <Route path="/:slug/boards/:boardId/*" element={<BoardLoopDialog board={board} open={open} onOpenChange={onOpenChange} />} />
  </Routes>;
  const utils = renderWithProviders(element(), { queryClient, routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}/kanban`] } });
  return { ...utils, onOpenChange, rerenderDialog: (open: boolean, board = makeBoard()) => utils.rerender(element(open, board)) };
}

/** Counts real PUTs so "Discard fired no request" is asserted at the wire. */
function captureLoopPut() {
  const captured = { calls: 0, body: null as Record<string, unknown> | null };
  server.use(
    http.put(LOOP_URL, async ({ request }) => {
      captured.body = (await request.json()) as Record<string, unknown>;
      captured.calls += 1;
      return HttpResponse.json({ ...makeLoop(), version: 8 });
    }),
  );
  return captured;
}

const prompt = () => screen.queryByTestId("unsaved-changes-prompt");

/** Waits for the hydration effect, then edits the loop-prompt textarea. */
async function makeDirty(user: ReturnType<typeof userEvent.setup>) {
  const textarea = await screen.findByDisplayValue("keep going");
  await user.type(textarea, " forever");
  return textarea;
}

const closeButton = (): HTMLButtonElement => {
  const label = screen.getAllByText("Close")[0];
  const btn = label?.closest("button");
  if (!btn) throw new Error("Close text not inside a button");
  return btn as HTMLButtonElement;
};

beforeEach(() => {
  window.localStorage.clear();
  server.use(
    http.get(LOOP_URL, () => HttpResponse.json(makeLoop())),
    http.get(EXECUTIONS_URL, () => HttpResponse.json([])),
    http.get(CONFIG_URL, () =>
      HttpResponse.json({
        max_rework_attempts: 3,
        card_cooldown_hours: 1,
        commit_message_template: "",
        pr_description_template: "",
        pipeline_config: null,
        version: 1,
        enforce_done_merge_gate: false,
      }),
    ),
    http.get(GIT_REPOS_URL, () => HttpResponse.json([])),
  );
});

afterEach(() => {
  window.localStorage.clear();
  stubReducedMotion(false);
});

describe("BoardLoopDialog — unsaved-changes close guard", () => {
  it("Escape does not close a dirty dialog; it raises the prompt", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onOpenChange } = renderDialog();
    await makeDirty(user);

    await user.keyboard("{Escape}");

    expect(prompt()).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("overlay click does not close a dirty dialog; it raises the prompt", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onOpenChange } = renderDialog();
    await makeDirty(user);

    const overlay = document.querySelector<HTMLElement>(".fixed.inset-0.z-50");
    if (!overlay) throw new Error("overlay not found");
    await user.click(overlay);

    expect(prompt()).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("the X button does not close a dirty dialog; it raises the prompt", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onOpenChange } = renderDialog();
    await makeDirty(user);

    await user.click(closeButton());

    expect(prompt()).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("Discard closes and fires NO PUT at the wire", async () => {
    const put = captureLoopPut();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onOpenChange } = renderDialog();
    await makeDirty(user);
    await user.keyboard("{Escape}");

    await user.click(screen.getByTestId("unsaved-changes-discard"));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(put.calls).toBe(0);
  });

  it("Save from the prompt issues the normal PUT, still carrying expected_version", async () => {
    const put = captureLoopPut();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderDialog();
    await makeDirty(user);
    await user.keyboard("{Escape}");

    await user.click(screen.getByTestId("unsaved-changes-save"));

    await waitFor(() => expect(put.calls).toBe(1));
    // The optimistic lock from PRs #130/#134 must survive the guard path.
    expect(put.body).toMatchObject({
      loop_prompt: "keep going forever",
      expected_version: 7,
    });
  });

  it("Keep editing dismisses the prompt and preserves the edit", async () => {
    stubReducedMotion(true);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onOpenChange } = renderDialog();
    await makeDirty(user);
    await user.keyboard("{Escape}");

    await user.click(screen.getByTestId("unsaved-changes-keep-editing"));

    await waitFor(() => expect(prompt()).not.toBeInTheDocument());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("keep going forever")).toBeInTheDocument();
  });

  it("a clean dialog closes immediately on Escape with no prompt", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onOpenChange } = renderDialog();
    await screen.findByDisplayValue("keep going");

    await user.keyboard("{Escape}");

    expect(prompt()).not.toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("hydrating from the server config does not itself read as dirty", async () => {
    // The dirty flag compares against `config ?? BOARD_LOOP_DEFAULTS`; a
    // mismatch in any of the ~15 fields' `??` fallbacks would make every
    // freshly-opened dialog spuriously guarded.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onOpenChange } = renderDialog();
    await screen.findByDisplayValue("keep going");

    await user.keyboard("{Escape}");

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(prompt()).not.toBeInTheDocument();
  });
});

describe("BoardLoopDialog — background config changes", () => {
  it("keeps policy, source, prompts and rails until explicit rebase, then saves against the reviewed version", async () => {
    stubReducedMotion(true);
    const client = createTestQueryClient();
    let current = { ...makeLoop(), model: "server-exact-model" };
    const puts: Record<string, unknown>[] = [];
    const resolution = { override: null, workspace_policy: null, effective_policy: null, origin: "legacy", policy_hash: null, capabilities: {}, incompatibilities: [] };
    const policyUrl = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/completion/policy`;
    server.use(
      http.get(LOOP_URL, () => HttpResponse.json(current)),
      http.get(policyUrl, () => HttpResponse.json(resolution)),
      http.post(`${policyUrl}/preview`, async ({ request }) => HttpResponse.json({ ...resolution, effective_policy: (await request.json() as { policy: unknown }).policy })),
      http.put(LOOP_URL, async ({ request }) => {
        const body = await request.json() as Record<string, unknown>;
        puts.push(body);
        return body.expected_version === current.version
          ? HttpResponse.json({ ...current, ...body, version: current.version + 1 })
          : HttpResponse.json({ detail: "stale version" }, { status: 409 });
      }),
    );
    const { onOpenChange } = renderDialog(client);
    await screen.findByDisplayValue("keep going");
    await userEvent.click(await screen.findByRole("button", { name: "Agent-managed" }));
    const edits = [
      ["Provider", "operator-provider"], ["Custom model id", "operator-exact-model"],
      ["System prompt", "operator system"], ["Loop prompt", "operator loop"],
      ["Max iterations", "39"], ["Iteration delay (seconds)", "41"],
      ["Iteration timeout (seconds)", "3700"], ["Max consecutive failures", "5"],
      ["Max consecutive blocked on human (0 = off)", "6"],
    ];
    for (const [label, value] of edits) fireEvent.change(screen.getByLabelText(label!, { exact: true }), { target: { value } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    current = { ...current, provider: "teammate-provider", budget_usd: 44, max_iterations: 30, version: 8 };
    await act(async () => { await client.invalidateQueries({ queryKey: boardLoopKeys.detail(SLUG, BOARD_UUID) }); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await waitFor(() => expect(client.getQueryData(boardLoopKeys.withConfigured(SLUG, BOARD_UUID, undefined))).toMatchObject({ version: 8 }));
    for (const [label, value] of edits) expect((screen.getByLabelText(label!, { exact: true }) as HTMLInputElement).value).toBe(value);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({ expected_version: 7, max_iterations: 39, completion_policy: { landing_actor: "agent" } });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByLabelText("Max iterations", { exact: true })).toHaveValue(39);
    await userEvent.click(await screen.findByRole("button", { name: "Reload and keep edits" }));
    expect(screen.getByLabelText("Budget (USD)", { exact: true })).toHaveValue(44);
    for (const [label, value] of edits) expect((screen.getByLabelText(label!, { exact: true }) as HTMLInputElement).value).toBe(value);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    current = { ...current, budget_usd: 45, version: 9 };
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toMatchObject({ expected_version: 8, budget_usd: 44, max_iterations: 39 });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    await waitFor(() => expect(client.getQueryData(boardLoopKeys.withConfigured(SLUG, BOARD_UUID, undefined))).toMatchObject({ version: 9 }));
    await userEvent.click(screen.getByRole("button", { name: "Reload and keep edits" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts).toHaveLength(3));
    expect(puts[2]).toMatchObject({ expected_version: 9, budget_usd: 45, max_iterations: 39, provider: "operator-provider", model: "operator-exact-model", completion_policy: { landing_actor: "agent" } });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    for (const locale of [en, es, pt]) { expect(locale.boardLoop.configChanged).toBeTruthy(); expect(locale.boardLoop.reloadKeepEdits).toBeTruthy(); }
  });

  it("refreshes an untouched form without marking it dirty", async () => {
    const client = createTestQueryClient();
    let current = makeLoop();
    server.use(http.get(LOOP_URL, () => HttpResponse.json(current)));
    const { onOpenChange } = renderDialog(client);
    await screen.findByDisplayValue("keep going");
    current = { ...current, max_iterations: 31, version: 8 };
    await act(async () => { await client.invalidateQueries({ queryKey: boardLoopKeys.detail(SLUG, BOARD_UUID) }); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await waitFor(() => expect(screen.getByLabelText("Max iterations", { exact: true })).toHaveValue(31));
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(prompt()).not.toBeInTheDocument();
  });
});


it("withholds editing and Save until the first config response has hydrated", async () => {
  let respond: ((response: Response) => void) | undefined;
  server.use(http.get(LOOP_URL, () => new Promise<Response>((resolve) => { respond = resolve; })));
  renderDialog();
  await waitFor(() => expect(respond).toBeDefined());
  expect(screen.getByLabelText("Loop prompt", { exact: true })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  respond!(HttpResponse.json(makeLoop()));
  await screen.findByDisplayValue("keep going");
  expect(screen.getByLabelText("Loop prompt", { exact: true })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
});

it("retains a policy-only draft lock and observes a live stop without restarting the loop", async () => {
  const client = createTestQueryClient();
  let current = { ...makeLoop(), enabled: true };
  const put = captureLoopPut();
  const resolution = { override: null, workspace_policy: null, effective_policy: null, origin: "legacy", policy_hash: null, capabilities: {}, incompatibilities: [] };
  const policyUrl = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/completion/policy`;
  server.use(
    http.get(LOOP_URL, () => HttpResponse.json(current)),
    http.get(policyUrl, () => HttpResponse.json(resolution)),
    http.post(`${policyUrl}/preview`, () => HttpResponse.json(resolution)),
  );
  renderDialog(client);
  await screen.findByDisplayValue("keep going");
  await userEvent.click(await screen.findByRole("button", { name: "Agent-managed" }));
  current = { ...current, enabled: false, version: 8 };
  await act(async () => { await client.invalidateQueries({ queryKey: boardLoopKeys.detail(SLUG, BOARD_UUID) }); await new Promise((resolve) => setTimeout(resolve, 0)); });
  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(put.calls).toBe(1));
  expect(put.body).toMatchObject({ enabled: false, expected_version: 7, completion_policy: { landing_actor: "agent" } });
});

it("hydrates a fresh snapshot after discard/reopen and when the board identity changes", async () => {
  stubReducedMotion(true);
  let current = makeLoop();
  const otherBoard = { ...makeBoard(), id: "another-board-id" };
  server.use(
    http.get(LOOP_URL, () => HttpResponse.json(current)),
    http.get(`/api/workspaces/${SLUG}/boards/${otherBoard.id}/loop`, () => HttpResponse.json({ ...makeLoop(), loop_prompt: "Other board prompt", version: 2 })),
  );
  const client = createTestQueryClient();
  const view = renderDialog(client);
  await makeDirty(userEvent.setup());
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByTestId("unsaved-changes-discard"));
  view.rerenderDialog(false);
  current = { ...current, loop_prompt: "Latest prompt", version: 8 };
  await act(async () => { await client.invalidateQueries({ queryKey: boardLoopKeys.detail(SLUG, BOARD_UUID) }); });
  view.rerenderDialog(true);
  await screen.findByDisplayValue("Latest prompt");
  fireEvent.change(screen.getByLabelText("Loop prompt", { exact: true }), { target: { value: "Discarded board draft" } });
  view.rerenderDialog(true, otherBoard);
  await screen.findByDisplayValue("Other board prompt");
  expect(screen.queryByDisplayValue("Discarded board draft")).not.toBeInTheDocument();
});

it.each([true, false])("locks an unconfigured draft at version zero after concurrent creation (refetched: %s)", async (refetched) => {
  stubReducedMotion(true);
  const client = createTestQueryClient();
  let current: ReturnType<typeof makeLoop> | null = null;
  const puts: Record<string, unknown>[] = [];
  server.use(
    http.get(LOOP_URL, () => current ? HttpResponse.json(current) : HttpResponse.json({ detail: "not configured" }, { status: 404 })),
    http.put(LOOP_URL, async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
      puts.push(body);
      return body.expected_version !== undefined && current && body.expected_version !== current.version
        ? HttpResponse.json({ detail: "stale version" }, { status: 409 })
        : HttpResponse.json({ ...current, ...body, version: 2 });
    }),
  );
  const { onOpenChange } = renderDialog(client);
  await waitFor(() => expect(screen.getByLabelText("Loop prompt", { exact: true })).toBeEnabled());
  fireEvent.change(screen.getByLabelText("Loop prompt", { exact: true }), { target: { value: "My first config" } });
  fireEvent.change(screen.getByLabelText("Max iterations", { exact: true }), { target: { value: "39" } });
  current = { ...makeLoop(), loop_prompt: "Teammate created this", budget_usd: 44, version: 1 };
  if (refetched) await act(async () => { await client.invalidateQueries({ queryKey: boardLoopKeys.detail(SLUG, BOARD_UUID) }); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(screen.getByLabelText("Loop prompt", { exact: true })).toHaveValue("My first config");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]).toMatchObject({ expected_version: 0, loop_prompt: "My first config", max_iterations: 39 });
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
  await userEvent.click(await screen.findByRole("button", { name: "Reload and keep edits" }));
  expect(screen.getByLabelText("Budget (USD)", { exact: true })).toHaveValue(44);
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(puts).toHaveLength(2));
  expect(puts[1]).toMatchObject({ expected_version: 1, budget_usd: 44, loop_prompt: "My first config", max_iterations: 39 });
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
});
