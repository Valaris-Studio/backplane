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
import { ConnectionRow } from "../ConnectionRow";
import type { GitConnection } from "@/types/git";

const SLUG = "acme";

function makeConnection(overrides: Partial<GitConnection> = {}): GitConnection {
  return {
    id: "conn-1",
    workspace_id: "ws-1",
    provider: "github",
    account_login: "octocat",
    account_type: "user",
    auth_kind: "oauth",
    scopes: ["repo", "workflow"],
    expires_at: null,
    base_url: null,
    last_verified_at: null,
    last_error: null,
    scopes_confirmed: null,
    connected_by: "user-1",
    created_at: "2026-04-20T00:00:00Z",
    updated_at: "2026-04-20T00:00:00Z",
    ...overrides,
  };
}

describe("ConnectionRow", () => {
  it("explains the exact GitHub permissions before an unconfirmed PAT is verified", () => {
    renderWithProviders(
      <ConnectionRow slug={SLUG} isAdmin connection={makeConnection({
        auth_kind: "pat", scopes: [], scopes_confirmed: false,
      })} />,
    );
    const guidance = screen.getByRole("region", { name: /GitHub token permissions/i });
    expect(guidance).toHaveTextContent(/Pull requests.*Read and write/);
    expect(guidance).toHaveTextContent(/Contents.*Read and write/);
    expect(guidance).toHaveTextContent(/does not verify.*repository.*merge/i);
  });

  it("does not show GitHub token instructions for another provider", () => {
    renderWithProviders(
      <ConnectionRow slug={SLUG} isAdmin connection={makeConnection({
        provider: "gitlab", auth_kind: "pat", scopes: [], scopes_confirmed: false,
      })} />,
    );
    expect(screen.queryByRole("region", { name: /GitHub token permissions/i })).not.toBeInTheDocument();
  });

  it("renders the account login + scopes summary for an admin", () => {
    renderWithProviders(
      <ConnectionRow
        slug={SLUG}
        connection={makeConnection()}
        isAdmin
        resolveUserName={() => "Octo Cat"}
      />,
    );

    expect(screen.getByText("octocat")).toBeInTheDocument();
    expect(
      screen.getByText(/Repositories \+ Workflow actions/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Octo Cat/)).toBeInTheDocument();
  });

  it("hides the delete button entirely for non-admins", () => {
    renderWithProviders(
      <ConnectionRow
        slug={SLUG}
        connection={makeConnection()}
        isAdmin={false}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /disconnect/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the destructive delete control to admins", () => {
    renderWithProviders(
      <ConnectionRow slug={SLUG} connection={makeConnection()} isAdmin />,
    );

    expect(
      screen.getByRole("button", { name: /disconnect/i }),
    ).toBeInTheDocument();
  });
});

describe("ConnectionRow — auth kind badge", () => {
  it("labels an OAuth connection", () => {
    renderWithProviders(
      <ConnectionRow
        slug={SLUG}
        connection={makeConnection({ auth_kind: "oauth" })}
        isAdmin
      />,
    );
    expect(screen.getByText(/^OAuth$/i)).toBeInTheDocument();
  });

  it("labels a token connection", () => {
    renderWithProviders(
      <ConnectionRow
        slug={SLUG}
        connection={makeConnection({ auth_kind: "pat" })}
        isAdmin
      />,
    );
    expect(screen.getByText(/^Token$/i)).toBeInTheDocument();
  });
});

describe("ConnectionRow — health chip", () => {
  it("reads unverified when the connection has never been checked", () => {
    renderWithProviders(
      <ConnectionRow slug={SLUG} connection={makeConnection()} isAdmin />,
    );

    const chip = screen.getByTestId("connection-health-chip");
    expect(chip).toHaveTextContent(/not verified/i);
  });

  it("reads healthy once verified with no error", () => {
    renderWithProviders(
      <ConnectionRow
        slug={SLUG}
        connection={makeConnection({
          last_verified_at: "2026-08-09T10:00:00Z",
        })}
        isAdmin
      />,
    );

    const chip = screen.getByTestId("connection-health-chip");
    expect(chip).toHaveTextContent(/working/i);
  });

  it("reads failing and surfaces the stored error text", () => {
    renderWithProviders(
      <ConnectionRow
        slug={SLUG}
        connection={makeConnection({
          last_verified_at: "2026-08-09T10:00:00Z",
          last_error: "GitHub rejected this token (401).",
        })}
        isAdmin
      />,
    );

    expect(screen.getByTestId("connection-health-chip")).toHaveTextContent(
      /not working/i,
    );
    expect(
      screen.getByText(/GitHub rejected this token \(401\)\./),
    ).toBeInTheDocument();
  });

  it("prefers the failing state even when a verification timestamp exists", () => {
    // A credential that verified once and has failed since is broken NOW —
    // last_error must outrank last_verified_at or the chip lies.
    renderWithProviders(
      <ConnectionRow
        slug={SLUG}
        connection={makeConnection({
          last_verified_at: "2026-08-09T10:00:00Z",
          last_error: "boom",
        })}
        isAdmin
      />,
    );

    const chip = screen.getByTestId("connection-health-chip");
    expect(chip).toHaveTextContent(/not working/i);
    expect(chip.textContent?.trim()).not.toBe("Working");
  });

  it("warns when the token signed in but its permissions were never substantiated", () => {
    // The bug this state exists for: a GitHub fine-grained PAT discloses no
    // scopes, so an identity-only success used to render the same green chip
    // as a token that can actually push branches and merge PRs.
    renderWithProviders(
      <ConnectionRow
        slug={SLUG}
        connection={makeConnection({
          last_verified_at: "2026-08-09T10:00:00Z",
          scopes_confirmed: false,
        })}
        isAdmin
      />,
    );

    const chip = screen.getByTestId("connection-health-chip");
    expect(chip).toHaveTextContent(/permissions unconfirmed/i);
    expect(chip.textContent?.trim()).not.toBe("Working");
  });

  it("reads healthy when the probe substantiated every required scope", () => {
    renderWithProviders(
      <ConnectionRow
        slug={SLUG}
        connection={makeConnection({
          last_verified_at: "2026-08-09T10:00:00Z",
          scopes_confirmed: true,
        })}
        isAdmin
      />,
    );

    expect(screen.getByTestId("connection-health-chip")).toHaveTextContent(
      /working/i,
    );
  });

  it("keeps a never-assessed legacy row on its identity verdict", () => {
    // scopes_confirmed null means no probe ever looked, which is not the same
    // claim as "we looked and could not confirm" — it must not warn.
    renderWithProviders(
      <ConnectionRow
        slug={SLUG}
        connection={makeConnection({
          last_verified_at: "2026-08-09T10:00:00Z",
          scopes_confirmed: null,
        })}
        isAdmin
      />,
    );

    const chip = screen.getByTestId("connection-health-chip");
    expect(chip).toHaveTextContent(/working/i);
    expect(chip).not.toHaveTextContent(/permissions unconfirmed/i);
  });

  it("prefers the failing state over unconfirmed permissions", () => {
    // A dead credential outranks an unproven one: the operator's next action
    // is to replace the token either way, and "not working" is the louder truth.
    renderWithProviders(
      <ConnectionRow
        slug={SLUG}
        connection={makeConnection({
          last_verified_at: "2026-08-09T10:00:00Z",
          last_error: "GitHub rejected this token (401).",
          scopes_confirmed: false,
        })}
        isAdmin
      />,
    );

    expect(screen.getByTestId("connection-health-chip")).toHaveTextContent(
      /not working/i,
    );
  });

  it("warns on an unconfirmed row that has never been verified at all", () => {
    // The PAT add path writes the verdict without setting a verify click,
    // so unconfirmed must not need last_verified_at to show.
    renderWithProviders(
      <ConnectionRow
        slug={SLUG}
        connection={makeConnection({ scopes_confirmed: false })}
        isAdmin
      />,
    );

    expect(screen.getByTestId("connection-health-chip")).toHaveTextContent(
      /permissions unconfirmed/i,
    );
  });
});

describe("ConnectionRow — verify", () => {
  it("renders each returned check with its guidance", async () => {
    server.use(
      http.post(
        `/api/workspaces/${SLUG}/git-connections/conn-1/verify`,
        () =>
          HttpResponse.json({
            connection: makeConnection({
              last_verified_at: "2026-08-09T10:00:00Z",
            }),
            checks: [
              {
                name: "identity",
                ok: true,
                guidance: "Authenticated as 'octocat' (user).",
              },
              {
                name: "scope:repo",
                ok: false,
                guidance: "Missing 'repo' scope. Re-issue the token with it.",
              },
            ],
          }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <ConnectionRow slug={SLUG} connection={makeConnection()} isAdmin />,
    );

    await user.click(screen.getByRole("button", { name: /verify/i }));

    await waitFor(() =>
      expect(screen.getByText(/Authenticated as 'octocat'/)).toBeInTheDocument(),
    );
    // Failed checks show the backend's guidance verbatim — it names the fix.
    expect(
      screen.getByText(/Missing 'repo' scope\. Re-issue the token with it\./),
    ).toBeInTheDocument();
    // Check labels are translated, never raw keys like "scope:repo".
    expect(screen.getByText(/required scope: repo/i)).toBeInTheDocument();
    expect(screen.queryByText(/^scope:repo$/)).not.toBeInTheDocument();
    const checks = screen.getAllByTestId("connection-check");
    expect(checks).toHaveLength(2);
    expect(checks[0]).toHaveAttribute("data-ok", "true");
    expect(checks[1]).toHaveAttribute("data-ok", "false");
  });

  it("shows the verify control disabled for non-admins", () => {
    // Visible-but-disabled, matching the Add token / Connect GitHub CTAs:
    // members should see what exists and learn it's an admin action, not
    // wonder whether verification is possible at all.
    renderWithProviders(
      <ConnectionRow
        slug={SLUG}
        connection={makeConnection()}
        isAdmin={false}
      />,
    );
    expect(screen.getByRole("button", { name: /verify/i })).toBeDisabled();
  });
});
