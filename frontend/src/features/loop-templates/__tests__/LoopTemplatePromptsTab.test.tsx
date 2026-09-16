// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { LoopTemplatePromptsTab } from "../components/LoopTemplatePromptsTab";
import { SLOT_KINDS, blankSlot, readCatalog } from "../lib/slot-catalog";
import { TemplateDraftProvider } from "../hooks/TemplateDraftProvider";

// Card 2c18790f (F6) — the draft store now consults the caller's workspace
// role, so a tab test has to declare one. Admin: every case below asserts the
// editable behaviour, and an unmocked role lookup resolves to NOT-admin.
vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({
    role: "admin",
    isAdmin: true,
    isLoading: false,
    isError: false,
  }),
}));


// Card 199bf1ec — spec §5.1 Prompts tab.
//
// The tab is the first DRAFT-WRITING surface in the manager, so these tests
// pin the two contracts that make it safe: every edit goes through
// `useTemplateDraft` (never a direct PATCH of its own), and the validation
// chips mirror the backend publish validator's grammar.

const SLUG = "acme";
const REF = "11111111-2222-3333-4444-555555555555";
const DETAIL_URL = `/api/workspaces/${SLUG}/loop-templates/${REF}`;
const LIST_URL = `/api/workspaces/${SLUG}/loop-templates`;

const RUNNER_VARS = [
  "Workspace",
  "BoardID",
  "AgentID",
  "ExecutionID",
  "Iteration",
];

let patches: Record<string, unknown>[];

function detail(over: Record<string, unknown> = {}) {
  return {
    id: REF,
    slug: "coding-loop",
    source: "workspace",
    name: "Coding Loop",
    version: 2,
    is_system: false,
    is_draft: false,
    profile: {},
    content: { system_prompt: "", loop_prompt: "", slots: [] },
    lineage: null,
    updated_at: "2026-08-17T00:00:00Z",
    draft_updated_at: "2026-08-17T00:00:00Z",
    has_unpublished_changes: false,
    ...over,
  };
}

function serve(detailBody: Record<string, unknown>) {
  server.use(
    http.get(LIST_URL, () =>
      HttpResponse.json({ templates: [], meta: { runner_vars: RUNNER_VARS } }),
    ),
    http.get(DETAIL_URL, () => HttpResponse.json(detailBody)),
    http.patch(DETAIL_URL, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      patches.push(body);
      return HttpResponse.json({ ...detailBody, ...body });
    }),
  );
}

function renderTab() {
  return renderWithProviders(
    <TemplateDraftProvider slug={SLUG} templateRef={REF}>
      <LoopTemplatePromptsTab slug={SLUG} templateRef={REF} />
    </TemplateDraftProvider>,
  );
}

async function textarea(field: "system_prompt" | "loop_prompt") {
  return await screen.findByTestId(`loop-template-${field}`);
}

beforeEach(() => {
  patches = [];
});

