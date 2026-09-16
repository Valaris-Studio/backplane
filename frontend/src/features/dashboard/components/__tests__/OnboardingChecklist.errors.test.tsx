// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  renderWithProviders,
  screen,
  within,
  userEvent,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";

// Bug fb4defdb: the six onboarding mini-forms had NO error surface — a failed
// mutation silently left the form open with no message, and BoardCardInputs
// called onFinished() immediately regardless of how many of its up-to-3
// createCard calls actually succeeded, collapsing the row while the user
// believed the cards existed.
//
// These tests pin two things per mini-form:
// - a failed mutation renders inline error text (the codebase's
//   role="alert" destructive-tinted idiom) inside the step's popover
// - the popover/form stays open (still queryable) after the failure
// Plus a dedicated BoardCardInputs partial-failure contract: one of three
// creates failing keeps the popover open, names the failure, and never calls
// onFinished; all-succeed is an unchanged-behavior control.
// Rail refactor: forms live in a portaled modal, so every form query scopes
// to `[data-onboarding-modal]`, never to the rail pill.
import { OnboardingChecklist } from "../OnboardingChecklist";

const SLUG = "acme";

const boardAlpha = {
  id: "b1",
  slug: "alpha",
  name: "Alpha",
  description: "",
  tags: [],
  workspace_id: "ws-1",
  created_at: "2026-07-31T00:00:00Z",
  updated_at: "2026-07-31T00:00:00Z",
};

const seededColumns = [
  { id: "col-todo", name: "To Do", column_type: "backlog", position: 1024, board_id: "b1", cards: [], created_at: "2026-07-31T00:00:00Z", updated_at: "2026-07-31T00:00:00Z" },
  { id: "col-active", name: "In Progress", column_type: "active", position: 2048, board_id: "b1", cards: [], created_at: "2026-07-31T00:00:00Z", updated_at: "2026-07-31T00:00:00Z" },
  { id: "col-blocked", name: "Blocked", column_type: "blocked", position: 3072, board_id: "b1", cards: [], created_at: "2026-07-31T00:00:00Z", updated_at: "2026-07-31T00:00:00Z" },
  { id: "col-done", name: "Done", column_type: "done", position: 4096, board_id: "b1", cards: [], created_at: "2026-07-31T00:00:00Z", updated_at: "2026-07-31T00:00:00Z" },
];

const ownerMember = {
  user_id: "u1",
  email: "owner@acme.dev",
  name: "Owner",
  role: "owner",
  joined_at: "2026-07-31T00:00:00Z",
};

interface Sim {
  boards: (typeof boardAlpha)[];
  noteCount: number;
  channelCount: number;
  members: (typeof ownerMember)[];
  definitionContent: Record<string, unknown> | null;
  repos: Record<string, unknown>[];
}

