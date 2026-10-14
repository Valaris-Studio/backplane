// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { m } from "motion/react";
import type { ComponentProps } from "react";

import { useMotionTokens, useReducedMotionPreference } from "./reduced-motion";
import { listItemMotion } from "./variants";

type MotionListItemProps = Omit<ComponentProps<typeof m.li>, "initial" | "animate" | "exit">;

/**
 * A list row that grows in and collapses out. Render it inside
 * <AnimatePresence initial={false}> keyed by the item's id, so rows already
 * there on mount do not animate.
 */
export function MotionListItem(props: MotionListItemProps) {
  const reduced = useReducedMotionPreference();
  const recipe = listItemMotion(useMotionTokens(), reduced);
  return <m.li {...props} initial={recipe.initial} animate={recipe.animate} exit={recipe.exit} />;
}
