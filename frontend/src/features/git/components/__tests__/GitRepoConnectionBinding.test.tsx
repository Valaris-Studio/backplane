// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { http, HttpResponse, server } from "@/test/msw-server";
import {
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
} from "@/test/test-utils";
import { CreateGitRepoDialog } from "../CreateGitRepoDialog";
import { GitRepoEditor } from "../GitRepoEditor";
import type { GitConnection, GitRepo } from "@/types/git";

const SLUG = "acme";
const BOARD_ID = "board-1";

function makeConnection(overrides: Partial<GitConnection> = {}): GitConnection {
  return {
    id: "conn-gh",
    workspace_id: "ws-1",
    provider: "github",
    account_login: "octocat",
    account_type: "user",
    auth_kind: "pat",
    scopes: [],
    expires_at: null,
    base_url: null,
    last_verified_at: "2026-08-09T10:00:00Z",
    last_error: null,
    scopes_confirmed: null,
    connected_by: "user-1",
    created_at: "2026-08-09T10:00:00Z",
    updated_at: "2026-08-09T10:00:00Z",
    ...overrides,
  };
}

function makeRepo(overrides: Partial<GitRepo> = {}): GitRepo {
  return {
    id: "repo-1",
    slug: "widgets",
    board_id: BOARD_ID,
    workspace_id: "ws-1",
    name: "widgets",
    url: "https://github.com/octocat/widgets",
    provider: "github",
    default_branch: "main",
    integration_branch: null,
    connection_id: null,
    description: "",
    added_by: "user-1",
    created_at: "2026-08-09T10:00:00Z",
    updated_at: "2026-08-09T10:00:00Z",
    ...overrides,
  };
}

function serveConnections(connections: GitConnection[]) {
  server.use(
    http.get(`/api/workspaces/${SLUG}/git-connections`, () =>
      HttpResponse.json(connections),
    ),
  );
}

describe("CreateGitRepoDialog — connection binding", () => {
  it("persists the picked connection into the create payload", async () => {
    const bodies: Record<string, unknown>[] = [];
    serveConnections([makeConnection()]);
    server.use(
      http.get(
        `/api/workspaces/${SLUG}/git-connections/conn-gh/repositories`,
        () =>
          HttpResponse.json({
            items: [
              {
                provider: "github",
                id: "octocat/widgets",
                full_name: "octocat/widgets",
                default_branch: "trunk",
                private: true,
                clone_url_https: "https://github.com/octocat/widgets.git",
                updated_at: "2026-08-09T10:00:00Z",
              },
            ],
            next_cursor: null,
          }),
      ),
      http.post(
        `/api/workspaces/${SLUG}/boards/${BOARD_ID}/git-repos`,
        async ({ request }) => {
          bodies.push((await request.json()) as Record<string, unknown>);
          return HttpResponse.json(makeRepo(), { status: 201 });
        },
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <CreateGitRepoDialog
        slug={SLUG}
        boardId={BOARD_ID}
        open
        onOpenChange={() => {}}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /pick a repository/i }));
    await user.click(await screen.findByText("octocat/widgets"));

    await waitFor(() =>
      expect(screen.getByDisplayValue("widgets")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /add repository/i }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    // The picked account is the credential that can actually reach this repo —
    // discarding it was the pre-existing bug.
    expect(bodies[0]?.connection_id).toBe("conn-gh");
    expect(bodies[0]?.url).toBe("https://github.com/octocat/widgets");
  });

  it("offers connections matching the selected provider, not just github", async () => {
    serveConnections([
      makeConnection(),
      makeConnection({ id: "conn-gh2", account_login: "hubot" }),
      makeConnection({
        id: "conn-gl",
        provider: "gitlab",
        account_login: "gl-bot",
      }),
    ]);
    const user = userEvent.setup();
    renderWithProviders(
      <CreateGitRepoDialog
        slug={SLUG}
        boardId={BOARD_ID}
        open
        onOpenChange={() => {}}
      />,
    );

    // Provider starts at github — only the two github accounts are offered.
    await user.click(
      await screen.findByRole("button", { name: /choose an account/i }),
    );
    expect(screen.getByRole("option", { name: /octocat/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /hubot/ })).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /gl-bot/ }),
    ).not.toBeInTheDocument();
  });

  it("swaps the offered accounts when the provider changes to gitlab", async () => {
    serveConnections([
      makeConnection(),
      makeConnection({
        id: "conn-gl",
        provider: "gitlab",
        account_login: "gl-bot",
      }),
      makeConnection({
        id: "conn-gl2",
        provider: "gitlab",
        account_login: "gl-deploy",
      }),
    ]);
    const user = userEvent.setup();
    renderWithProviders(
      <CreateGitRepoDialog
        slug={SLUG}
        boardId={BOARD_ID}
        open
        onOpenChange={() => {}}
      />,
    );

    // Wait out the dialog's entrance tween before role queries can see it.
    await screen.findByRole("button", { name: /add repository/i });
    // The provider help icon shares the label, so pick the listbox trigger.
    const providerTrigger = screen
      .getAllByRole("button", { name: /select provider/i })
      .find((el) => el.getAttribute("aria-haspopup") === "listbox");
    await user.click(providerTrigger!);
    await user.click(screen.getByRole("option", { name: /^GitLab$/ }));

    await user.click(
      await screen.findByRole("button", { name: /choose an account/i }),
    );
    expect(screen.getByRole("option", { name: /gl-bot/ })).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /octocat/ }),
    ).not.toBeInTheDocument();
  });
});

