// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import type { BoardDetail } from "@/types/kanban";
import type { GitRepo } from "@/types/git";

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

function makeWorkspaceConfig(enforceDoneMergeGate: boolean) {
  return {
    max_rework_attempts: 3,
    card_cooldown_hours: 1,
    commit_message_template: "",
    pr_description_template: "",
    pipeline_config: null,
    version: 1,
    enforce_done_merge_gate: enforceDoneMergeGate,
  };
}

function makeBoard(enforceDoneMergeGate: boolean | null): BoardDetail {
  return {
    id: BOARD_UUID,
    slug: BOARD_ID,
    name: "Ops Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    is_frozen: false,
    enforce_done_merge_gate: enforceDoneMergeGate,
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
    loop_prompt: "",
    tools: [],
    max_iterations: 25,
    iteration_delay_seconds: 30,
    iteration_timeout_seconds: 3600,
    budget_usd: 20.0,
    max_consecutive_failures: 3,
    disabled_reason: null,
    version: 1,
    updated_at: "2026-07-30T12:00:00Z",
  };
}

function makeGitRepo(): GitRepo {
  return {
    id: "repo-1",
    slug: "ops-repo",
    board_id: BOARD_UUID,
    workspace_id: "ws-1",
    name: "ops-repo",
    url: "https://github.com/acme/ops-repo",
    provider: "github",
    default_branch: "main",
    integration_branch: null,
    connection_id: null,
    description: "",
    added_by: "user-1",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
  };
}

