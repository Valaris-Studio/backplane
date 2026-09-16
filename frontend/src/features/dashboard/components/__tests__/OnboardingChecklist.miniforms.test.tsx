// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  renderWithProviders,
  screen,
  waitFor,
  within,
  userEvent,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";

// Stage-B contract for the checklist's mini-forms (spec card 75b94de2):
// - Every area opens a mini-form in a portaled modal anchored to its
//   `[data-onboarding-step]` rail pill (rail refactor — the form used to
//   render inline inside a step card) — the user never leaves the wizard, so
//   the checklist stays mounted after every submit.
// - Each form submits through its area's mutation hook; these tests pin the
//   requests on the wire (method, path, payload) and the round-trip: after the
//   mutation the wizard's invalidations refetch the done-state sources and the
//   row flips to "done" — even for summary-derived areas (notes, channels).
// - Board-dependent areas (context, repos) show a create-a-board-first
//   guidance line instead of a form while the workspace has no board (the
//   build map gates their queries on the first board id; the forms follow).
//   Notes are workspace-level and need no board.
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

const CHANNEL_TYPES = ["email", "slack", "whatsapp", "phone", "website", "other"];
const GIT_PROVIDERS = ["github", "gitlab", "bitbucket", "other"];

// Mutable in-memory workspace: GET handlers read live state so the wizard's
// post-mutation invalidations observe their own writes (the round-trip that
// flips rows to done).
interface Sim {
  boards: (typeof boardAlpha)[];
  noteCount: number;
  channelCount: number;
  members: (typeof ownerMember)[];
  definitionContent: Record<string, unknown> | null;
  repos: Record<string, unknown>[];
}

interface CapturedRequest {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

function installSim(overrides: Partial<Sim> = {}) {
  const sim: Sim = {
    boards: [],
    noteCount: 0,
    channelCount: 0,
    members: [ownerMember],
    definitionContent: null,
    repos: [],
    ...overrides,
  };
  const captured: CapturedRequest[] = [];

  async function capture(request: Request) {
    const body = (await request.json()) as Record<string, unknown>;
    captured.push({
      method: request.method,
      path: new URL(request.url).pathname,
      body,
    });
    return body;
  }

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

    http.post(`/api/workspaces/${SLUG}/boards`, async ({ request }) => {
      const body = await capture(request);
      sim.boards = [...sim.boards, { ...boardAlpha, name: String(body.name) }];
      return HttpResponse.json(
        { ...boardAlpha, name: body.name, columns: seededColumns },
        { status: 201 },
      );
    }),
    http.post(
      `/api/workspaces/${SLUG}/boards/:boardId/cards`,
      async ({ request }) => {
        const body = await capture(request);
        return HttpResponse.json(
          { id: `card-${captured.length}`, board_id: "b1", ...body },
          { status: 201 },
        );
      },
    ),
    http.post(
      `/api/workspaces/${SLUG}/boards/:boardId/columns`,
      async ({ request }) => {
        await capture(request);
        return HttpResponse.json({}, { status: 201 });
      },
    ),
    http.put(
      `/api/workspaces/${SLUG}/boards/:boardId/definitions`,
      async ({ request }) => {
        const body = await capture(request);
        sim.definitionContent =
          (body.content as Record<string, unknown>) ?? null;
        return HttpResponse.json({
          id: "def-1",
          board_id: "b1",
          scope: "board",
          content: sim.definitionContent,
          created_at: "2026-07-31T00:00:00Z",
          updated_at: "2026-07-31T00:00:00Z",
        });
      },
    ),
    http.post(`/api/workspaces/${SLUG}/notes`, async ({ request }) => {
      const body = await capture(request);
      sim.noteCount += 1;
      return HttpResponse.json(
        {
          id: "note-1",
          workspace_id: "ws-1",
          board_id: null,
          card_id: null,
          title: body.title,
          content: body.content ?? "",
          pinned: false,
          kind: "user_note",
          failure_class: null,
          findings: null,
          source_execution_id: null,
          created_by: "u1",
          created_at: "2026-07-31T00:00:00Z",
          updated_at: "2026-07-31T00:00:00Z",
        },
        { status: 201 },
      );
    }),
    // The wizard's note goes to the workspace, not a board — a board-scoped
    // note POST is a contract violation.
    http.post(
      `/api/workspaces/${SLUG}/boards/:boardId/notes`,
      async ({ request }) => {
        await capture(request);
        return HttpResponse.json({}, { status: 201 });
      },
    ),
    http.post(`/api/workspaces/${SLUG}/members`, async ({ request }) => {
      const body = await capture(request);
      sim.members = [
        ...sim.members,
        {
          user_id: `u${sim.members.length + 1}`,
          email: String(body.email),
          name: "",
          role: String(body.role) as typeof ownerMember.role,
          joined_at: "2026-07-31T00:00:00Z",
        },
      ];
      return HttpResponse.json(sim.members[sim.members.length - 1], {
        status: 201,
      });
    }),
    http.post(`/api/workspaces/${SLUG}/channels`, async ({ request }) => {
      const body = await capture(request);
      sim.channelCount += 1;
      return HttpResponse.json(
        { id: "ch-1", workspace_id: "ws-1", ...body },
        { status: 201 },
      );
    }),
    http.post(
      `/api/workspaces/${SLUG}/boards/:boardId/git-repos`,
      async ({ request }) => {
        const body = await capture(request);
        sim.repos = [...sim.repos, { id: `repo-${sim.repos.length + 1}`, ...body }];
        return HttpResponse.json(sim.repos[sim.repos.length - 1], {
          status: 201,
        });
      },
    ),
  );

