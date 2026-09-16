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
import type { BoardDetail } from "@/types/kanban";

// Card 55a9866b — "Start from template" in the Loop dialog. RED phase.
//
// Locator contract (the implementation must satisfy these testids):
// - "loop-template-select"          — the select trigger listing templates by
//                                     name (items rendered as role="option").
// - "loop-template-confirm"         — the overwrite confirm gate, shown ONLY
//                                     when a prompt field is already non-empty.
// - "loop-template-confirm-apply"   — applies the template over the user text.
// - "loop-template-confirm-cancel"  — keeps the user's text untouched.
//
// Behavior pins: templates come from GET /loop-templates via a hook (MSW-served
// here); selection fills system_prompt + loop_prompt + tools into FORM STATE
// only — Go template vars stay verbatim and no PUT fires until the dialog's
// own Save button is clicked.

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

import { BoardLoopDialog } from "../BoardLoopDialog";

const SLUG = "acme";
// Route param is the board SLUG; /loop resolves UUIDs — same split as
// BoardLoopDialog.test.tsx (see the slug-vs-UUID note there).
const BOARD_ID = "ops-board";
const BOARD_UUID = "0b7c1e2a-4c1d-4a9a-9c2e-2f6d8f3a1b11";

const LOOP_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/loop`;
const EXECUTIONS_URL = `/api/workspaces/${SLUG}/executions`;
const CONFIG_URL = `/api/workspaces/${SLUG}/config`;
const GIT_REPOS_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/git-repos`;
// The catalog is workspace-scoped (auth consistency), not board-scoped.
const TEMPLATES_URL = `/api/workspaces/${SLUG}/loop-templates`;

// The catalog's server-declared runner var vocabulary (backend
// LOOP_RUNNER_VARS). The palette renders chips from THIS, never from a
// frontend literal.
const CATALOG_META = {
  runner_vars: ["Workspace", "BoardID", "AgentID", "ExecutionID", "Iteration"],
};

// Fixture templates: tools use the full MCP ids the loop config stores (the
// ToolPicker selects by full id — FULL_PUT_BODY precedent in the backend
// suite). Prose is placeholder; the tests pin structure and behavior only.
const CODING_TEMPLATE = {
  id: "coding-loop",
  name: "Coding loop",
  description: "Work the board and land PRs.",
  system_prompt: "You are the coding agent for {{.Workspace}}.",
  loop_prompt:
    "Iteration {{.Iteration}} on board {{.BoardID}}. [CUSTOMIZE: objective]\n\n## Lessons\n- (append learnings here)",
  tools: [
    "mcp__valaris__enqueue_pr_for_merge",
    "mcp__valaris__set_board_loop",
  ],
};

const REVISION_TEMPLATE = {
  id: "revision-loop",
  name: "Revision loop",
  description: "Revise and polish existing work.",
  system_prompt: "You revise work for {{.Workspace}}.",
  loop_prompt:
    "Iteration {{.Iteration}}. [CUSTOMIZE: what to revise]\n\n## Lessons\n- none yet",
  tools: ["mcp__valaris__get_card", "mcp__valaris__update_card"],
};

const TRIAGE_TEMPLATE = {
  id: "triage-loop",
  name: "Triage loop",
  description: "Keep the backlog groomed.",
  system_prompt: "You triage the backlog for {{.Workspace}}.",
  loop_prompt:
    "Iteration {{.Iteration}}. [CUSTOMIZE: triage rules]\n\n## Lessons\n- none yet",
  tools: ["mcp__valaris__get_card", "mcp__valaris__move_card"],
};

const TEMPLATES = [CODING_TEMPLATE, REVISION_TEMPLATE, TRIAGE_TEMPLATE];

// A template the raw dialog CANNOT apply: its prompts carry <<SLOT>>s, so
// copying them into the textareas would 422 (unrendered_slot) at save. Until
// the bind step ships it is offered disabled. Deliberately unlike the others
// so an assertion on the applied text cannot pass by coincidence.
const SLOTTED_TEMPLATE = {
  id: "coding-loop-v2",
  name: "Coding loop v2",
  description: "Slot-driven coding loop — needs the bind step.",
  system_prompt: "You are the delivery agent for <<PROJECT_NAME>>.",
  loop_prompt: "Iteration {{.Iteration}}. Ship <<CARD_SCOPE>>.",
  tools: ["mcp__valaris__get_card"],
  has_slots: true,
};

function makeBoard(): BoardDetail {
  return {
    id: BOARD_UUID,
    slug: BOARD_ID,
    name: "Ops Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    is_frozen: false,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    columns: [],
  } as BoardDetail;
}

function makeLoop(overrides: Partial<Record<string, unknown>> = {}) {
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
    starvation_policy: "park",
    loop_landing: "human",
    merge_gate: "forge_ci",
    disabled_reason: null,
    version: 1,
    updated_at: "2026-07-30T12:00:00Z",
    ...overrides,
  };
}

