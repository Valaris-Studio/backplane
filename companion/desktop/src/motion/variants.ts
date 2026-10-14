// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { TargetAndTransition } from "motion/react";

import type { MotionTokens } from "./tokens";

/** initial/animate/exit for one m.* element; spread it onto the element. */
export interface MotionRecipe {
  initial: TargetAndTransition | false;
  animate: TargetAndTransition;
  exit: TargetAndTransition;
}

export const VIEW_SWAP_KINDS = ["push", "pop", "left", "right", "fade", "none"] as const;
export type ViewSwapKind = (typeof VIEW_SWAP_KINDS)[number];

// Literal timings motion-spec.md gives without a token of their own.
const TAB_SWITCH_MS = 180;
const TAB_SHIFT_PX = 10;
const EXIT_SHARE_OF_ENTER = 0.6;
const SHEET_ENTER_MS = 280;
const SHEET_EXIT_MS = 200;
const SCRIM_EXIT_MS = 160;
const DIALOG_SCALE_FROM = 0.96;
const TOAST_RISE_PX = 8;
const TOAST_SINK_PX = 4;
const TOAST_EXIT_MS = 160;
const LIST_INSERT_MS = 220;
const LIST_REMOVE_MS = 180;
const LIST_DROP_PX = 4;
const TICK_RISE_PX = 3;
const REDUCED_EXIT_MS = 120;
const REDUCED_VIEW_EXIT_MS = 100;
const DISCLOSURE_OPEN_MS = 180;
const MENU_SCALE_FROM = 0.96;
const MENU_OPEN_MS = 140;

const seconds = (ms: number) => ms / 1000;

function fadeOnly(enterMs: number, exitMs: number): MotionRecipe {
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: seconds(enterMs), ease: "easeInOut" } },
    exit: { opacity: 0, transition: { duration: seconds(exitMs), ease: "easeInOut" } },
  };
}

export function viewSwapMotion(kind: ViewSwapKind, tokens: MotionTokens, reduced: boolean): MotionRecipe {
  if (kind === "none") {
    return { initial: false, animate: { opacity: 1 }, exit: { opacity: 0, transition: { duration: 0 } } };
  }
  if (reduced) return fadeOnly(tokens.durationMs.fast, REDUCED_VIEW_EXIT_MS);

  const isDepthMove = kind === "push" || kind === "pop";
  const direction = kind === "pop" || kind === "left" ? -1 : 1;
  const distance = isDepthMove ? tokens.distancePx.push : kind === "fade" ? 0 : TAB_SHIFT_PX;
  const enterMs = isDepthMove ? tokens.durationMs.slow : TAB_SWITCH_MS;
  const ease = tokens.ease.out;
  const xTransition = isDepthMove ? { type: "spring" as const, ...tokens.spring.push } : { duration: seconds(enterMs), ease };

  return {
    initial: { opacity: 0, x: direction * distance },
    animate: { opacity: 1, x: 0, transition: { opacity: { duration: seconds(enterMs), ease }, x: xTransition } },
    exit: { opacity: 0, x: -direction * distance * 0.5, transition: { duration: seconds(enterMs * EXIT_SHARE_OF_ENTER), ease } },
  };
}

export function sheetMotion(tokens: MotionTokens, reduced: boolean): MotionRecipe {
  if (reduced) return fadeOnly(tokens.durationMs.fast, REDUCED_EXIT_MS);
  return {
    initial: { y: "100%" },
    animate: { y: 0, transition: { duration: seconds(SHEET_ENTER_MS), ease: tokens.ease.drawer } },
    exit: { y: "100%", transition: { duration: seconds(SHEET_EXIT_MS), ease: tokens.ease.drawer } },
  };
}

export function scrimMotion(tokens: MotionTokens, reduced: boolean): MotionRecipe {
  return fadeOnly(reduced ? tokens.durationMs.fast : tokens.durationMs.base, SCRIM_EXIT_MS);
}

export function dialogMotion(tokens: MotionTokens, reduced: boolean): MotionRecipe {
  if (reduced) return fadeOnly(tokens.durationMs.fast, REDUCED_EXIT_MS);
  return {
    initial: { opacity: 0, scale: DIALOG_SCALE_FROM },
    animate: { opacity: 1, scale: 1, transition: { duration: seconds(tokens.durationMs.base), ease: tokens.ease.out } },
    exit: { opacity: 0, transition: { duration: seconds(REDUCED_EXIT_MS), ease: "easeInOut" } },
  };
}

export function toastMotion(tokens: MotionTokens, reduced: boolean): MotionRecipe {
  if (reduced) return fadeOnly(REDUCED_EXIT_MS, REDUCED_EXIT_MS);
  return {
    initial: { opacity: 0, y: TOAST_RISE_PX },
    animate: { opacity: 1, y: 0, transition: { duration: seconds(tokens.durationMs.base), ease: tokens.ease.out } },
    exit: { opacity: 0, y: TOAST_SINK_PX, transition: { duration: seconds(TOAST_EXIT_MS), ease: tokens.ease.out } },
  };
}

export function listItemMotion(tokens: MotionTokens, reduced: boolean): MotionRecipe {
  if (reduced) return fadeOnly(tokens.durationMs.fast, REDUCED_EXIT_MS);
  const ease = tokens.ease.out;
  return {
    initial: { height: 0, opacity: 0, y: -LIST_DROP_PX, overflow: "hidden" },
    animate: {
      height: "auto",
      opacity: 1,
      y: 0,
      transition: { duration: seconds(LIST_INSERT_MS), ease },
      transitionEnd: { overflow: "visible" },
    },
    exit: { height: 0, opacity: 0, overflow: "hidden", transition: { duration: seconds(LIST_REMOVE_MS), ease } },
  };
}

/** Enter-only: a ticking number is replaced, never exits. */
export type EnterRecipe = Omit<MotionRecipe, "exit">;

export function numberTickMotion(tokens: MotionTokens, reduced: boolean): EnterRecipe {
  if (reduced || tokens.durationMs.tick === 0) {
    return { initial: false, animate: { opacity: 1 } };
  }
  return {
    initial: { y: TICK_RISE_PX, opacity: 0.35, filter: "blur(1px)" },
    animate: { y: 0, opacity: 1, filter: "blur(0px)", transition: { duration: seconds(tokens.durationMs.tick), ease: tokens.ease.out } },
  };
}

/** Enter-only: a menu closes at once, as a native one does once a choice is made. */
export function menuMotion(tokens: MotionTokens, reduced: boolean): EnterRecipe {
  if (reduced) return { initial: { opacity: 0 }, animate: { opacity: 1, transition: { duration: seconds(tokens.durationMs.fast), ease: "easeInOut" } } };
  return {
    initial: { opacity: 0, scale: MENU_SCALE_FROM },
    animate: { opacity: 1, scale: 1, transition: { duration: seconds(MENU_OPEN_MS), ease: tokens.ease.out } },
  };
}

/** A disclosure panel opening under its trigger (session row detail, Advanced). */
export function disclosureMotion(tokens: MotionTokens, reduced: boolean): MotionRecipe {
  if (reduced) return fadeOnly(tokens.durationMs.fast, REDUCED_EXIT_MS);
  const ease = tokens.ease.out;
  return {
    initial: { height: 0, opacity: 0, overflow: "hidden" },
    animate: { height: "auto", opacity: 1, transition: { duration: seconds(DISCLOSURE_OPEN_MS), ease }, transitionEnd: { overflow: "visible" } },
    exit: { height: 0, opacity: 0, overflow: "hidden", transition: { duration: seconds(tokens.durationMs.fast), ease } },
  };
}
