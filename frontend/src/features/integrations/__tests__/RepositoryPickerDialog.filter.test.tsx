// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  renderWithProviders,
  screen,
  userEvent,
} from "@/test/test-utils";
import type { GitConnectionRepository } from "@/types/git";

// A repo-scope account sees hundreds of repositories across orgs. The filter is
// purely client-side over the pages already fetched, so the two empty states
// must not read alike: "nothing matched, but there are more pages to pull" is
// actionable, "nothing matched anywhere" is not.

const fetchNextPage = vi.fn();

let hasNextPage = true;

function repo(fullName: string): GitConnectionRepository {
  return {
    provider: "github",
    id: fullName,
    full_name: fullName,
    default_branch: "main",
    private: false,
    clone_url_https: `https://github.com/${fullName}.git`,
    updated_at: "2026-08-01T00:00:00Z",
  };
}

const LOADED = [
  "example/project",
  "Valaris-Studio/backplane-docs",
  "acme/website",
  "acme/billing-service",
  "acme/mobile-app",
  "octo/telemetry",
  "octo/ingest",
  "octo/scheduler",
  "personal/dotfiles",
  "personal/notes",
].map(repo);

vi.mock("../api/use-git-connections", () => ({
  useConnectionRepositories: () => ({
    data: { pages: [{ items: LOADED, next_cursor: hasNextPage ? "c2" : null }] },
    isLoading: false,
    isError: false,
    hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage,
  }),
}));

const { RepositoryPickerDialog } = await import(
  "../components/RepositoryPickerDialog"
);

function renderPicker() {
  const onSelect = vi.fn();
  renderWithProviders(
    <RepositoryPickerDialog
      slug="acme"
      connectionId="conn-1"
      open
      onOpenChange={vi.fn()}
      onSelect={onSelect}
    />,
  );
  return { onSelect, user: userEvent.setup() };
}

function filterInput() {
  return screen.getByTestId("repo-picker-filter");
}

function visibleRepoNames() {
  return screen
    .getAllByTestId("repo-picker-item")
    .map((node) => node.textContent ?? "");
}

beforeEach(() => {
  hasNextPage = true;
  fetchNextPage.mockClear();
});

describe("RepositoryPickerDialog — client-side filter", () => {
  it("narrows the list case-insensitively on full_name", async () => {
    const { user } = renderPicker();
    expect(visibleRepoNames()).toHaveLength(LOADED.length);

    await user.type(filterInput(), "OCTO");

    const shown = visibleRepoNames();
    expect(shown).toHaveLength(3);
    expect(shown.every((text) => text.includes("octo/"))).toBe(true);
  });

  it("clearing the filter restores every loaded repository", async () => {
    const { user } = renderPicker();
    await user.type(filterInput(), "octo");
    expect(visibleRepoNames()).toHaveLength(3);

    await user.clear(filterInput());

    expect(visibleRepoNames()).toHaveLength(LOADED.length);
  });

  it("offers Load more when nothing matched but more pages exist", async () => {
    const { user } = renderPicker();

    await user.type(filterInput(), "zzz-no-such-repo");

    expect(screen.queryAllByTestId("repo-picker-item")).toHaveLength(0);
    expect(screen.getByTestId("repo-picker-no-matches-more")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /load more/i }));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("says plainly that nothing matched when every page is loaded", async () => {
    hasNextPage = false;
    const { user } = renderPicker();

    await user.type(filterInput(), "zzz-no-such-repo");

    expect(screen.getByTestId("repo-picker-no-matches")).toBeInTheDocument();
    expect(
      screen.queryByTestId("repo-picker-no-matches-more"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /load more/i }),
    ).not.toBeInTheDocument();
  });

  it("never refetches on a keystroke", async () => {
    const { user } = renderPicker();

    await user.type(filterInput(), "acme");

    expect(fetchNextPage).not.toHaveBeenCalled();
  });

  it("still selects the repository the operator clicks after filtering", async () => {
    const { user, onSelect } = renderPicker();

    await user.type(filterInput(), "billing");
    await user.click(screen.getByTestId("repo-picker-item"));

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ full_name: "acme/billing-service" }),
    );
  });
});
