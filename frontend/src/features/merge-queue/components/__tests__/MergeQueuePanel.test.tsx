// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, within, userEvent } from "@/test/test-utils";
import { MergeQueuePanel, RECENTLY_MERGED_WINDOW_HOURS } from "../MergeQueuePanel";
import type { MergeQueueEntry, MergeQueueState } from "@/types/merge-queue";

const listQuery = vi.fn();
const reEnqueueMutate = vi.fn();
const cancelMutate = vi.fn();

vi.mock("../../api/use-merge-queue", () => ({
  useMergeQueue: (...args: unknown[]) => listQuery(...args),
  useReEnqueueMergeQueueEntry: () => ({ mutate: reEnqueueMutate, isPending: false }),
  useCancelMergeQueueEntry: () => ({ mutate: cancelMutate, isPending: false }),
}));

// Ages are computed against the real clock, so fixtures anchor to `now` —
// a hardcoded past date would make every default entry read as stale.
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function entry(state: MergeQueueState, overrides: Partial<MergeQueueEntry> = {}): MergeQueueEntry {
  return {
    id: `entry-${state}`,
    repo_id: "repo-1",
    integration_branch: "self-improve-1",
    card_id: `card-${state}`,
    pr_url: `https://github.com/acme/repo/pull/${state}`,
    pr_branch: `loop1/${state}`,
    workspace_id: "ws-1",
    enqueued_at: minutesAgo(1),
    first_enqueued_at: minutesAgo(1),
    state,
    attempt_count: 1,
    error_message: null,
    merged_at: null,
    ...overrides,
  };
}

const ALL_STATES: MergeQueueState[] = [
  "queued",
  "merging",
  "merged",
  "conflict",
  "failed",
  "blocked_pending_consolidation",
];

beforeEach(() => {
  listQuery.mockReset();
  reEnqueueMutate.mockReset();
  cancelMutate.mockReset();
});