describe("LoopTemplatePromptsTab — palette insertion (AC1)", () => {
  it("inserts a runner var as {{.Name}} at the caret", async () => {
    serve(
      detail({ content: { system_prompt: "", loop_prompt: "ab", slots: [] } }),
    );
    const user = userEvent.setup();
    renderTab();

    const loop = (await textarea("loop_prompt")) as HTMLTextAreaElement;
    await user.click(loop);
    loop.setSelectionRange(1, 1);
    await user.click(
      screen.getByRole("button", { name: "Insert {{.BoardID}}" }),
    );

    await waitFor(() => expect(loop).toHaveValue("a{{.BoardID}}b"));
  });

  it("inserts a catalogued slot as <<NAME>>", async () => {
    serve(
      detail({
        content: {
          system_prompt: "",
          loop_prompt: "",
          slots: [{ name: "RUN_LABEL", kind: "scalar" }],
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();

    const loop = (await textarea("loop_prompt")) as HTMLTextAreaElement;
    await user.click(loop);
    await user.click(
      screen.getByRole("button", { name: "Insert <<RUN_LABEL>>" }),
    );

    await waitFor(() => expect(loop).toHaveValue("<<RUN_LABEL>>"));
  });

  it("inserts into the SYSTEM prompt once it holds the caret", async () => {
    // Two editors share one palette; the token must land in the one the author
    // last touched, not always in the loop prompt.
    serve(detail());
    const user = userEvent.setup();
    renderTab();

    const system = (await textarea("system_prompt")) as HTMLTextAreaElement;
    await user.click(system);
    await user.click(
      screen.getByRole("button", { name: "Insert {{.Workspace}}" }),
    );

    await waitFor(() => expect(system).toHaveValue("{{.Workspace}}"));
    expect(await textarea("loop_prompt")).toHaveValue("");
  });
});

describe("LoopTemplatePromptsTab — validation chips (AC2, AC3)", () => {
  it("flags a slot token that is not in the catalog", async () => {
    serve(
      detail({
        content: { system_prompt: "", loop_prompt: "go <<FOO>>", slots: [] },
      }),
    );
    renderTab();
    expect(
      await screen.findByTestId("loop-template-issue-unknown-slot-FOO"),
    ).toBeInTheDocument();
  });

  it("flags a catalogued slot no prompt references", async () => {
    serve(
      detail({
        content: {
          system_prompt: "",
          loop_prompt: "nothing here",
          slots: [{ name: "RUN_LABEL", kind: "scalar" }],
        },
      }),
    );
    renderTab();
    expect(
      await screen.findByTestId("loop-template-issue-unused-slot-RUN_LABEL"),
    ).toBeInTheDocument();
  });

  it("clears the unknown chip when the token is deleted", async () => {
    serve(
      detail({
        content: { system_prompt: "", loop_prompt: "<<FOO>>", slots: [] },
      }),
    );
    const user = userEvent.setup();
    renderTab();

    await screen.findByTestId("loop-template-issue-unknown-slot-FOO");
    await user.clear(await textarea("loop_prompt"));

    await waitFor(() =>
      expect(
        screen.queryByTestId("loop-template-issue-unknown-slot-FOO"),
      ).not.toBeInTheDocument(),
    );
  });

  it("does not flag a slot whose only consumer is a variant fill", async () => {
    // The tab must pass the catalog's variant fills into the validator; without
    // that wiring every variant-only slot reads as dead and the author is
    // trained to ignore the chip.
    serve(
      detail({
        content: {
          system_prompt: "",
          loop_prompt: "<<OUTER>>",
          slots: [
            {
              name: "OUTER",
              kind: "variant",
              // The real SlotVariant shape: `fills` is a map of target slot
              // name -> fill text. The fixture used to invent a singular
              // `fill` string the API never sends, so this suppression was
              // pinned by a shape that could not occur (card 41dc5cb8).
              variants: [
                {
                  id: "fast",
                  label: "Fast",
                  fills: { BODY: "text mentioning <<NESTED>>" },
                },
              ],
            },
            { name: "NESTED", kind: "scalar" },
          ],
        },
      }),
    );
    renderTab();
    await screen.findByTestId("loop-template-prompts-tab");
    expect(
      screen.queryByTestId("loop-template-issue-unused-slot-NESTED"),
    ).not.toBeInTheDocument();
  });

  it("drops a nameless catalog row rather than charting it as unused", async () => {
    // A row with no name cannot be referenced by any prompt, so surfacing it
    // would render an permanent "unused undefined" chip the author cannot clear.
    serve(
      detail({
        content: {
          system_prompt: "",
          loop_prompt: "",
          slots: [{ kind: "scalar" }, { name: "", kind: "scalar" }],
        },
      }),
    );
    renderTab();
    await screen.findByTestId("loop-template-prompts-tab");
    expect(
      screen.queryByTestId("loop-template-prompt-issues"),
    ).not.toBeInTheDocument();
  });

  it("flags a template var the runner does not provide", async () => {
    serve(
      detail({
        content: { system_prompt: "{{.Foo}}", loop_prompt: "", slots: [] },
      }),
    );
    renderTab();
    expect(
      await screen.findByTestId("loop-template-issue-non-runner-var-Foo"),
    ).toBeInTheDocument();
  });

  it("does not flag the runner vars the server advertises", async () => {
    serve(
      detail({
        content: { system_prompt: "{{.BoardID}}", loop_prompt: "", slots: [] },
      }),
    );
    renderTab();
    await screen.findByTestId("loop-template-prompts-tab");
    expect(
      screen.queryByTestId("loop-template-issue-non-runner-var-BoardID"),
    ).not.toBeInTheDocument();
  });
});

describe("LoopTemplatePromptsTab — new slot (AC4)", () => {
  it("adds the catalog entry and inserts its token in one action", async () => {
    serve(detail());
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole("button", { name: "New slot…" }));
    await user.type(
      screen.getByTestId("loop-template-new-slot-name"),
      "repo_url",
    );
    await user.click(screen.getByTestId("loop-template-new-slot-add"));

    // Upper-cased to satisfy the slot grammar, present in the prompt, and NOT
    // reported as unknown — which is only true if it reached the catalog too.
    const loop = await textarea("loop_prompt");
    await waitFor(() => expect(loop).toHaveValue("<<REPO_URL>>"));
    expect(
      screen.queryByTestId("loop-template-issue-unknown-slot-REPO_URL"),
    ).not.toBeInTheDocument();
  });

  it("refuses a blank name instead of cataloguing an unnamed slot", async () => {
    // Without the guard this writes {name: ""} into the catalog and splices a
    // literal `<<>>` into the prompt — a token the backend grammar rejects at
    // publish, from a row the author cannot see or remove in the Slots tab.
    serve(detail());
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole("button", { name: "New slot…" }));
    await user.type(screen.getByTestId("loop-template-new-slot-name"), "   ");
    await user.click(screen.getByTestId("loop-template-new-slot-add"));

    expect(await textarea("loop_prompt")).toHaveValue("");
    // The form stays open so the author can correct the name.
    expect(
      screen.getByTestId("loop-template-new-slot-name"),
    ).toBeInTheDocument();
  });

  it("autosaves the new slot through the draft store, not a direct write", async () => {
    serve(detail());
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole("button", { name: "New slot…" }));
    await user.type(screen.getByTestId("loop-template-new-slot-name"), "X");
    await user.click(screen.getByTestId("loop-template-new-slot-add"));

    await waitFor(() => expect(patches.length).toBeGreaterThan(0), {
      timeout: 3000,
    });
    const content = patches.at(-1)?.content as Record<string, unknown>;
    const written = content.slots as { name: string; kind: string }[];
    expect(written).toHaveLength(1);
    expect(written[0]?.name).toBe("X");
    // The optimistic lock must ride along or a concurrent editor is clobbered.
    expect(patches.at(-1)).toHaveProperty("expected_updated_at");
  });

  it("gives the new slot a kind the publish validator accepts (card 41dc5cb8)", async () => {
    // The palette used to write kind:"text", which is not a member of the
    // backend SlotKind literal. SlotSpec forbids extras and types `kind`
    // strictly, so pydantic rejected the whole content bag — every template
    // whose author added a slot from this tab failed to PUBLISH.
    //
    // SLOT_KINDS is imported, never restated: if the backend vocabulary grows
    // or shrinks, this assertion follows it instead of pinning a stale copy.
    serve(detail());
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole("button", { name: "New slot…" }));
    await user.type(screen.getByTestId("loop-template-new-slot-name"), "X");
    await user.click(screen.getByTestId("loop-template-new-slot-add"));

    await waitFor(() => expect(patches.length).toBeGreaterThan(0), {
      timeout: 3000,
    });
    const content = patches.at(-1)?.content as Record<string, unknown>;
    const written = (content.slots as { kind: string }[])[0];
    expect(SLOT_KINDS).toContain(written?.kind);
  });

  it("writes the whole catalog row so the Slots tab does not see a stub", async () => {
    // The two tabs share one draft. A partial row here means the Slots tab
    // renders an entry with no label/help/enum_values and the next autosave
    // from THAT tab persists the gaps as authored intent.
    serve(detail());
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole("button", { name: "New slot…" }));
    await user.type(screen.getByTestId("loop-template-new-slot-name"), "X");
    await user.click(screen.getByTestId("loop-template-new-slot-add"));

    await waitFor(() => expect(patches.length).toBeGreaterThan(0), {
      timeout: 3000,
    });
    const content = patches.at(-1)?.content as Record<string, unknown>;
    const written = (content.slots as unknown[])[0];
    // Same row the Slots tab's own "add" produces — one shared constructor.
    expect(written).toEqual(blankSlot("X"));
    // Spelled out, because comparing against blankSlot() alone is circular:
    // a change to the constructor moves both sides and proves nothing. A new
    // slot must start OPTIONAL — defaulting it required makes the template
    // unfittable until the author edits a field they never chose to add.
    expect(written).toMatchObject({ name: "X", kind: "scalar", required: false });
  });

  it("preserves every existing catalog row when a slot is added (card 1f9f210c)", async () => {
    // handleCreateSlot persisted `[...readSlots(content), blankSlot(name)]`,
    // and readSlots is the prompts tab's LOSSY projection (name/kind/required/
    // help/example/variant fills only). So one palette add on a coding-loop
    // fork rewrote RUN_HISTORY_KEY without `deprecated` — straight back behind
    // the unused_slot publish block — and dropped label/default/enum_values/
    // autofill/join/items from every other slot as authored intent.
    const seedContent = {
      system_prompt: "<<CHARTER_KEY>>",
      loop_prompt: "",
      slots: [
        {
          name: "RUN_HISTORY_KEY",
          kind: "scalar",
          required: false,
          label: "Run-history definition key (legacy)",
          help: "Kept so stored values keep rendering; no prompt reads it.",
          example: "loop_run_history",
          default: "",
          deprecated: true,
        },
        {
          name: "CHARTER_KEY",
          kind: "enum",
          required: true,
          label: "Charter",
          help: "The definition key holding this run's ground rules.",
          example: "loop_charter",
          default: "loop_charter",
          enum_values: ["loop_charter", "charter"],
          join: ", ",
          items: { hint: "one key" },
          autofill: "DEFINITION_KEYS",
        },
      ],
    };
    serve(detail({ content: seedContent }));
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole("button", { name: "New slot…" }));
    await user.type(screen.getByTestId("loop-template-new-slot-name"), "X");
    await user.click(screen.getByTestId("loop-template-new-slot-add"));

    await waitFor(() => expect(patches.length).toBeGreaterThan(0), {
      timeout: 3000,
    });
    const content = patches.at(-1)?.content as Record<string, unknown>;
    // The full rows the Slots tab would read, untouched, plus the new blank one.
    expect(content.slots).toEqual([...readCatalog(seedContent), blankSlot("X")]);
    const persisted = content.slots as Record<string, unknown>[];
    expect(persisted[0]).toMatchObject({ name: "RUN_HISTORY_KEY", deprecated: true });
    expect(persisted[1]).toMatchObject({
      name: "CHARTER_KEY",
      label: "Charter",
      default: "loop_charter",
      autofill: "DEFINITION_KEYS",
    });
  });
});

