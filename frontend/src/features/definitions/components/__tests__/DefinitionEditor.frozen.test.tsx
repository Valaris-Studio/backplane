// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";

const useBoardMock = vi.fn();
vi.mock("@/features/kanban/api/use-boards", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useBoard: (...args: unknown[]) => useBoardMock(...args),
}));

vi.mock("@/features/definitions/api/use-definitions", () => ({
  useDefinition: () => ({ data: null, isLoading: false }),
  useUpsertDefinition: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/features/members/api/use-members", () => ({
  useMembers: () => ({ data: [] }),
}));
vi.mock("@/features/channels/api/use-channels", () => ({
  useChannels: () => ({ data: [] }),
}));
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useParams: () => ({ slug: "acme", boardId: "board-1" }),
}));

import { DefinitionEditor } from "../DefinitionEditor";

beforeEach(() => {
  useBoardMock.mockReturnValue({ data: { is_frozen: false } });
});

describe("DefinitionEditor — frozen board gates saving", () => {
  it("disables both Save buttons when the board is frozen", () => {
    useBoardMock.mockReturnValue({ data: { is_frozen: true } });
    renderWithProviders(<DefinitionEditor />);
    const saveButtons = screen.getAllByRole("button", { name: /^save$/i });
    expect(saveButtons.length).toBeGreaterThanOrEqual(2);
    for (const button of saveButtons) {
      expect(button).toBeDisabled();
    }
  });

  it("leaves the Save buttons enabled when the board is not frozen", () => {
    renderWithProviders(<DefinitionEditor />);
    const saveButtons = screen.getAllByRole("button", { name: /^save$/i });
    expect(saveButtons.length).toBeGreaterThanOrEqual(2);
    for (const button of saveButtons) {
      expect(button).toBeEnabled();
    }
  });
});
