// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import type { Resource } from "@/types/resource";

// Partial mock: child dialogs pull other exports from this module, so only
// the list query is swapped.
const useResourcesMock = vi.fn();
vi.mock("@/features/resources/api/use-resources", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useResources: (...args: unknown[]) => useResourcesMock(...args),
  useTags: () => ({ data: [] }),
}));

import { ResourceList } from "../ResourceList";

// isFrozen isn't on the props type yet — cast keeps the red a BEHAVIOR
// failure (button still enabled), not a TS one.
const List = ResourceList as unknown as React.ComponentType<
  Record<string, unknown>
>;

function makeResource(overrides: Partial<Resource> = {}): Resource {
  return {
    id: "res-1",
    name: "spec.pdf",
    resource_type: "file",
    parent_id: null,
    board_id: "board-1",
    size_bytes: 2048,
    tags: [],
    created_at: "2026-04-24T00:00:00Z",
    updated_at: "2026-04-24T00:00:00Z",
    ...overrides,
  } as Resource;
}

function renderList(props: Record<string, unknown>) {
  return renderWithProviders(
    <List slug="acme" boardId="board-1" {...props} />,
  );
}

beforeEach(() => {
  useResourcesMock.mockReturnValue({
    data: [makeResource()],
    isLoading: false,
  });
});

// RichTooltip wraps the upload Button in a <span role="button"> trigger, so
// role queries match two nodes. The real control is the <button> element.
function uploadButton(): HTMLButtonElement {
  const matches = screen
    .getAllByRole("button", { name: /upload file/i })
    .filter((el): el is HTMLButtonElement => el.tagName === "BUTTON");
  const button = matches[0];
  if (!button) throw new Error("no upload <button> rendered");
  return button;
}

describe("ResourceList — frozen board gates uploads and folder creation", () => {
  it("disables the upload button when frozen", () => {
    renderList({ isFrozen: true });
    expect(uploadButton()).toBeDisabled();
  });

  it("disables the new-folder button when frozen", () => {
    renderList({ isFrozen: true });
    expect(screen.getByRole("button", { name: /new folder/i })).toBeDisabled();
  });

  it("leaves both buttons enabled when isFrozen is absent", () => {
    renderList({});
    expect(uploadButton()).toBeEnabled();
    expect(screen.getByRole("button", { name: /new folder/i })).toBeEnabled();
  });
});
