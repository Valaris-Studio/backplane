// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import type { GitRepo } from "@/types/git";

// Partial mock: the create/edit dialogs pull other exports from this module,
// so only useGitRepos is swapped.
const useGitReposMock = vi.fn();
vi.mock("@/features/git/api/use-git-repos", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useGitRepos: (...args: unknown[]) => useGitReposMock(...args),
}));

import { GitRepoList } from "../GitRepoList";

// isFrozen isn't on the props type yet — cast keeps the red a BEHAVIOR
// failure (button still enabled), not a TS one.
const List = GitRepoList as unknown as React.ComponentType<
  Record<string, unknown>
>;

function makeRepo(overrides: Partial<GitRepo> = {}): GitRepo {
  return {
    id: "repo-1",
    name: "backplane",
    provider: "github",
    url: "https://github.com/acme/backplane",
    default_branch: "main",
    board_id: "board-1",
    created_at: "2026-04-24T00:00:00Z",
    updated_at: "2026-04-24T00:00:00Z",
    ...overrides,
  } as GitRepo;
}

function renderList(props: Record<string, unknown>) {
  return renderWithProviders(
    <List slug="acme" boardId="board-1" {...props} />,
  );
}

beforeEach(() => {
  useGitReposMock.mockReturnValue({ data: [makeRepo()], isLoading: false });
});

describe("GitRepoList — frozen board gates repo creation", () => {
  it("disables the header add-repo button when frozen", () => {
    renderList({ isFrozen: true });
    expect(screen.getByRole("button", { name: /add repository/i })).toBeDisabled();
  });

  it("leaves the header add-repo button enabled when isFrozen is absent", () => {
    renderList({});
    expect(screen.getByRole("button", { name: /add repository/i })).toBeEnabled();
  });

  it("disables the empty-state add-repo button when frozen", () => {
    useGitReposMock.mockReturnValue({ data: [], isLoading: false });
    renderList({ isFrozen: true });
    for (const button of screen.getAllByRole("button", { name: /add repository/i })) {
      expect(button).toBeDisabled();
    }
  });

  it("leaves the empty-state add-repo button enabled when not frozen", () => {
    useGitReposMock.mockReturnValue({ data: [], isLoading: false });
    renderList({ isFrozen: false });
    for (const button of screen.getAllByRole("button", { name: /add repository/i })) {
      expect(button).toBeEnabled();
    }
  });
});
