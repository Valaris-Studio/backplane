// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  renderWithProviders,
  screen,
  waitFor,
} from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { PendingApprovalsPanel } from "../PendingApprovalsPanel";
import type { Approval } from "@/types/approval";

const SLUG = "test-workspace";
const BASE = `/api/workspaces/${SLUG}/approvals`;

const PENDING: Approval = {
  id: "apr-1",
  agent_id: "agent-1",
  agent_name: "coder-bot",
  workspace_id: "ws-1",
  board_id: null,
  category: "deletion",
  action_description: "Delete 15 stale cards",
  action_payload: {},
  risk_score: 75,
  status: "pending",
  decided_by_id: null,
  decided_by_name: null,
  decided_at: null,
  decision_reason: null,
  expires_at: "2026-04-11T00:00:00Z",
  execution_id: null,
  created_at: "2026-04-10T08:00:00Z",
  updated_at: "2026-04-10T08:00:00Z",
};

const PENDING_2: Approval = {
  ...PENDING,
  id: "apr-2",
  agent_id: "agent-2",
  agent_name: "review-bot",
  category: "bulk_change",
  action_description: "Reassign 10 cards",
  risk_score: 45,
};

describe("PendingApprovalsPanel", () => {
  it("renders pending approval items", async () => {
    server.use(
      http.get(BASE, () => HttpResponse.json([PENDING, PENDING_2])),
    );

    renderWithProviders(<PendingApprovalsPanel slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText("Delete 15 stale cards")).toBeInTheDocument();
    });

    expect(screen.getByText("Reassign 10 cards")).toBeInTheDocument();
  });

  it("shows risk score with severity label", async () => {
    server.use(
      http.get(BASE, () => HttpResponse.json([PENDING])),
    );

    renderWithProviders(<PendingApprovalsPanel slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText(/75/)).toBeInTheDocument();
    });

    expect(screen.getByText(/High/)).toBeInTheDocument();
  });

  it("shows agent name for each approval", async () => {
    server.use(
      http.get(BASE, () => HttpResponse.json([PENDING, PENDING_2])),
    );

    renderWithProviders(<PendingApprovalsPanel slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText(/coder-bot/)).toBeInTheDocument();
    });

    expect(screen.getByText(/review-bot/)).toBeInTheDocument();
  });

  it("shows empty state when no pending approvals", async () => {
    server.use(
      http.get(BASE, () => HttpResponse.json([])),
    );

    renderWithProviders(<PendingApprovalsPanel slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText(/no pending approvals/i)).toBeInTheDocument();
    });
  });

  it("shows count badge in panel header", async () => {
    server.use(
      http.get(BASE, () => HttpResponse.json([PENDING, PENDING_2])),
    );

    renderWithProviders(<PendingApprovalsPanel slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText("2")).toBeInTheDocument();
    });
  });

  it("shows View All link to approvals page", async () => {
    server.use(
      http.get(BASE, () => HttpResponse.json([PENDING])),
    );

    renderWithProviders(
      <PendingApprovalsPanel slug={SLUG} />,
      { routerProps: { initialEntries: [`/${SLUG}/agents`] } },
    );

    await waitFor(() => {
      const link = screen.getByText(/view all/i);
      expect(link).toBeInTheDocument();
      expect(link.closest("a")).toHaveAttribute("href", `/${SLUG}/approvals`);
    });
  });
});
