// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";

// The :boardId route param also accepts the board's slug (GET /boards/{id}
// resolves both), but /definitions and /definitions/export resolve UUIDs
// only. Route param and board UUID are kept DISTINCT here (the 43597f1
// fixture pattern) so a hook that forwards the raw param instead of the
// fetched board's canonical id fails loudly instead of passing by accident.
const SLUG = "acme";
const ROUTE_PARAM = "board2";
const BOARD_UUID = "7c9e6c1a-0b4d-4a4e-9c3d-2f6a8b1d4e5a";

const paramsState = { current: { slug: SLUG, boardId: ROUTE_PARAM } };

const useBoardMock = vi.fn();
vi.mock("@/features/kanban/api/use-boards", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useBoard: (...args: unknown[]) => useBoardMock(...args),
}));

const useDefinitionMock = vi.fn();
const useUpsertDefinitionMock = vi.fn();
vi.mock("@/features/definitions/api/use-definitions", () => ({
  useDefinition: (...args: unknown[]) => useDefinitionMock(...args),
  useUpsertDefinition: (...args: unknown[]) => useUpsertDefinitionMock(...args),
}));

vi.mock("@/features/members/api/use-members", () => ({
  useMembers: () => ({ data: [] }),
}));
vi.mock("@/features/channels/api/use-channels", () => ({
  useChannels: () => ({ data: [] }),
}));
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useParams: () => paramsState.current,
}));

const exportButtonProps = vi.fn();
vi.mock("@/components/export/export-button", () => ({
  ExportButton: (props: { endpoint: string; defaultFilename: string }) => {
    exportButtonProps(props);
    return <button type="button">Export</button>;
  },
}));

import { DefinitionEditor } from "../DefinitionEditor";

beforeEach(() => {
  vi.clearAllMocks();
  paramsState.current = { slug: SLUG, boardId: ROUTE_PARAM };
  useBoardMock.mockReturnValue({
    data: { id: BOARD_UUID, is_frozen: false, has_definition: true },
  });
  useDefinitionMock.mockReturnValue({ data: null, isLoading: false });
  useUpsertDefinitionMock.mockReturnValue({ mutate: vi.fn(), isPending: false });
});

describe("DefinitionEditor — slug route param vs canonical board id", () => {
  it("fetches the definition with the board's UUID, not the raw route param", () => {
    renderWithProviders(<DefinitionEditor />);

    expect(useDefinitionMock).toHaveBeenCalledWith(
      SLUG,
      BOARD_UUID,
      expect.objectContaining({ configured: true }),
    );
  });

  it("upserts the definition against the board's UUID, not the raw route param", () => {
    renderWithProviders(<DefinitionEditor />);

    expect(useUpsertDefinitionMock).toHaveBeenCalledWith(SLUG, BOARD_UUID);
  });

  it("builds the export endpoint and filename from the board's UUID, not the raw route param", async () => {
    renderWithProviders(<DefinitionEditor />);

    await screen.findByRole("button", { name: /export/i });
    expect(exportButtonProps).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: `/workspaces/${SLUG}/boards/${BOARD_UUID}/definitions/export`,
        defaultFilename: `${BOARD_UUID}.valaris.definition.json`,
      }),
    );
  });

  it("still resolves correctly when the route param already IS the UUID", () => {
    paramsState.current = { slug: SLUG, boardId: BOARD_UUID };
    renderWithProviders(<DefinitionEditor />);

    expect(useDefinitionMock).toHaveBeenCalledWith(
      SLUG,
      BOARD_UUID,
      expect.objectContaining({ configured: true }),
    );
  });
});