  return { sim, captured };
}

function requestsTo(captured: CapturedRequest[], method: string, path: string) {
  return captured.filter((r) => r.method === method && r.path === path);
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
  // Reduced motion: celebrations are pinned by the dedicated celebration
  // test — here we only care that content stays queryable.
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

// Content lives in a portaled modal, so form queries scope to the panel —
// NOT to the rail pill, which must never grow to hold it.
function modalEl() {
  return document.querySelector<HTMLElement>("[data-onboarding-modal]")!;
}

// The rail's pill is the trigger; the step's long title now lives inside the
// modal, so `title` is asserted there rather than clicked.
async function expandStep(
  user: ReturnType<typeof userEvent.setup>,
  container: HTMLElement,
  id: string,
  title: string,
) {
  const pill = stepEl(container, id);
  await user.click(within(pill).getByRole("button"));
  const panel = modalEl();
  expect(panel, `step "${id}" opened no modal`).not.toBeNull();
  expect(within(panel).getByText(title)).toBeInTheDocument();
  expect(pill.contains(panel)).toBe(false);
  return panel;
}

describe("OnboardingChecklist mini-forms — board cards", () => {
  it("creates cards in the seeded To Do column with append positions, no column POSTs", async () => {
    const { captured } = installSim();
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });
    const boardPanel = await expandStep(
      user,
      container,
      "board",
      "Keep track of what needs doing",
    );

    await user.type(
      within(boardPanel).getByPlaceholderText("Board name"),
      "Alpha",
    );
    await user.click(
      within(boardPanel).getByRole("button", { name: "Create board" }),
    );

    // The optional card inputs appear in the same popover once the board exists.
    await within(boardPanel).findByText("What's on your plate right now?");
    const cardInputs = within(boardPanel).getAllByPlaceholderText(
      "Something that needs doing",
    );
    expect(cardInputs.length).toBeGreaterThanOrEqual(2);
    expect(cardInputs.length).toBeLessThanOrEqual(3);

    // Fill first and last, leave the middle empty — the two cards actually
    // created must post in order. Ordering is the BACKEND's to assign (it
    // appends at max_position + 1024 and its CardCreate schema rejects a
    // client-sent `position`), so the contract here is the sequence of POSTs.
    await user.type(cardInputs[0]!, "Write the launch checklist");
    await user.type(cardInputs[cardInputs.length - 1]!, "Fix the login flake");
    await user.click(
      within(boardPanel).getByRole("button", { name: "Add cards" }),
    );

    await waitFor(() =>
      expect(
        requestsTo(captured, "POST", `/api/workspaces/${SLUG}/boards/b1/cards`),
      ).toHaveLength(2),
    );
    const cardPosts = requestsTo(
      captured,
      "POST",
      `/api/workspaces/${SLUG}/boards/b1/cards`,
    );
    expect(cardPosts[0]!.body).toMatchObject({
      title: "Write the launch checklist",
      column_id: "col-todo",
    });
    expect(cardPosts[1]!.body).toMatchObject({
      title: "Fix the login flake",
      column_id: "col-todo",
    });
    for (const post of cardPosts) {
      expect(post.body.card_type).toBeTruthy();
      expect(post.body.priority).toBeTruthy();
      expect(post.body).not.toHaveProperty("position");
    }
    // Columns come seeded from the backend — never created client-side.
    expect(
      requestsTo(
        captured,
        "POST",
        `/api/workspaces/${SLUG}/boards/b1/columns`,
      ),
    ).toHaveLength(0);
    // Still inside the wizard.
    expect(
      container.querySelector("[data-onboarding-checklist]"),
    ).not.toBeNull();
  });
});

