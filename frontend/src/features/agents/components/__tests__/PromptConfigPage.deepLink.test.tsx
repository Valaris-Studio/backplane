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

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
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

function renderPage(initialEntries: string[]) {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/agents/prompts" element={<PromptConfigPage />} />
    </Routes>,
    { routerProps: { initialEntries } },
  );
}

describe("PromptConfigPage — deep link from skipped execution", () => {
  it("opens the create dialog with role and stage prefilled from query params", async () => {
    registerBaselineHandlers();
    renderPage([`/${SLUG}/agents/prompts?role=security-auditor&stage=security_review`]);

    await waitFor(() => {
      expect(screen.getByTestId("create-stage-role")).toBeInTheDocument();
    });
    expect(screen.getByTestId("create-stage-role")).toHaveValue("security-auditor");
    expect(screen.getByTestId("create-stage-stage")).toHaveValue("security_review");
  });

  it("does not open the dialog when query params are absent", async () => {
    registerBaselineHandlers();
    renderPage([`/${SLUG}/agents/prompts`]);

    await waitFor(() => {
      expect(
        screen
          .getAllByRole("button", { name: /Create New Stage/i })
          .some((el) => el.tagName === "BUTTON"),
      ).toBe(true);
    });
    expect(screen.queryByTestId("create-stage-role")).not.toBeInTheDocument();
  });

  it("does not reopen the dialog after the user closes it with params still in url", async () => {
    registerBaselineHandlers();
    renderPage([`/${SLUG}/agents/prompts?role=security-auditor&stage=security_review`]);
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByTestId("create-stage-role")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Cancel/i }));

    await waitFor(() => {
      expect(screen.queryByTestId("create-stage-role")).not.toBeInTheDocument();
    });
  });

  it("role-only param filters the panel to that role without opening the create dialog", async () => {
    // The "Edit prompt" link on an existing (custom or default) prompt sends
    // role-only: land on the role's prompt list to edit, not on a create form
    // that would duplicate the stage.
    registerBaselineHandlers();
    renderPage([`/${SLUG}/agents/prompts?role=security-auditor`]);

    await waitFor(() => {
      expect(screen.getByTestId("role-prompts-empty")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("create-stage-role")).not.toBeInTheDocument();
  });

  it("preserves any user-defined role/stage string verbatim", async () => {
    registerBaselineHandlers();
    renderPage([`/${SLUG}/agents/prompts?role=My%20Custom%20Role&stage=Weird.Stage_1`]);

    await waitFor(() => {
      expect(screen.getByTestId("create-stage-role")).toHaveValue("My Custom Role");
    });
    expect(screen.getByTestId("create-stage-stage")).toHaveValue("Weird.Stage_1");
  });
});
