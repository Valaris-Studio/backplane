// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { ToolInvocationList } from "../ToolInvocationList";
import type { ToolInvocation } from "../../api/agents";

const INVOCATIONS: ToolInvocation[] = [
  {
    id: "inv-1",
    tool_name: "create_card",
    arguments_summary: '{"title": "Fix login bug", "column_id": "col-1"}',
    result_summary: '{"id": "card-abc"}',
    started_at: "2026-04-12T10:00:00Z",
    completed_at: "2026-04-12T10:00:01Z",
    duration_seconds: 1.2,
    status: "completed",
    error_message: null,
    position: 0,
  },
  {
    id: "inv-2",
    tool_name: "move_card",
    arguments_summary: '{"card_id": "card-abc", "column_id": "col-2"}',
    result_summary: null,
    started_at: "2026-04-12T10:00:02Z",
    completed_at: "2026-04-12T10:00:02.5Z",
    duration_seconds: 0.5,
    status: "completed",
    error_message: null,
    position: 1,
  },
  {
    id: "inv-3",
    tool_name: "update_definition",
    arguments_summary: '{"scope": "new scope"}',
    result_summary: null,
    started_at: "2026-04-12T10:00:03Z",
    completed_at: null,
    duration_seconds: null,
    status: "failed",
    error_message: "Permission denied",
    position: 2,
  },
];

describe("ToolInvocationList", () => {
  it("renders all invocations sorted by position", () => {
    const reversed = [...INVOCATIONS].reverse();
    renderWithProviders(<ToolInvocationList invocations={reversed} />);

    const toolNames = screen.getAllByText(/create_card|move_card|update_definition/);
    expect(toolNames).toHaveLength(3);
    expect(toolNames[0]).toHaveTextContent("create_card");
    expect(toolNames[1]).toHaveTextContent("move_card");
    expect(toolNames[2]).toHaveTextContent("update_definition");
  });

  it("shows status badges", () => {
    renderWithProviders(<ToolInvocationList invocations={INVOCATIONS} />);

    const completed = screen.getAllByText("Completed");
    expect(completed).toHaveLength(2);
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("shows duration for completed invocations", () => {
    renderWithProviders(<ToolInvocationList invocations={INVOCATIONS} />);

    expect(screen.getByText("1.2s")).toBeInTheDocument();
    expect(screen.getByText("500ms")).toBeInTheDocument();
  });

  it("renders empty state when no invocations", () => {
    renderWithProviders(<ToolInvocationList invocations={[]} />);

    expect(screen.getByText("No tool invocations recorded")).toBeInTheDocument();
  });

  it("expands to show arguments and result on click", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ToolInvocationList invocations={[INVOCATIONS[0]!]} />);

    // Arguments should not be visible initially
    expect(screen.queryByText(/Fix login bug/)).not.toBeInTheDocument();

    // Click to expand
    const row = screen.getByText("create_card").closest("button")!;
    await user.click(row);

    // Now arguments and result should be visible
    expect(screen.getByText(/Fix login bug/)).toBeInTheDocument();
    expect(screen.getByText(/card-abc/)).toBeInTheDocument();
  });

  it("shows error message for failed invocations when expanded", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ToolInvocationList invocations={[INVOCATIONS[2]!]} />);

    const row = screen.getByText("update_definition").closest("button")!;
    await user.click(row);

    expect(screen.getByText("Permission denied")).toBeInTheDocument();
  });
});
