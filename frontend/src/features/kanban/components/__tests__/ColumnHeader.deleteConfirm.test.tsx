// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import { ColumnHeader } from "../ColumnHeader";

const SLUG = "acme";

server.use(
  http.get(`/api/workspaces/${SLUG}/config`, () =>
    HttpResponse.json({
      max_rework_attempts: 3,
      card_cooldown_hours: 1,
      commit_message_template: "",
      pr_description_template: "",
      pipeline_config: null,
      version: 1,
      enforce_done_merge_gate: false,
    }),
  ),
);

function setup(overrides: Partial<React.ComponentProps<typeof ColumnHeader>> = {}) {
  const props = {
    name: "To Do",
    columnType: "backlog" as const,
    cardCount: 3,
    slug: SLUG,
    onRename: vi.fn(),
    onTypeChange: vi.fn(),
    onDelete: vi.fn(),
    sortMode: "position" as const,
    onSortChange: vi.fn(),
    ...overrides,
  };
  return { props, ...renderWithProviders(<ColumnHeader {...props} />) };
}

async function openDeleteMenuItem(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: en.a11y.column.more }));
  await user.click(await screen.findByRole("menuitem", { name: en.common.delete }));
}

describe("ColumnHeader delete confirmation", () => {
  it("does not delete on the menu click — it opens a confirmation dialog instead", async () => {
    const user = userEvent.setup();
    const { props } = setup();

    await openDeleteMenuItem(user);

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it("names the column and the exact number of cards that will be destroyed", async () => {
    const user = userEvent.setup();
    setup({ name: "Blocked Work", cardCount: 7 });

    await openDeleteMenuItem(user);

    const body = (await screen.findByRole("dialog")).textContent ?? "";
    expect(body).toContain("Blocked Work");
    expect(body).toMatch(/\b7\b/);
  });

  it("calls onDelete exactly once when the destructive confirm button is pressed", async () => {
    const user = userEvent.setup();
    const { props } = setup();

    await openDeleteMenuItem(user);
    await user.click(
      await screen.findByRole("button", { name: en.columns.delete.confirm }),
    );

    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  it("deletes nothing and dismisses when Cancel is pressed", async () => {
    const user = userEvent.setup();
    const { props } = setup();

    await openDeleteMenuItem(user);
    await user.click(
      await screen.findByRole("button", { name: en.common.cancel }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it("still confirms on an empty column, without claiming cards will be lost", async () => {
    const user = userEvent.setup();
    setup({ name: "Empty", cardCount: 0, totalCount: 0 });

    await openDeleteMenuItem(user);

    const body = (await screen.findByRole("dialog")).textContent ?? "";
    expect(body).toContain("Empty");
    // The zero-card body must not warn about card loss — nothing is at stake.
    expect(body).not.toMatch(/\bcards?\b/i);
  });

  it("reports totalCount, not the filtered visible count, when a board filter hides cards", async () => {
    const user = userEvent.setup();
    // Board filter is showing 1 of 9 — the delete destroys all 9.
    setup({ name: "Filtered", cardCount: 1, visibleCount: 1, totalCount: 9 });

    await openDeleteMenuItem(user);

    const body = (await screen.findByRole("dialog")).textContent ?? "";
    expect(body).toMatch(/\b9\b/);
    expect(body).not.toMatch(/\b1 card\b/);
  });

  it("ships the confirmation copy in both en and es", () => {
    for (const catalog of [en, es]) {
      const del = (catalog as unknown as {
        columns: { delete: Record<string, string> };
      }).columns.delete;
      expect(del.confirmTitle).toBeTruthy();
      expect(del.confirm).toBeTruthy();
      expect(del.confirmBody_zero).toBeTruthy();
      expect(del.confirmBody_one).toContain("{{name}}");
      expect(del.confirmBody_other).toContain("{{name}}");
      expect(del.confirmBody_other).toContain("{{count}}");
    }
  });
});
