// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { gsap } from "gsap";
import { Inbox } from "lucide-react";
import { EmptyState } from "../EmptyState";

const reduceQuery = "(prefers-reduced-motion: reduce)";

function stubMatchMedia(reduceMatches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query === reduceQuery ? reduceMatches : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function renderEmptyState() {
  return render(
    <EmptyState
      icon={Inbox}
      title="Nothing here"
      description="Create your first item"
      action={<button type="button">Create</button>}
    />,
  );
}

describe("EmptyState", () => {
  afterEach(() => {
    cleanup();
    gsap.globalTimeline.clear();
    stubMatchMedia(false);
  });

  it("renders title, description and action", () => {
    stubMatchMedia(false);
    renderEmptyState();
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(screen.getByText("Create your first item")).toBeInTheDocument();
    // role query MUST work mid-entrance: the cascade animates plain opacity
    // (never autoAlpha/visibility), so the CTA stays in the a11y tree.
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
  });

  it("animates the icon chip with a gentle infinite float when motion is allowed", () => {
    stubMatchMedia(false);
    renderEmptyState();
    const chip = screen.getByTestId("empty-state-icon-chip");
    const tweens = gsap.getTweensOf(chip);
    expect(tweens.length).toBeGreaterThan(0);

    const float = tweens.find((tween) => tween.vars.repeat === -1);
    expect(float).toBeDefined();
    expect(float?.vars.yoyo).toBe(true);
    // amplitude must stay subtle so it never reads as broken layout
    expect(Math.abs(float?.vars.y as number)).toBeLessThanOrEqual(4);
  });

  it("cascades title, description and action after the icon chip", () => {
    stubMatchMedia(false);
    renderEmptyState();
    const title = screen.getByText("Nothing here");
    const description = screen.getByText("Create your first item");
    const action = screen.getByText("Create").closest("button")?.parentElement;
    expect(gsap.getTweensOf(title).length).toBeGreaterThan(0);
    expect(gsap.getTweensOf(description).length).toBeGreaterThan(0);
    expect(gsap.getTweensOf(action as Element).length).toBeGreaterThan(0);
  });

  it("skips all animation when prefers-reduced-motion is set", () => {
    stubMatchMedia(true);
    renderEmptyState();
    const chip = screen.getByTestId("empty-state-icon-chip");
    expect(gsap.getTweensOf(chip)).toHaveLength(0);
    expect(gsap.getTweensOf(screen.getByText("Nothing here"))).toHaveLength(0);
    // static render is the fallback — content must remain fully visible
    expect(screen.getByText("Nothing here")).toBeVisible();
  });
});
