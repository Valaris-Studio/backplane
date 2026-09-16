// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  waitFor,
  within,
  userEvent,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";

// Card 1a31b329 — Runner console "Loops" tab, template Library. RED phase.
//
// Locator contract the implementation must satisfy:
// - "loop-template-search"        — the ?q= search input
// - "loop-template-sort"          — the ?sort= select trigger
// - "loop-template-new"           — "New template" (admin only)
// - `loop-template-card-<id>`     — one summary card per template
// - `loop-template-duplicate-<id>`— per-card Duplicate (admin only)

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

const navigateSpy = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigateSpy };
});

import { LoopTemplateLibrary } from "../components/LoopTemplateLibrary";

const SLUG = "acme";
const LIST_URL = `/api/workspaces/${SLUG}/loop-templates`;

const SYSTEM_TEMPLATE = {
  id: "coding-loop",
  source: "system",
  name: "Coding Loop",
  version: 2,
  is_system: true,
  is_draft: false,
  has_slots: true,
  profile: { emoji: "🔁", tagline: "Ship one card per iteration", tags: [] },
  boards_using: 3,
  last_used_at: "2026-08-17T00:00:00Z",
  updated_at: "2026-08-16T00:00:00Z",
  draft_updated_at: null,
  has_unpublished_changes: false,
};

const MINE_PUBLISHED = {
  id: "11111111-1111-4111-8111-111111111111",
  source: "workspace",
  name: "Docs Sweep",
  version: 4,
  is_system: false,
  is_draft: false,
  has_slots: false,
  profile: { emoji: "📚", tagline: "Audit the docs tree", tags: [] },
  boards_using: 1,
  last_used_at: null,
  updated_at: "2026-08-15T00:00:00Z",
  draft_updated_at: null,
  has_unpublished_changes: false,
};

const MINE_DRAFT = {
  id: "22222222-2222-4222-8222-222222222222",
  source: "workspace",
  name: "Perf Hunt",
  version: 0,
  is_system: false,
  is_draft: true,
  has_slots: false,
  profile: { emoji: "⚡", tagline: "Find the slow paths", tags: [] },
  boards_using: 0,
  last_used_at: null,
  updated_at: "2026-08-14T00:00:00Z",
  draft_updated_at: "2026-08-14T00:00:00Z",
  has_unpublished_changes: true,
};

const ALL = [SYSTEM_TEMPLATE, MINE_PUBLISHED, MINE_DRAFT];
const META = {
  runner_vars: ["Workspace", "BoardID", "AgentID", "ExecutionID", "Iteration"],
};

// Every list request the component made, so query-param assertions read the
// REAL outbound URL rather than a re-derived guess.
let listRequests: URL[] = [];

function serveList(templates = ALL) {
  server.use(
    http.get(LIST_URL, ({ request }) => {
      listRequests.push(new URL(request.url));
      return HttpResponse.json({ templates, meta: META });
    }),
  );
}

function renderLibrary() {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/runner/loops" element={<LoopTemplateLibrary />} />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/runner/loops`] } },
  );
}

beforeEach(() => {
  adminState.current.role = "admin";
  navigateSpy.mockClear();
  listRequests = [];
});

