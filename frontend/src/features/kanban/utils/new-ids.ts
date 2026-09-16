// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Which of `current` weren't present in `previous`. Used to animate ONLY
// freshly-arrived cards on a column re-render — a card move or single-field
// update must not re-trigger the whole column's entrance (which would re-hide
// and re-reveal every card, a visible flash on every WS event). `null`
// previous means "first mount" → everything is new.
export function newIdsSince(
  current: string[],
  previous: Set<string> | null,
): string[] {
  if (previous === null) return [...current];
  return current.filter((id) => !previous.has(id));
}
