// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderWithProviders, screen, userEvent, act } from "@/test/test-utils";
import type { Definition } from "@/types/definition";

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
  useParams: () => ({ slug: "acme", boardId: "board-1" }),
}));

import { DefinitionEditor } from "../DefinitionEditor";

const SAVED_DEFINITION = {
  scope: "Ship the thing",
  content: {
    // A seeded objective gives the test a plain <input> to dirty the form
    // through. The scope field is a TipTap rich-text editor, which userEvent
    // can't drive meaningfully in jsdom.
    objectives: [{ text: "Launch", priority: null }],
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
  updated_by: "someone",
  updated_at: "2026-01-01T00:00:00Z",
} as unknown as Definition;

let mutate: ReturnType<typeof vi.fn>;

function saveButtons() {
  return screen.getAllByRole("button", { name: /^(save|saved)$/i });
}

// Looked up by placeholder, not display value: the value changes as the test
// types, and this is the only objective row on the fixture.
function objectiveInput() {
  return screen.getByPlaceholderText(/objective/i);
}

beforeEach(() => {
  vi.clearAllMocks();
  mutate = vi.fn();
  useBoardMock.mockReturnValue({
    data: { id: "board-1", is_frozen: false, has_definition: true },
  });
  useDefinitionMock.mockReturnValue({
    data: SAVED_DEFINITION,
    isLoading: false,
  });
  useUpsertDefinitionMock.mockReturnValue({ mutate, isPending: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DefinitionEditor — Save is gated on unsaved changes", () => {
  it("disables both Save buttons on a freshly loaded, unmodified definition", () => {
    renderWithProviders(<DefinitionEditor />);
    const buttons = saveButtons();
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const button of buttons) expect(button).toBeDisabled();
  });

  it("enables Save once an objective is edited", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DefinitionEditor />);

    await user.type(objectiveInput(), " more");

    for (const button of saveButtons()) expect(button).toBeEnabled();
  });

  it("re-disables Save when the edit is reverted back to the saved value", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DefinitionEditor />);

    await user.type(objectiveInput(), "X");
    for (const button of saveButtons()) expect(button).toBeEnabled();

    await user.type(objectiveInput(), "{backspace}");
    for (const button of saveButtons()) expect(button).toBeDisabled();
  });

  it("keeps Save disabled on a frozen board even when there are unsaved changes", async () => {
    const user = userEvent.setup();
    useBoardMock.mockReturnValue({
      data: { id: "board-1", is_frozen: true, has_definition: true },
    });
    renderWithProviders(<DefinitionEditor />);

    // The textbox itself may be editable; the gate under test is the button.
    await user.type(objectiveInput(), "X").catch(() => {});

    for (const button of saveButtons()) expect(button).toBeDisabled();
  });

  it("starts enabled for a board with no definition yet — the seeded Start milestone is unsaved content", () => {
    useDefinitionMock.mockReturnValue({ data: null, isLoading: false });
    renderWithProviders(<DefinitionEditor />);

    for (const button of saveButtons()) expect(button).toBeEnabled();
  });
});

describe("DefinitionEditor — save feedback", () => {
  it("shows a transient Saved label after a successful save, then returns to Save", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<DefinitionEditor />);

    await user.type(objectiveInput(), "X");
    await user.click(saveButtons()[0]!);

    expect(mutate).toHaveBeenCalledTimes(1);
    // The component drives feedback off the mutation's onSuccess callback.
    const onSuccess = mutate.mock.calls[0]![1]?.onSuccess as
      | (() => void)
      | undefined;
    expect(onSuccess).toBeTypeOf("function");
    act(() => onSuccess!());

    expect(screen.getAllByText(/^saved$/i).length).toBeGreaterThanOrEqual(1);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText(/^saved$/i)).not.toBeInTheDocument();
  });

  it("disables Save again after a successful save — state now matches the baseline", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DefinitionEditor />);

    await user.type(objectiveInput(), "X");
    await user.click(saveButtons()[0]!);

    const onSuccess = mutate.mock.calls[0]![1]?.onSuccess as () => void;
    act(() => onSuccess());

    for (const button of saveButtons()) expect(button).toBeDisabled();
  });

  it("re-enables Save on a second edit made after a successful save", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DefinitionEditor />);

    await user.type(objectiveInput(), "X");
    await user.click(saveButtons()[0]!);
    const onSuccess = mutate.mock.calls[0]![1]?.onSuccess as () => void;
    act(() => onSuccess());

    await user.type(objectiveInput(), "Y");

    for (const button of saveButtons()) expect(button).toBeEnabled();
  });

  it("keeps the pending label while the mutation is in flight", () => {
    useUpsertDefinitionMock.mockReturnValue({ mutate, isPending: true });
    renderWithProviders(<DefinitionEditor />);

    expect(screen.getAllByText(/saving/i).length).toBeGreaterThanOrEqual(2);
  });
});
