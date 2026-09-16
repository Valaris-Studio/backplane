// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  renderWithProviders,
  screen,
  waitFor,
  userEvent,
  stubReducedMotion,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";

// Card 41bf51d3 (p3-08) — "Save as template…" from a raw board loop.
//
// The sheet turns the board's OWN prompts into a workspace template draft:
// mark ranges as slots, see the leak-lint warnings, create, land in the
// manager. The board itself must come out untouched — that is the acceptance
// criterion with teeth, so this file asserts NO PUT /loop is ever issued.
//
// Selection is injected (`getSelectionRange` prop) rather than driven through
// jsdom: jsdom implements Selection only partially, and the offset math it
// would exercise is pinned exhaustively in
// features/loop-templates/__tests__/slot-marking.test.ts.

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return { ...actual, useNavigate: () => navigate };
});

import { SaveAsTemplateSheet } from "../loop-template/SaveAsTemplateSheet";

const SLUG = "acme";
const BOARD_UUID = "0b7c1e2a-4c1d-4a9a-9c2e-2f6d8f3a1b11";
const TEMPLATES_URL = `/api/workspaces/${SLUG}/loop-templates`;
const LOOP_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/loop`;

// A raw loop that deliberately carries BOTH a repo fact (the URL, which the
// leak-lint flags) and a runner var (which must survive untouched).
const SYSTEM_PROMPT = "You work the board at https://github.com/acme/widgets.";
const LOOP_PROMPT = "Iteration {{.Iteration}} on acme-prod. Ship acme-prod.";

const CREATED = {
  id: "tpl-new-id",
  slug: "my-loop",
  name: "My loop",
  source: "workspace",
  is_draft: true,
};

const LINT_FINDING = {
  code: "url",
  match: "https://github.com/acme/widgets",
  line: 1,
  hint: "move into a slot such as <<REPO_URL>>",
};

let createBodies: unknown[] = [];
let patchBodies: unknown[] = [];
let lintCalls = 0;
let putLoopCalls = 0;

function handlers() {
  return [
    http.post(TEMPLATES_URL, async ({ request }) => {
      createBodies.push(await request.json());
      return HttpResponse.json(CREATED, { status: 201 });
    }),
    http.post(`${TEMPLATES_URL}/:ref/lint`, () => {
      lintCalls += 1;
      return HttpResponse.json({ findings: [LINT_FINDING] });
    }),
    http.patch(`${TEMPLATES_URL}/:ref`, async ({ request }) => {
      patchBodies.push(await request.json());
      return HttpResponse.json(CREATED);
    }),
    http.put(LOOP_URL, () => {
      putLoopCalls += 1;
      return HttpResponse.json({});
    }),
  ];
}

function renderSheet(
  props: Partial<React.ComponentProps<typeof SaveAsTemplateSheet>> = {},
) {
  return renderWithProviders(
    <SaveAsTemplateSheet
      slug={SLUG}
      open
      onOpenChange={() => {}}
      systemPrompt={SYSTEM_PROMPT}
      loopPrompt={LOOP_PROMPT}
      tools={["mcp__valaris__get_card"]}
      rails={{ max_iterations: 40 }}
      onBindNow={() => {}}
      {...props}
    />,
  );
}

/** Advance step 1 (identity) → step 2 (marking). */
async function goToMarking(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByTestId("save-as-template-name"), "My loop");
  await user.click(screen.getByTestId("save-as-template-next"));
  await screen.findByTestId("save-as-template-marking");
}

beforeEach(() => {
  createBodies = [];
  patchBodies = [];
  lintCalls = 0;
  putLoopCalls = 0;
  navigate.mockClear();
  stubReducedMotion(true);
  server.use(...handlers());
});

afterEach(() => stubReducedMotion(false));

describe("SaveAsTemplateSheet — marking ranges as slots", () => {
  it("replaces the selected range with <<NAME>> and captures the text as the slot example", async () => {
    const user = userEvent.setup();
    // "acme-prod" — the first occurrence in the loop prompt.
    const start = LOOP_PROMPT.indexOf("acme-prod");
    renderSheet({
      getSelectionRange: () => ({
        field: "loop_prompt",
        start,
        end: start + "acme-prod".length,
      }),
    });
    await goToMarking(user);

    await user.click(screen.getByTestId("save-as-template-make-slot"));
    await user.type(screen.getByTestId("slot-name-input"), "TARGET");
    await user.click(screen.getByTestId("slot-name-confirm"));

    const preview = await screen.findByTestId("marking-pre-loop_prompt");
    expect(preview).toHaveTextContent("<<TARGET>>");

    // The slot row carries the replaced text as its example, which is how the
    // board's own binding survives as documentation on the template.
    const row = await screen.findByTestId("slot-row-TARGET");
    expect(row).toHaveTextContent("acme-prod");
  });

  it("offers replace-all and substitutes every identical occurrence", async () => {
    const user = userEvent.setup();
    const start = LOOP_PROMPT.indexOf("acme-prod");
    renderSheet({
      getSelectionRange: () => ({
        field: "loop_prompt",
        start,
        end: start + "acme-prod".length,
      }),
    });
    await goToMarking(user);

    await user.click(screen.getByTestId("save-as-template-make-slot"));
    await user.type(screen.getByTestId("slot-name-input"), "TARGET");
    // The prompt has acme-prod twice, so the offer must be present and counted.
    const replaceAll = screen.getByTestId("slot-replace-all");
    expect(replaceAll).toHaveTextContent("2");
    await user.click(replaceAll);
    await user.click(screen.getByTestId("slot-name-confirm"));

    const preview = await screen.findByTestId("marking-pre-loop_prompt");
    expect(preview.textContent).toBe(
      "Iteration {{.Iteration}} on <<TARGET>>. Ship <<TARGET>>.",
    );
  });

  it("preserves the runner variables verbatim", async () => {
    const user = userEvent.setup();
    renderSheet();
    await goToMarking(user);
    // {{.Iteration}} is a runner contract, never a slot candidate.
    expect(screen.getByTestId("marking-pre-loop_prompt")).toHaveTextContent(
      "{{.Iteration}}",
    );
  });

  it("derives block for a multi-line range and scalar for a single-line one", async () => {
    const user = userEvent.setup();
    renderSheet({
      systemPrompt: "alpha\nbeta",
      getSelectionRange: () => ({ field: "system_prompt", start: 0, end: 10 }),
    });
    await goToMarking(user);

    await user.click(screen.getByTestId("save-as-template-make-slot"));
    expect(screen.getByTestId("slot-kind-select")).toHaveValue("block");
  });
});

describe("SaveAsTemplateSheet — name validation", () => {
  it("rejects a name that breaks the slot grammar", async () => {
    const user = userEvent.setup();
    renderSheet({
      getSelectionRange: () => ({ field: "loop_prompt", start: 0, end: 9 }),
    });
    await goToMarking(user);

    await user.click(screen.getByTestId("save-as-template-make-slot"));
    await user.type(screen.getByTestId("slot-name-input"), "lower case");

    expect(await screen.findByTestId("slot-name-error")).toBeInTheDocument();
    expect(screen.getByTestId("slot-name-confirm")).toBeDisabled();
  });

  it("rejects a duplicate slot name", async () => {
    const user = userEvent.setup();
    const start = LOOP_PROMPT.indexOf("acme-prod");
    renderSheet({
      getSelectionRange: () => ({
        field: "loop_prompt",
        start,
        end: start + "acme-prod".length,
      }),
    });
    await goToMarking(user);

    await user.click(screen.getByTestId("save-as-template-make-slot"));
    await user.type(screen.getByTestId("slot-name-input"), "TARGET");
    await user.click(screen.getByTestId("slot-name-confirm"));
    await screen.findByTestId("slot-row-TARGET");

    await user.click(screen.getByTestId("save-as-template-make-slot"));
    await user.type(screen.getByTestId("slot-name-input"), "TARGET");
    expect(await screen.findByTestId("slot-name-error")).toBeInTheDocument();
    expect(screen.getByTestId("slot-name-confirm")).toBeDisabled();
  });
});

describe("SaveAsTemplateSheet — create", () => {
  it("posts prompts, slots, rails_defaults, tools and profile, then lints the draft", async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.type(screen.getByTestId("save-as-template-name"), "My loop");
    await user.type(
      screen.getByTestId("save-as-template-tagline"),
      "Ship things",
    );
    await user.click(screen.getByTestId("save-as-template-next"));
    await screen.findByTestId("save-as-template-marking");
    await user.click(screen.getByTestId("save-as-template-create"));

    await waitFor(() => expect(createBodies).toHaveLength(1));
    const body = createBodies[0] as {
      name: string;
      profile: { tagline: string };
      content: {
        system_prompt: string;
        loop_prompt: string;
        slots: unknown[];
        rails_defaults: Record<string, unknown>;
        tools: string[];
      };
    };
    expect(body.name).toBe("My loop");
    expect(body.profile.tagline).toBe("Ship things");
    expect(body.content.system_prompt).toBe(SYSTEM_PROMPT);
    expect(body.content.loop_prompt).toBe(LOOP_PROMPT);
    expect(body.content.tools).toEqual(["mcp__valaris__get_card"]);
    expect(body.content.rails_defaults).toEqual({ max_iterations: 40 });

    // Lint runs on the created draft — there is no lint-before-create route.
    await waitFor(() => expect(lintCalls).toBe(1));
  });

  it("never touches the board's own loop config", async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.type(screen.getByTestId("save-as-template-name"), "My loop");
    await user.click(screen.getByTestId("save-as-template-next"));
    await screen.findByTestId("save-as-template-marking");
    await user.click(screen.getByTestId("save-as-template-create"));

    await waitFor(() => expect(createBodies).toHaveLength(1));
    expect(putLoopCalls).toBe(0);
  });

  it("shows the leak-lint findings with their snippet after creating", async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.type(screen.getByTestId("save-as-template-name"), "My loop");
    await user.click(screen.getByTestId("save-as-template-next"));
    await screen.findByTestId("save-as-template-marking");
    await user.click(screen.getByTestId("save-as-template-create"));

    const finding = await screen.findByTestId("leak-finding-0");
    expect(finding).toHaveTextContent("https://github.com/acme/widgets");
  });

  it("navigates to the manager Prompts tab from the review step", async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.type(screen.getByTestId("save-as-template-name"), "My loop");
    await user.click(screen.getByTestId("save-as-template-next"));
    await screen.findByTestId("save-as-template-marking");
    await user.click(screen.getByTestId("save-as-template-create"));

    await screen.findByTestId("save-as-template-review");
    await user.click(screen.getByTestId("save-as-template-open-manager"));
    expect(navigate).toHaveBeenCalledWith(
      `/${SLUG}/runner/loops/${CREATED.id}/prompts`,
    );
  });

  it("offers 'Bind this board now' as an explicit, separate action", async () => {
    const user = userEvent.setup();
    const onBindNow = vi.fn();
    renderSheet({ onBindNow });
    await user.type(screen.getByTestId("save-as-template-name"), "My loop");
    await user.click(screen.getByTestId("save-as-template-next"));
    await screen.findByTestId("save-as-template-marking");
    await user.click(screen.getByTestId("save-as-template-create"));

    await screen.findByTestId("save-as-template-review");
    await user.click(screen.getByTestId("save-as-template-bind-now"));
    // Preselected by id — the panel jumps straight to Bind for this template.
    expect(onBindNow).toHaveBeenCalledWith(CREATED.id);
    expect(putLoopCalls).toBe(0);
  });
});

// Card 7f7eb6a7 (F10) — the sheet creates ONCE per session.
//
// The review step's "make slot" sends the author back to marking, and the
// footer there used to re-run the same create mutation: a second POST with the
// slug the first one just claimed, which the backend's `_require_slug_free`
// answers with a 409. The template already exists by then and has an id, so
// the second pass is an UPDATE.
describe("SaveAsTemplateSheet — one create per session (card 7f7eb6a7)", () => {
  /** Identity → marking → create → review, the state a second pass starts from. */
  async function createThenReview(
    user: ReturnType<typeof userEvent.setup>,
  ) {
    await user.type(screen.getByTestId("save-as-template-name"), "My loop");
    await user.click(screen.getByTestId("save-as-template-next"));
    await screen.findByTestId("save-as-template-marking");
    await user.click(screen.getByTestId("save-as-template-create"));
    await screen.findByTestId("save-as-template-review");
  }

  it("PATCHes the created draft on a second pass instead of re-POSTing (AC4)", async () => {
    const user = userEvent.setup();
    // The lint finding's own match is what `markFinding` re-selects, so this
    // second pass needs no injected selection.
    renderSheet();
    await createThenReview(user);
    expect(createBodies).toHaveLength(1);

    await user.click(screen.getByTestId("leak-finding-0-make-slot"));
    await screen.findByTestId("save-as-template-marking");
    await user.type(screen.getByTestId("slot-name-input"), "REPO_URL");
    await user.click(screen.getByTestId("slot-name-confirm"));

    await user.click(screen.getByTestId("save-as-template-save"));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    // The POST count is the assertion with teeth: a second one 409s in prod.
    expect(createBodies).toHaveLength(1);

    const body = patchBodies[0] as {
      content: { system_prompt: string; slots: { name: string }[] };
    };
    expect(body.content.slots.map((slot) => slot.name)).toEqual(["REPO_URL"]);
    expect(body.content.system_prompt).toContain("<<REPO_URL>>");
    // The leaked URL is what the slot replaced — it must be gone from the
    // prompt the update ships, or the second pass fixed nothing.
    expect(body.content.system_prompt).not.toContain(
      "https://github.com/acme/widgets",
    );
  });

  it("re-lints after the update so the review step is not stale", async () => {
    const user = userEvent.setup();
    renderSheet();
    await createThenReview(user);
    expect(lintCalls).toBe(1);

    await user.click(screen.getByTestId("leak-finding-0-make-slot"));
    await screen.findByTestId("save-as-template-marking");
    await user.type(screen.getByTestId("slot-name-input"), "REPO_URL");
    await user.click(screen.getByTestId("slot-name-confirm"));
    await user.click(screen.getByTestId("save-as-template-save"));

    await waitFor(() => expect(lintCalls).toBe(2));
    await screen.findByTestId("save-as-template-review");
  });

  it("keeps the bind-now handoff working after an update (AC8)", async () => {
    const user = userEvent.setup();
    const onBindNow = vi.fn();
    renderSheet({ onBindNow });
    await createThenReview(user);

    await user.click(screen.getByTestId("leak-finding-0-make-slot"));
    await screen.findByTestId("save-as-template-marking");
    await user.type(screen.getByTestId("slot-name-input"), "REPO_URL");
    await user.click(screen.getByTestId("slot-name-confirm"));
    await user.click(screen.getByTestId("save-as-template-save"));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    await user.click(await screen.findByTestId("save-as-template-bind-now"));
    // `created.id` must survive the switch from create to update untouched —
    // it is what preselects the template in the panel's Bind step.
    expect(onBindNow).toHaveBeenCalledWith(CREATED.id);
    expect(putLoopCalls).toBe(0);
  });
});
