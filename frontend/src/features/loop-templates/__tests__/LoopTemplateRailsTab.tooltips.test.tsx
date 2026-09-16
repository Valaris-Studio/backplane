// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { LoopTemplateRailsTab } from "../components/LoopTemplateRailsTab";
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

function serve() {
  const body = {
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
      tools: ["search_cards", "set_board_loop"],
      derived_rails: {},
    },
    lineage: null,
    updated_at: "2026-08-17T00:00:00Z",
    draft_updated_at: "2026-08-17T00:00:00Z",
    has_unpublished_changes: false,
  };
  server.use(
    http.get(DETAIL_URL, () => HttpResponse.json(body)),
    http.patch(DETAIL_URL, () => HttpResponse.json(body)),
  );
}

/**
 * RichTooltip wraps its child in an outer span carrying the dialog affordance;
 * the rail's own label is the inner node, so hover/click must target the
 * wrapper or the panel never opens.
 */
function wrapperOf(inner: HTMLElement): HTMLElement {
  let node: HTMLElement | null = inner.parentElement;
  while (node) {
    if (node.getAttribute("aria-haspopup") === "dialog") return node;
    node = node.parentElement;
  }
  throw new Error("no RichTooltip wrapper found around element");
}

async function railTrigger(rail: string): Promise<HTMLElement> {
  await screen.findByTestId("loop-template-rails-tab");
  return wrapperOf(
    await screen.findByTestId(`loop-template-rail-tooltip-${rail}`),
  );
}

describe("LoopTemplateRailsTab — tooltip content", () => {
  it("shows the authored summary on hover, not an empty panel", async () => {
    serve();
    renderWithProviders(<TemplateDraftProvider slug={SLUG} templateRef={REF}>
      <LoopTemplateRailsTab slug={SLUG} templateRef={REF} />
    </TemplateDraftProvider>);
    const user = userEvent.setup();

    await user.hover(await railTrigger("max_iterations"));

    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent(
        /hard ceiling on iterations/i,
      );
    });
  });

  it("opens the modal with What/Why rows and the provenance callout", async () => {
    serve();
    renderWithProviders(<TemplateDraftProvider slug={SLUG} templateRef={REF}>
      <LoopTemplateRailsTab slug={SLUG} templateRef={REF} />
    </TemplateDraftProvider>);
    const user = userEvent.setup();

    // max_consecutive_failures is the rail whose lesson the anatomy note
    // records verbatim, so it is the one that proves rows AND callouts render.
    await user.click(await railTrigger("max_consecutive_failures"));

    const rows = await screen.findByTestId("rt-rows");
    expect(rows).toHaveTextContent("What");
    expect(rows).toHaveTextContent("Why");
    expect(rows).toHaveTextContent(/consecutive failed iterations/i);

    expect(await screen.findByTestId("rt-callouts")).toHaveTextContent(
      /Loop #4\/#5/,
    );
  });

  it("links the rail to the loop-mode docs page", async () => {
    serve();
    renderWithProviders(<TemplateDraftProvider slug={SLUG} templateRef={REF}>
      <LoopTemplateRailsTab slug={SLUG} templateRef={REF} />
    </TemplateDraftProvider>);
    const user = userEvent.setup();

    await user.click(await railTrigger("budget_usd"));

    const link = (await screen.findByTestId("rt-links")).querySelector("a");
    // resolveHref prefixes a bare path with the workspace slug; with no slug in
    // the route it falls back to a root-relative path, so assert the suffix.
    expect(link?.getAttribute("href")).toMatch(
      /documentation\/loop-mode#config$/,
    );
  });

  it("gives an enum rail its own panel rather than falling back to a sibling", async () => {
    serve();
    renderWithProviders(<TemplateDraftProvider slug={SLUG} templateRef={REF}>
      <LoopTemplateRailsTab slug={SLUG} templateRef={REF} />
    </TemplateDraftProvider>);
    const user = userEvent.setup();

    await user.hover(await railTrigger("starvation_policy"));

    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent(
        /no card is workable/i,
      );
    });
  });
});