describe("OnboardingChecklist mini-forms — project context", () => {
  it("saves the textarea as the board definition and flips the row to done", async () => {
    const { captured } = installSim({ boards: [boardAlpha] });
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Definition/ });
    const panel = await expandStep(
      user,
      container,
      "context",
      "Tell Backplane what you're working on",
    );
    const card = stepEl(container, "context");

    const textarea = within(panel).getByPlaceholderText(
      "What is this project about, and where should it end up?",
    );
    await user.type(textarea, "A billing portal for the finance team");
    await user.click(within(panel).getByRole("button", { name: "Save context" }));

    await waitFor(() =>
      expect(
        requestsTo(
          captured,
          "PUT",
          `/api/workspaces/${SLUG}/boards/b1/definitions`,
        ),
      ).toHaveLength(1),
    );
    const put = requestsTo(
      captured,
      "PUT",
      `/api/workspaces/${SLUG}/boards/b1/definitions`,
    )[0]!;
    const content = put.body.content as {
      objectives?: { text: string }[];
    };
    expect(content.objectives?.length).toBeGreaterThanOrEqual(1);
    expect(content.objectives![0]!.text).toContain(
      "A billing portal for the finance team",
    );

    // Round-trip: the definition invalidation refetches and the card flips.
    await waitFor(() =>
      expect(card.getAttribute("data-step-state")).toBe("done"),
    );
    expect(
      container.querySelector("[data-onboarding-checklist]"),
    ).not.toBeNull();
  });

  it("guides toward creating a board first when the workspace has none", async () => {
    installSim();
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Definition/ });
    const panel = await expandStep(
      user,
      container,
      "context",
      "Tell Backplane what you're working on",
    );

    expect(
      within(panel).getByText(
        "Create a board first — your project context lives on it.",
      ),
    ).toBeInTheDocument();
    expect(
      within(panel).queryByRole("button", { name: "Save context" }),
    ).toBeNull();
  });
});

describe("OnboardingChecklist mini-forms — notes", () => {
  it("creates a workspace-level note (no board required) and flips the row to done", async () => {
    const { captured } = installSim();
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Notes/ });
    const panel = await expandStep(
      user,
      container,
      "notes",
      "Keep what you know next to the work",
    );
    const card = stepEl(container, "notes");

    await user.type(
      within(panel).getByPlaceholderText("Note title"),
      "Deploy runbook",
    );
    await user.type(
      within(panel).getByPlaceholderText("What do you want to keep close?"),
      "Always check the active gcloud project before deploying.",
    );
    await user.click(within(panel).getByRole("button", { name: "Save note" }));

    await waitFor(() =>
      expect(
        requestsTo(captured, "POST", `/api/workspaces/${SLUG}/notes`),
      ).toHaveLength(1),
    );
    const post = requestsTo(
      captured,
      "POST",
      `/api/workspaces/${SLUG}/notes`,
    )[0]!;
    expect(post.body.title).toBe("Deploy runbook");
    expect(post.body.content).toContain(
      "Always check the active gcloud project before deploying.",
    );
    // Workspace-level, never board-scoped.
    expect(
      captured.filter(
        (r) => r.method === "POST" && /\/boards\/[^/]+\/notes$/.test(r.path),
      ),
    ).toHaveLength(0);

    // note_count is summary-derived: the wizard must refetch the summary
    // after creating the note so the card flips without a page refresh.
    await waitFor(() =>
      expect(card.getAttribute("data-step-state")).toBe("done"),
    );
  });
});

describe("OnboardingChecklist mini-forms — members", () => {
  it("adds teammates via email+role rows and flips to done at two members", async () => {
    const { captured } = installSim();
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Team/ });
    const panel = await expandStep(user, container, "members", "Bring your team in");
    const card = stepEl(container, "members");

    // Rail refactor: the pills carry no controls, so the members step's
    // explicit solo skip lives in the modal beside its form.
    expect(within(panel).getByText("Working solo for now")).toBeInTheDocument();
    // Each row pairs an email input with a role control.
    expect(
      within(panel).getAllByRole("combobox").length,
    ).toBeGreaterThanOrEqual(1);

    await user.type(
      within(panel).getAllByPlaceholderText("Email address")[0]!,
      "dana@acme.dev",
    );
    // A second email+role row can be added inline.
    await user.click(within(panel).getByText("Add another"));
    const emailInputs = within(panel).getAllByPlaceholderText("Email address");
    expect(emailInputs).toHaveLength(2);
    await user.type(emailInputs[1]!, "sam@acme.dev");

    await user.click(within(panel).getByRole("button", { name: "Add member" }));

    await waitFor(() =>
      expect(
        requestsTo(captured, "POST", `/api/workspaces/${SLUG}/members`),
      ).toHaveLength(2),
    );
    const posts = requestsTo(
      captured,
      "POST",
      `/api/workspaces/${SLUG}/members`,
    );
    expect(posts.map((p) => p.body.email)).toEqual([
      "dana@acme.dev",
      "sam@acme.dev",
    ]);
    for (const post of posts) {
      // Never invite at owner level from the wizard.
      expect(["admin", "member", "viewer"]).toContain(post.body.role);
    }

    await waitFor(() =>
      expect(card.getAttribute("data-step-state")).toBe("done"),
    );
  });
});

