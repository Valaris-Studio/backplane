// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  renderWithProviders,
  screen,
  waitFor,
  userEvent,
} from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { ApprovalList } from "../ApprovalList";
import type { Approval } from "@/types/approval";

const SLUG = "test-workspace";
const BASE = "/api/workspaces/test-workspace/approvals";

// `skill_publication` widens the ApprovalCategory union (W2). Until the type
// grows the member, this fixture is the TS-level red; at runtime the list
// must render it like any other category.
const SKILL_PUBLICATION_APPROVAL: Approval = {
  id: "apr-skill-1",
  agent_id: "agent-1",
  agent_name: "loop-bot",
  workspace_id: "ws-1",
  board_id: "board-1",
  category: "skill_publication" as Approval["category"],
  action_description: "Publish version 2 of skill Deploy Runbook",
  action_payload: { slug: "deploy-runbook", version: 2 },
  risk_score: 60,
  status: "pending",
  decided_by_id: null,
  decided_by_name: null,
  decided_at: null,
  decision_reason: null,
  expires_at: "2026-08-25T00:00:00Z",
  execution_id: null,
  created_at: "2026-08-24T08:00:00Z",
  updated_at: "2026-08-24T08:00:00Z",
};

describe("ApprovalList — skill_publication category", () => {
  it("renders a skill_publication approval with a human-readable category label", async () => {
    server.use(
      http.get(BASE, () => HttpResponse.json([SKILL_PUBLICATION_APPROVAL])),
    );

    renderWithProviders(<ApprovalList slug={SLUG} />);

    await waitFor(() => {
      expect(
        screen.getByText("Publish version 2 of skill Deploy Runbook"),
      ).toBeInTheDocument();
    });

    // Translated label, not the raw enum value or a bare i18n key.
    expect(screen.getByText(/skill publication/i)).toBeInTheDocument();
    expect(screen.queryByText(/approvals\.category\./)).toBeNull();
  });

  it("offers skill_publication in the Category filter options", async () => {
    server.use(
      http.get(BASE, () => HttpResponse.json([SKILL_PUBLICATION_APPROVAL])),
    );

    const user = userEvent.setup();
    renderWithProviders(<ApprovalList slug={SLUG} />);

    await waitFor(() => {
      expect(
        screen.getByText("Publish version 2 of skill Deploy Runbook"),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /^Category/ }));

    expect(
      screen.getByRole("menuitem", { name: /skill publication/i }),
    ).toBeInTheDocument();
  });

  it("decides a pending skill_publication approval via the decide dialog", async () => {
    let decided: { id: string; body: Record<string, unknown> } | null = null;
    server.use(
      http.get(BASE, () => HttpResponse.json([SKILL_PUBLICATION_APPROVAL])),
      http.post(`${BASE}/:id/decide`, async ({ request, params }) => {
        decided = {
          id: params.id as string,
          body: (await request.json()) as Record<string, unknown>,
        };
        return HttpResponse.json({
          ...SKILL_PUBLICATION_APPROVAL,
          status: "approved",
        });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<ApprovalList slug={SLUG} />);

    // Anchor on the translated label so this scenario also pins the new
    // category rendering, not just the (category-agnostic) decide plumbing.
    await waitFor(() => {
      expect(screen.getByText(/skill publication/i)).toBeInTheDocument();
    });

    await user.click(screen.getByText("Decide"));

    await waitFor(() => {
      expect(screen.getByText("Decide on Approval")).toBeInTheDocument();
    });

    // getByText targets the inner <button> text node, so the click lands on
    // the live control rather than its RichTooltip wrapper span.
    await user.click(screen.getByText("Approve"));

    await waitFor(() => expect(decided).not.toBeNull());
    expect(decided!.id).toBe("apr-skill-1");
    expect(decided!.body.decision).toBe("approved");
  });
});
