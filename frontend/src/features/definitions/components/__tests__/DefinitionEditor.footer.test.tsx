// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import type { Definition } from "@/types/definition";
import type { WorkspaceMember } from "@/types/member";

vi.mock("@/features/kanban/api/use-boards", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useBoard: () => ({
    data: { id: "board-1", is_frozen: false, has_definition: true },
  }),
}));

const useDefinitionMock = vi.fn();
vi.mock("@/features/definitions/api/use-definitions", () => ({
  useDefinition: (...args: unknown[]) => useDefinitionMock(...args),
  useUpsertDefinition: () => ({ mutate: vi.fn(), isPending: false }),
}));

const useMembersMock = vi.fn();
vi.mock("@/features/members/api/use-members", () => ({
  useMembers: (...args: unknown[]) => useMembersMock(...args),
}));
vi.mock("@/features/channels/api/use-channels", () => ({
  useChannels: () => ({ data: [] }),
}));
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useParams: () => ({ slug: "acme", boardId: "board-1" }),
}));

import { DefinitionEditor } from "../DefinitionEditor";

const UPDATER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function member(overrides: Partial<WorkspaceMember> = {}): WorkspaceMember {
  return {
    user_id: UPDATER_ID,
    email: "ada@example.com",
    name: "Ada Lovelace",
    role: "member",
    joined_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const SAVED_DEFINITION = {
  id: "def-1",
  board_id: "board-1",
  workspace_id: "ws-1",
  scope: "Ship the thing",
  content: {
    objectives: [],
    exclusions: [],
    milestones: [],
    tech_stack: [],
    stakeholders: [],
    constraints: [],
    decisions: [],
    references: [],
    custom_fields: [],
    _overflow: {},
  },
  updated_by: UPDATER_ID,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
} satisfies Definition;

function footer(): HTMLElement {
  return screen.getByText(/last updated by/i);
}

beforeEach(() => {
  vi.clearAllMocks();
  useDefinitionMock.mockReturnValue({
    data: SAVED_DEFINITION,
    isLoading: false,
  });
  useMembersMock.mockReturnValue({ data: [] });
});

describe("DefinitionEditor — footer names the updater instead of the raw user id", () => {
  it("shows the member's name when updated_by matches a workspace member", () => {
    useMembersMock.mockReturnValue({ data: [member()] });
    renderWithProviders(<DefinitionEditor />);

    expect(footer()).toHaveTextContent("Last updated by Ada Lovelace at");
    expect(footer()).not.toHaveTextContent(UPDATER_ID);
  });

  it("falls back to the member's email when the member has no name", () => {
    // Backend User.name defaults to "" — an empty name is the no-name case.
    useMembersMock.mockReturnValue({ data: [member({ name: "" })] });
    renderWithProviders(<DefinitionEditor />);

    expect(footer()).toHaveTextContent("Last updated by ada@example.com at");
    expect(footer()).not.toHaveTextContent(UPDATER_ID);
  });

  it("shortens the id to its first 8 chars when no workspace member matches", () => {
    useMembersMock.mockReturnValue({
      data: [member({ user_id: "00000000-0000-0000-0000-000000000000" })],
    });
    renderWithProviders(<DefinitionEditor />);

    expect(footer()).toHaveTextContent(
      `Last updated by ${UPDATER_ID.slice(0, 8)} at`,
    );
    expect(footer()).not.toHaveTextContent(UPDATER_ID);
  });
});