function makeWorkspaceConfig() {
  return {
    max_rework_attempts: 3,
    card_cooldown_hours: 1,
    commit_message_template: "",
    pr_description_template: "",
    pipeline_config: null,
    version: 1,
    enforce_done_merge_gate: false,
  };
}

function renderDialog() {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId/*"
        element={
          <BoardLoopDialog board={makeBoard()} open onOpenChange={() => {}} />
        }
      />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}/kanban`] } },
  );
}

async function openTemplateSelect(user: ReturnType<typeof userEvent.setup>) {
  const trigger = await screen.findByTestId("loop-template-select");
  await user.click(trigger);
  return trigger;
}

async function chooseTemplate(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await openTemplateSelect(user);
  await user.click(await screen.findByRole("option", { name }));
}

beforeEach(() => {
  adminState.current.role = "admin";
  server.use(
    http.get(LOOP_URL, () => HttpResponse.json(makeLoop())),
    http.get(EXECUTIONS_URL, () => HttpResponse.json([])),
    http.get(CONFIG_URL, () => HttpResponse.json(makeWorkspaceConfig())),
    http.get(GIT_REPOS_URL, () => HttpResponse.json([])),
    http.get(TEMPLATES_URL, () =>
      HttpResponse.json({ templates: TEMPLATES, meta: CATALOG_META }),
    ),
  );
});

describe("BoardLoopDialog — template select", () => {
  it("lists the served templates by name", async () => {
    const user = userEvent.setup();
    renderDialog();

    await openTemplateSelect(user);
    for (const template of TEMPLATES) {
      expect(
        await screen.findByRole("option", { name: template.name }),
      ).toBeInTheDocument();
    }
  });
});

describe("BoardLoopDialog — slotted templates are not applicable", () => {
  // Rollout guard (spec §3.2, F3): P1 seeds templates with <<SLOT>>s but the
  // bind step that renders them is P3. Applying one here would fill the
  // textareas with text the save endpoint rejects — a dead end. Per the card's
  // Direction they render DISABLED with a hint rather than hidden, so the
  // operator learns templates are coming.
  beforeEach(() => {
    server.use(
      http.get(TEMPLATES_URL, () =>
        HttpResponse.json({
          templates: [...TEMPLATES, SLOTTED_TEMPLATE],
          meta: CATALOG_META,
        }),
      ),
    );
  });

  it("lists the slotted template but marks the option disabled", async () => {
    const user = userEvent.setup();
    renderDialog();

    await openTemplateSelect(user);

    const slotted = await screen.findByRole("option", {
      name: new RegExp(SLOTTED_TEMPLATE.name),
    });
    // aria-disabled is what Radix sets and what assistive tech reads; the
    // data attribute is what drives the muted styling.
    expect(slotted).toHaveAttribute("aria-disabled", "true");
    expect(slotted).toHaveAttribute("data-disabled");

    // Non-slotted options stay selectable — the guard must not disable the
    // whole list. Anchored: "Coding loop" is a prefix of "Coding loop v2".
    const coding = await screen.findByRole("option", {
      name: new RegExp(`^${CODING_TEMPLATE.name}$`),
    });
    expect(coding).not.toHaveAttribute("aria-disabled", "true");
  });

  it("names the reason on the disabled option so the dead end is legible", async () => {
    const user = userEvent.setup();
    renderDialog();

    await openTemplateSelect(user);

    const slotted = await screen.findByRole("option", {
      name: new RegExp(SLOTTED_TEMPLATE.name),
    });
    expect(slotted).toHaveTextContent(/bind step|not yet applicable/i);
  });

  it("does not fill the prompts when a slotted template is chosen", async () => {
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toHaveValue(""),
    );
    await openTemplateSelect(user);
    await user.click(
      await screen.findByRole("option", {
        name: new RegExp(SLOTTED_TEMPLATE.name),
      }),
    );

    // The <<SLOT>> text must never reach a textarea — that is the 422 the
    // guard exists to prevent.
    expect(screen.getByLabelText(/system prompt/i)).toHaveValue("");
    expect(screen.getByLabelText(/loop prompt/i)).toHaveValue("");
    expect(
      (screen.getByLabelText(/system prompt/i) as HTMLTextAreaElement).value,
    ).not.toContain("<<PROJECT_NAME>>");
  });

  it("refuses a slotted template even through the overwrite confirm gate", async () => {
    // Defense in depth: a disabled SelectItem still carries a value, and the
    // confirm path calls applyTemplate with whatever was staged. The handler
    // itself must refuse, so no route into applyTemplate can smuggle slots in.
    const USER_PROMPT = "Keep my hand-written prompt.";
    server.use(
      http.get(LOOP_URL, () =>
        HttpResponse.json(makeLoop({ loop_prompt: USER_PROMPT })),
      ),
    );
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toHaveValue(USER_PROMPT),
    );
    await openTemplateSelect(user);
    await user.click(
      await screen.findByRole("option", {
        name: new RegExp(SLOTTED_TEMPLATE.name),
      }),
    );

    // No confirm gate may even open for a template that can never be applied.
    expect(
      screen.queryByTestId("loop-template-confirm"),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText(/loop prompt/i)).toHaveValue(USER_PROMPT);
  });

  it("refuses a slotted id the Select reports without the disabled attribute", async () => {
    // The two guards would otherwise mask each other: a disabled Radix option
    // never fires onValueChange, so every test above stays green with the
    // handler guard deleted. Serving the slotted entry WITHOUT has_slots makes
    // the option enabled and clickable, then the applied text proves which
    // guard actually ran — the handler must consult the prompts' own slots.
    server.use(
      http.get(TEMPLATES_URL, () =>
        HttpResponse.json({
          templates: [
            ...TEMPLATES,
            { ...SLOTTED_TEMPLATE, has_slots: undefined },
          ],
          meta: CATALOG_META,
        }),
      ),
    );
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toHaveValue(""),
    );
    await openTemplateSelect(user);

    const slotted = await screen.findByRole("option", {
      name: new RegExp(SLOTTED_TEMPLATE.name),
    });
    expect(slotted).not.toHaveAttribute("aria-disabled", "true");
    await user.click(slotted);

    // Reached the handler with an enabled option — the <<SLOT>> text must
    // still never land in a textarea.
    await waitFor(() =>
      expect(
        (screen.getByLabelText(/system prompt/i) as HTMLTextAreaElement).value,
      ).not.toContain("<<PROJECT_NAME>>"),
    );
    expect(screen.getByLabelText(/loop prompt/i)).not.toHaveValue(
      SLOTTED_TEMPLATE.loop_prompt,
    );
  });

  it.each([
    {
      label: "system_prompt only",
      overrides: {
        system_prompt: "Agent for <<PROJECT_NAME>>.",
        loop_prompt: "Iteration {{.Iteration}}. Nothing slotted here.",
      },
      applicable: false,
    },
    {
      label: "loop_prompt only",
      overrides: {
        system_prompt: "A plain system prompt.",
        loop_prompt: "Iteration {{.Iteration}}. Ship <<CARD_SCOPE>>.",
      },
      applicable: false,
    },
    {
      label: "bare angle brackets are not a slot",
      overrides: {
        system_prompt: "Compare a << b and c >> d.",
        loop_prompt: "Iteration {{.Iteration}}. Still applicable.",
      },
      applicable: true,
    },
    {
      label: "lowercase is not the slot grammar",
      overrides: {
        system_prompt: "Agent for <<project_name>>.",
        loop_prompt: "Iteration {{.Iteration}}. Still applicable.",
      },
      applicable: true,
    },
  ])(
    "re-checks each prompt against the real slot grammar — $label",
    async ({ overrides, applicable }) => {
      // Each case carries slots (or slot-like text) in ONE field only, so a
      // guard that scans just one of the two — or one that matches a bare
      // "<<" — is distinguishable. has_slots is omitted throughout: the
      // option stays enabled and the handler is the only thing deciding.
      const candidate = {
        ...SLOTTED_TEMPLATE,
        ...overrides,
        has_slots: undefined,
      };
      server.use(
        http.get(TEMPLATES_URL, () =>
          HttpResponse.json({
            templates: [...TEMPLATES, candidate],
            meta: CATALOG_META,
          }),
        ),
      );
      const user = userEvent.setup();
      renderDialog();

      await waitFor(() =>
        expect(screen.getByLabelText(/loop prompt/i)).toHaveValue(""),
      );
      await openTemplateSelect(user);
      await user.click(
        await screen.findByRole("option", {
          name: new RegExp(SLOTTED_TEMPLATE.name),
        }),
      );

      if (applicable) {
        await waitFor(() =>
          expect(screen.getByLabelText(/system prompt/i)).toHaveValue(
            candidate.system_prompt,
          ),
        );
      } else {
        // Give the (rejected) state update a chance to land before asserting
        // absence, so this cannot pass merely by racing the render.
        await waitFor(() =>
          expect(screen.getByLabelText(/loop prompt/i)).toHaveValue(""),
        );
        expect(screen.getByLabelText(/system prompt/i)).toHaveValue("");
      }
    },
  );

  it("treats a template with no has_slots field as applicable (older backend)", async () => {
    // The fixtures above omit has_slots entirely — an undefined marker must
    // read as false, never as "possibly slotted", or a stale backend would
    // disable the whole catalog.
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toHaveValue(""),
    );
    await chooseTemplate(user, CODING_TEMPLATE.name);

    await waitFor(() =>
      expect(screen.getByLabelText(/system prompt/i)).toHaveValue(
        CODING_TEMPLATE.system_prompt,
      ),
    );
  });
});

describe("BoardLoopDialog — filling from a template (both prompts empty)", () => {
  it("fills system_prompt, loop_prompt, and the tools selection without a confirm gate", async () => {
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toHaveValue(""),
    );
    await chooseTemplate(user, CODING_TEMPLATE.name);

    await waitFor(() =>
      expect(screen.getByLabelText(/system prompt/i)).toHaveValue(
        CODING_TEMPLATE.system_prompt,
      ),
    );
    expect(screen.getByLabelText(/loop prompt/i)).toHaveValue(
      CODING_TEMPLATE.loop_prompt,
    );
    // ToolPicker renders selected tools as badges labeled with the bare name.
    expect(screen.getByText("enqueue_pr_for_merge")).toBeInTheDocument();
    expect(screen.getByText("set_board_loop")).toBeInTheDocument();
    // Both prompts were empty — no overwrite gate may appear.
    expect(
      screen.queryByTestId("loop-template-confirm"),
    ).not.toBeInTheDocument();
  });

  it("preserves Go template vars verbatim in the filled prompts", async () => {
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toHaveValue(""),
    );
    await chooseTemplate(user, CODING_TEMPLATE.name);

    await waitFor(() =>
      expect(
        (screen.getByLabelText(/system prompt/i) as HTMLTextAreaElement).value,
      ).toContain("{{.Workspace}}"),
    );
    const loopPrompt = (
      screen.getByLabelText(/loop prompt/i) as HTMLTextAreaElement
    ).value;
    expect(loopPrompt).toContain("{{.Iteration}}");
    expect(loopPrompt).toContain("{{.BoardID}}");
  });

  it("does not fire any PUT on selection — the Save button still gates persistence", async () => {
    let putCalls = 0;
    let putBody: Record<string, unknown> | null = null;
    server.use(
      http.put(LOOP_URL, async ({ request }) => {
        putCalls += 1;
        putBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          makeLoop({
            system_prompt: putBody.system_prompt,
            loop_prompt: putBody.loop_prompt,
            tools: putBody.tools,
            version: 2,
          }),
        );
      }),
    );
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toHaveValue(""),
    );
    await chooseTemplate(user, CODING_TEMPLATE.name);

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toHaveValue(
        CODING_TEMPLATE.loop_prompt,
      ),
    );
    // Selection alone persists nothing.
    expect(putCalls).toBe(0);

    await user.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(putCalls).toBe(1));
    expect(putBody!.system_prompt).toBe(CODING_TEMPLATE.system_prompt);
    expect(putBody!.loop_prompt).toBe(CODING_TEMPLATE.loop_prompt);
    expect(putBody!.tools).toEqual(
      expect.arrayContaining(CODING_TEMPLATE.tools),
    );
  });
});

describe("BoardLoopDialog — template over existing prompt text (confirm gate)", () => {
  const USER_PROMPT = "Keep my hand-written prompt.";

  beforeEach(() => {
    server.use(
      http.get(LOOP_URL, () =>
        HttpResponse.json(makeLoop({ loop_prompt: USER_PROMPT })),
      ),
    );
  });

  it("shows the confirm gate and does not overwrite before confirmation", async () => {
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toHaveValue(USER_PROMPT),
    );
    await chooseTemplate(user, CODING_TEMPLATE.name);

    expect(
      await screen.findByTestId("loop-template-confirm"),
    ).toBeInTheDocument();
    // Nothing is overwritten while the gate is open.
    expect(screen.getByLabelText(/loop prompt/i)).toHaveValue(USER_PROMPT);
  });

  it("cancel keeps the user's text untouched", async () => {
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toHaveValue(USER_PROMPT),
    );
    await chooseTemplate(user, CODING_TEMPLATE.name);

    await user.click(
      await screen.findByTestId("loop-template-confirm-cancel"),
    );

    await waitFor(() =>
      expect(
        screen.queryByTestId("loop-template-confirm"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText(/loop prompt/i)).toHaveValue(USER_PROMPT);
    expect(screen.getByLabelText(/system prompt/i)).toHaveValue("");
  });

  it("confirm applies the template over the user's text", async () => {
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toHaveValue(USER_PROMPT),
    );
    await chooseTemplate(user, CODING_TEMPLATE.name);

    await user.click(await screen.findByTestId("loop-template-confirm-apply"));

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toHaveValue(
        CODING_TEMPLATE.loop_prompt,
      ),
    );
    expect(screen.getByLabelText(/system prompt/i)).toHaveValue(
      CODING_TEMPLATE.system_prompt,
    );
  });
});