describe("LoopTemplateLibrary — sections and badges", () => {
  it("splits system templates from workspace templates into two sections", async () => {
    serveList();
    renderLibrary();

    // Cards land in their own section, keyed by id.
    expect(
      await screen.findByTestId(`loop-template-card-${SYSTEM_TEMPLATE.id}`),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`loop-template-card-${MINE_PUBLISHED.id}`),
    ).toBeInTheDocument();

    const systemSection = screen.getByTestId("loop-template-section-system");
    const mineSection = screen.getByTestId("loop-template-section-workspace");

    expect(systemSection).toContainElement(
      screen.getByTestId(`loop-template-card-${SYSTEM_TEMPLATE.id}`),
    );
    expect(mineSection).toContainElement(
      screen.getByTestId(`loop-template-card-${MINE_PUBLISHED.id}`),
    );
    // A system template must never leak into "My templates".
    expect(mineSection).not.toContainElement(
      screen.getByTestId(`loop-template-card-${SYSTEM_TEMPLATE.id}`),
    );
  });

  it("renders emoji, tagline, version and boards-using on a summary card", async () => {
    serveList();
    renderLibrary();

    const card = await screen.findByTestId(
      `loop-template-card-${SYSTEM_TEMPLATE.id}`,
    );
    expect(card).toHaveTextContent("Coding Loop");
    expect(card).toHaveTextContent("Ship one card per iteration");
    expect(card).toHaveTextContent("🔁");
    expect(card).toHaveTextContent("v2");
    // boards_using: 3 — the count that tells an operator this is load-bearing.
    expect(card).toHaveTextContent("3");
  });

  it("badges a draft template and does not badge a published one", async () => {
    serveList();
    renderLibrary();

    const draftCard = await screen.findByTestId(
      `loop-template-card-${MINE_DRAFT.id}`,
    );
    expect(
      within(draftCard).getByTestId("loop-template-draft-badge"),
    ).toBeInTheDocument();

    const publishedCard = screen.getByTestId(
      `loop-template-card-${MINE_PUBLISHED.id}`,
    );
    expect(
      within(publishedCard).queryByTestId("loop-template-draft-badge"),
    ).not.toBeInTheDocument();
  });

  it("shows a per-section empty state when a section has no templates", async () => {
    serveList([SYSTEM_TEMPLATE]);
    renderLibrary();

    await screen.findByTestId(`loop-template-card-${SYSTEM_TEMPLATE.id}`);
    // Only the workspace half is empty — the system section still has content.
    expect(
      screen.getByTestId("loop-template-empty-workspace"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("loop-template-empty-system"),
    ).not.toBeInTheDocument();
  });
});

describe("LoopTemplateLibrary — admin gating", () => {
  it("hides New and Duplicate from a non-admin", async () => {
    adminState.current.role = "member";
    serveList();
    renderLibrary();

    await screen.findByTestId(`loop-template-card-${SYSTEM_TEMPLATE.id}`);
    expect(screen.queryByTestId("loop-template-new")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(`loop-template-duplicate-${SYSTEM_TEMPLATE.id}`),
    ).not.toBeInTheDocument();
  });

  it("shows New and Duplicate to an admin", async () => {
    serveList();
    renderLibrary();

    expect(
      await screen.findByTestId(
        `loop-template-duplicate-${SYSTEM_TEMPLATE.id}`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("loop-template-new")).toBeInTheDocument();
  });

  it("never offers Archive on a system template, only on a workspace one", async () => {
    serveList();
    renderLibrary();

    await screen.findByTestId(`loop-template-card-${SYSTEM_TEMPLATE.id}`);
    // System templates are code-defined — there is no row to archive.
    expect(
      screen.queryByTestId(`loop-template-archive-${SYSTEM_TEMPLATE.id}`),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId(`loop-template-archive-${MINE_PUBLISHED.id}`),
    ).toBeInTheDocument();
  });

  // Devops UX round 2 (#2): the per-card Archive opens the shared confirm
  // dialog instead of firing immediately.
  it("asks for confirmation before archiving a card", async () => {
    adminState.current.role = "admin";
    const archived = vi.fn();
    serveList();
    server.use(
      http.post(`${LIST_URL}/${MINE_PUBLISHED.id}/archive`, () => {
        archived();
        return HttpResponse.json({});
      }),
    );
    renderLibrary();

    await userEvent.click(
      await screen.findByTestId(`loop-template-archive-${MINE_PUBLISHED.id}`),
    );
    expect(archived).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Archive" }),
    );
    await waitFor(() => expect(archived).toHaveBeenCalledTimes(1));
  });
});

