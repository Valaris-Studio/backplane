// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { LoopTemplateRailsTab } from "../components/LoopTemplateRailsTab";
import { NUMERIC_RAILS, ENUM_RAIL_NAMES } from "../lib/rails-catalog";
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


const SLUG = "acme";
const REF = "11111111-2222-3333-4444-555555555555";
const DETAIL_URL = `/api/workspaces/${SLUG}/loop-templates/${REF}`;

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
    content: {
      system_prompt: "",
      loop_prompt: "",
      slots: [],
      rails_defaults: {
        max_iterations: 25,
        iteration_delay_seconds: 30,
        iteration_timeout_seconds: 3600,
        budget_usd: 20,
        max_consecutive_failures: 3,
        max_blocked_on_human: 0,
        starvation_policy: "park",
        loop_landing: "human",
        merge_gate: "forge_ci",
        model: "mid",
        provider: "",
      },
      tools: ["search_cards", "update_card", "set_board_loop"],
      derived_rails: { completion_query: { label: "<<RUN_LABEL>>" } },
    },
    lineage: null,
    updated_at: "2026-08-17T00:00:00Z",
    draft_updated_at: "2026-08-17T00:00:00Z",
    has_unpublished_changes: false,
    ...over,
  };
}

function serve(detailBody: Record<string, unknown>) {
  server.use(
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
      <LoopTemplateRailsTab slug={SLUG} templateRef={REF} />
    </TemplateDraftProvider>,
  );
}

/** The autosaved `content.rails_defaults` from the most recent PATCH. */
async function lastRails(): Promise<Record<string, unknown>> {
  await waitFor(() => expect(patches.length).toBeGreaterThan(0));
  const content = patches[patches.length - 1]?.content as Record<
    string,
    unknown
  >;
  return content?.rails_defaults as Record<string, unknown>;
}

beforeEach(() => {
  patches = [];
});

