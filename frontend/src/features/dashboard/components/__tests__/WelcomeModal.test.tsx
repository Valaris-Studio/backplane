// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  renderWithProviders,
  screen,
  waitFor,
  within,
  userEvent,
} from "@/test/test-utils";

// Stage-A contract for the one-time welcome modal (spec card 75b94de2):
// - <WelcomeModal slug boardCount /> renders an open dialog only when the
//   workspace is KNOWN to have no boards (boardCount === 0) AND
//   `valaris:onboardingWelcome:seen:<slug>` is unset. An undefined boardCount
//   (summary still loading, or failed) means "unknown", never "empty" — a
//   joiner of a populated workspace must not get the one-time welcome off the
//   back of a transient 500. It reads/writes localStorage itself (same
//   try/catch mechanics as the old FirstRunPanel dismiss key).
// - BOTH CTAs write the seen key and close the dialog. "I'll explore on my
//   own" additionally writes `valaris:onboardingChecklist:collapsed:<slug>`
//   so the checklist stays available but collapsed; "Set up my workspace"
//   must NOT write the collapsed key (the checklist expands by default).
import { WelcomeModal } from "../WelcomeModal";

const SLUG = "acme";
const SEEN_KEY = `valaris:onboardingWelcome:seen:${SLUG}`;
const COLLAPSED_KEY = `valaris:onboardingChecklist:collapsed:${SLUG}`;

function stubMatchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

beforeEach(() => {
  window.localStorage.clear();
  // Reduced motion: entrance tweens are skipped so role/text queries see
  // fully visible content immediately.
  stubMatchMedia(true);
});

afterEach(() => stubMatchMedia(false));

function renderModal({
  boardCount = 0,
}: { boardCount?: number | undefined } = {}) {
  return renderWithProviders(<WelcomeModal slug={SLUG} boardCount={boardCount} />);
}

describe("WelcomeModal — one-time welcome over the dashboard", () => {
  // MUST stay the FIRST test in this file: React's validateDOMNesting warns
  // only once per (child, ancestor) tag pair per process, so an earlier
  // render of the modal would swallow the violation before the spy exists.
  it("renders the badge+footnote block with valid DOM nesting (no console.error)", async () => {
    // Regression: the footnote wrapper was a <p> holding a Badge (a <div>),
    // so rendering logged React's "<div> cannot be a descendant of <p>"
    // nesting violation to console.error.
    const errorSpy = vi.spyOn(console, "error");
    renderModal();

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("experimental")).toBeInTheDocument();

    const errorCalls = [...errorSpy.mock.calls];
    errorSpy.mockRestore();
    expect(errorCalls).toEqual([]);
  });

  it("shows headline, subtitle and the four feature glyphs for a boardless workspace", async () => {
    renderModal();

    expect(await screen.findByText("Welcome to Backplane")).toBeInTheDocument();
    expect(
      screen.getByText(/Backplane is where your project work lives/),
    ).toBeInTheDocument();

    const dialog = screen.getByRole("dialog");
    // Four quiet feature glyphs — boards, notes & resources, channels, members.
    expect(within(dialog).getByText("Boards")).toBeInTheDocument();
    expect(within(dialog).getByText("Notes & resources")).toBeInTheDocument();
    expect(within(dialog).getByText("Channels")).toBeInTheDocument();
    expect(within(dialog).getByText("Members")).toBeInTheDocument();
  });

  it("carries the muted runner footnote with an experimental badge", async () => {
    renderModal();

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        /Backplane can also host autonomous coding agents/,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("experimental")).toBeInTheDocument();
  });

  it("marks welcome seen and closes on 'Set up my workspace' without collapsing the checklist", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(
      await screen.findByRole("button", { name: "Set up my workspace" }),
    );

    await waitFor(() =>
      expect(screen.queryByText("Welcome to Backplane")).toBeNull(),
    );
    expect(window.localStorage.getItem(SEEN_KEY)).toBe("1");
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBeNull();
  });

  it("marks welcome seen, collapses the checklist and closes on 'I'll explore on my own'", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(
      await screen.findByRole("button", { name: "I'll explore on my own" }),
    );

    await waitFor(() =>
      expect(screen.queryByText("Welcome to Backplane")).toBeNull(),
    );
    expect(window.localStorage.getItem(SEEN_KEY)).toBe("1");
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBe("1");
  });

  it("never renders for joiners of a workspace that already has boards", () => {
    renderModal({ boardCount: 3 });

    expect(screen.queryByText("Welcome to Backplane")).toBeNull();
    expect(window.localStorage.getItem(SEEN_KEY)).toBeNull();
  });

  it("never renders while the board count is unknown (summary loading or failed)", () => {
    // Not via renderModal — its destructuring default would turn an explicit
    // undefined back into 0, which is exactly the confusion under test.
    renderWithProviders(<WelcomeModal slug={SLUG} boardCount={undefined} />);

    expect(screen.queryByText("Welcome to Backplane")).toBeNull();
    expect(window.localStorage.getItem(SEEN_KEY)).toBeNull();
  });

  it("never renders again once the seen flag is set", () => {
    window.localStorage.setItem(SEEN_KEY, "1");
    renderModal();

    expect(screen.queryByText("Welcome to Backplane")).toBeNull();
  });

  it("tracks the seen flag per workspace — another workspace's flag does not suppress it", async () => {
    window.localStorage.setItem("valaris:onboardingWelcome:seen:other", "1");
    renderModal();

    expect(await screen.findByText("Welcome to Backplane")).toBeInTheDocument();
  });
});
