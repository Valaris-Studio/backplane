// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import {
  renderWithProviders,
  screen,
  waitFor,
  userEvent,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { CreateWorkspaceDialog } from "../CreateWorkspaceDialog";

const createdWorkspace = {
  id: "ws-1",
  name: "Acme Corp",
  slug: "acme-corp",
  created_by: "user-1",
  created_at: "2026-09-29T00:00:00Z",
  updated_at: "2026-09-29T00:00:00Z",
};

function renderDialog() {
  const onOpenChange = vi.fn();
  const onCreated = vi.fn();
  renderWithProviders(
    <CreateWorkspaceDialog open onOpenChange={onOpenChange} onCreated={onCreated} />,
  );
  return { onOpenChange, onCreated };
}

describe("CreateWorkspaceDialog slug handling", () => {
  it("derives a valid slug from the name and submits it", async () => {
    let postedBody: unknown = null;
    server.use(
      http.post("/api/workspaces", async ({ request }) => {
        postedBody = await request.json();
        return HttpResponse.json(createdWorkspace, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    const { onCreated } = renderDialog();

    await user.type(screen.getByPlaceholderText("My Workspace"), "  Acme__Corp!! ");
    expect(screen.getByPlaceholderText("my-workspace")).toHaveValue("acme-corp");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("acme-corp"));
    expect(postedBody).toEqual({ name: "Acme__Corp!!", slug: "acme-corp" });
  });

  it("flags a hand-typed invalid slug and never submits it", async () => {
    let posts = 0;
    server.use(
      http.post("/api/workspaces", () => {
        posts += 1;
        return HttpResponse.json(createdWorkspace, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByPlaceholderText("My Workspace"), "Acme");
    const slugInput = screen.getByPlaceholderText("my-workspace");
    await user.clear(slugInput);
    await user.type(slugInput, "Bad Slug");

    expect(
      screen.getByText(/lowercase letters, numbers and single hyphens/i),
    ).toBeInTheDocument();
    expect(slugInput).toHaveAttribute("aria-invalid", "true");
    const createButton = screen.getByRole("button", { name: "Create" });
    expect(createButton).toBeDisabled();
    await user.click(createButton);
    expect(posts).toBe(0);
  });

  it("explains why Create is disabled when the name yields no slug", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByPlaceholderText("My Workspace"), "日本語");

    expect(screen.getByPlaceholderText("my-workspace")).toHaveValue("");
    expect(
      screen.getByText(/couldn't derive a url slug from this name/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("shows no empty-slug hint before a name is typed", () => {
    renderDialog();

    expect(
      screen.queryByText(/couldn't derive a url slug from this name/i),
    ).not.toBeInTheDocument();
  });

  it("surfaces a backend 422 inside the dialog and keeps it open", async () => {
    server.use(
      http.post("/api/workspaces", () =>
        HttpResponse.json(
          {
            detail: [{ loc: ["body", "slug"], msg: "bad slug" }],
            error_code: "request_validation_error",
            error_params: {},
          },
          { status: 422 },
        ),
      ),
    );
    const user = userEvent.setup();
    const { onOpenChange, onCreated } = renderDialog();

    await user.type(screen.getByPlaceholderText("My Workspace"), "Acme");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Some fields are invalid. Review them and try again.",
    );
    expect(onCreated).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("explains a taken slug on 409", async () => {
    server.use(
      http.post("/api/workspaces", () =>
        HttpResponse.json(
          {
            detail: "Workspace slug 'acme' is already taken",
            error_code: "conflict",
            error_params: {},
          },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByPlaceholderText("My Workspace"), "Acme");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /slug is already taken/i,
    );
  });
});