describe("MergeQueuePanel", () => {
  it("renders a group for every state present, in queue-progression order", () => {
    listQuery.mockReturnValue({
      data: ALL_STATES.map((s) =>
        entry(s, { error_message: s === "failed" || s === "conflict" ? `${s} boom` : null }),
      ),
      isLoading: false,
      isError: false,
    });

    renderWithProviders(<MergeQueuePanel slug="ws" />);

    const rendered = screen
      .getAllByTestId(/^merge-queue-group-/)
      .map((el) => el.getAttribute("data-testid"));

    expect(rendered).toEqual([
      "merge-queue-group-merging",
      "merge-queue-group-queued",
      "merge-queue-group-conflict",
      "merge-queue-group-blocked_pending_consolidation",
      "merge-queue-group-failed",
      "merge-queue-group-merged",
    ]);
  });

  it("omits groups that have no entries", () => {
    listQuery.mockReturnValue({
      data: [entry("queued")],
      isLoading: false,
      isError: false,
    });

    renderWithProviders(<MergeQueuePanel slug="ws" />);

    expect(screen.getByTestId("merge-queue-group-queued")).toBeInTheDocument();
    expect(screen.queryByTestId("merge-queue-group-merged")).not.toBeInTheDocument();
  });

  it("shows branch flow, attempt count and a card deep-link on each row", () => {
    listQuery.mockReturnValue({
      data: [entry("queued", { attempt_count: 3 })],
      isLoading: false,
      isError: false,
    });

    renderWithProviders(<MergeQueuePanel slug="ws" />);

    const row = screen.getByTestId("merge-queue-entry-entry-queued");
    expect(within(row).getByText("loop1/queued")).toBeInTheDocument();
    expect(within(row).getByText("self-improve-1")).toBeInTheDocument();
    expect(within(row).getByText("3")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: /card/i })).toHaveAttribute(
      "href",
      "/ws/boards/card-queued",
    );
  });

  it("reveals a long error message only after expanding it", async () => {
    const longError = "x".repeat(400);
    listQuery.mockReturnValue({
      data: [entry("failed", { error_message: longError })],
      isLoading: false,
      isError: false,
    });

    renderWithProviders(<MergeQueuePanel slug="ws" />);

    const row = screen.getByTestId("merge-queue-entry-entry-failed");
    expect(within(row).queryByText(longError)).not.toBeInTheDocument();

    await userEvent.click(within(row).getByRole("button", { name: /details/i }));
    expect(within(row).getByText(longError)).toBeInTheDocument();
  });

  it("offers Re-enqueue only on failed rows and Cancel only on queued rows", () => {
    listQuery.mockReturnValue({
      data: ALL_STATES.map((s) => entry(s)),
      isLoading: false,
      isError: false,
    });

    renderWithProviders(<MergeQueuePanel slug="ws" />);

    for (const state of ALL_STATES) {
      const row = screen.getByTestId(`merge-queue-entry-entry-${state}`);
      const reEnqueue = within(row).queryByRole("button", { name: /re-enqueue/i });
      const cancel = within(row).queryByRole("button", { name: /^cancel$/i });

      expect(Boolean(reEnqueue)).toBe(state === "failed");
      expect(Boolean(cancel)).toBe(state === "queued");
    }
  });

  it("dispatches re-enqueue by card_id and cancel by entry id", async () => {
    listQuery.mockReturnValue({
      data: [entry("failed"), entry("queued")],
      isLoading: false,
      isError: false,
    });

    renderWithProviders(<MergeQueuePanel slug="ws" />);

    await userEvent.click(
      within(screen.getByTestId("merge-queue-entry-entry-failed")).getByRole("button", {
        name: /re-enqueue/i,
      }),
    );
    expect(reEnqueueMutate).toHaveBeenCalledWith({ card_id: "card-failed" });

    await userEvent.click(
      within(screen.getByTestId("merge-queue-entry-entry-queued")).getByRole("button", {
        name: /^cancel$/i,
      }),
    );
    expect(cancelMutate).toHaveBeenCalledWith({ entryId: "entry-queued" });
  });

  it("renders the idle empty state when the queue has no entries", () => {
    listQuery.mockReturnValue({ data: [], isLoading: false, isError: false });

    renderWithProviders(<MergeQueuePanel slug="ws" />);

    expect(screen.getByText(/merge queue is idle/i)).toBeInTheDocument();
    expect(screen.queryByTestId(/^merge-queue-group-/)).not.toBeInTheDocument();
  });

  it("asks for no merged window until the operator opts in", async () => {
    listQuery.mockReturnValue({ data: [entry("queued")], isLoading: false, isError: false });

    renderWithProviders(<MergeQueuePanel slug="ws" />);

    expect(listQuery).toHaveBeenLastCalledWith("ws", undefined);

    await userEvent.click(screen.getByRole("button", { name: /include merged/i }));

    expect(listQuery).toHaveBeenLastCalledWith("ws", RECENTLY_MERGED_WINDOW_HOURS);
  });

  it("renders the merged group once the widened data arrives", async () => {
    listQuery.mockReturnValue({ data: [entry("queued")], isLoading: false, isError: false });

    const { rerender } = renderWithProviders(<MergeQueuePanel slug="ws" />);
    expect(screen.queryByTestId("merge-queue-group-merged")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /include merged/i }));

    listQuery.mockReturnValue({
      data: [entry("queued"), entry("merged", { merged_at: "2026-08-11T13:00:00Z" })],
      isLoading: false,
      isError: false,
    });
    rerender(<MergeQueuePanel slug="ws" />);

    expect(screen.getByTestId("merge-queue-group-merged")).toBeInTheDocument();
  });

  it("labels each entry with its state pill", () => {
    listQuery.mockReturnValue({
      data: [entry("blocked_pending_consolidation")],
      isLoading: false,
      isError: false,
    });

    renderWithProviders(<MergeQueuePanel slug="ws" />);

    const row = screen.getByTestId("merge-queue-entry-entry-blocked_pending_consolidation");
    expect(within(row).getByText(/awaiting consolidation/i)).toBeInTheDocument();
  });
});