describe("OnboardingChecklist mini-forms — channels", () => {
  it("prefills the name with 'general' and creates the channel with a valid payload", async () => {
    const { captured } = installSim();
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Channel/ });
    const panel = await expandStep(
      user,
      container,
      "channels",
      "Give discussions a home",
    );
    const card = stepEl(container, "channels");

    const nameInput = within(panel).getByPlaceholderText(
      "Channel name",
    ) as HTMLInputElement;
    // Suggested default, ready to submit untouched.
    expect(nameInput.value).toBe("general");

    await user.click(
      within(panel).getByRole("button", { name: "Create channel" }),
    );

    await waitFor(() =>
      expect(
        requestsTo(captured, "POST", `/api/workspaces/${SLUG}/channels`),
      ).toHaveLength(1),
    );
    const post = requestsTo(
      captured,
      "POST",
      `/api/workspaces/${SLUG}/channels`,
    )[0]!;
    expect(post.body.name).toBe("general");
    // ChannelCreate requires both of these; the wizard picks quiet defaults.
    expect(CHANNEL_TYPES).toContain(post.body.channel_type);
    expect(typeof post.body.contact_value).toBe("string");

    // channel_count is summary-derived — same refetch obligation as notes.
    await waitFor(() =>
      expect(card.getAttribute("data-step-state")).toBe("done"),
    );
  });
});

describe("OnboardingChecklist mini-forms — git repos", () => {
  it("is marked optional and links a board-scoped repository", async () => {
    const { captured } = installSim({ boards: [boardAlpha] });
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Git/ });
    const panel = await expandStep(user, container, "repos", "Connect the code");
    const card = stepEl(container, "repos");

    // Rail refactor: the optional marker labels the step in the modal header,
    // beside its title — the pill has no room for it.
    expect(within(panel).getByText("Optional")).toBeInTheDocument();

    await user.type(
      within(panel).getByPlaceholderText("Repository URL"),
      "https://github.com/acme/alpha",
    );
    await user.type(
      within(panel).getByPlaceholderText("Repository name"),
      "alpha",
    );
    await user.click(
      within(panel).getByRole("button", { name: "Link repository" }),
    );

    await waitFor(() =>
      expect(
        requestsTo(
          captured,
          "POST",
          `/api/workspaces/${SLUG}/boards/b1/git-repos`,
        ),
      ).toHaveLength(1),
    );
    const post = requestsTo(
      captured,
      "POST",
      `/api/workspaces/${SLUG}/boards/b1/git-repos`,
    )[0]!;
    expect(post.body.name).toBe("alpha");
    expect(post.body.url).toBe("https://github.com/acme/alpha");
    expect(GIT_PROVIDERS).toContain(post.body.provider);

    await waitFor(() =>
      expect(card.getAttribute("data-step-state")).toBe("done"),
    );
  });

  it("guides toward creating a board first when the workspace has none", async () => {
    installSim();
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Git/ });
    const panel = await expandStep(user, container, "repos", "Connect the code");

    expect(
      within(panel).getByText(
        "Create a board first — repositories connect to it.",
      ),
    ).toBeInTheDocument();
    expect(
      within(panel).queryByRole("button", { name: "Link repository" }),
    ).toBeNull();
  });
});