describe("LoopTemplateRailsTab", () => {
  it("renders every numeric and enum rail with its current value", async () => {
    serve(detail());
    renderTab();

    await screen.findByTestId("loop-template-rails-tab");

    for (const rail of NUMERIC_RAILS) {
      const input = screen.getByTestId(`loop-template-rail-${rail}`);
      expect(input).toBeInTheDocument();
    }
    for (const rail of ENUM_RAIL_NAMES) {
      expect(
        screen.getByTestId(`loop-template-rail-${rail}`),
      ).toBeInTheDocument();
    }

    expect(screen.getByTestId("loop-template-rail-max_iterations")).toHaveValue(
      25,
    );
    // 0 is a REAL value (opts out of the blocked-on-human breaker), not absent.
    expect(
      screen.getByTestId("loop-template-rail-max_blocked_on_human"),
    ).toHaveValue(0);
  });

  it("gives every rail a tooltip trigger keyed loopTemplates.rails.<rail>", async () => {
    serve(detail());
    renderTab();
    await screen.findByTestId("loop-template-rails-tab");

    for (const rail of [...NUMERIC_RAILS, ...ENUM_RAIL_NAMES]) {
      const trigger = screen.getByTestId(`loop-template-rail-tooltip-${rail}`);
      expect(trigger).toHaveAttribute(
        "data-tooltip-key",
        `loopTemplates.rails.${rail}`,
      );
    }
  });

  it("writes a numeric rail edit to the draft", async () => {
    const user = userEvent.setup();
    serve(detail());
    renderTab();
    await screen.findByTestId("loop-template-rails-tab");

    const input = screen.getByTestId("loop-template-rail-max_iterations");
    await user.clear(input);
    await user.type(input, "40");

    await waitFor(async () => {
      expect((await lastRails()).max_iterations).toBe(40);
    });
  });

  it("keeps an emptied numeric rail out of the payload rather than writing NaN", async () => {
    const user = userEvent.setup();
    serve(detail());
    renderTab();
    await screen.findByTestId("loop-template-rails-tab");

    await user.clear(screen.getByTestId("loop-template-rail-budget_usd"));

    await waitFor(async () => {
      const rails = await lastRails();
      // Assert on the SERIALIZED payload: an `undefined` value would vanish
      // in JSON and make an `in`/property check pass vacuously, so the only
      // assertion that distinguishes "key deleted" from "key set to
      // undefined" is the wire form the backend actually receives.
      expect(Object.keys(JSON.parse(JSON.stringify(rails)))).not.toContain(
        "budget_usd",
      );
      // The sibling rails must survive the delete untouched.
      expect(rails.max_iterations).toBe(25);
      expect(rails.starvation_policy).toBe("park");
    });
  });

  it("writes an enum rail edit to the draft", async () => {
    const user = userEvent.setup();
    serve(detail());
    renderTab();
    await screen.findByTestId("loop-template-rails-tab");

    await user.selectOptions(
      screen.getByTestId("loop-template-rail-starvation_policy"),
      "always_run",
    );

    await waitFor(async () => {
      expect((await lastRails()).starvation_policy).toBe("always_run");
    });
  });

  it("offers exactly the closed vocabulary for each enum rail", async () => {
    serve(detail());
    renderTab();
    await screen.findByTestId("loop-template-rails-tab");

    const optionValues = (testid: string) =>
      Array.from(
        screen.getByTestId(testid).querySelectorAll("option"),
      ).map((option) => (option as HTMLOptionElement).value);

    expect(optionValues("loop-template-rail-starvation_policy")).toEqual([
      "park",
      "always_run",
    ]);
    expect(optionValues("loop-template-rail-loop_landing")).toEqual([
      "self_merge",
      "human",
      "merge_queue",
    ]);
    expect(optionValues("loop-template-rail-merge_gate")).toEqual([
      "forge_ci",
      "none",
    ]);
  });

  it("round-trips a concrete model id through the custom escape hatch", async () => {
    serve(
      detail({
        content: {
          ...detail().content,
          rails_defaults: {
            ...detail().content.rails_defaults,
            model: "claude-opus-4-6-20260101",
          },
        },
      }),
    );
    renderTab();
    await screen.findByTestId("loop-template-rails-tab");

    // A non-tier model selects the sentinel and surfaces the id verbatim.
    expect(screen.getByTestId("loop-template-rail-model")).toHaveValue(
      "__custom__",
    );
    expect(screen.getByTestId("loop-template-rail-model-custom")).toHaveValue(
      "claude-opus-4-6-20260101",
    );
  });

  it("warns when the off-switch tool is absent from the grant", async () => {
    serve(
      detail({
        content: {
          ...detail().content,
          tools: ["search_cards", "update_card"],
        },
      }),
    );
    renderTab();
    await screen.findByTestId("loop-template-rails-tab");

    expect(
      screen.getByTestId("loop-template-rails-off-switch-warning"),
    ).toBeInTheDocument();
  });

  it("does not warn when the off-switch is present under its bare name", async () => {
    serve(detail());
    renderTab();
    await screen.findByTestId("loop-template-rails-tab");

    expect(
      screen.queryByTestId("loop-template-rails-off-switch-warning"),
    ).not.toBeInTheDocument();
  });

  it("does not warn when the off-switch is present under its mcp__valaris__ id", async () => {
    // ToolPicker and BoardLoopConfig store the PREFIXED id; the profile
    // fixtures store the bare name. Either spelling must satisfy the check.
    serve(
      detail({
        content: {
          ...detail().content,
          tools: ["mcp__valaris__search_cards", "mcp__valaris__set_board_loop"],
        },
      }),
    );
    renderTab();
    await screen.findByTestId("loop-template-rails-tab");

    expect(
      screen.queryByTestId("loop-template-rails-off-switch-warning"),
    ).not.toBeInTheDocument();
  });

  it("round-trips the ToolPicker value into the draft", async () => {
    const user = userEvent.setup();
    serve(detail());
    renderTab();
    await screen.findByTestId("loop-template-rails-tab");

    // Toggling a tool off in the picker must reach content.tools.
    await user.click(screen.getByTestId("loop-template-rails-tools-clear"));

    await waitFor(() => {
      const content = patches[patches.length - 1]?.content as Record<
        string,
        unknown
      >;
      expect(content?.tools).toEqual([]);
    });
  });

  it("shows derived_rails read-only outside the advanced disclosure", async () => {
    serve(detail());
    renderTab();
    await screen.findByTestId("loop-template-rails-tab");

    const summary = screen.getByTestId("loop-template-derived-rails-summary");
    expect(summary).toHaveTextContent("completion_query");
  });

  it("rejects invalid derived_rails JSON with a field error and no draft write", async () => {
    const user = userEvent.setup();
    serve(detail());
    renderTab();
    await screen.findByTestId("loop-template-rails-tab");

    await user.click(screen.getByTestId("loop-template-derived-rails-toggle"));
    const editor = screen.getByTestId("loop-template-derived-rails-json");
    await user.clear(editor);
    await user.type(editor, "{{ not json");

    expect(
      await screen.findByTestId("loop-template-derived-rails-error"),
    ).toBeInTheDocument();

    // The invalid text must never reach the autosave payload. Editing a
    // SEPARATE rail afterwards forces a real PATCH to flush, so `patches` is
    // non-empty and the assertion below cannot pass vacuously — without this,
    // the debounce means nothing is ever captured and any write survives.
    await user.clear(screen.getByTestId("loop-template-rail-max_iterations"));
    await user.type(screen.getByTestId("loop-template-rail-max_iterations"), "7");

    await waitFor(() => expect(patches.length).toBeGreaterThan(0));

    // `derived_rails` is a MAP, always. The invalid text must never be stored
    // — asserting the TYPE catches a write of the raw string, which a check
    // against one exact string literal would miss. (Clearing the editor is a
    // deliberate "empty the map" and legitimately autosaves `{}`.)
    for (const patch of patches) {
      const value = (patch.content as Record<string, unknown>)?.derived_rails;
      if (value === undefined) continue;
      expect(typeof value).toBe("object");
      expect(Array.isArray(value)).toBe(false);
      expect(JSON.stringify(value)).not.toContain("not json");
    }
  });

  it("accepts valid derived_rails JSON and writes the parsed object", async () => {
    const user = userEvent.setup();
    serve(detail());
    renderTab();
    await screen.findByTestId("loop-template-rails-tab");

    await user.click(screen.getByTestId("loop-template-derived-rails-toggle"));
    const editor = screen.getByTestId("loop-template-derived-rails-json");
    await user.clear(editor);
    // `{{` is userEvent's escape for a literal `{`; `}` is already literal.
    await user.type(editor, '{{"completion_query": {{"label": "x"}}');

    await waitFor(() => {
      const content = patches[patches.length - 1]?.content as Record<
        string,
        unknown
      >;
      expect(content?.derived_rails).toEqual({
        completion_query: { label: "x" },
      });
    });
    expect(
      screen.queryByTestId("loop-template-derived-rails-error"),
    ).not.toBeInTheDocument();
  });

  it("disables every control for a system template but still shows the values", async () => {
    serve(detail({ is_system: true }));
    renderTab();
    await screen.findByTestId("loop-template-rails-tab");

    expect(
      screen.getByTestId("loop-template-rails-readonly"),
    ).toBeInTheDocument();

    for (const rail of NUMERIC_RAILS) {
      expect(screen.getByTestId(`loop-template-rail-${rail}`)).toBeDisabled();
    }
    for (const rail of ENUM_RAIL_NAMES) {
      expect(screen.getByTestId(`loop-template-rail-${rail}`)).toBeDisabled();
    }
    // Values remain legible — read-only, not hidden.
    expect(screen.getByTestId("loop-template-rail-max_iterations")).toHaveValue(
      25,
    );
    // The advanced JSON editor must not be editable either.
    expect(
      screen.queryByTestId("loop-template-rails-tools-clear"),
    ).not.toBeInTheDocument();
  });

  it("does not write to the draft when a system template's rail is edited", async () => {
    const user = userEvent.setup();
    serve(detail({ is_system: true }));
    renderTab();
    await screen.findByTestId("loop-template-rails-tab");

    const input = screen.getByTestId("loop-template-rail-max_iterations");
    await user.type(input, "9");

    // Disabled inputs cannot receive input, and setField no-ops on readOnly.
    expect(patches).toHaveLength(0);
  });
});
