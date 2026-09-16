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

const PENDING_APPROVAL: Approval = {
  id: "apr-1",
  agent_id: "agent-1",
  agent_name: "coder-bot",
  workspace_id: "ws-1",
  board_id: null,
  category: "deletion",
  action_description: "Delete 15 stale cards from backlog",
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

const APPROVED_APPROVAL: Approval = {
  id: "apr-2",
  agent_id: "agent-2",
  agent_name: "review-bot",
  workspace_id: "ws-1",
  board_id: null,
  category: "bulk_change",
  action_description: "Update priority on 10 cards",
  action_payload: {},
  risk_score: 30,
  status: "approved",
  decided_by_id: "user-1",
  decided_by_name: "Alice Reviewer",
  decided_at: "2026-04-10T09:00:00Z",
  decision_reason: "Looks good",
  expires_at: "2026-04-11T00:00:00Z",
  execution_id: null,
  created_at: "2026-04-10T07:00:00Z",
  updated_at: "2026-04-10T09:00:00Z",
};

describe("ApprovalList", () => {
  it("renders approval table with pending and approved items", async () => {
    server.use(
      http.get(BASE, () =>
        HttpResponse.json([PENDING_APPROVAL, APPROVED_APPROVAL]),
      ),
    );

    renderWithProviders(<ApprovalList slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText("Delete 15 stale cards from backlog")).toBeInTheDocument();
    });

    expect(screen.getByText("Update priority on 10 cards")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
  });

  it("renders risk indicators with correct labels", async () => {
    server.use(
      http.get(BASE, () =>
        HttpResponse.json([PENDING_APPROVAL, APPROVED_APPROVAL]),
      ),
    );

    renderWithProviders(<ApprovalList slug={SLUG} />);

    await waitFor(() => {
      // risk_score 75 -> High
      expect(screen.getByText(/High/)).toBeInTheDocument();
    });

    // risk_score 30 -> Low
    expect(screen.getByText(/Low/)).toBeInTheDocument();
  });

  it("shows Decide button only for pending approvals", async () => {
    server.use(
      http.get(BASE, () =>
        HttpResponse.json([PENDING_APPROVAL, APPROVED_APPROVAL]),
      ),
    );

    renderWithProviders(<ApprovalList slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText("Decide")).toBeInTheDocument();
    });

    // Only one Decide button (for pending approval)
    const buttons = screen.getAllByText("Decide");
    expect(buttons).toHaveLength(1);
  });

  it("shows a View button on decided approvals so they stay inspectable", async () => {
    server.use(
      http.get(BASE, () =>
        HttpResponse.json([PENDING_APPROVAL, APPROVED_APPROVAL]),
      ),
    );

    renderWithProviders(<ApprovalList slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText("Update priority on 10 cards")).toBeInTheDocument();
    });

    // The decided (approved) row exposes a View action, not Decide.
    expect(screen.getByText("View")).toBeInTheDocument();
    expect(screen.getAllByText("Decide")).toHaveLength(1);
  });

  it("opens the read-only decision view when View is clicked", async () => {
    server.use(http.get(BASE, () => HttpResponse.json([APPROVED_APPROVAL])));

    const user = userEvent.setup();
    renderWithProviders(<ApprovalList slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText("View")).toBeInTheDocument();
    });

    await user.click(screen.getByText("View"));

    await waitFor(() => {
      expect(screen.getByText("Approval Details")).toBeInTheDocument();
    });

    // The decision summary surfaces the reviewer + reason; no action buttons.
    expect(screen.getByText(/Alice Reviewer/)).toBeInTheDocument();
    expect(screen.getByText("Looks good")).toBeInTheDocument();
    expect(screen.queryByText("Approve")).toBeNull();
  });

  it("filters rows by the search query (description and agent)", async () => {
    server.use(
      http.get(BASE, () =>
        HttpResponse.json([PENDING_APPROVAL, APPROVED_APPROVAL]),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ApprovalList slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText("Delete 15 stale cards from backlog")).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText(/search approvals/i), "priority");

    await waitFor(() => {
      expect(screen.queryByText("Delete 15 stale cards from backlog")).toBeNull();
    });
    expect(screen.getByText("Update priority on 10 cards")).toBeInTheDocument();
  });

  it("clears the search query via the clear button", async () => {
    server.use(
      http.get(BASE, () =>
        HttpResponse.json([PENDING_APPROVAL, APPROVED_APPROVAL]),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ApprovalList slug={SLUG} />);

    const input = (await screen.findByPlaceholderText(
      /search approvals/i,
    )) as HTMLInputElement;
    await user.type(input, "priority");
    await user.click(screen.getByLabelText(/clear search/i));

    expect(input.value).toBe("");
    await waitFor(() => {
      expect(
        screen.getByText("Delete 15 stale cards from backlog"),
      ).toBeInTheDocument();
    });
  });

  it("debounces the search so filtering trails the keystrokes", async () => {
    server.use(
      http.get(BASE, () =>
        HttpResponse.json([PENDING_APPROVAL, APPROVED_APPROVAL]),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ApprovalList slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText("Delete 15 stale cards from backlog")).toBeInTheDocument();
    });

    const input = (await screen.findByPlaceholderText(
      /search approvals/i,
    )) as HTMLInputElement;
    await user.type(input, "priority");

    // The field itself is uncontrolled by the debounce — it must echo every
    // keystroke immediately even while the filtered list still shows the old
    // result.
    expect(input.value).toBe("priority");

    await waitFor(() => {
      expect(screen.queryByText("Delete 15 stale cards from backlog")).toBeNull();
    });
  });

  it("filters rows by status via the Status filter", async () => {
    server.use(
      http.get(BASE, () =>
        HttpResponse.json([PENDING_APPROVAL, APPROVED_APPROVAL]),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ApprovalList slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText("Delete 15 stale cards from backlog")).toBeInTheDocument();
    });

    // Open the Status filter pill and select "Approved" (exact, so it doesn't
    // also match "Auto-approved").
    await user.click(screen.getByRole("button", { name: /^Status/ }));
    await user.click(screen.getByRole("menuitem", { name: "Approved" }));

    expect(screen.queryByText("Delete 15 stale cards from backlog")).toBeNull();
    expect(screen.getByText("Update priority on 10 cards")).toBeInTheDocument();
  });

  it("shows a no-match state distinct from the empty state", async () => {
    server.use(
      http.get(BASE, () =>
        HttpResponse.json([PENDING_APPROVAL, APPROVED_APPROVAL]),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<ApprovalList slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText("Delete 15 stale cards from backlog")).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText(/search approvals/i), "zzz-nothing");

    await waitFor(() => {
      expect(screen.getByText(/no approvals match/i)).toBeInTheDocument();
    });
    expect(screen.queryByText("Delete 15 stale cards from backlog")).toBeNull();
  });

  it("renders agent name from approval data", async () => {
    server.use(
      http.get(BASE, () =>
        HttpResponse.json([PENDING_APPROVAL]),
      ),
    );

    renderWithProviders(<ApprovalList slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText("coder-bot")).toBeInTheDocument();
    });
  });

  it("falls back to truncated agent_id when agent_name is null", async () => {
    const noNameApproval = { ...PENDING_APPROVAL, agent_name: null, agent_id: "abcdef12-3456-7890" };
    server.use(
      http.get(BASE, () => HttpResponse.json([noNameApproval])),
    );

    renderWithProviders(<ApprovalList slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText("abcdef12")).toBeInTheDocument();
    });
  });

  it("renders empty state when no approvals", async () => {
    server.use(
      http.get(BASE, () => HttpResponse.json([])),
    );

    renderWithProviders(<ApprovalList slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText("No approvals yet")).toBeInTheDocument();
    });
  });

  it("renders table column headers", async () => {
    server.use(
      http.get(BASE, () => HttpResponse.json([PENDING_APPROVAL])),
    );

    renderWithProviders(<ApprovalList slug={SLUG} />);

    // "Status"/"Category" also label the filter pills, so assert the table's
    // column headers specifically (columnheader role) to disambiguate.
    await waitFor(() => {
      expect(
        screen.getByRole("columnheader", { name: "Status" }),
      ).toBeInTheDocument();
    });

    expect(screen.getByRole("columnheader", { name: "Category" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Description" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Risk Score" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Runner" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Created" })).toBeInTheDocument();
  });

  it("renders loading skeletons before data loads", () => {
    server.use(
      http.get(BASE, async () => {
        await new Promise(() => {}); // never resolves
      }),
    );

    renderWithProviders(<ApprovalList slug={SLUG} />);

    const skeletons = document.querySelectorAll("[class*='animate-shimmer']");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("opens decide dialog when Decide button is clicked", async () => {
    server.use(
      http.get(BASE, () => HttpResponse.json([PENDING_APPROVAL])),
    );

    const user = userEvent.setup();
    renderWithProviders(<ApprovalList slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText("Decide")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Decide"));

    await waitFor(() => {
      expect(screen.getByText("Decide on Approval")).toBeInTheDocument();
    });

    // Description appears in both table and dialog
    expect(screen.getAllByText("Delete 15 stale cards from backlog")).toHaveLength(2);
    expect(screen.getByText("Approve")).toBeInTheDocument();
    expect(screen.getByText("Reject")).toBeInTheDocument();
  });

  it("surfaces the terminal-reject warning in the decide dialog", async () => {
    server.use(http.get(BASE, () => HttpResponse.json([PENDING_APPROVAL])));

    const user = userEvent.setup();
    renderWithProviders(<ApprovalList slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText("Decide")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Decide"));

    await waitFor(() => {
      expect(screen.getByText("Reject")).toBeInTheDocument();
    });

    // The Reject button is wrapped by a RichTooltip trigger; clicking the
    // wrapper (parent span) opens the tooltip modal rather than firing the
    // mutation.
    const rejectButton = screen.getByText("Reject");
    const rejectTrigger = rejectButton.closest("span[role='button']");
    expect(rejectTrigger).not.toBeNull();
    await user.click(rejectTrigger!);

    await waitFor(() => {
      expect(screen.getByTestId("rt-backdrop")).toBeInTheDocument();
    });

    const callouts = screen.getByTestId("rt-callouts");
    // Terminal-reject callout uses the warn variant.
    expect(callouts.querySelector("[data-variant='warn']")).not.toBeNull();
    expect(callouts).toHaveTextContent(/does not undo/i);
  });

  it("shows category tooltip with risk-score rows on click", async () => {
    server.use(http.get(BASE, () => HttpResponse.json([PENDING_APPROVAL])));

    const user = userEvent.setup();
    renderWithProviders(<ApprovalList slug={SLUG} />);

    // Wait for the row so we can query the category cell by text.
    await waitFor(() => {
      expect(screen.getByText("Delete 15 stale cards from backlog")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Deletion"));

    await waitFor(() => {
      expect(screen.getByTestId("rt-backdrop")).toBeInTheDocument();
    });

    // Row table surfaces the category-specific scoring breakdown.
    const rows = screen.getByTestId("rt-rows");
    expect(rows).toHaveTextContent("Base score");
    expect(rows).toHaveTextContent("60");
  });

  it("exposes the risk-score heuristic tooltip", async () => {
    server.use(http.get(BASE, () => HttpResponse.json([PENDING_APPROVAL])));

    const user = userEvent.setup();
    renderWithProviders(<ApprovalList slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText(/High/)).toBeInTheDocument();
    });

    // The numeric score appears alongside the (High) qualifier in a single
    // span — click that span to open the risk-score tooltip.
    await user.click(screen.getByText(/High/).closest("span")!);

    await waitFor(() => {
      expect(screen.getByTestId("rt-backdrop")).toBeInTheDocument();
    });

    const callouts = screen.getByTestId("rt-callouts");
    // The "honest remark" callout grounds the score as a heuristic.
    expect(callouts).toHaveTextContent(/heuristic/i);
    expect(callouts).toHaveTextContent(/risk\.py/);
  });

  it("exposes the 24h expiry note on the created column", async () => {
    server.use(http.get(BASE, () => HttpResponse.json([PENDING_APPROVAL])));

    const user = userEvent.setup();
    renderWithProviders(<ApprovalList slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText("Delete 15 stale cards from backlog")).toBeInTheDocument();
    });

    // created_at is rendered via toLocaleDateString; match the day token.
    const createdCell = screen.getByText(
      new Date(PENDING_APPROVAL.created_at).toLocaleDateString(),
    );
    await user.click(createdCell);

    await waitFor(() => {
      expect(screen.getByTestId("rt-backdrop")).toBeInTheDocument();
    });

    expect(screen.getByRole("dialog")).toHaveTextContent(/24 hours/);
  });
});
