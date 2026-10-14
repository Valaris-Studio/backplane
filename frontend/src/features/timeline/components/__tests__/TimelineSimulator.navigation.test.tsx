// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen, waitFor, userEvent } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { TimelineSimulator } from "../TimelineSimulator";
import { generation, overview, readyWindow, HISTORY_BASE, GENERATION_ID } from "../../__tests__/history-fixtures";

function setup() {
  const selectors: URLSearchParams[] = [];
  server.use(
    http.post(`/api${HISTORY_BASE}/generations`, () => HttpResponse.json(generation())),
    http.get(`/api${HISTORY_BASE}/generations/${GENERATION_ID}/overview`, () => HttpResponse.json(overview())),
    http.get(`/api${HISTORY_BASE}/generations/${GENERATION_ID}/window`, ({ request }) => {
      const selector = new URL(request.url).searchParams;
      selectors.push(selector);
      return HttpResponse.json(readyWindow(selector.get("cursor") === "before-42" ? 39 : selector.has("cursor") ? 45 : 42));
    }),
  );
  renderWithProviders(<TimelineSimulator slug="test-ws" boardId="development" />);
  return selectors;
}

describe("history keyboard window boundaries", () => {
  it("steps into the next contiguous window after the last event", async () => {
    const selectors = setup();
    const slider = await screen.findByRole("slider", { name: "Timeline position" });
    fireEvent.change(slider, { target: { value: "2" } });
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    await waitFor(() => expect(selectors.at(-1)?.get("cursor")).toBe("after-44"));
    expect(await screen.findByRole("slider", { name: "Timeline position" })).toHaveValue("0");
  });

  it("steps to the final event in the previous contiguous window", async () => {
    const selectors = setup();
    await screen.findByRole("slider", { name: "Timeline position" });
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    await waitFor(() => expect(selectors.at(-1)?.get("cursor")).toBe("before-42"));
    await waitFor(() => expect(screen.getByRole("slider", { name: "Timeline position" })).toHaveValue("2"));
  });
});


it("Play at a middle window's end continues forward instead of restarting that window", async () => {
  const selectors = setup();
  const slider = await screen.findByRole("slider", { name: "Timeline position" });
  fireEvent.change(slider, { target: { value: "2" } });
  await userEvent.setup().click(screen.getByRole("button", { name: "Play" }));
  await waitFor(() => expect(selectors.at(-1)?.get("cursor")).toBe("after-44"));
  await waitFor(() => {
    const nextWindow = screen.getByRole("slider", { name: "Timeline position" });
    expect(nextWindow).toHaveValue("0");
    expect(nextWindow).toHaveAttribute("aria-valuetext", "1 / 3: Recorded event 45");
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });
});

it("running playback advances across a window boundary after showing its final event", async () => {
  const selectors = setup();
  const slider = await screen.findByRole("slider", { name: "Timeline position" });
  fireEvent.change(slider, { target: { value: "1" } });
  await userEvent.setup().click(screen.getByRole("button", { name: "Play" }));
  await waitFor(() => expect(slider).toHaveValue("2"), { timeout: 1800 });
  expect(selectors).toHaveLength(1);
  await waitFor(() => expect(selectors.at(-1)?.get("cursor")).toBe("after-44"), { timeout: 1800 });
  // The ready next window commits one render before its resume effect plays,
  // so assert the ready window and resumed playback together. The slider is
  // hidden while loading, which rules out the loading-state Pause fallback;
  // its value text names event 45, which rules out restarting the old window.
  await waitFor(() => {
    const nextWindow = screen.getByRole("slider", { name: "Timeline position" });
    expect(nextWindow).toHaveValue("0");
    expect(nextWindow).toHaveAttribute("aria-valuetext", "1 / 3: Recorded event 45");
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });
});

it("cancels pending automatic playback when switching to the observed board", async () => {
  setup();
  let releaseWindow!: () => void;
  const pendingWindow = new Promise<void>((resolve) => { releaseWindow = resolve; });
  let requestedNext = false;
  server.use(
    http.get(`/api${HISTORY_BASE}/generations/${GENERATION_ID}/window`, async ({ request }) => {
      if (new URL(request.url).searchParams.has("cursor")) {
        requestedNext = true;
        await pendingWindow;
        return HttpResponse.json(readyWindow(45));
      }
      return HttpResponse.json(readyWindow(42));
    }),
    http.get(`/api${HISTORY_BASE}/generations/${GENERATION_ID}/live-head`, () => HttpResponse.json({
      generation_id: GENERATION_ID, observed_at: generation().created_at, head_seq: generation().head_seq,
      state: readyWindow().anchor.state,
    })),
  );
  const user = userEvent.setup();
  const slider = await screen.findByRole("slider", { name: "Timeline position" });
  fireEvent.change(slider, { target: { value: "2" } });
  await user.click(screen.getByRole("button", { name: "Play" }));
  await waitFor(() => expect(requestedNext).toBe(true));
  await user.click(screen.getByRole("button", { name: "Observed board" }));
  await screen.findByText(/This observation is separate from historical replay/);
  releaseWindow();
  await waitFor(() => expect(screen.getByRole("slider", { hidden: true })).toHaveAttribute("max", "2"));
  expect(screen.queryByRole("button", { name: "Pause", hidden: true })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Return to replay" })).toBeInTheDocument();
});

it("restarts the full generation from a one-event final window", async () => {
  setup();
  let requestedSequence: string | null = null;
  server.use(http.get(`/api${HISTORY_BASE}/generations/${GENERATION_ID}/window`, ({ request }) => {
    requestedSequence = new URL(request.url).searchParams.get("at_seq");
    if (requestedSequence) return HttpResponse.json(readyWindow(0));
    const final = readyWindow(10_000);
    final.events = final.events.slice(0, 1);
    final.window.last_seq = final.window.first_seq;
    return HttpResponse.json(final);
  }));
  const slider = await screen.findByRole("slider", { name: "Timeline position" });
  expect(slider).toHaveAttribute("max", "0");
  await userEvent.setup().click(screen.getByRole("button", { name: /Replay from start/i }));
  await waitFor(() => expect(requestedSequence).toBe(generation().first_seq));
  await waitFor(() => expect(screen.getByRole("slider", { name: "Timeline position" })).toHaveAttribute("max", "2"));
  expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
});
