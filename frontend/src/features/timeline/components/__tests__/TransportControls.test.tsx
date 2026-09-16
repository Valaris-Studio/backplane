// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { TransportControls } from "../TransportControls";

// Controllable reduced-motion preference (jsdom's matchMedia stub always
// reports false; the component reads the hook directly since the simulator
// doesn't thread the prop down).
const { reducedMotionState } = vi.hoisted(() => ({
  reducedMotionState: { value: false },
}));
vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => reducedMotionState.value,
}));

beforeEach(() => {
  reducedMotionState.value = false;
});

// TransportControls is presentational: it renders play/pause, step±, speed, the
// current timestamp and caption, and calls the supplied callbacks. Buttons are
// disabled at the ends. Labels come from i18n; we query by accessible role/name
// (i18n is loaded in test-utils, so the EN strings resolve).

function setup(overrides: Partial<Parameters<typeof TransportControls>[0]> = {}) {
  const props = {
    playing: false,
    speed: 1,
    atStart: false,
    atEnd: false,
    currentTimestamp: "2026-01-01T12:00:00Z",
    caption: "Alice moved Login bug from Backlog to Active",
    onToggle: vi.fn(),
    onStepBack: vi.fn(),
    onStepForward: vi.fn(),
    onSpeedCycle: vi.fn(),
    ...overrides,
  };
  renderWithProviders(<TransportControls {...props} />);
  return props;
}

describe("TransportControls", () => {
  it("renders the caption text", () => {
    setup();
    expect(
      screen.getByText("Alice moved Login bug from Backlog to Active"),
    ).toBeInTheDocument();
  });

  it("renders play/step/speed controls", () => {
    setup();
    expect(screen.getByRole("button", { name: /play/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /previous event/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next event/i })).toBeInTheDocument();
    // speed control shows the multiplier label
    expect(screen.getByText(/1×/)).toBeInTheDocument();
  });

  it("shows a pause control when playing", () => {
    setup({ playing: true });
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
  });

  it("clicking the toggle calls onToggle", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: /play/i }));
    expect(props.onToggle).toHaveBeenCalledTimes(1);
  });

  it("clicking step-back / step-forward calls the respective callbacks", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: /previous event/i }));
    await user.click(screen.getByRole("button", { name: /next event/i }));
    expect(props.onStepBack).toHaveBeenCalledTimes(1);
    expect(props.onStepForward).toHaveBeenCalledTimes(1);
  });

  it("clicking the speed control cycles the speed", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: /speed/i }));
    expect(props.onSpeedCycle).toHaveBeenCalledTimes(1);
  });

  it("disables step-back at the start", () => {
    setup({ atStart: true });
    expect(screen.getByRole("button", { name: /previous event/i })).toBeDisabled();
  });

  it("disables step-forward at the end", () => {
    setup({ atEnd: true });
    expect(screen.getByRole("button", { name: /next event/i })).toBeDisabled();
  });

  it("reflects the current speed in the label", () => {
    setup({ speed: 4 });
    expect(screen.getByText(/4×/)).toBeInTheDocument();
  });
});

describe("TransportControls — replay-from-end affordance", () => {
  it("shows a replay control when stopped at the end", () => {
    setup({ atEnd: true, playing: false });
    expect(
      screen.getByRole("button", { name: /replay from start/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^play$/i })).not.toBeInTheDocument();
  });

  it("keeps the pause control while playing at the end", () => {
    setup({ atEnd: true, playing: true });
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /replay from start/i }),
    ).not.toBeInTheDocument();
  });

  it("clicking the replay control calls onToggle (reducer restarts from 0)", async () => {
    const user = userEvent.setup();
    const props = setup({ atEnd: true, playing: false });
    await user.click(screen.getByRole("button", { name: /replay from start/i }));
    expect(props.onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("TransportControls — playing halo", () => {
  it("pulses a live halo behind the toggle while playing", () => {
    setup({ playing: true });
    expect(screen.getByTestId("playing-halo")).toBeInTheDocument();
  });

  it("renders no halo when paused", () => {
    setup({ playing: false });
    expect(screen.queryByTestId("playing-halo")).not.toBeInTheDocument();
  });

  it("renders no halo under reduced motion even while playing", () => {
    reducedMotionState.value = true;
    setup({ playing: true });
    expect(screen.queryByTestId("playing-halo")).not.toBeInTheDocument();
    // static state encoding (variant swap) still works: pause label present
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
  });
});


it("omits an empty caption block when the event is described separately", () => {
  setup({ currentTimestamp: null, caption: "" });
  expect(document.querySelectorAll("p")).toHaveLength(0);
});
