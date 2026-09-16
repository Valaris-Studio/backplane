// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// The tree's read-only invariant, in ONE place so the three suites that assert
// it cannot drift apart. Card 2 asserted "zero mutation affordances"; card 3
// narrowed it to "inert until asked" when it added editors; card 4 widened the
// allowed set again for structure controls. Each widening must be deliberate —
// this list is what stops a stray uncontrolled input or an unlabelled button
// from appearing in the tree unnoticed.
export const TREE_CONTROL_ATTRIBUTES = [
  "data-node-id",
  "data-edit-for",
  "data-add-step-for",
  "data-remove-for",
  "data-move-up-for",
  "data-move-down-for",
] as const;

/** Buttons that are not node-scoped but still belong to the tree chrome. */
export const TREE_CONTROL_TEST_IDS = [
  "tree-add-role",
  // Card 5's toolbar: navigation only — they change what is VISIBLE, never the
  // draft, so they widen the chrome without weakening the read-only rule.
  "tree-expand-all",
  "tree-collapse-all",
] as const;

export function isKnownTreeControl(button: Element): boolean {
  if (TREE_CONTROL_ATTRIBUTES.some((attr) => button.hasAttribute(attr))) return true;
  const testId = button.getAttribute("data-testid");
  return TREE_CONTROL_TEST_IDS.some((id) => id === testId);
}
