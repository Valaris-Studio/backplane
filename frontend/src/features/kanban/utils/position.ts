// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export function calculatePosition(before?: number, after?: number): number {
  if (before != null && after != null) {
    return (before + after) / 2;
  }
  if (after != null) {
    return after / 2;
  }
  if (before != null) {
    return before + 1024;
  }
  return 1024;
}
