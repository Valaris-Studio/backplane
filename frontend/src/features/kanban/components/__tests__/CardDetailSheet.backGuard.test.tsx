// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { useSearchParams } from "react-router-dom";
import { act, screen, stubReducedMotion, userEvent } from "@/test/test-utils";
import { renderNavigationRouter } from "@/test/navigation-router";
import type { Card, Column } from "@/types/kanban";

const update = vi.fn();
const move = vi.fn();
vi.mock("../../hooks/use-optimistic-card-move", () => ({ useOptimisticCardMove: () => ({ mutate: move, isPending: false }) }));
vi.mock("../../api/use-cards", () => ({
  useUpdateCard: () => ({ mutate: update, isPending: false }),
  useAddParticipant: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveParticipant: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteCard: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/features/members/api/use-members", () => ({ useMembers: () => ({ data: [] }) }));
vi.mock("@/features/agents/hooks/useAgentMetrics", () => ({ useCardExecutions: () => ({ data: [] }) }));
vi.mock("@/features/agents/hooks/usePipelineConfig", () => ({ usePipelineConfig: () => ({ pipelineConfig: null }) }));
vi.mock("@/features/notes/api/use-notes", () => ({ useNotes: () => ({ data: [] }), useUpdateNote: () => ({ mutate: vi.fn() }) }));
vi.mock("../DependenciesSection", () => ({ DependenciesSection: () => null }));
vi.mock("../CardCompletionSection", () => ({ CardCompletionSection: () => null }));
vi.mock("@/features/sessions/components/LinkedSessionsSection", () => ({ CardSessionsSection: () => null }));
vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: ({ content, onChange }: { content: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Card description" value={content} onChange={(event) => onChange(event.target.value)} />
  ),
}));
import { CardDetailSheet } from "../CardDetailSheet";

const card: Card = {
  id: "card-1", title: "Saved card", description: "Saved description", card_type: "task", priority: "medium",
  position: 1024, column_id: "column-1", participants: [], due_date: null, status: null, labels: null,
  created_at: "2026-10-18T04:00:00Z", updated_at: "2026-10-18T04:00:00Z",
};
const columns: Column[] = [{ id: "column-1", name: "In progress", position: 1024, board_id: "board-1", column_type: "active", cards: [], created_at: card.created_at, updated_at: card.updated_at }];
columns.push({ ...columns[0]!, id: "column-2", name: "Queued", column_type: "backlog" });
const boardPath = "/acme/boards/board-1/kanban?filter=mine&sort=priority";
const cardPath = `${boardPath}&card=card-1`;
function BoardRoute() {
  const [params, setParams] = useSearchParams();
  const open = params.has("card");
  return <><h1>Filtered board</h1><CardDetailSheet card={open ? card : null} columns={columns} slug="acme" boardId="board-1" open={open}
    onOpenChange={(next) => { if (!next) setParams((current) => { current.delete("card"); return current; }); }} /></>;
}
function mount() {
  return renderNavigationRouter([{ path: "/acme/boards/board-1/kanban", element: <BoardRoute /> }], { initialEntries: [boardPath, cardPath], initialIndex: 1 });
}
function edit() {
  fireEvent.change(screen.getByDisplayValue("Saved card"), { target: { value: "Unsaved card" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Card description" }), { target: { value: "Unsaved description" } });
}
beforeEach(() => { update.mockReset(); move.mockReset(); stubReducedMotion(true); });
afterEach(() => stubReducedMotion(false));

describe("CardDetailSheet query-only Back", () => {
  it("blocks removal of the selected card query and Cancel retains all edits", async () => {
    const { router } = mount();
    edit();
    await act(async () => { await router.navigate(-1); });
    expect(router.state.location.pathname + router.state.location.search).toBe(cardPath);
    await userEvent.click(screen.getByTestId("unsaved-changes-keep-editing"));
    expect(screen.getByDisplayValue("Unsaved card")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Card description" })).toHaveValue("Unsaved description");
    expect(update).not.toHaveBeenCalled();
  });

  it("Discard removes the sheet through POP while preserving the board filters", async () => {
    const { router } = mount();
    edit();
    await act(async () => { await router.navigate(-1); });
    expect(router.state.location.pathname + router.state.location.search).toBe(cardPath);
    await userEvent.click(screen.getByTestId("unsaved-changes-discard"));
    expect(router.state.location.pathname + router.state.location.search).toBe(boardPath);
    expect(router.state.historyAction).toBe("POP");
    expect(screen.queryByDisplayValue("Unsaved card")).not.toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it.each(["sheet Save", "pending-route Save"])("%s keeps the exact draft when column move fails even if the field update succeeds", async (action) => {
    const { router } = mount();
    const user = userEvent.setup();
    edit();
    await user.click(document.querySelector<HTMLButtonElement>('button[id$="-column"]')!);
    await user.click(await screen.findByRole("option", { name: "Queued" }));
    if (action === "pending-route Save") {
      await act(async () => { await router.navigate(-1); });
      expect(router.state.location.pathname + router.state.location.search).toBe(cardPath);
      await user.click(screen.getByTestId("unsaved-changes-save"));
    } else {
      await user.click(screen.getByRole("button", { name: "Save" }));
    }
    expect(move).toHaveBeenCalledTimes(1);
    expect(move.mock.calls[0]![0]).toMatchObject({ cardId: "card-1", column_id: "column-2" });
    await act(async () => {
      move.mock.calls[0]![1]?.onError?.(new Error("move rejected"));
      // Either ordering is valid: if the field write was sent concurrently,
      // its later success cannot turn the rejected move into a successful save.
      const fieldWrite = update.mock.calls[0];
      if (fieldWrite) {
        const { cardId, ...fields } = fieldWrite[0];
        fieldWrite[1]?.onSuccess?.({ ...card, ...fields, id: cardId } satisfies Card);
      }
    });
    expect(router.state.location.pathname + router.state.location.search).toBe(cardPath);
    expect(screen.getByDisplayValue("Unsaved card")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Card description" })).toHaveValue("Unsaved description");
    expect(document.querySelector('button[id$="-column"]')).toHaveTextContent("Queued");
  });

  it("allows clean query-only Back without a prompt or write", async () => {
    const { router } = mount();
    await act(async () => { await router.navigate(-1); });
    expect(router.state.location.pathname + router.state.location.search).toBe(boardPath);
    expect(screen.queryByTestId("unsaved-changes-prompt")).not.toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });
});
