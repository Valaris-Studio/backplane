// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { LoopTemplateVersionsTab } from "../components/LoopTemplateVersionsTab";

let isAdmin = true;

vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({
    isAdmin,
    role: isAdmin ? "admin" : "member",
    isLoading: false,
    isError: false,
  }),
}));

const SLUG = "acme";
const REF = "11111111-2222-3333-4444-555555555555";
const DETAIL_URL = `/api/workspaces/${SLUG}/loop-templates/${REF}`;

let restoreCalls: number[];

// Published content is deliberately UNLIKE the draft: a realistic fixture where
// both halves read the same would make every diff assertion vacuous.
const PUBLISHED = {
  system_prompt: "You are a careful agent.\nFollow the rails.",
  loop_prompt: "Advance one card.",
  slots: [{ name: "REPO", kind: "scalar" }],
  rails_defaults: { max_iterations: 20 },
  tools: ["set_board_loop"],
};

const DRAFT = {
  system_prompt: "You are a careful agent.\nNever touch main.",
  loop_prompt: "Advance one card.",
  slots: [
    { name: "REPO", kind: "scalar" },
    { name: "BRANCH", kind: "scalar" },
  ],
  rails_defaults: { max_iterations: 20, budget_usd: 250 },
  tools: ["set_board_loop"],
};

function detail(over: Record<string, unknown> = {}) {
  return {
    id: REF,
    slug: "coding-loop",
    source: "workspace",
    name: "Coding Loop",
    version: 3,
    is_system: false,
    is_draft: false,
    profile: {},
    content: DRAFT,
    lineage: null,
    updated_at: "2026-08-16T10:00:00Z",
    draft_updated_at: "2026-08-16T11:00:00Z",
    has_unpublished_changes: true,
    ...over,
  };
}

const VERSIONS = [
  { version: 3, published_at: "2026-08-16T09:00:00Z", note: "Tighten the rails" },
  { version: 2, published_at: "2026-08-15T09:00:00Z", note: null },
  { version: 1, published_at: "2026-08-14T09:00:00Z", note: "First cut" },
];

function serve({
  versions = VERSIONS,
  draftDetail = detail(),
  publishedDetail = detail({ content: PUBLISHED, has_unpublished_changes: true }),
  versionsStatus = 200,
  restoreStatus = 200,
}: {
  versions?: typeof VERSIONS;
  draftDetail?: Record<string, unknown>;
  publishedDetail?: Record<string, unknown>;
  versionsStatus?: number;
  restoreStatus?: number;
} = {}) {
  server.use(
    http.get(`${DETAIL_URL}/versions`, () =>
      versionsStatus === 200
        ? HttpResponse.json(versions)
        : new HttpResponse(null, { status: versionsStatus }),
    ),
    // The published half and the draft half are the SAME url, split by ?draft.
    http.get(DETAIL_URL, ({ request }) => {
      const isDraft = new URL(request.url).searchParams.get("draft") === "true";
      return HttpResponse.json(isDraft ? draftDetail : publishedDetail);
    }),
    http.patch(DETAIL_URL, async ({ request }) =>
      HttpResponse.json({
        ...draftDetail,
        ...((await request.json()) as Record<string, unknown>),
      }),
    ),
    http.post(`${DETAIL_URL}/versions/:version/restore`, ({ params }) => {
      restoreCalls.push(Number(params.version));
      return restoreStatus === 200
        ? HttpResponse.json(detail({ content: PUBLISHED }))
        : new HttpResponse(null, { status: restoreStatus });
    }),
  );
}

const render = () =>
  renderWithProviders(<LoopTemplateVersionsTab slug={SLUG} templateRef={REF} />);

beforeEach(() => {
  restoreCalls = [];
  isAdmin = true;
});