describe("LoopTemplateLibrary — search and sort", () => {
  it("sends the typed text as ?q= after the debounce", async () => {
    const user = userEvent.setup();
    serveList();
    renderLibrary();

    await screen.findByTestId(`loop-template-card-${SYSTEM_TEMPLATE.id}`);
    await user.type(screen.getByTestId("loop-template-search"), "docs");

    await waitFor(() => {
      expect(listRequests.some((u) => u.searchParams.get("q") === "docs")).toBe(
        true,
      );
    });
  });

  it("debounces — typing N characters does not fire N requests", async () => {
    const user = userEvent.setup();
    serveList();
    renderLibrary();

    await screen.findByTestId(`loop-template-card-${SYSTEM_TEMPLATE.id}`);
    const before = listRequests.length;
    await user.type(screen.getByTestId("loop-template-search"), "docs");

    await waitFor(() => {
      expect(listRequests.some((u) => u.searchParams.get("q") === "docs")).toBe(
        true,
      );
    });

    // Undebounced, each keystroke is its own query key and its own request:
    // "d", "do", "doc", "docs" = 4. Debounced, only the settled value is
    // fetched. Anything above 2 means the debounce is not doing its job.
    const prefixRequests = listRequests
      .slice(before)
      .map((u) => u.searchParams.get("q"))
      .filter((q) => q && q !== "docs");
    expect(prefixRequests).toEqual([]);
  });

  it("does not send a q param at all when the search box is empty", async () => {
    serveList();
    renderLibrary();

    await screen.findByTestId(`loop-template-card-${SYSTEM_TEMPLATE.id}`);
    // An empty `?q=` is not the same request as no q — it would make the
    // backend run a LIKE '%%' scan for every first paint.
    expect(listRequests.every((u) => !u.searchParams.has("q"))).toBe(true);
  });

  it("defaults to ?sort=name and sends the chosen sort", async () => {
    const user = userEvent.setup();
    serveList();
    renderLibrary();

    await screen.findByTestId(`loop-template-card-${SYSTEM_TEMPLATE.id}`);
    // Pin that a request happened at all, so the `?.` below cannot pass
    // vacuously on an empty array.
    expect(listRequests.length).toBeGreaterThan(0);
    expect(listRequests[0]?.searchParams.get("sort")).toBe("name");

    await user.click(screen.getByTestId("loop-template-sort"));
    // `boards_using` is a REAL backend sort value — the router's pattern is
    // ^(name|updated_at|boards_using)$, so the card's "last_used" is stale.
    await user.click(await screen.findByRole("option", { name: /most used/i }));

    await waitFor(() => {
      expect(
        listRequests.some((u) => u.searchParams.get("sort") === "boards_using"),
      ).toBe(true);
    });
  });
});