// Base GET handlers shared by every test here — mirrors installSim from the
// miniforms suite but this file only needs mutating (POST/PUT) overrides per
// test, so GETs are static rather than sim-driven.
function installBaseGets(overrides: Partial<Sim> = {}) {
  const sim: Sim = {
    boards: [],
    noteCount: 0,
    channelCount: 0,
    members: [ownerMember],
    definitionContent: null,
    repos: [],
    ...overrides,
  };
  server.use(
    http.get(`/api/workspaces/${SLUG}/summary`, () =>
      HttpResponse.json({
        board_count: sim.boards.length,
        card_count: 0,
        note_count: sim.noteCount,
        channel_count: sim.channelCount,
        recent_activity: [],
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/boards`, () =>
      HttpResponse.json(sim.boards),
    ),
    http.get(`/api/workspaces/${SLUG}/members`, () =>
      HttpResponse.json(sim.members),
    ),
    http.get(`/api/workspaces/${SLUG}/boards/:boardId/definitions`, () =>
      sim.definitionContent
        ? HttpResponse.json({
            id: "def-1",
            board_id: "b1",
            scope: "board",
            content: sim.definitionContent,
            created_at: "2026-07-31T00:00:00Z",
            updated_at: "2026-07-31T00:00:00Z",
          })
        : HttpResponse.json({ detail: "Not found" }, { status: 404 }),
    ),
    http.get(`/api/workspaces/${SLUG}/boards/:boardId/git-repos`, () =>
      HttpResponse.json(sim.repos),
    ),
    http.get(`/api/workspaces/${SLUG}/resources`, () => HttpResponse.json([])),
  );
  return sim;
}

function fail500() {
  return HttpResponse.json({ detail: "Internal server error" }, { status: 500 });
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

beforeEach(() => {
  window.localStorage.clear();
  stubMatchMedia(true);
});

afterEach(() => stubMatchMedia(false));

function renderChecklist() {
  return renderWithProviders(<OnboardingChecklist slug={SLUG} />);
}

function stepEl(container: HTMLElement, id: string) {
  return container.querySelector<HTMLElement>(
    `[data-onboarding-step="${id}"]`,
  )!;
}

// Opens a step from its rail pill and returns the MODAL — the form and its
// error surface render there, outside the rail.
async function expandStep(
  user: ReturnType<typeof userEvent.setup>,
  container: HTMLElement,
  id: string,
  title: string,
) {
  const pill = stepEl(container, id);
  await user.click(within(pill).getByRole("button"));
  const panel = document.querySelector<HTMLElement>(
    "[data-onboarding-modal]",
  )!;
  expect(panel, `step "${id}" opened no modal`).not.toBeNull();
  expect(within(panel).getByText(title)).toBeInTheDocument();
  expect(pill.contains(panel)).toBe(false);
  return panel;
}

describe("OnboardingChecklist mini-forms — error surfacing", () => {
  it("board: shows an inline error and keeps the form open on a failed create", async () => {
    installBaseGets();
    server.use(
      http.post(`/api/workspaces/${SLUG}/boards`, () => fail500()),
    );
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });
    const row = await expandStep(
      user,
      container,
      "board",
      "Keep track of what needs doing",
    );

    await user.type(
      within(row).getByPlaceholderText("Board name"),
      "Alpha",
    );
    await user.click(
      within(row).getByRole("button", { name: "Create board" }),
    );

    const alert = await within(row).findByRole("alert");
    expect(alert.textContent).toBeTruthy();
    // Form is still there — the name input survives the failed submit.
    expect(within(row).getByPlaceholderText("Board name")).toBeInTheDocument();
    expect(
      within(row).getByRole("button", { name: "Create board" }),
    ).toBeInTheDocument();
  });

  it("context: shows an inline error and keeps the textarea open on a failed save", async () => {
    installBaseGets({ boards: [boardAlpha] });
    server.use(
      http.put(`/api/workspaces/${SLUG}/boards/:boardId/definitions`, () =>
        fail500(),
      ),
    );
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Definition/ });
    const row = await expandStep(
      user,
      container,
      "context",
      "Tell Backplane what you're working on",
    );

    await user.type(
      within(row).getByPlaceholderText(
        "What is this project about, and where should it end up?",
      ),
      "A billing portal",
    );
    await user.click(within(row).getByRole("button", { name: "Save context" }));

    const alert = await within(row).findByRole("alert");
    expect(alert.textContent).toBeTruthy();
    expect(
      within(row).getByPlaceholderText(
        "What is this project about, and where should it end up?",
      ),
    ).toBeInTheDocument();
  });

  it("notes: shows an inline error and keeps the form open on a failed create", async () => {
    installBaseGets();
    server.use(http.post(`/api/workspaces/${SLUG}/notes`, () => fail500()));
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Notes/ });
    const row = await expandStep(
      user,
      container,
      "notes",
      "Keep what you know next to the work",
    );

    await user.type(
      within(row).getByPlaceholderText("Note title"),
      "Deploy runbook",
    );
    await user.click(within(row).getByRole("button", { name: "Save note" }));

    const alert = await within(row).findByRole("alert");
    expect(alert.textContent).toBeTruthy();
    expect(within(row).getByPlaceholderText("Note title")).toBeInTheDocument();
  });

  it("members: shows an inline error and keeps the rows open on a failed add", async () => {
    installBaseGets();
    server.use(http.post(`/api/workspaces/${SLUG}/members`, () => fail500()));
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Team/ });
    const row = await expandStep(user, container, "members", "Bring your team in");

    await user.type(
      within(row).getAllByPlaceholderText("Email address")[0]!,
      "dana@acme.dev",
    );
    await user.click(within(row).getByRole("button", { name: "Add member" }));

    const alert = await within(row).findByRole("alert");
    expect(alert.textContent).toBeTruthy();
    expect(
      within(row).getAllByPlaceholderText("Email address")[0],
    ).toBeInTheDocument();
  });

  it("channels: shows an inline error and keeps the form open on a failed create", async () => {
    installBaseGets();
    server.use(http.post(`/api/workspaces/${SLUG}/channels`, () => fail500()));
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Channel/ });
    const row = await expandStep(
      user,
      container,
      "channels",
      "Give discussions a home",
    );

    await user.click(
      within(row).getByRole("button", { name: "Create channel" }),
    );

    const alert = await within(row).findByRole("alert");
    expect(alert.textContent).toBeTruthy();
    expect(
      within(row).getByPlaceholderText("Channel name"),
    ).toBeInTheDocument();
  });

  it("repos: shows an inline error and keeps the form open on a failed link", async () => {
    installBaseGets({ boards: [boardAlpha] });
    server.use(
      http.post(`/api/workspaces/${SLUG}/boards/:boardId/git-repos`, () =>
        fail500(),
      ),
    );
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Git/ });
    const row = await expandStep(user, container, "repos", "Connect the code");

    await user.type(
      within(row).getByPlaceholderText("Repository URL"),
      "https://github.com/acme/alpha",
    );
    await user.type(
      within(row).getByPlaceholderText("Repository name"),
      "alpha",
    );
    await user.click(
      within(row).getByRole("button", { name: "Link repository" }),
    );

    const alert = await within(row).findByRole("alert");
    expect(alert.textContent).toBeTruthy();
    expect(
      within(row).getByPlaceholderText("Repository URL"),
    ).toBeInTheDocument();
  });
});

describe("OnboardingChecklist — BoardCardInputs partial failure", () => {
  async function createBoardAndReachCardInputs(
    user: ReturnType<typeof userEvent.setup>,
    container: HTMLElement,
  ) {
    const row = await expandStep(
      user,
      container,
      "board",
      "Keep track of what needs doing",
    );
    await user.type(within(row).getByPlaceholderText("Board name"), "Alpha");
    await user.click(
      within(row).getByRole("button", { name: "Create board" }),
    );
    await within(row).findByText("What's on your plate right now?");
    return row;
  }

  it("keeps the row expanded and names the failure when one of several card creates fails", async () => {
    installBaseGets();
    server.use(
      http.post(`/api/workspaces/${SLUG}/boards`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { ...boardAlpha, name: body.name, columns: seededColumns },
          { status: 201 },
        );
      }),
      http.post(
        `/api/workspaces/${SLUG}/boards/:boardId/cards`,
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          if (body.title === "Fix the login flake") {
            return HttpResponse.json(
              { detail: "Internal server error" },
              { status: 500 },
            );
          }
          return HttpResponse.json(
            { id: `card-${String(body.title)}`, board_id: "b1", ...body },
            { status: 201 },
          );
        },
      ),
    );
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });
    const row = await createBoardAndReachCardInputs(user, container);

    const cardInputs = within(row).getAllByPlaceholderText(
      "Something that needs doing",
    );
    await user.type(cardInputs[0]!, "Write the launch checklist");
    await user.type(cardInputs[1]!, "Fix the login flake");
    await user.click(within(row).getByRole("button", { name: "Add cards" }));

    const alert = await within(row).findByRole("alert");
    expect(alert.textContent).toBeTruthy();
    // The row/content must still be open — onFinished was NOT called.
    expect(
      within(row).getByRole("button", { name: "Add cards" }),
    ).toBeInTheDocument();
    expect(
      container.querySelector("[data-onboarding-checklist]"),
    ).not.toBeNull();
  });

  it("control: confirms in place and clears the slots when all card creates succeed", async () => {
    installBaseGets();
    server.use(
      http.post(`/api/workspaces/${SLUG}/boards`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          { ...boardAlpha, name: body.name, columns: seededColumns },
          { status: 201 },
        );
      }),
      http.post(
        `/api/workspaces/${SLUG}/boards/:boardId/cards`,
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            { id: `card-${String(body.title)}`, board_id: "b1", ...body },
            { status: 201 },
          );
        },
      ),
    );
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });
    const row = await createBoardAndReachCardInputs(user, container);

    const cardInputs = within(row).getAllByPlaceholderText(
      "Something that needs doing",
    );
    await user.type(cardInputs[0]!, "Write the launch checklist");
    await user.click(within(row).getByRole("button", { name: "Add cards" }));

    // Feedback fix: the modal no longer closes out from under the user. It
    // confirms what landed and empties the slots so more cards can follow.
    expect(
      await within(row).findByText("1 card added to your board."),
    ).toBeInTheDocument();
    expect(document.querySelector("[data-onboarding-modal]")).not.toBeNull();
    for (const input of within(row).getAllByPlaceholderText(
      "Something that needs doing",
    )) {
      expect(input).toHaveValue("");
    }
  });
});
