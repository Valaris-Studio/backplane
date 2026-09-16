// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import type { Card, CardDependencyRead } from "@/types/kanban";
import i18n from "@/i18n/config";
const edges = { current: [] as CardDependencyRead[] };
const remove = vi.fn();
vi.mock("@/features/kanban/api/use-dependencies", () => ({
  useCardDependencies: () => ({ data: { depends_on: edges.current, blocks: [] } }),
  useRemoveDependency: () => ({ mutate: remove, isPending: false }),
  useBulkSetDependencies: () => ({ mutate: vi.fn(), isPending: false }),
}));
import { DependenciesSection } from "../DependenciesSection";
function renderEdge(edge: Partial<CardDependencyRead> & { satisfied?: boolean }) {
  edges.current = [{ card_id: "card-1", depends_on_card_id: "source-1", depends_on_title: "Source work", depends_on_status: null, depends_on_column_type: "active", created_at: "2026-09-13", created_by: "operator", ...edge }];
  renderWithProviders(<DependenciesSection card={{ id: "card-1" } as Card} slug="acme" boardId="board-1" columns={[]} />);
}
beforeEach(async () => { remove.mockClear(); await i18n.changeLanguage("en"); });
describe("authoritative completion dependency readiness", () => {
  it("shows accepted source as satisfied before Done and confirms its removal", async () => {
    renderEdge({ satisfied: true, depends_on_column_type: "active" });
    expect(screen.getByLabelText("Dependency satisfied")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: i18n.t("kanban.dependencies.removeDependency") }));
    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(remove).not.toHaveBeenCalled();
  });
  it("shows stale Done source as unsatisfied and removes without a satisfied confirmation", async () => {
    renderEdge({ satisfied: false, depends_on_column_type: "done" });
    expect(screen.getByLabelText("Dependency not satisfied")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: i18n.t("kanban.dependencies.removeDependency") }));
    expect(remove).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("retains the Done fallback only for a legacy edge without satisfaction", () => {
    renderEdge({ depends_on_column_type: "done" });
    expect(screen.getByLabelText("Dependency satisfied")).toBeVisible();
  });
});
