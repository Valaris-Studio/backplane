// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { BoardTimelinePage } from "../BoardTimelinePage";

vi.mock("@/features/timeline/components/TimelineSimulator", () => ({
  TimelineSimulator: function TimelineSimulator({ slug, boardId }: { slug: string; boardId: string }) {
    const [state, setState] = useState({ cardId: "all", playhead: 0 });
    return (
      <div>
        <p data-testid="timeline-board">{slug}/{boardId}</p>
        <p data-testid="timeline-state">{state.cardId}:{state.playhead}</p>
        <button onClick={() => setState({ cardId: "selected-card", playhead: 12 })}>Choose card and frame</button>
      </div>
    );
  },
}));

function App({ revision = 0 }: { revision?: number }) {
  return (
    <MemoryRouter initialEntries={["/workspace-one/boards/board-one/timeline"]}>
      <div data-revision={revision}>
        <Link to="/workspace-one/boards/board-two/timeline">Other board</Link>
        <Link to="/workspace-two/boards/board-one/timeline">Other workspace</Link>
        <Routes>
          <Route path="/:slug/boards/:boardId/timeline" element={<BoardTimelinePage />} />
        </Routes>
      </div>
    </MemoryRouter>
  );
}

describe("BoardTimelinePage state isolation", () => {
  it.each([
    ["Other board", "workspace-one/board-two"],
    ["Other workspace", "workspace-two/board-one"],
  ])("resets card filters and playhead when navigating to %s", async (link, expectedBoard) => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Choose card and frame" }));
    expect(screen.getByTestId("timeline-state")).toHaveTextContent("selected-card:12");
    await user.click(screen.getByRole("link", { name: link }));
    expect(screen.getByTestId("timeline-board")).toHaveTextContent(expectedBoard);
    expect(screen.getByTestId("timeline-state")).toHaveTextContent("all:0");
  });

  it("preserves filters and playhead on ordinary rerenders of the same board", async () => {
    const user = userEvent.setup();
    const view = render(<App />);
    await user.click(screen.getByRole("button", { name: "Choose card and frame" }));
    view.rerender(<App revision={1} />);
    expect(screen.getByTestId("timeline-state")).toHaveTextContent("selected-card:12");
  });
});