describe("LoopTemplateLibrary — create and duplicate", () => {
  it("duplicates a system template and navigates to the new detail route", async () => {
    const user = userEvent.setup();
    serveList();
    const NEW_ID = "33333333-3333-4333-8333-333333333333";
    let duplicatedRef: string | null = null;
    server.use(
      http.post(`${LIST_URL}/:ref/duplicate`, ({ params }) => {
        duplicatedRef = params.ref as string;
        return HttpResponse.json(
          { id: NEW_ID, slug: "coding-loop-copy" },
          {
            status: 201,
          },
        );
      }),
    );
    renderLibrary();

    await user.click(
      await screen.findByTestId(
        `loop-template-duplicate-${SYSTEM_TEMPLATE.id}`,
      ),
    );
    await user.click(await screen.findByTestId("loop-template-duplicate-confirm"));

    await waitFor(() => {
      // Duplicate is addressed by the SOURCE ref; navigation targets the COPY.
      expect(duplicatedRef).toBe(SYSTEM_TEMPLATE.id);
      expect(navigateSpy).toHaveBeenCalledWith(
        `/${SLUG}/runner/loops/${NEW_ID}`,
      );
    });
  });

  it("posts NO new_slug when the operator leaves the prefilled name alone", async () => {
    // The whole point of B6's backend half is that an unnamed duplicate is
    // retryable: the SERVER walks -copy, -copy-2, … Prefilling the dialog with
    // a slug and always posting it would move that decision to a client that
    // cannot see the other rows, and the third fork would 409 again.
    const user = userEvent.setup();
    serveList();
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post(`${LIST_URL}/:ref/duplicate`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { id: "55555555-5555-4555-8555-555555555555", slug: "coding-loop-copy" },
          { status: 201 },
        );
      }),
    );
    renderLibrary();

    await user.click(
      await screen.findByTestId(
        `loop-template-duplicate-${SYSTEM_TEMPLATE.id}`,
      ),
    );
    await user.click(await screen.findByTestId("loop-template-duplicate-confirm"));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({});
  });

  it("posts new_name and new_slug once the operator names the copy", async () => {
    const user = userEvent.setup();
    serveList();
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post(`${LIST_URL}/:ref/duplicate`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { id: "66666666-6666-4666-8666-666666666666", slug: "prod-fork" },
          { status: 201 },
        );
      }),
    );
    renderLibrary();

    await user.click(
      await screen.findByTestId(
        `loop-template-duplicate-${SYSTEM_TEMPLATE.id}`,
      ),
    );
    const nameInput = await screen.findByTestId("loop-template-duplicate-name");
    await user.clear(nameInput);
    await user.type(nameInput, "Production Fork");
    const slugInput = screen.getByTestId("loop-template-duplicate-slug");
    await user.clear(slugInput);
    await user.type(slugInput, "prod-fork");
    await user.click(screen.getByTestId("loop-template-duplicate-confirm"));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({ new_slug: "prod-fork", new_name: "Production Fork" });
  });

  it("names the taken slug when an explicit choice 409s", async () => {
    const user = userEvent.setup();
    serveList();
    server.use(
      http.post(`${LIST_URL}/:ref/duplicate`, () =>
        HttpResponse.json(
          {
            detail: "taken",
            error_code: "slug_taken",
            error_params: { slug: "prod-fork" },
          },
          { status: 409 },
        ),
      ),
    );
    renderLibrary();

    await user.click(
      await screen.findByTestId(
        `loop-template-duplicate-${SYSTEM_TEMPLATE.id}`,
      ),
    );
    const slugInput = await screen.findByTestId("loop-template-duplicate-slug");
    await user.clear(slugInput);
    await user.type(slugInput, "prod-fork");
    await user.click(screen.getByTestId("loop-template-duplicate-confirm"));

    const alert = await screen.findByTestId("loop-template-duplicate-error");
    // The generic copy tells an operator nothing about WHICH slug clashed, so
    // pin the interpolated slug rather than merely "some error rendered".
    expect(alert.textContent).toContain("prod-fork");
    expect(alert.textContent).not.toMatch(/Try again\.$/);
  });

  it("creates a draft and navigates to it", async () => {
    const user = userEvent.setup();
    serveList();
    const NEW_ID = "44444444-4444-4444-8444-444444444444";
    let created: unknown = null;
    server.use(
      http.post(LIST_URL, async ({ request }) => {
        created = await request.json();
        return HttpResponse.json(
          { id: NEW_ID, slug: "untitled-loop" },
          {
            status: 201,
          },
        );
      }),
    );
    renderLibrary();

    await user.click(await screen.findByTestId("loop-template-new"));

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith(
        `/${SLUG}/runner/loops/${NEW_ID}`,
      );
    });
    // The draft must carry a slug and a name — both are required by the P1
    // create schema (min_length=1), so an empty body would 422.
    expect(created).toEqual(
      expect.objectContaining({
        slug: expect.stringMatching(/.+/),
        name: expect.stringMatching(/.+/),
      }),
    );
  });

  it("does not navigate when duplicate fails", async () => {
    const user = userEvent.setup();
    serveList();
    server.use(
      http.post(`${LIST_URL}/:ref/duplicate`, () =>
        HttpResponse.json({ detail: "conflict" }, { status: 409 }),
      ),
    );
    renderLibrary();

    await user.click(
      await screen.findByTestId(
        `loop-template-duplicate-${SYSTEM_TEMPLATE.id}`,
      ),
    );
    await user.click(await screen.findByTestId("loop-template-duplicate-confirm"));

    await waitFor(() => {
      expect(
        screen.getByTestId("loop-template-duplicate-error"),
      ).toBeInTheDocument();
    });
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});

describe("LoopTemplateLibrary — layout", () => {
  it("stacks to one column below md and two from md up", async () => {
    serveList();
    renderLibrary();

    await screen.findByTestId(`loop-template-card-${SYSTEM_TEMPLATE.id}`);
    const grid = screen.getByTestId("loop-template-grid-system");
    // jsdom does not evaluate media queries, so the responsive contract can
    // only be asserted as the utility classes that encode it.
    expect(grid.className).toContain("grid-cols-1");
    expect(grid.className).toContain("md:grid-cols-2");
  });
});
