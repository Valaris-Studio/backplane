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

function registerHandlersWithOneStage() {
  server.use(
    http.get(`/api/workspaces/${SLUG}/config`, () =>
      HttpResponse.json({
        max_rework_attempts: 3,
        card_cooldown_hours: 1,
        commit_message_template: "",
        pr_description_template: "",
        pipeline_config: {
          version: 1,
          stages: [{ role: "implementer", llm: { stage: "implement" } }],
        },
        version: 1,
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/prompt-configs/defaults`, () =>
      HttpResponse.json([
        {
          role: "implementer",
          stage: "implement",
          slug: "implementer-implement",
          description: "Write the code.",
          default_content: "Implement the card {{.CardID}}",
          template_variables: ["CardID", "Title", "ProjectDirectives"],
        },
      ]),
    ),
    http.get(`/api/workspaces/${SLUG}/prompt-configs`, () =>
      HttpResponse.json([]),
    ),
  );
}

function renderPage(initialEntries: string[] = [`/${SLUG}/agents/prompts`]) {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/agents/prompts" element={<PromptConfigPage />} />
    </Routes>,
    { routerProps: { initialEntries } },
  );
}

// RichTooltip wraps its children in an outer <span role="button" aria-haspopup="dialog">.
// Queries against the inner label-bearing button return multiple matches, so we
// target the wrapping trigger via its aria-haspopup attribute.
function wrapperOf(inner: HTMLElement): HTMLElement {
  let node: HTMLElement | null = inner.parentElement;
  while (node) {
    if (node.getAttribute("aria-haspopup") === "dialog") return node;
    node = node.parentElement;
  }
  throw new Error("no RichTooltip wrapper found around element");
}

describe("PromptConfigPage — tooltips", () => {
  it("wraps the Create New Stage button in a RichTooltip trigger", async () => {
    registerHandlersWithOneStage();
    renderPage();

    const createText = await screen.findByText(/Create New Stage/i, {
      selector: "button *,button",
    });
    const innerBtn = createText.closest("button") as HTMLElement;
    const wrapper = wrapperOf(innerBtn);
    expect(wrapper).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("shows the Create New Stage tooltip summary on hover", async () => {
    registerHandlersWithOneStage();
    renderPage();
    const user = userEvent.setup();

    const createLabel = await screen.findByText(/Create New Stage/i, {
      selector: "button *,button",
    });
    const innerBtn = createLabel.closest("button") as HTMLElement;
    await user.hover(wrapperOf(innerBtn));

    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent(
        /pair that does not yet appear/i,
      );
    });
  });

  it("opens the editor tooltip with the textarea callout on hover", async () => {
    registerHandlersWithOneStage();
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByText("implement"));
    // The button is wrapped in a RichTooltip trigger (also role="button"), so
    // target the real <button> by its label text to avoid the ambiguous match.
    const overrideLabel = await screen.findByText(/Create Custom Override/i);
    await user.click(overrideLabel.closest("button") as HTMLElement);

    const textarea = await screen.findByPlaceholderText(
      /Enter your custom prompt/i,
    );
    await user.hover(wrapperOf(textarea));

    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent(/Plain textarea/i);
    });
  });

  it("opens the template-variables tooltip with every variable listed as a row", async () => {
    registerHandlersWithOneStage();
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByText("implement"));

    const label = await screen.findByText(/Template Variables/i);
    await user.click(wrapperOf(label));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("{{.CardID}}");
    expect(dialog).toHaveTextContent("{{.Title}}");
    expect(dialog).toHaveTextContent("{{.ProjectDirectives}}");
    expect(dialog).toHaveTextContent("{{.ReviewHistory}}");
    expect(dialog).toHaveTextContent("{{.ActionPlan}}");
    expect(dialog).toHaveTextContent("{{.WorkspaceSlug}}");
    expect(dialog).toHaveTextContent("{{.BoardID}}");
    expect(dialog).toHaveTextContent("{{.ExecutionID}}");
  });

  it("opens the stage-list tooltip modal from the Default badge", async () => {
    registerHandlersWithOneStage();
    renderPage();
    const user = userEvent.setup();

    const badge = await screen.findByText(/^Default$/);
    await user.click(wrapperOf(badge));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/platform-shipped prompt/i);
    expect(dialog).toHaveTextContent(/Custom vN/);
  });

  it("opens the deep-link hint tooltip from the stage hint text", async () => {
    registerHandlersWithOneStage();
    renderPage(
      [`/${SLUG}/agents/prompts?role=security-auditor&stage=security_review`],
    );
    const user = userEvent.setup();

    // The create dialog auto-opens from the deep link — the hint is present.
    const hint = await screen.findByText(
      /Lowercase token; must match the/i,
    );
    await user.click(wrapperOf(hint));

    const dialog = await screen.findByRole("dialog", {
      name: /exact lowercase token/i,
    });
    expect(dialog).toHaveTextContent(/exact lowercase token/i);
  });
});
