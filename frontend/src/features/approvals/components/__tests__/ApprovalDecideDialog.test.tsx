// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import i18n from "@/i18n/config";
import { ApprovalDecideDialog } from "../ApprovalDecideDialog";
import type { Approval } from "@/types/approval";

vi.mock("../../hooks/useApprovals", () => ({
  useApprovals: vi.fn(),
  useDecideApproval: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

// The markdown an LLM writes into action_description: a heading, prose, and
// three labeled options. Pre-fix this rendered as one flattened blob.
const MARKDOWN_DESCRIPTION = [
  "## Retry schedule ambiguity",
  "",
  "SPEC §13.8 leaves the backoff policy underspecified. Options:",
  "",
  "- (A) Exponential backoff capped at 5m",
  "- (B) Fixed 30s interval",
  "- (C) Linear ramp",
  "",
  "Recommendation: **A**.",
].join("\n");

const approval: Approval = {
  id: "ap-md",
  workspace_id: "ws-1",
  board_id: null,
  agent_id: "agent-123456789",
  agent_name: "Spec Bot",
  category: "external_action",
  action_description: MARKDOWN_DESCRIPTION,
  action_payload: { card_id: "card-1", details: "Blocks M7-03 until resolved." },
  risk_score: 50,
  status: "pending",
  decided_by_id: null,
  decided_by_name: null,
  decided_at: null,
  decision_reason: null,
  expires_at: "2025-01-16T10:00:00Z",
  execution_id: null,
  created_at: "2025-01-15T10:00:00Z",
  updated_at: "2025-01-15T10:00:00Z",
};

function renderDialog(a: Approval | null) {
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient()}>
        <ApprovalDecideDialog
          slug="test-ws"
          approval={a}
          open={true}
          onOpenChange={() => {}}
        />
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

describe("ApprovalDecideDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the markdown action_description structurally, not as a raw blob", () => {
    renderDialog(approval);

    // Heading text appears in its own element, free of the literal "##" marker.
    const heading = screen.getByText("Retry schedule ambiguity");
    expect(heading).toBeInTheDocument();
    expect(heading.textContent).not.toContain("##");

    // The three options render as distinct list items (markdown "- " stripped).
    const optionA = screen.getByText(/Exponential backoff capped at 5m/);
    expect(optionA.closest("li")).not.toBeNull();
    expect(optionA.textContent).not.toContain("- (A)");

    // The whole literal markdown source must NOT appear as one text node.
    expect(screen.queryByText(MARKDOWN_DESCRIPTION)).toBeNull();
  });

  it("renders action_payload.details below the description", () => {
    renderDialog(approval);
    expect(screen.getByText("Blocks M7-03 until resolved.")).toBeInTheDocument();
  });

  it("omits the details section when action_payload has no details", () => {
    renderDialog({ ...approval, action_payload: { card_id: "card-1" } });
    expect(screen.queryByText("Blocks M7-03 until resolved.")).toBeNull();
  });

  it("shows approve/reject actions only for a pending approval", () => {
    renderDialog(approval);
    expect(screen.getByText("Approve")).toBeInTheDocument();
    expect(screen.getByText("Reject")).toBeInTheDocument();
    // No decided-summary yet.
    expect(screen.queryByText(/decided by/i)).toBeNull();
  });

  it("renders a read-only decision summary for a decided approval", () => {
    renderDialog({
      ...approval,
      status: "approved",
      decided_by_id: "user-1",
      decided_by_name: "Alice Reviewer",
      decided_at: "2025-01-15T11:30:00Z",
      decision_reason: "Looks safe to proceed.",
    });

    // The reviewer's name + reason are shown.
    expect(screen.getByText(/Alice Reviewer/)).toBeInTheDocument();
    expect(screen.getByText("Looks safe to proceed.")).toBeInTheDocument();

    // Action buttons are gone; a Close affordance replaces them.
    expect(screen.queryByText("Approve")).toBeNull();
    expect(screen.queryByText("Reject")).toBeNull();
    // The footer Close button (the Dialog also renders an icon-only X with an
    // sr-only "Close" label, so match the visible-text button specifically).
    expect(
      screen
        .getAllByText("Close")
        .some((el) => el.tagName === "BUTTON" && !el.className.includes("sr-only")),
    ).toBe(true);

    // The reason-entry textarea is not rendered in read-only mode.
    expect(screen.queryByLabelText(/reason/i)).toBeNull();
  });

  it("shows the decider name with no reason when the reason is empty", () => {
    renderDialog({
      ...approval,
      status: "rejected",
      decided_by_id: "user-2",
      decided_by_name: "Bob Admin",
      decided_at: "2025-01-15T12:00:00Z",
      decision_reason: null,
    });
    expect(screen.getByText(/Bob Admin/)).toBeInTheDocument();
    // The footer Close button (the Dialog also renders an icon-only X with an
    // sr-only "Close" label, so match the visible-text button specifically).
    expect(
      screen
        .getAllByText("Close")
        .some((el) => el.tagName === "BUTTON" && !el.className.includes("sr-only")),
    ).toBe(true);
  });
});
