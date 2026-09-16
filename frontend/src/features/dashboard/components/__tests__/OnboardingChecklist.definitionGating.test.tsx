// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import { renderWithProviders, screen, waitFor, act } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { api } from "@/lib/api";

// BP-005 sub-fix A1 wiring: the checklist must pass the first board's
// additive `has_definition` flag into useDefinition (`has_definition ?? true`)
// so a workspace whose board has no definition never fires the red-404
// GET /definitions on the dashboard. Handler/fixture idiom copied from
// OnboardingChecklist.test.tsx.
import { OnboardingChecklist } from "../OnboardingChecklist";

const SLUG = "acme";

const soloMember = {
  id: "m1",
  user_id: "u1",
  email: "owner@acme.dev",
  role: "owner",
  created_at: "2026-07-31T00:00:00Z",
};

const definitionFixture = {
  id: "def-1",
  board_id: "b1",
  scope: "board",
  content: { objectives: [{ text: "Ship the first release", priority: null }] },
  created_at: "2026-07-31T00:00:00Z",
  updated_at: "2026-07-31T00:00:00Z",
};

// `has_definition` is the new additive list-endpoint flag; extra fields on the
// wire fixture are free.
function makeBoard(hasDefinition: boolean | null | undefined) {
  return {
    id: "b1",
    slug: "alpha",
    name: "Alpha",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    created_at: "2026-07-31T00:00:00Z",
    updated_at: "2026-07-31T00:00:00Z",
    ...(hasDefinition === undefined ? {} : { has_definition: hasDefinition }),
  };
}

function installHandlers(board: Record<string, unknown>, hasDefinition: boolean) {
  server.use(
    http.get(`/api/workspaces/${SLUG}/summary`, () =>
      HttpResponse.json({
        board_count: 1,
        card_count: 0,
        note_count: 0,
        channel_count: 0,
        recent_activity: [],
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/boards`, () => HttpResponse.json([board])),
    http.get(`/api/workspaces/${SLUG}/members`, () =>
      HttpResponse.json([soloMember]),
    ),
    http.get(`/api/workspaces/${SLUG}/boards/:boardId/definitions`, () =>
      hasDefinition
        ? HttpResponse.json(definitionFixture)
        : HttpResponse.json({ detail: "Not found" }, { status: 404 }),
    ),
    http.get(`/api/workspaces/${SLUG}/boards/:boardId/git-repos`, () =>
      HttpResponse.json([]),
    ),
    http.get(`/api/workspaces/${SLUG}/resources`, () => HttpResponse.json([])),
  );
}

function stubMatchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function definitionGetCalls(getSpy: MockInstance<typeof api.get>) {
  return getSpy.mock.calls.filter(([url]) =>
    String(url).includes("/definitions"),
  );
}

function stepEl(container: HTMLElement, id: string) {
  return container.querySelector<HTMLElement>(`[data-onboarding-step="${id}"]`);
}

beforeEach(() => {
  window.localStorage.clear();
  stubMatchMedia(true);
});

afterEach(() => {
  stubMatchMedia(false);
  vi.restoreAllMocks();
});

describe("OnboardingChecklist — has_definition gates the GET /definitions request", () => {
  it("never requests definitions when the board says has_definition=false, yet still settles and renders the context step as empty", async () => {
    installHandlers(makeBoard(false), false);
    const getSpy = vi.spyOn(api, "get");
    const { container } = renderChecklist();

    // The checklist only renders once every query SETTLES — so this also
    // pins that a gated-off definition query resolves (to null) instead of
    // hanging disabled in pending forever.
    await screen.findByRole("button", { name: /Board/ });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(definitionGetCalls(getSpy)).toHaveLength(0);
    expect(stepEl(container, "context")!.getAttribute("data-step-state")).toBe(
      "empty",
    );
  });

  it("fetches definitions when has_definition=true and marks the context step done", async () => {
    installHandlers(makeBoard(true), true);
    const getSpy = vi.spyOn(api, "get");
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });
    await waitFor(() => {
      expect(
        stepEl(container, "context")!.getAttribute("data-step-state"),
      ).toBe("done");
    });
    expect(definitionGetCalls(getSpy).length).toBeGreaterThan(0);
  });

  it("fetches definitions when the flag is absent (old-backend compat), 404 → empty", async () => {
    installHandlers(makeBoard(undefined), false);
    const getSpy = vi.spyOn(api, "get");
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });
    await waitFor(() =>
      expect(definitionGetCalls(getSpy).length).toBeGreaterThan(0),
    );
    expect(stepEl(container, "context")!.getAttribute("data-step-state")).toBe(
      "empty",
    );
  });

  it("fetches definitions when has_definition is null (?? true mapping)", async () => {
    installHandlers(makeBoard(null), true);
    const getSpy = vi.spyOn(api, "get");
    renderChecklist();

    await screen.findByRole("button", { name: /Board/ });
    await waitFor(() =>
      expect(definitionGetCalls(getSpy).length).toBeGreaterThan(0),
    );
  });
});

function renderChecklist() {
  return renderWithProviders(<OnboardingChecklist slug={SLUG} />);
}