function renderDialog(board: BoardDetail) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId/*"
        element={<BoardLoopDialog board={board} open onOpenChange={() => {}} />}
      />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}/kanban`] } },
  );
}

beforeEach(() => {
  server.use(
    http.get(LOOP_URL, () => HttpResponse.json(makeLoop())),
    http.get(EXECUTIONS_URL, () => HttpResponse.json([])),
    // Repo present throughout: these tests isolate the flag resolution, not
    // the structural repo-less exemption (pinned in BoardLoopDialog.test.tsx).
    http.get(GIT_REPOS_URL, () => HttpResponse.json([makeGitRepo()])),
  );
});

// The board override wins over the workspace flag, exactly as the backend
// resolves it. The repo-less exemption still gates everything on top.
describe("BoardLoopDialog — board done-gate override", () => {
  it("omits the hint when the board overrides the gate OFF, even with the workspace flag ON", async () => {
    // The absence assert only discriminates once the config query has settled
    // (workspace gate known ON) — before that, every implementation passes.
    let configServed = false;
    server.use(
      http.get(CONFIG_URL, () => {
        configServed = true;
        return HttpResponse.json(makeWorkspaceConfig(true));
      }),
    );
    renderDialog(makeBoard(false));

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toBeInTheDocument(),
    );
    await waitFor(() => expect(configServed).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(
      screen.queryByTestId("board-loop-done-gate-hint"),
    ).not.toBeInTheDocument();
  });

  it("shows the hint when the board overrides the gate ON, even with the workspace flag OFF", async () => {
    server.use(
      http.get(CONFIG_URL, () => HttpResponse.json(makeWorkspaceConfig(false))),
    );
    renderDialog(makeBoard(true));

    expect(
      await screen.findByTestId("board-loop-done-gate-hint"),
    ).toBeInTheDocument();
  });

  it("inherits the workspace flag when the override is null", async () => {
    server.use(
      http.get(CONFIG_URL, () => HttpResponse.json(makeWorkspaceConfig(true))),
    );
    renderDialog(makeBoard(null));

    expect(
      await screen.findByTestId("board-loop-done-gate-hint"),
    ).toBeInTheDocument();
  });

  it("keeps the repo-less exemption supreme over an ON override", async () => {
    let reposServed = false;
    server.use(
      http.get(CONFIG_URL, () => HttpResponse.json(makeWorkspaceConfig(false))),
      http.get(GIT_REPOS_URL, () => {
        reposServed = true;
        return HttpResponse.json([]);
      }),
    );
    renderDialog(makeBoard(true));

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toBeInTheDocument(),
    );
    await waitFor(() => expect(reposServed).toBe(true));
    expect(
      screen.queryByTestId("board-loop-done-gate-hint"),
    ).not.toBeInTheDocument();
  });
});

// --- B10: the auto-relax notice under self_merge — accept is the default ---
//
// The trap the old opt-in confirm failed to close: the gate defaults ON at
// workspace level, so a board whose landing has the agent move its OWN card
// dead-ended unless the operator noticed and clicked through the confirm.
// The server now relaxes on a human self_merge save by default; the row is a
// notice with a decline lever, shown only where the stamp will land.

async function openDialogWithLanding(
  board: BoardDetail,
  landing: string,
  workspaceGate = true,
) {
  server.use(
    http.get(CONFIG_URL, () => HttpResponse.json(makeWorkspaceConfig(workspaceGate))),
    http.get(LOOP_URL, () =>
      HttpResponse.json({ ...makeLoop(), loop_landing: landing }),
    ),
  );
  renderDialog(board);
  await waitFor(() =>
    expect(screen.getByLabelText(/loop prompt/i)).toBeInTheDocument(),
  );
  return { user: userEvent.setup() };
}

describe("BoardLoopDialog — self_merge done-gate auto-relax notice", () => {
  it("shows the notice when the gate is ON, the board has a repo, and the landing is self_merge", async () => {
    await openDialogWithLanding(makeBoard(null), "self_merge");

    const offer = await screen.findByTestId("board-loop-relax-gate-offer");
    expect(offer).toBeInTheDocument();
    // The plain notice is REPLACED, not stacked beside its own actionable form.
    expect(
      screen.queryByTestId("board-loop-done-gate-hint"),
    ).not.toBeInTheDocument();
  });

  it("shows the enforced-gate warning, not the offer, when the override is explicitly ON", async () => {
    // The server never implicitly softens an explicit True — offering the
    // relax would promise a stamp that will not happen.
    await openDialogWithLanding(makeBoard(true), "self_merge", false);

    expect(
      await screen.findByTestId("board-loop-enforced-gate-warning"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("board-loop-relax-gate-offer"),
    ).not.toBeInTheDocument();
  });

  it("keeps the plain notice and no offer under the human landing", async () => {
    await openDialogWithLanding(makeBoard(null), "human");

    expect(
      await screen.findByTestId("board-loop-done-gate-hint"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("board-loop-relax-gate-offer"),
    ).not.toBeInTheDocument();
  });

  it("withdraws the notice live when the landing is switched away from self_merge", async () => {
    const { user } = await openDialogWithLanding(makeBoard(null), "self_merge");
    expect(
      await screen.findByTestId("board-loop-relax-gate-offer"),
    ).toBeInTheDocument();

    await user.click(screen.getByLabelText(/pr landing/i));
    await user.click(
      await screen.findByRole("option", { name: /human merge/i }),
    );

    await waitFor(() =>
      expect(
        screen.queryByTestId("board-loop-relax-gate-offer"),
      ).not.toBeInTheDocument(),
    );
  });

  it("shows no notice when the board has no repo, even under self_merge", async () => {
    let reposServed = false;
    server.use(
      http.get(GIT_REPOS_URL, () => {
        reposServed = true;
        return HttpResponse.json([]);
      }),
    );
    await openDialogWithLanding(makeBoard(null), "self_merge");
    await waitFor(() => expect(reposServed).toBe(true));

    expect(
      screen.queryByTestId("board-loop-relax-gate-offer"),
    ).not.toBeInTheDocument();
  });

  it("shows no notice when the board already overrides the gate OFF", async () => {
    let configServed = false;
    server.use(
      http.get(CONFIG_URL, () => {
        configServed = true;
        return HttpResponse.json(makeWorkspaceConfig(true));
      }),
      http.get(LOOP_URL, () =>
        HttpResponse.json({ ...makeLoop(), loop_landing: "self_merge" }),
      ),
    );
    renderDialog(makeBoard(false));
    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toBeInTheDocument(),
    );
    await waitFor(() => expect(configServed).toBe(true));

    expect(
      screen.queryByTestId("board-loop-relax-gate-offer"),
    ).not.toBeInTheDocument();
  });

  it("omits the field on a default save — the accept is server-side, not a client signal", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.put(LOOP_URL, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...makeLoop(), loop_landing: "self_merge" });
      }),
    );
    const { user } = await openDialogWithLanding(makeBoard(null), "self_merge");
    await screen.findByTestId("board-loop-relax-gate-offer");

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body!.relax_done_merge_gate).toBeUndefined();
  });

  it("sends relax_done_merge_gate: false after the operator declines", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.put(LOOP_URL, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...makeLoop(), loop_landing: "self_merge" });
      }),
    );
    const { user } = await openDialogWithLanding(makeBoard(null), "self_merge");

    await user.click(await screen.findByTestId("board-loop-relax-gate-undo"));
    await screen.findByTestId("board-loop-relax-gate-declined");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body!.relax_done_merge_gate).toBe(false);
  });

  it("re-accepting after a decline goes back to omitting the field", async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.put(LOOP_URL, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...makeLoop(), loop_landing: "self_merge" });
      }),
    );
    const { user } = await openDialogWithLanding(makeBoard(null), "self_merge");

    await user.click(await screen.findByTestId("board-loop-relax-gate-undo"));
    await user.click(await screen.findByTestId("board-loop-relax-gate-accept"));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body!.relax_done_merge_gate).toBeUndefined();
  });

  it("states the consequence — that agents may move cards to Done with no merged PR", async () => {
    await openDialogWithLanding(makeBoard(null), "self_merge");

    const offer = await screen.findByTestId("board-loop-relax-gate-offer");
    expect(offer.textContent).toMatch(/without a merged PR/i);
  });
});

describe("BoardLoopDialog — declined offer keeps the consequence visible", () => {
  it("still shows the consequence copy after a decline", async () => {
    const { user } = await openDialogWithLanding(makeBoard(null), "self_merge");

    const offer = await screen.findByTestId("board-loop-relax-gate-offer");
    await user.click(screen.getByTestId("board-loop-relax-gate-undo"));

    expect(
      screen.getByTestId("board-loop-relax-gate-declined"),
    ).toBeInTheDocument();
    // The notice paragraph is hoisted above the branch: an operator
    // reconsidering sees what re-accepting does, not just a button label.
    expect(offer).toHaveTextContent(/without a merged PR/i);
  });
});

describe("BoardLoopDialog — re-arm notice when the landing leaves self_merge", () => {
  it("announces the server's restore when a relaxed board's landing is switched away", async () => {
    // Stored landing self_merge + board override OFF is the auto-relax
    // footprint; moving the landing off self_merge makes the next save
    // restore the override to inherit. Silent re-arming would surprise.
    const { user } = await openDialogWithLanding(makeBoard(false), "self_merge");
    expect(
      screen.queryByTestId("board-loop-rearm-notice"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByLabelText(/pr landing/i));
    await user.click(
      await screen.findByRole("option", { name: /human merge/i }),
    );

    expect(
      await screen.findByTestId("board-loop-rearm-notice"),
    ).toBeInTheDocument();
  });

  it("shows no re-arm notice when the gate override is not OFF", async () => {
    const { user } = await openDialogWithLanding(makeBoard(null), "self_merge");

    await user.click(screen.getByLabelText(/pr landing/i));
    await user.click(
      await screen.findByRole("option", { name: /human merge/i }),
    );

    await waitFor(() =>
      expect(
        screen.queryByTestId("board-loop-relax-gate-offer"),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("board-loop-rearm-notice"),
    ).not.toBeInTheDocument();
  });
});

describe("BoardLoopDialog — the CI gate is named apart from the done gate", () => {
  it("labels the merge_gate select 'CI gate', not 'Merge gate'", async () => {
    await openDialogWithLanding(makeBoard(null), "human");

    expect(screen.getByLabelText(/^ci gate$/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^merge gate$/i)).not.toBeInTheDocument();
  });
});

describe("BoardLoopDialog — a decline does not outlive the landing it was given for", () => {
  it("drops a declined relax when the landing is switched away before saving", async () => {
    // The notice is withdrawn from view when the landing changes, which hides
    // the stale decline without clearing it. Under any other landing there is
    // no auto-relax to decline — sending false anyway would be a signal about
    // a box the operator can no longer even see.
    let body: Record<string, unknown> | null = null;
    server.use(
      http.put(LOOP_URL, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...makeLoop(), loop_landing: "human" });
      }),
    );
    const { user } = await openDialogWithLanding(makeBoard(null), "self_merge");

    await user.click(await screen.findByTestId("board-loop-relax-gate-undo"));
    await screen.findByTestId("board-loop-relax-gate-declined");

    await user.click(screen.getByLabelText(/pr landing/i));
    await user.click(
      await screen.findByRole("option", { name: /human merge/i }),
    );
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body!.loop_landing).toBe("human");
    expect(body!.relax_done_merge_gate).toBeUndefined();
  });
});

it("shows effective completion policy in disabled loop setup and saves its explicit override atomically", async () => {
  const policyUrl = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/completion/policy`;
  const result = (policy: unknown) => ({ override: policy, workspace_policy: null, effective_policy: policy, origin: policy ? "board" : "legacy", policy_hash: null, capabilities: {}, incompatibilities: [], changes: [] });
  const saved: unknown[] = [];
  server.use(
    http.get(policyUrl, () => HttpResponse.json(result(null))),
    http.post(`${policyUrl}/preview`, async ({ request }) => HttpResponse.json(result((await request.json() as { policy: unknown }).policy))),
    http.put(policyUrl, async ({ request }) => { const { policy } = await request.json() as { policy: unknown }; saved.push(policy); return HttpResponse.json(result(policy)); }),
    http.put(LOOP_URL, async ({ request }) => { const body = await request.json() as { completion_policy: unknown }; saved.push(body.completion_policy); return HttpResponse.json(makeLoop()); }),
  );
  renderDialog(makeBoard(true));
  await userEvent.setup().click(await screen.findByRole("button", { name: "Agent-managed" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
  await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saved).toEqual([expect.objectContaining({ landing_actor: "agent" })]));
});

it("does not enable an explicitly configured policy while effective compatibility is unavailable", async () => {
  server.use(
    http.get(LOOP_URL, () => HttpResponse.json({ ...makeLoop(), loop_prompt: "Work on cards", completion_policy: { version: 1 } })),
    http.get(`/api/workspaces/${SLUG}/boards/${BOARD_UUID}/completion/policy`, () => new HttpResponse(null, { status: 503 })),
  );
  renderDialog(makeBoard(null));
  await screen.findByDisplayValue("Work on cards");
  const enable = screen.getByRole("checkbox", { name: /enable/i });
  expect(enable).toBeDisabled();
});


it("previews model repairs with the selected policy and saves both in one loop request", async () => {
  const policyUrl = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/completion/policy`;
  const resolution = (policy: unknown) => ({ override: policy, workspace_policy: null, effective_policy: policy, origin: policy ? "board" : "legacy", policy_hash: null, capabilities: {}, incompatibilities: [], changes: [] });
  const proposals: Record<string, unknown>[] = [];
  const saves: Record<string, unknown>[] = [];
  let policyWrites = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  server.use(
    http.get(LOOP_URL, () => HttpResponse.json({ ...makeLoop(), provider: "custom-provider", model: "missing-model" })),
    http.get(policyUrl, () => HttpResponse.json(resolution(null))),
    http.post(`${policyUrl}/preview`, async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
      proposals.push(body);
      if (body.policy && (body.loop_config as { model?: string } | undefined)?.model === "exact-model") await pending;
      return HttpResponse.json(resolution(body.policy));
    }),
    http.put(policyUrl, async ({ request }) => { policyWrites++; return HttpResponse.json(resolution((await request.json() as { policy: unknown }).policy)); }),
    http.put(LOOP_URL, async ({ request }) => { saves.push(await request.json() as Record<string, unknown>); return HttpResponse.json({ detail: "Repair not yet available" }, { status: 422 }); }),
  );
  renderDialog(makeBoard(null));
  const model = await screen.findByDisplayValue("missing-model");
  await userEvent.setup().click(await screen.findByRole("button", { name: "Agent-managed" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
  await userEvent.clear(model);
  await userEvent.type(model, "exact-model");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await waitFor(() => expect(proposals).toContainEqual(expect.objectContaining({ policy: expect.objectContaining({ landing_actor: "agent" }), loop_config: expect.objectContaining({ provider: "custom-provider", model: "exact-model" }) })));
  release();
  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saves).toHaveLength(1));
  expect(saves[0]).toMatchObject({ provider: "custom-provider", model: "exact-model", completion_policy: expect.objectContaining({ landing_actor: "agent" }) });
  expect(policyWrites).toBe(0);
  expect(screen.getByDisplayValue("exact-model")).toBeVisible();
});

it("replaces legacy self-merge routing only when the operator selects an explicit policy", async () => {
  const policyUrl = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/completion/policy`;
  const saves: Record<string, unknown>[] = [];
  const resolution = (policy: unknown) => ({ override: policy, workspace_policy: null, effective_policy: policy, origin: policy ? "board" : "legacy", policy_hash: null, capabilities: {}, incompatibilities: [], changes: [] });
  server.use(
    http.get(LOOP_URL, () => HttpResponse.json({ ...makeLoop(), loop_landing: "self_merge" })),
    http.get(policyUrl, () => HttpResponse.json(resolution(null))),
    http.post(`${policyUrl}/preview`, async ({ request }) => {
      const body = await request.json() as { policy: unknown; loop_config: { loop_landing: string } };
      return HttpResponse.json({ ...resolution(body.policy), incompatibilities: body.policy && body.loop_config.loop_landing === "self_merge" ? [{ code: "completion_policy_conflict", message: "Use policy-mediated landing" }] : [] });
    }),
    http.put(LOOP_URL, async ({ request }) => { saves.push(await request.json() as Record<string, unknown>); return HttpResponse.json(makeLoop()); }),
  );
  renderDialog(makeBoard(null));
  await userEvent.click(await screen.findByRole("button", { name: "Agent-managed" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saves).toHaveLength(1));
  expect(saves[0]).toMatchObject({ loop_landing: "merge_queue", completion_policy: expect.objectContaining({ landing_actor: "agent" }) });
  expect(saves[0]).not.toHaveProperty("relax_done_merge_gate");
});