describe("GitRepoEditor — connection binding", () => {
  it("sends the selected connection id on save", async () => {
    const bodies: Record<string, unknown>[] = [];
    serveConnections([makeConnection()]);
    server.use(
      http.put(
        `/api/workspaces/${SLUG}/boards/${BOARD_ID}/git-repos/repo-1`,
        async ({ request }) => {
          bodies.push((await request.json()) as Record<string, unknown>);
          return HttpResponse.json(makeRepo({ connection_id: "conn-gh" }));
        },
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <GitRepoEditor
        repo={makeRepo()}
        slug={SLUG}
        boardId={BOARD_ID}
        open
        onOpenChange={() => {}}
        isAdmin
      />,
    );

    await user.click(await screen.findByRole("button", { name: /credential/i }));
    await user.click(await screen.findByRole("option", { name: /octocat/ }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]?.connection_id).toBe("conn-gh");
  });

  it("sends an explicit null when the binding is cleared", async () => {
    const bodies: Record<string, unknown>[] = [];
    serveConnections([makeConnection()]);
    server.use(
      http.put(
        `/api/workspaces/${SLUG}/boards/${BOARD_ID}/git-repos/repo-1`,
        async ({ request }) => {
          bodies.push((await request.json()) as Record<string, unknown>);
          return HttpResponse.json(makeRepo());
        },
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <GitRepoEditor
        repo={makeRepo({ connection_id: "conn-gh" })}
        slug={SLUG}
        boardId={BOARD_ID}
        open
        onOpenChange={() => {}}
        isAdmin
      />,
    );

    await user.click(await screen.findByRole("button", { name: /credential/i }));
    await user.click(await screen.findByRole("option", { name: /platform default/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    // Explicit null, not an omitted key: the backend patches with
    // exclude_unset, so omitting it would silently keep the old binding.
    expect(bodies[0]).toHaveProperty("connection_id", null);
  });

  it("disables the credential picker for non-admins", async () => {
    serveConnections([makeConnection()]);
    renderWithProviders(
      <GitRepoEditor
        repo={makeRepo()}
        slug={SLUG}
        boardId={BOARD_ID}
        open
        onOpenChange={() => {}}
        isAdmin={false}
      />,
    );

    expect(
      await screen.findByRole("button", { name: /credential/i }),
    ).toBeDisabled();
  });
});