describe("MergeQueuePanel stale surfacing", () => {
  it("flags a hot-retry entry as stale even though its FIFO position is fresh", () => {
    // The exact shape the backend sibling (migration 088) exists to expose:
    // enqueued_at keeps getting bumped to the back of the queue, so only
    // first_enqueued_at reveals that this has been stuck for 90 minutes.
    listQuery.mockReturnValue({
      data: [
        entry("queued", {
          enqueued_at: minutesAgo(1),
          first_enqueued_at: minutesAgo(90),
          attempt_count: 12,
          error_message: "merge conflict in backend/app/main.py",
        }),
      ],
      isLoading: false,
      isError: false,
    });

    renderWithProviders(<MergeQueuePanel slug="ws" />);

    const row = screen.getByTestId("merge-queue-entry-entry-queued");
    expect(row).toHaveAttribute("data-stale", "entry_failing");
    expect(within(row).getByText(/failing/i)).toBeInTheDocument();
    // 90 minutes since FIRST enqueue, not the 1 minute since the last retry —
    // reading the FIFO field would render "1m in queue" here.
    expect(within(row).getByText(/1h in queue/i)).toBeInTheDocument();
  });

  it("distinguishes an untouched aged entry as a stalled worker", () => {
    listQuery.mockReturnValue({
      data: [
        entry("queued", {
          first_enqueued_at: minutesAgo(30),
          attempt_count: 0,
          error_message: null,
        }),
      ],
      isLoading: false,
      isError: false,
    });

    renderWithProviders(<MergeQueuePanel slug="ws" />);

    const row = screen.getByTestId("merge-queue-entry-entry-queued");
    expect(row).toHaveAttribute("data-stale", "worker_stalled");
    expect(within(row).getByText(/not being worked/i)).toBeInTheDocument();
  });

  it("leaves fresh entries unflagged", () => {
    listQuery.mockReturnValue({
      data: [entry("queued")],
      isLoading: false,
      isError: false,
    });

    renderWithProviders(<MergeQueuePanel slug="ws" />);

    const row = screen.getByTestId("merge-queue-entry-entry-queued");
    expect(row).not.toHaveAttribute("data-stale");
    expect(within(row).queryByText(/failing|not being worked/i)).not.toBeInTheDocument();
  });

  it("summarises the stale count above the queue so it is visible without scrolling", () => {
    listQuery.mockReturnValue({
      data: [
        entry("queued", { first_enqueued_at: minutesAgo(90), attempt_count: 4 }),
        entry("merging", { first_enqueued_at: minutesAgo(40), attempt_count: 0 }),
        entry("failed"),
      ],
      isLoading: false,
      isError: false,
    });

    renderWithProviders(<MergeQueuePanel slug="ws" />);

    expect(screen.getByTestId("merge-queue-stale-banner")).toHaveTextContent(/2/);
  });

  it("shows no banner when nothing is stale", () => {
    listQuery.mockReturnValue({
      data: [entry("queued"), entry("merging")],
      isLoading: false,
      isError: false,
    });

    renderWithProviders(<MergeQueuePanel slug="ws" />);

    expect(screen.queryByTestId("merge-queue-stale-banner")).not.toBeInTheDocument();
  });

  it("does not flag terminal states no matter how old they are", () => {
    listQuery.mockReturnValue({
      data: [
        entry("failed", { first_enqueued_at: minutesAgo(600), error_message: "boom" }),
        entry("merged", { first_enqueued_at: minutesAgo(600), merged_at: minutesAgo(590) }),
      ],
      isLoading: false,
      isError: false,
    });

    renderWithProviders(<MergeQueuePanel slug="ws" />);

    expect(screen.getByTestId("merge-queue-entry-entry-failed")).not.toHaveAttribute("data-stale");
    expect(screen.getByTestId("merge-queue-entry-entry-merged")).not.toHaveAttribute("data-stale");
    expect(screen.queryByTestId("merge-queue-stale-banner")).not.toBeInTheDocument();
  });
});
