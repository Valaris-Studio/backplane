// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse, server } from "@/test/msw-server";
import {
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
  within,
} from "@/test/test-utils";
import { AddTokenConnectionDialog } from "../AddTokenConnectionDialog";

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMocks }));

beforeEach(() => {
  toastMocks.success.mockClear();
  toastMocks.info.mockClear();
  toastMocks.error.mockClear();
});

const SLUG = "acme";

// DialogContent enters via a GSAP autoAlpha tween, so on the first frame the
// panel is still `visibility: hidden` and role queries (which respect
// visibility) can't see it. Await one visible control before asserting.
async function renderDialog(onOpenChange: (open: boolean) => void = () => {}) {
  const result = renderWithProviders(
    <AddTokenConnectionDialog slug={SLUG} open onOpenChange={onOpenChange} />,
  );
  await screen.findByRole("button", { name: /connect account/i });
  return result;
}

// Scoped to form controls: DialogContent is itself an aria-labelledby'd element
// named after its title ("Connect with an access token"), and getByLabelText
// matches any labelled element, not just fields — so an unscoped query is
// ambiguous here.
function tokenField() {
  return screen.getByLabelText(/access token/i, {
    selector: "input, textarea",
  });
}

function submitButton() {
  return screen.getByRole("button", { name: /connect account/i });
}

function providerSelect() {
  return screen.getByRole("button", { name: /provider/i });
}

describe("AddTokenConnectionDialog — validation", () => {
  it("keeps submit disabled until a token is pasted", async () => {
    const user = userEvent.setup();
    await renderDialog();

    const submit = submitButton();
    expect(submit).toBeDisabled();

    await user.type(tokenField(), "ghp_abc123");
    expect(submit).toBeEnabled();
  });

  it("never renders the token back as readable text", async () => {
    const user = userEvent.setup();
    await renderDialog();

    await user.type(tokenField(), "ghp_supersecret");

    // password-type input: the value exists but the browser never shows it,
    // and no other node in the dialog echoes it.
    expect(tokenField()).toHaveAttribute("type", "password");
    expect(screen.queryByText(/ghp_supersecret/)).not.toBeInTheDocument();
  });

  it("requires a base URL before gitea can be submitted", async () => {
    const user = userEvent.setup();
    await renderDialog();

    await user.type(tokenField(), "gt_abc123");
    await user.click(providerSelect());
    await user.click(screen.getByRole("option", { name: /gitea/i }));

    const submit = submitButton();
    expect(submit).toBeDisabled();

    await user.type(
      screen.getByLabelText(/server url/i),
      "https://git.acme.dev",
    );
    expect(submit).toBeEnabled();
  });

  it("rejects a base URL that is not http(s) before calling the API", async () => {
    const user = userEvent.setup();
    await renderDialog();

    await user.type(tokenField(), "gt_abc123");
    await user.click(providerSelect());
    await user.click(screen.getByRole("option", { name: /gitea/i }));
    await user.type(screen.getByLabelText(/server url/i), "git.acme.dev");

    expect(
      submitButton(),
    ).toBeDisabled();
  });

  it("blocks bitbucket with an explanation instead of a failed request", async () => {
    const user = userEvent.setup();
    await renderDialog();

    await user.type(tokenField(), "bb_abc123");
    await user.click(providerSelect());
    await user.click(screen.getByRole("option", { name: /bitbucket/i }));

    expect(
      submitButton(),
    ).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/bitbucket/i);
  });
});