// Rail refactor: a step's whole pill is its open affordance, and the step's
// title/intro/bullets moved into the modal the pill opens.
describe("OnboardingChecklist rail — open affordance", () => {
  it("opens a step's modal from its rail pill and closes it on Escape", async () => {
    installSim();
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });
    const pill = within(stepEl(container, "board")).getByRole("button");

    await user.click(pill);
    expect(
      within(modalEl()).getByPlaceholderText("Board name"),
    ).toBeInTheDocument();
    // The step's full title is the modal's headline, not the pill's label.
    expect(
      within(modalEl()).getByText("Keep track of what needs doing"),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        document.querySelector("[data-onboarding-modal]"),
      ).toBeNull(),
    );
  });

  // Replaces the grid's "hover cue only while closed" contract: the rail pill
  // keeps one hover treatment (an open modal is not a false affordance), so
  // what must stay honest is the state the pill reports.
  it("keeps the rail pill's state in sync while its modal is open", async () => {
    installSim();
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });
    const step = stepEl(container, "board");
    expect(step.getAttribute("data-step-state")).toBe("empty");

    await user.click(within(step).getByRole("button"));
    await user.type(
      within(modalEl()).getByPlaceholderText("Board name"),
      "Alpha",
    );
    await user.click(
      within(modalEl()).getByRole("button", { name: "Create board" }),
    );

    await waitFor(() =>
      expect(step.getAttribute("data-step-state")).toBe("done"),
    );
  });
});

// Owner feedback: submitting a mini-form gave NO feedback and left the fields
// filled, so the user could not tell whether anything happened — and could
// easily submit the same values twice. Every create-form now confirms in place
// and empties itself; the definition upsert confirms but KEEPS its text,
// because there the box holds the saved value rather than a consumed input.
describe("OnboardingChecklist mini-forms — submit feedback", () => {
  it("confirms and clears the channel form after a successful create", async () => {
    installSim();
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Channel/ });
    const panel = await expandStep(
      user,
      container,
      "channels",
      "Give discussions a home",
    );

    const input = within(panel).getByPlaceholderText("Channel name");
    expect(input).toHaveValue("general");
    await user.click(
      within(panel).getByRole("button", { name: "Create channel" }),
    );

    expect(
      await within(panel).findByText("Channel created."),
    ).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  it("confirms and clears the note form, then drops the note on further edits", async () => {
    installSim();
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Notes/ });
    const panel = await expandStep(
      user,
      container,
      "notes",
      "Keep what you know next to the work",
    );

    const title = within(panel).getByPlaceholderText("Note title");
    await user.type(title, "Kickoff decisions");
    await user.click(within(panel).getByRole("button", { name: "Save note" }));

    expect(
      await within(panel).findByText("Note saved to your workspace."),
    ).toBeInTheDocument();
    expect(title).toHaveValue("");

    // A stale confirmation must not sit above a fresh draft.
    await user.type(title, "Another note");
    await waitFor(() =>
      expect(
        within(panel).queryByText("Note saved to your workspace."),
      ).toBeNull(),
    );
  });

  it("confirms the definition save but keeps the text, since it is an upsert", async () => {
    installSim({ boards: [boardAlpha] });
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Definition/ });
    const panel = await expandStep(
      user,
      container,
      "context",
      "Tell Backplane what you're working on",
    );

    const textarea = within(panel).getByPlaceholderText(
      "What is this project about, and where should it end up?",
    );
    await user.type(textarea, "Ship the billing portal");
    await user.click(
      within(panel).getByRole("button", { name: "Save context" }),
    );

    expect(
      await within(panel).findByText("Project context saved."),
    ).toBeInTheDocument();
    // The saved definition stays on screen — clearing it would read as data loss.
    expect(textarea).toHaveValue("Ship the billing portal");
  });

  it("reports how many teammates were invited and clears the rows", async () => {
    installSim();
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Team/ });
    const panel = await expandStep(
      user,
      container,
      "members",
      "Bring your team in",
    );

    await user.type(
      within(panel).getByPlaceholderText("Email address"),
      "dana@acme.dev",
    );
    await user.click(within(panel).getByRole("button", { name: "Add member" }));

    expect(
      await within(panel).findByText("1 teammate invited."),
    ).toBeInTheDocument();
    expect(
      within(panel).getByPlaceholderText("Email address"),
    ).toHaveValue("");
  });

  it("confirms and clears the repository form", async () => {
    installSim({ boards: [boardAlpha] });
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Git/ });
    const panel = await expandStep(
      user,
      container,
      "repos",
      "Connect the code",
    );

    const url = within(panel).getByPlaceholderText("Repository URL");
    const name = within(panel).getByPlaceholderText("Repository name");
    await user.type(url, "https://github.com/acme/alpha");
    await user.type(name, "alpha");
    await user.click(
      within(panel).getByRole("button", { name: "Link repository" }),
    );

    expect(
      await within(panel).findByText("Repository linked to your board."),
    ).toBeInTheDocument();
    expect(url).toHaveValue("");
    expect(name).toHaveValue("");
  });
});
