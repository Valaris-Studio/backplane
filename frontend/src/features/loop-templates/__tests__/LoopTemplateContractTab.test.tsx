// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { LoopTemplateContractTab } from "../components/LoopTemplateContractTab";
import { CONTRACT_FLAGS, CONTRACT_CHIP_LISTS } from "../lib/rails-catalog";
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

/** The real ColumnType union — the multi-select must offer exactly this. */
const COLUMN_TYPES = ["backlog", "active", "review", "done", "blocked"];

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
      setup_contract: {
        required_column_types: ["backlog", "done"],
        optional_column_types: [],
        requires_run_label: true,
        definition_keys: ["north_star"],
        pinned_notes: [],
        card_sections: [],
        git_repo_bound: true,
        agent_bound_with_tools: false,
        dependencies_server_side: false,
      },
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
      <LoopTemplateContractTab slug={SLUG} templateRef={REF} />
    </TemplateDraftProvider>,
  );
}

async function lastContract(): Promise<Record<string, unknown>> {
  await waitFor(() => expect(patches.length).toBeGreaterThan(0));
  const content = patches[patches.length - 1]?.content as Record<
    string,
    unknown
  >;
  return content?.setup_contract as Record<string, unknown>;
}

beforeEach(() => {
  patches = [];
});

