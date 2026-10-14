// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { FALLBACK_MOTION_TOKENS, parseCubicBezier, parseDurationMs, readMotionTokens } from "./tokens";
import {
  VIEW_SWAP_KINDS,
  dialogMotion,
  listItemMotion,
  numberTickMotion,
  scrimMotion,
  sheetMotion,
  toastMotion,
  viewSwapMotion,
  type MotionRecipe,
} from "./variants";

const TRANSFORM_KEYS = ["x", "y", "scale", "rotate", "transform", "filter"];

function targetsOf(recipe: MotionRecipe) {
  return [recipe.initial, recipe.animate, recipe.exit].flatMap((target) => (target === false ? [] : [target as Record<string, unknown>]));
}

function transformKeys(recipe: MotionRecipe): string[] {
  return targetsOf(recipe).flatMap((target) => Object.keys(target).filter((key) => TRANSFORM_KEYS.includes(key)));
}

const tokens = FALLBACK_MOTION_TOKENS;

describe("motion tokens", () => {
  it("parses ms and s durations and rejects junk", () => {
    expect(parseDurationMs("200ms")).toBe(200);
    expect(parseDurationMs(" 0.26s")).toBe(260);
    expect(parseDurationMs("fast")).toBeNull();
    expect(parseDurationMs("")).toBeNull();
  });

  it("parses cubic-bezier easings and rejects anything else", () => {
    expect(parseCubicBezier("cubic-bezier(0.23, 1, 0.32, 1)")).toEqual([0.23, 1, 0.32, 1]);
    expect(parseCubicBezier("ease")).toBeNull();
    expect(parseCubicBezier("cubic-bezier(1, 2)")).toBeNull();
  });

  it("falls back to the DK-0 values when the stylesheet is absent (jsdom)", () => {
    const read = readMotionTokens();
    expect(read.durationMs.base).toBe(200);
    expect(read.durationMs.slow).toBe(260);
    expect(read.ease.out).toEqual([0.23, 1, 0.32, 1]);
    expect(read.spring.push).toEqual({ stiffness: 380, damping: 38 });
    expect(read.distancePx.push).toBe(24);
  });

  it("reads overrides from the root's custom properties", () => {
    document.documentElement.style.setProperty("--duration-base", "150ms");
    document.documentElement.style.setProperty("--spring-sheet-stiffness", "333");
    try {
      const read = readMotionTokens();
      expect(read.durationMs.base).toBe(150);
      expect(read.spring.sheet.stiffness).toBe(333);
    } finally {
      document.documentElement.style.removeProperty("--duration-base");
      document.documentElement.style.removeProperty("--spring-sheet-stiffness");
    }
  });
});

describe("view swap", () => {
  it("pushes in from the right by the push distance and pops in from the left", () => {
    const push = viewSwapMotion("push", tokens, false);
    const pop = viewSwapMotion("pop", tokens, false);
    expect(push.initial).toMatchObject({ opacity: 0, x: 24 });
    expect(pop.initial).toMatchObject({ opacity: 0, x: -24 });
    expect(push.animate).toMatchObject({ opacity: 1, x: 0 });
  });

  it("shifts tabs by 10 px toward the tab's side", () => {
    expect(viewSwapMotion("right", tokens, false).initial).toMatchObject({ x: 10 });
    expect(viewSwapMotion("left", tokens, false).initial).toMatchObject({ x: -10 });
  });

  it("fades without moving for a plain fade", () => {
    expect(transformKeys(viewSwapMotion("fade", tokens, false)).every((key) => key === "x")).toBe(true);
    expect(viewSwapMotion("fade", tokens, false).initial).toMatchObject({ x: 0 });
  });

  it("does not animate at all for kind none", () => {
    expect(viewSwapMotion("none", tokens, false).initial).toBe(false);
  });

  it("uses only opacity under reduced motion, for every kind", () => {
    for (const kind of VIEW_SWAP_KINDS) {
      expect(transformKeys(viewSwapMotion(kind, tokens, true))).toEqual([]);
    }
  });
});

describe("layer and list motion", () => {
  it("slides the sheet up from 100% and back down", () => {
    const sheet = sheetMotion(tokens, false);
    expect(sheet.initial).toMatchObject({ y: "100%" });
    expect(sheet.animate).toMatchObject({ y: 0 });
    expect(sheet.exit).toMatchObject({ y: "100%" });
  });

  it("scales the dialog from 0.96", () => {
    expect(dialogMotion(tokens, false).initial).toMatchObject({ opacity: 0, scale: 0.96 });
  });

  it("lifts the toast 8 px", () => {
    expect(toastMotion(tokens, false).initial).toMatchObject({ opacity: 0, y: 8 });
  });

  it("grows list items from zero height and collapses them on exit", () => {
    const item = listItemMotion(tokens, false);
    expect(item.initial).toMatchObject({ height: 0, opacity: 0, y: -4 });
    expect(item.animate).toMatchObject({ height: "auto", opacity: 1, y: 0 });
    expect(item.exit).toMatchObject({ height: 0, opacity: 0 });
  });

  it("ticks numbers up 3 px out of a blur", () => {
    expect(numberTickMotion(tokens, false).initial).toMatchObject({ y: 3, opacity: 0.35, filter: "blur(1px)" });
  });

  it("reduces every layer and list moment to opacity", () => {
    for (const recipe of [
      sheetMotion(tokens, true),
      scrimMotion(tokens, true),
      dialogMotion(tokens, true),
      toastMotion(tokens, true),
      listItemMotion(tokens, true),
    ]) {
      expect(transformKeys(recipe)).toEqual([]);
    }
    expect(listItemMotion(tokens, true).initial).not.toHaveProperty("height");
  });

  it("replaces number ticks outright under reduced motion", () => {
    expect(numberTickMotion(tokens, true).initial).toBe(false);
  });
});
