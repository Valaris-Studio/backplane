// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { Routes, Route } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
} from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { PromptConfigPage } from "../PromptConfigPage";

const SLUG = "test-ws";

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: toastMocks.success,
    error: toastMocks.error,
  },
}));

function registerBaselineHandlers() {
  server.use(
    http.get(`/api/workspaces/${SLUG}/config`, () =>
      HttpResponse.json({
        max_rework_attempts: 3,
        card_cooldown_hours: 1,
        commit_message_template: "",
        pr_description_template: "",
        pipeline_config: { version: 1, stages: [] },
        version: 1,
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/prompt-configs/defaults`, () =>
      HttpResponse.json([]),
    ),
    http.get(`/api/workspaces/${SLUG}/prompt-configs`, () =>
      HttpResponse.json([]),
    ),
  );
}

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/agents/prompts" element={<PromptConfigPage />} />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/agents/prompts`] } },
  );
}

describe("PromptConfigPage — Create New Stage bypass", () => {
  it("renders a Create New Stage button", async () => {
    registerBaselineHandlers();
    renderPage();

    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: /Create New Stage/i }).find((el) => el.tagName === "BUTTON") as HTMLElement,
      ).toBeInTheDocument();
    });
  });

  it("opens a dialog with role, stage, and content fields on click", async () => {
    registerBaselineHandlers();
    renderPage();
    const user = userEvent.setup();

    const openButton = (await screen.findAllByRole("button", {
      name: /Create New Stage/i,
    })).find((el) => el.tagName === "BUTTON") as HTMLElement;
    await user.click(openButton);

    await waitFor(() => {
      expect(screen.getByTestId("create-stage-role")).toBeInTheDocument();
    });
    expect(screen.getByTestId("create-stage-stage")).toBeInTheDocument();
    expect(screen.getByTestId("create-stage-content")).toBeInTheDocument();

    const createSubmit = screen.getByTestId("create-stage-submit");
    expect(createSubmit).toBeDisabled();
  });

  it("enables Create button when all three fields are filled", async () => {
    registerBaselineHandlers();
    renderPage();
    const user = userEvent.setup();

    await user.click(
      (await screen.findAllByRole("button", { name: /Create New Stage/i })).find((el) => el.tagName === "BUTTON") as HTMLElement,
    );

    const roleInput = await screen.findByTestId("create-stage-role");
    const stageInput = screen.getByTestId("create-stage-stage");
    const contentInput = screen.getByTestId("create-stage-content");

    await user.type(roleInput, "security-auditor");
    await user.type(stageInput, "security_review");
    await user.type(contentInput, "Test content");

    await waitFor(() => {
      expect(screen.getByTestId("create-stage-submit")).toBeEnabled();
    });
  });

  it("calls POST /prompt-configs with slugified role-stage on submit", async () => {
    registerBaselineHandlers();

    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.post(`/api/workspaces/${SLUG}/prompt-configs`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            id: "cfg-1",
            name: capturedBody.name,
            slug: capturedBody.slug,
            agent_type: null,
            team_role: capturedBody.team_role,
            stage: capturedBody.stage,
            content: capturedBody.content,
            is_system: false,
            workspace_id: "ws-1",
            team_id: null,
            version: 1,
            created_by_id: "user-1",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          { status: 201 },
        );
      }),
    );

    renderPage();
    const user = userEvent.setup();

    await user.click(
      (await screen.findAllByRole("button", { name: /Create New Stage/i })).find((el) => el.tagName === "BUTTON") as HTMLElement,
    );

    await user.type(
      await screen.findByTestId("create-stage-role"),
      "security-auditor",
    );
    await user.type(
      screen.getByTestId("create-stage-stage"),
      "security_review",
    );
    await user.type(screen.getByTestId("create-stage-content"), "Test content");

    await user.click(screen.getByTestId("create-stage-submit"));

    await waitFor(() => {
      expect(capturedBody).not.toBeNull();
    });
    expect(capturedBody).toMatchObject({
      team_role: "security-auditor",
      stage: "security_review",
      slug: "security-auditor-security_review",
      content: "Test content",
      name: "security_review",
    });
  });

  it("closes the dialog and shows success toast on successful create", async () => {
    registerBaselineHandlers();
    server.use(
      http.post(`/api/workspaces/${SLUG}/prompt-configs`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            id: "cfg-1",
            name: body.name,
            slug: body.slug,
            agent_type: null,
            team_role: body.team_role,
            stage: body.stage,
            content: body.content,
            is_system: false,
            workspace_id: "ws-1",
            team_id: null,
            version: 1,
            created_by_id: "user-1",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          { status: 201 },
        );
      }),
    );

    toastMocks.success.mockClear();
    renderPage();
    const user = userEvent.setup();

    await user.click(
      (await screen.findAllByRole("button", { name: /Create New Stage/i })).find((el) => el.tagName === "BUTTON") as HTMLElement,
    );
    await user.type(
      await screen.findByTestId("create-stage-role"),
      "security-auditor",
    );
    await user.type(
      screen.getByTestId("create-stage-stage"),
      "security_review",
    );
    await user.type(screen.getByTestId("create-stage-content"), "Test content");
    await user.click(screen.getByTestId("create-stage-submit"));

    await waitFor(() => {
      expect(screen.queryByTestId("create-stage-role")).not.toBeInTheDocument();
    });
    expect(toastMocks.success).toHaveBeenCalledWith("Prompt saved");
  });

  it("keeps the dialog open and shows error toast on failed create", async () => {
    registerBaselineHandlers();
    server.use(
      http.post(`/api/workspaces/${SLUG}/prompt-configs`, () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );

    toastMocks.error.mockClear();
    renderPage();
    const user = userEvent.setup();

    await user.click(
      (await screen.findAllByRole("button", { name: /Create New Stage/i })).find((el) => el.tagName === "BUTTON") as HTMLElement,
    );
    await user.type(
      await screen.findByTestId("create-stage-role"),
      "security-auditor",
    );
    await user.type(
      screen.getByTestId("create-stage-stage"),
      "security_review",
    );
    await user.type(screen.getByTestId("create-stage-content"), "Test content");
    await user.click(screen.getByTestId("create-stage-submit"));

    await waitFor(() => {
      expect(toastMocks.error).toHaveBeenCalledWith("Failed to save prompt");
    });
    expect(screen.getByTestId("create-stage-role")).toBeInTheDocument();
  });
});
