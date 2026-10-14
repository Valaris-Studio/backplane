// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderWithProviders, screen, userEvent, within } from "@/test/test-utils";
import type { RhythmBucket, SessionRhythm } from "@/types/agent-session";
import { SLUG, makeSession } from "../../__tests__/fixtures";
import { setPromptsHidden } from "../../hooks/use-hide-prompts";
import { RhythmView } from "../RhythmStrip";

const START = Date.parse("2026-10-05T14:00:00Z");
const MINUTE = 60_000;

function bucket(index: number, counts: Partial<Omit<RhythmBucket, "t">> = {}): RhythmBucket {
  return { t: new Date(START + index * MINUTE).toISOString(), prompt: 0, tool: 0, file: 0, work: 0, error: 0, ...counts };
}

function rhythm(overrides: Partial<SessionRhythm> = {}): SessionRhythm {
  const buckets = Array.from({ length: 72 }, (_, index) => bucket(index));
  buckets[2] = bucket(2, { prompt: 1, tool: 3 });
  buckets[21] = bucket(21, { prompt: 1, tool: 7, error: 1, work: 1 });
  buckets[30] = bucket(30, { file: 2 });
  return {
    start: new Date(START).toISOString(),
    end: new Date(START + 72 * MINUTE).toISOString(),
    live: false,
    bucket_seconds: 60,
    buckets,
    idle_spans: [{ start: new Date(START + 35 * MINUTE).toISOString(), end: new Date(START + 56 * MINUTE).toISOString() }],
    children: [
      {
        session_id: "child-1",
        harness: "claude_code",
        harness_display_name: "Claude Code",
        title: "Explore · map callers",
        start: new Date(START + 9 * MINUTE).toISOString(),
        end: new Date(START + 16 * MINUTE).toISOString(),
        display_state: "ended",
      },
    ],
    capture_gaps: 0,
    ...overrides,
  };
}

const SESSION = makeSession({ started_at: new Date(START).toISOString(), last_event_at: new Date(START + 72 * MINUTE).toISOString() });

function renderStrip(data: SessionRhythm = rhythm(), onJump = vi.fn()) {
  renderWithProviders(<RhythmView slug={SLUG} session={SESSION} rhythm={data} onJump={onJump} />);
  return onJump;
}

afterEach(() => {
  act(() => setPromptsHidden(false));
});

describe("Session rhythm", () => {
  it("states wall time once, and that subagent time overlaps", () => {
    renderStrip();
    const region = screen.getByRole("region", { name: "Session rhythm" });
    expect(region).toHaveTextContent("1h 12m wall time");
    expect(region).toHaveTextContent("subagent time overlaps and is counted once");
    const legend = within(region).getByRole("list", { name: "Legend" });
    for (const kind of ["Your prompts", "Tools", "File edits", "Backplane work", "Failures"]) {
      expect(within(legend).getByText(kind)).toBeInTheDocument();
    }
  });

  it("describes itself as an image and offers the same buckets as a table", () => {
    renderStrip();
    const picture = screen.getByRole("img", { name: /^Session rhythm from .+: 2 prompts, 14 calls, 1 failed, 1 subagent$/ });
    expect(picture).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Rhythm as a list" });
    expect(within(table).getAllByRole("row")).toHaveLength(1 + 3);
  });

  it("labels long silences and says, without placing them, how many records are missing", () => {
    renderStrip(rhythm({ capture_gaps: 3 }));
    expect(screen.getByText("idle 21m")).toBeInTheDocument();
    expect(screen.getByText("3 records weren't captured; when is unknown")).toBeInTheDocument();
  });

  it("draws each subagent as a lane that opens its session", () => {
    renderStrip();
    expect(screen.getByRole("link", { name: "Open subagent session: Explore · map callers" })).toHaveAttribute(
      "href",
      `/${SLUG}/sessions/child-1`,
    );
  });

  it("moves through active stretches with the arrow keys and jumps to a turn on Enter", async () => {
    const onJump = renderStrip();
    const strip = screen.getByRole("group", { name: /Activity over time/ });
    const first = within(strip).getAllByRole("button")[0] as HTMLElement;
    first.focus();
    expect(first).toHaveAccessibleName(/3 calls/);

    await userEvent.keyboard("{ArrowRight}");
    const second = within(strip).getAllByRole("button")[1] as HTMLElement;
    expect(second).toHaveFocus();
    expect(second).toHaveAccessibleName(/9 calls · 1 failed/);
    expect(screen.getByTestId("rhythm-readout")).toHaveTextContent("9 calls · 1 failed");

    await userEvent.keyboard("{Enter}");
    expect(onJump).toHaveBeenCalledWith(new Date(START + 22 * MINUTE).toISOString());
  });

  it("marks now on a live session", () => {
    renderStrip(rhythm({ live: true }));
    expect(screen.getByText("now")).toBeInTheDocument();
  });

  it("blurs subagent titles in presenter mode", () => {
    act(() => setPromptsHidden(true));
    renderStrip();
    expect(screen.getAllByText("Explore · map callers")[0]).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("link", { name: "Open subagent session: Prompt hidden" })).toBeInTheDocument();
  });
});