describe("AddTokenConnectionDialog — scope guidance", () => {
  it("teaches the GitHub fine-grained permissions by name", async () => {
    await renderDialog();

    const guidance = screen.getByTestId("pat-scope-guidance");
    expect(guidance).toHaveTextContent(/Contents/i);
    expect(guidance).toHaveTextContent(/Pull requests/i);
    expect(guidance).toHaveTextContent(/Actions/i);
    expect(guidance).toHaveTextContent(/Commit statuses/i);
    const permissions = screen.getByRole("region", { name: /GitHub token permissions/i });
    expect(within(permissions).getByText(/Pull requests.*Read and write/)).toBeVisible();
    expect(within(permissions).getByText(/Contents.*Read and write/)).toBeVisible();
    expect(within(permissions).getAllByRole("listitem")).toHaveLength(4);
    expect(permissions.compareDocumentPosition(tokenField()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tokenField()).toHaveAccessibleDescription(/Pull requests/);
    expect(permissions).toHaveTextContent(/does not verify.*repository.*merge/i);
    expect(permissions).toHaveTextContent(/resource owner/i);
    expect(permissions).toHaveTextContent(/repositories/i);
    expect(screen.queryByText(/a token that cannot do the job is refused/i)).not.toBeInTheDocument();
  });

  it("swaps guidance when the provider changes", async () => {
    const user = userEvent.setup();
    await renderDialog();

    await user.click(providerSelect());
    await user.click(screen.getByRole("option", { name: /gitlab/i }));

    expect(screen.getByTestId("pat-scope-guidance")).toHaveTextContent(/api/i);
    expect(screen.queryByRole("region", { name: /GitHub token permissions/i })).not.toBeInTheDocument();
  });
});

describe("AddTokenConnectionDialog — submission", () => {
  it("posts the token and closes on success", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`/api/workspaces/${SLUG}/git-connections`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(
          {
            id: "conn-1",
            workspace_id: "ws-1",
            provider: "github",
            account_login: "deploy-bot",
            account_type: "user",
            auth_kind: "pat",
            scopes: [],
            expires_at: null,
            base_url: null,
            last_verified_at: "2026-08-09T10:00:00Z",
            last_error: null,
            connected_by: "user-1",
            created_at: "2026-08-09T10:00:00Z",
            updated_at: "2026-08-09T10:00:00Z",
          },
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    let closed = false;
    await renderDialog((open: boolean) => {
      if (open === false) closed = true;
    });

    await user.type(tokenField(), "ghp_abc123");
    await user.click(submitButton());

    await waitFor(() => expect(closed).toBe(true));
    expect(bodies[0]).toEqual({ provider: "github", token: "ghp_abc123" });
    expect(toastMocks.success).toHaveBeenCalledWith(
      expect.stringContaining("deploy-bot"),
    );
    expect(toastMocks.info).not.toHaveBeenCalled();
  });

  it("announces a replaced token when the account was already connected", async () => {
    // Re-pasting a token for an already-connected account upserts in place
    // (backend answers 200, not 201) — the documented rotation path. Silence
    // here once let an under-scoped token replace a full-scope one with no
    // hint anything changed; the toast is what makes rotation observable.
    server.use(
      http.post(`/api/workspaces/${SLUG}/git-connections`, () =>
        HttpResponse.json(
          {
            id: "conn-1",
            workspace_id: "ws-1",
            provider: "github",
            account_login: "deploy-bot",
            account_type: "user",
            auth_kind: "pat",
            scopes: [],
            expires_at: null,
            base_url: null,
            last_verified_at: "2026-08-10T10:00:00Z",
            last_error: null,
            connected_by: "user-1",
            created_at: "2026-08-09T10:00:00Z",
            updated_at: "2026-08-10T10:00:00Z",
          },
          { status: 200 },
        ),
      ),
    );
    const user = userEvent.setup();
    let closed = false;
    await renderDialog((open: boolean) => {
      if (open === false) closed = true;
    });

    await user.type(tokenField(), "ghp_rotated");
    await user.click(submitButton());

    await waitFor(() => expect(closed).toBe(true));
    expect(toastMocks.info).toHaveBeenCalledWith(
      expect.stringContaining("deploy-bot"),
    );
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it("shows the 422 detail inline and keeps the dialog open", async () => {
    server.use(
      http.post(`/api/workspaces/${SLUG}/git-connections`, () =>
        HttpResponse.json(
          {
            detail:
              "GitHub rejected this token (401). Check that it has not expired.",
          },
          { status: 422 },
        ),
      ),
    );
    const user = userEvent.setup();
    let closed = false;
    await renderDialog((open: boolean) => {
      if (open === false) closed = true;
    });

    await user.type(tokenField(), "ghp_bad");
    await user.click(submitButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/GitHub rejected this token/i);
    expect(closed).toBe(false);
    // The failed token stays in the field so the operator can correct it, but
    // it is still never rendered as text.
    expect(screen.queryByText(/ghp_bad/)).not.toBeInTheDocument();
  });
});