describe("LoopTemplateVersionsTab", () => {
  it("lists every published version newest-first with its note", async () => {
    serve();
    render();

    await waitFor(() =>
      expect(screen.getByTestId("loop-template-version-3")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("loop-template-version-2")).toBeInTheDocument();
    expect(screen.getByTestId("loop-template-version-1")).toBeInTheDocument();
    expect(screen.getByText("Tighten the rails")).toBeInTheDocument();
    expect(screen.getByText("First cut")).toBeInTheDocument();

    const rendered = screen
      .getAllByTestId(/^loop-template-version-\d+$/)
      .map((el) => el.getAttribute("data-testid"));
    expect(rendered).toEqual([
      "loop-template-version-3",
      "loop-template-version-2",
      "loop-template-version-1",
    ]);
  });

  it("marks the version the template currently publishes at", async () => {
    serve();
    render();

    await waitFor(() =>
      expect(screen.getByTestId("loop-template-version-3")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("loop-template-version-current-3")).toBeInTheDocument();
    expect(
      screen.queryByTestId("loop-template-version-current-2"),
    ).not.toBeInTheDocument();
  });

  it("diffs the draft against the published prompt, marking the real change", async () => {
    serve();
    render();

    // "Follow the rails." (published) → "Never touch main." (draft)
    await waitFor(() =>
      expect(screen.getByText("Never touch main.")).toBeInTheDocument(),
    );
    expect(screen.getByText("Follow the rails.")).toBeInTheDocument();

    const added = screen.getByText("Never touch main.").closest("[data-testid^='line-diff-row-']");
    const removed = screen.getByText("Follow the rails.").closest("[data-testid^='line-diff-row-']");
    expect(added?.className).toContain("bg-success/15");
    expect(removed?.className).toContain("bg-destructive/15");

    // The unchanged first line must NOT be tinted, or the diff claims a
    // whole-prompt rewrite.
    const unchanged = screen
      .getByText("You are a careful agent.")
      .closest("[data-testid^='line-diff-row-']");
    expect(unchanged?.className).not.toContain("bg-success/15");
    expect(unchanged?.className).not.toContain("bg-destructive/15");
  });

  it("summarizes structural counts that a line diff of prose would hide", async () => {
    serve();
    render();

    // slots 1 → 2 and rails 1 → 2; tools unchanged at 1.
    await waitFor(() =>
      expect(screen.getByTestId("loop-template-version-summary")).toBeInTheDocument(),
    );
    const summary = screen.getByTestId("loop-template-version-summary");
    expect(summary).toHaveTextContent("Slots: 1 → 2");
    expect(summary).toHaveTextContent("Rails: 1 → 2");
  });

  it("restores a version through the backend only after the confirm dialog", async () => {
    serve();
    render();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByTestId("loop-template-version-2")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("loop-template-version-restore-2"));

    // Opening the dialog must not have restored anything yet.
    expect(restoreCalls).toEqual([]);

    await user.click(screen.getByTestId("loop-template-version-restore-confirm"));
    await waitFor(() => expect(restoreCalls).toEqual([2]));
  });

  it("restores the version whose button was clicked, not the newest", async () => {
    serve();
    render();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByTestId("loop-template-version-1")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("loop-template-version-restore-1"));
    await user.click(screen.getByTestId("loop-template-version-restore-confirm"));

    await waitFor(() => expect(restoreCalls).toEqual([1]));
  });

  it("warns that unsaved draft work will be lost before restoring over it", async () => {
    serve();
    render();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByTestId("loop-template-version-2")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("loop-template-version-restore-2"));

    expect(
      screen.getByTestId("loop-template-version-restore-warning"),
    ).toBeInTheDocument();
  });

  it("omits the warning when the draft has no unpublished changes", async () => {
    serve({
      draftDetail: detail({ has_unpublished_changes: false }),
      publishedDetail: detail({
        content: PUBLISHED,
        has_unpublished_changes: false,
      }),
    });
    render();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByTestId("loop-template-version-2")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("loop-template-version-restore-2"));

    expect(
      screen.queryByTestId("loop-template-version-restore-warning"),
    ).not.toBeInTheDocument();
  });

  it("surfaces a failed restore instead of pretending it worked", async () => {
    serve({ restoreStatus: 500 });
    render();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByTestId("loop-template-version-2")).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("loop-template-version-restore-2"));
    await user.click(screen.getByTestId("loop-template-version-restore-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("loop-template-version-restore-error")).toBeInTheDocument(),
    );
  });

  it("shows the never-published empty state rather than an empty list", async () => {
    serve({ versions: [] });
    render();

    await waitFor(() =>
      expect(screen.getByTestId("loop-template-versions-empty")).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("loop-template-version-restore-3"),
    ).not.toBeInTheDocument();
  });

  it("offers no restore control on a system template, which has no row to write", async () => {
    // Versions are deliberately PRESENT: with an empty list no rows render at
    // all, so the assertion would pass whether or not the system guard runs.
    serve({
      draftDetail: detail({ is_system: true, source: "system" }),
      publishedDetail: detail({
        is_system: true,
        source: "system",
        content: PUBLISHED,
      }),
    });
    render();

    await waitFor(() =>
      expect(screen.getByTestId("loop-template-version-2")).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("loop-template-version-restore-2"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("loop-template-version-restore-1"),
    ).not.toBeInTheDocument();
  });

  it("shows the system empty state when a system template has no history", async () => {
    serve({
      versions: [],
      draftDetail: detail({ is_system: true, source: "system" }),
      publishedDetail: detail({
        is_system: true,
        source: "system",
        content: PUBLISHED,
      }),
    });
    render();

    await waitFor(() =>
      expect(screen.getByTestId("loop-template-versions-system")).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("loop-template-versions-empty"),
    ).not.toBeInTheDocument();
  });

  it("offers no restore control to a non-admin member, who cannot write templates", async () => {
    isAdmin = false;
    serve();
    render();

    await waitFor(() =>
      expect(screen.getByTestId("loop-template-version-2")).toBeInTheDocument(),
    );
    // The history stays readable — a member may inspect it, just not stage a
    // snapshot as the draft (template mutations are admin-only).
    expect(screen.getByTestId("loop-template-version-3")).toBeInTheDocument();
    expect(
      screen.queryByTestId("loop-template-version-restore-2"),
    ).not.toBeInTheDocument();
  });
});