describe("LoopTemplatePromptsTab — system templates (AC6)", () => {
  it("disables both editors and hides the palette", async () => {
    serve(detail({ is_system: true, source: "system" }));
    renderTab();

    expect(await textarea("system_prompt")).toBeDisabled();
    expect(await textarea("loop_prompt")).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "New slot…" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("loop-template-prompts-readonly"),
    ).toBeInTheDocument();
  });

  it("still renders the preview panel", async () => {
    serve(detail({ is_system: true, source: "system" }));
    renderTab();
    expect(
      await screen.findByTestId("loop-template-preview-panel"),
    ).toBeInTheDocument();
  });
});

describe("LoopTemplatePromptsTab — highlight pane", () => {
  it("stays collapsed until asked (37 KB kernels)", async () => {
    serve(
      detail({
        content: { system_prompt: "", loop_prompt: "<<A>>", slots: [] },
      }),
    );
    const user = userEvent.setup();
    renderTab();

    const toggle = await screen.findByTestId(
      "loop-template-highlight-toggle-loop_prompt",
    );
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByTestId("loop-template-highlight-loop_prompt"),
    ).not.toBeInTheDocument();

    await user.click(toggle);
    expect(
      screen.getByTestId("loop-template-highlight-loop_prompt"),
    ).toBeInTheDocument();
  });
});
