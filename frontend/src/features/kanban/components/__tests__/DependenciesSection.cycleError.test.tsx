// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  renderWithProviders,
  screen,
  userEvent,
  within,
} from "@/test/test-utils";
import i18n from "@/i18n/config";
import { ApiError } from "@/lib/api-error";
import type { Card, Column } from "@/types/kanban";

// The bulk-set mutation rejects the way the axios interceptor would for a
// backend ValidationError(error_code="cycle_detected") — HTTP 400, no
// success path — so the picker's onError is the only callback that fires.
const bulkSetMutate = vi.fn(
  (
    _vars: unknown,
    callbacks: { onError?: (error: unknown) => void },
  ) => {
    callbacks.onError?.(
      new ApiError(
        "Adding card-a -> card-b would create a cycle",
        400,
        "Adding card-a -> card-b would create a cycle",
        { errorCode: "cycle_detected" },
      ),
    );
  },
);

vi.mock("@/features/kanban/api/use-dependencies", () => ({
  useCardDependencies: () => ({ data: { depends_on: [], blocks: [] } }),
  useRemoveDependency: () => ({ mutate: vi.fn(), isPending: false }),
  useBulkSetDependencies: () => ({ mutate: bulkSetMutate, isPending: false }),
  isCycleError: () => true,
}));

import { DependenciesSection } from "../DependenciesSection";

function makeCard(overrides: Partial<Card>): Card {
  return {
    id: "card-a",
    title: "Card A",
    description: "",
    card_type: "task",
    priority: "medium",
    position: 1024,
    column_id: "col-1",
    participants: [],
    due_date: null,
    status: null,
    labels: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as Card;
}

const CARD_A = makeCard({ id: "card-a", title: "Card A" });
const CARD_B = makeCard({ id: "card-b", title: "Card B" });

const COLUMNS: Column[] = [
  {
    id: "col-1",
    name: "Backlog",
    position: 1024,
    board_id: "board-1",
    column_type: "backlog",
    cards: [CARD_A, CARD_B],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
];

const cycleMessage = () => i18n.t("errors.cycle_detected");

async function openPickerAndSaveCycle() {
  const user = userEvent.setup();
  renderWithProviders(
    <DependenciesSection
      card={CARD_A}
      slug="acme"
      boardId="board-1"
      columns={COLUMNS}
    />,
  );

  await user.click(
    screen.getByRole("button", {
      name: i18n.t("kanban.dependencies.manageDependencies"),
    }),
  );
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: /Card B/ }));
  await user.click(
    within(dialog).getByRole("button", {
      name: i18n.t("kanban.dependencies.pickerSave"),
    }),
  );
  expect(bulkSetMutate).toHaveBeenCalledTimes(1);
  return { user, dialog };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
});

describe("DependenciesSection — cycle error surfaces inside the picker dialog", () => {
  it("renders the cycle message inside the still-open picker dialog", async () => {
    const { dialog } = await openPickerAndSaveCycle();

    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      cycleMessage(),
    );
  });

  it("does not render the cycle message behind the dialog backdrop", async () => {
    const { dialog } = await openPickerAndSaveCycle();

    const renderedMessages = screen.getAllByText(cycleMessage());
    expect(renderedMessages).toHaveLength(1);
    for (const node of renderedMessages) {
      expect(dialog.contains(node)).toBe(true);
    }
  });
});
