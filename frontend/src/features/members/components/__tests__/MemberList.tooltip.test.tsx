// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { useTooltipContent } from "@/components/ui/rich-tooltip";
import "@/i18n/config";
import { MemberList } from "../MemberList";
import type { WorkspaceMember } from "@/types/member";

const SLUG = "test-workspace";

const MEMBERS: WorkspaceMember[] = [
  {
    user_id: "u-owner",
    email: "owner@valaris.dev",
    name: "Owner User",
    role: "owner",
    joined_at: "2026-01-01T00:00:00Z",
  },
];

describe("MemberList workspace.members.roles tooltip", () => {
  it("exposes the roles tooltip content via useTooltipContent", () => {
    const { result } = renderHook(() => useTooltipContent("workspace.members.roles"));
    expect(result.current.summary).toMatch(/four tiers/i);
    const labels = (result.current.rows ?? []).map((r) => r.label);
    expect(labels).toEqual(expect.arrayContaining(["owner", "admin", "member", "viewer"]));
  });

  it("wraps the role pill in a RichTooltip that surfaces the summary on hover", async () => {
    server.use(
      http.get(`/api/workspaces/${SLUG}/members`, () => HttpResponse.json(MEMBERS)),
    );

    const user = userEvent.setup();
    renderWithProviders(<MemberList slug={SLUG} />);

    await waitFor(() => expect(screen.getByText("Owner User")).toBeInTheDocument());

    const pill = screen.getByText(/owner/i, { selector: "span" });
    const trigger = pill.closest('[role="button"]');
    expect(trigger).not.toBeNull();

    await user.hover(trigger as Element);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toMatch(/four tiers/i);
  });
});