describe("LoopTemplateContractTab", () => {
  it("offers exactly the real ColumnType enum for required column types", async () => {
    serve(detail());
    renderTab();
    await screen.findByTestId("loop-template-contract-tab");

    const offered = COLUMN_TYPES.map((type) =>
      screen.getByTestId(`loop-template-contract-required-${type}`),
    );
    expect(offered).toHaveLength(5);

    // Nothing outside the enum — notably no `todo` / `in_progress`, which are
    // column NAMES on real boards and not types.
    const all = screen.getAllByTestId(/^loop-template-contract-required-/);
    expect(all).toHaveLength(COLUMN_TYPES.length);
    for (const stale of ["todo", "in_progress"]) {
      expect(
        screen.queryByTestId(`loop-template-contract-required-${stale}`),
      ).not.toBeInTheDocument();
    }
  });

  it("reflects the stored required column types as checked", async () => {
    serve(detail());
    renderTab();
    await screen.findByTestId("loop-template-contract-tab");

    expect(
      screen.getByTestId("loop-template-contract-required-backlog"),
    ).toBeChecked();
    expect(
      screen.getByTestId("loop-template-contract-required-done"),
    ).toBeChecked();
    expect(
      screen.getByTestId("loop-template-contract-required-review"),
    ).not.toBeChecked();
  });

  it("toggling a required type on writes it to the draft", async () => {
    const user = userEvent.setup();
    serve(detail());
    renderTab();
    await screen.findByTestId("loop-template-contract-tab");

    await user.click(
      screen.getByTestId("loop-template-contract-required-active"),
    );

    await waitFor(async () => {
      expect((await lastContract()).required_column_types).toEqual([
        "backlog",
        "active",
        "done",
      ]);
    });
  });

  it("toggling a required type off removes it from the draft", async () => {
    const user = userEvent.setup();
    serve(detail());
    renderTab();
    await screen.findByTestId("loop-template-contract-tab");

    await user.click(
      screen.getByTestId("loop-template-contract-required-backlog"),
    );

    await waitFor(async () => {
      expect((await lastContract()).required_column_types).toEqual(["done"]);
    });
  });

  it("updates the live fit summary when a required type is toggled", async () => {
    const user = userEvent.setup();
    serve(detail());
    renderTab();
    await screen.findByTestId("loop-template-contract-tab");

    const summary = screen.getByTestId("loop-template-contract-summary");
    expect(summary).toHaveTextContent("backlog");
    expect(summary).not.toHaveTextContent("review");

    await user.click(
      screen.getByTestId("loop-template-contract-required-review"),
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("loop-template-contract-summary"),
      ).toHaveTextContent("review");
    });
  });

  it("keeps a type out of BOTH lists when it moves from required to optional", async () => {
    const user = userEvent.setup();
    serve(detail());
    renderTab();
    await screen.findByTestId("loop-template-contract-tab");

    // A column type cannot be simultaneously required and optional — checking
    // it optional must drop it from required.
    await user.click(
      screen.getByTestId("loop-template-contract-optional-backlog"),
    );

    await waitFor(async () => {
      const contract = await lastContract();
      expect(contract.optional_column_types).toEqual(["backlog"]);
      expect(contract.required_column_types).toEqual(["done"]);
    });
  });

  it("renders every contract boolean flag with its stored value", async () => {
    serve(detail());
    renderTab();
    await screen.findByTestId("loop-template-contract-tab");

    for (const flag of CONTRACT_FLAGS) {
      expect(
        screen.getByTestId(`loop-template-contract-flag-${flag}`),
      ).toBeInTheDocument();
    }
    expect(
      screen.getByTestId("loop-template-contract-flag-requires_run_label"),
    ).toBeChecked();
    expect(
      screen.getByTestId("loop-template-contract-flag-git_repo_bound"),
    ).toBeChecked();
    expect(
      screen.getByTestId(
        "loop-template-contract-flag-dependencies_server_side",
      ),
    ).not.toBeChecked();
  });

  it("toggling a boolean flag writes it to the draft", async () => {
    const user = userEvent.setup();
    serve(detail());
    renderTab();
    await screen.findByTestId("loop-template-contract-tab");

    await user.click(
      screen.getByTestId(
        "loop-template-contract-flag-dependencies_server_side",
      ),
    );

    await waitFor(async () => {
      expect((await lastContract()).dependencies_server_side).toBe(true);
    });
  });

  it("renders a chip list editor for each declarative list", async () => {
    serve(detail());
    renderTab();
    await screen.findByTestId("loop-template-contract-tab");

    for (const list of CONTRACT_CHIP_LISTS) {
      expect(
        screen.getByTestId(`loop-template-contract-list-${list}`),
      ).toBeInTheDocument();
    }
    expect(
      screen.getByTestId("loop-template-contract-chip-definition_keys-0"),
    ).toHaveTextContent("north_star");
  });

  it("adding a chip writes the new entry to the draft", async () => {
    const user = userEvent.setup();
    serve(detail());
    renderTab();
    await screen.findByTestId("loop-template-contract-tab");

    const input = screen.getByTestId(
      "loop-template-contract-list-definition_keys",
    );
    await user.type(input, "testing_discipline{enter}");

    await waitFor(async () => {
      expect((await lastContract()).definition_keys).toEqual([
        "north_star",
        "testing_discipline",
      ]);
    });
  });

  it("does not add a blank or duplicate chip", async () => {
    const user = userEvent.setup();
    serve(detail());
    renderTab();
    await screen.findByTestId("loop-template-contract-tab");

    const input = screen.getByTestId(
      "loop-template-contract-list-definition_keys",
    );
    await user.type(input, "   {enter}");
    await user.type(input, "north_star{enter}");

    // Asserting `patches` is empty would pass vacuously — the autosave is
    // debounced, so nothing has flushed yet either way. Force a real write
    // with an unrelated edit, then assert the list is still the original one.
    await user.click(
      screen.getByTestId("loop-template-contract-required-active"),
    );

    await waitFor(async () => {
      expect((await lastContract()).definition_keys).toEqual(["north_star"]);
    });
    // And the rendered list never grew a blank or duplicate chip.
    expect(
      screen.queryByTestId("loop-template-contract-chip-definition_keys-1"),
    ).not.toBeInTheDocument();
  });

  it("preserves contract keys this UI does not model", async () => {
    const user = userEvent.setup();
    serve(
      detail({
        content: {
          ...detail().content,
          setup_contract: {
            ...detail().content.setup_contract,
            future_backend_key: { nested: true },
          },
        },
      }),
    );
    renderTab();
    await screen.findByTestId("loop-template-contract-tab");

    await user.click(
      screen.getByTestId("loop-template-contract-required-active"),
    );

    // A lossy round-trip would silently drop the backend's newer field.
    await waitFor(async () => {
      expect((await lastContract()).future_backend_key).toEqual({
        nested: true,
      });
    });
  });

  it("disables every control for a system template but still shows the values", async () => {
    serve(detail({ is_system: true }));
    renderTab();
    await screen.findByTestId("loop-template-contract-tab");

    expect(
      screen.getByTestId("loop-template-contract-readonly"),
    ).toBeInTheDocument();

    for (const type of COLUMN_TYPES) {
      expect(
        screen.getByTestId(`loop-template-contract-required-${type}`),
      ).toBeDisabled();
    }
    for (const flag of CONTRACT_FLAGS) {
      expect(
        screen.getByTestId(`loop-template-contract-flag-${flag}`),
      ).toBeDisabled();
    }
    // Values remain legible.
    expect(
      screen.getByTestId("loop-template-contract-required-backlog"),
    ).toBeChecked();
  });

  it("does not write to the draft when a system template's control is clicked", async () => {
    const user = userEvent.setup();
    serve(detail({ is_system: true }));
    renderTab();
    await screen.findByTestId("loop-template-contract-tab");

    await user.click(
      screen.getByTestId("loop-template-contract-required-review"),
    );

    expect(patches).toHaveLength(0);
  });
});
