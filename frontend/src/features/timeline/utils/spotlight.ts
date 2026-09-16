// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { StepDescriptor, StepKind } from "./event-descriptor";

// The particle burst is reserved for MILESTONE card events so it reads as a
// notable flourish, not constant noise: a card being CREATED (appears) or
// DELETED (removed) are the visually significant lifecycle moments. Routine
// moves/updates still glow + ring, but don't trigger the heavier burst. This is
// the "differentiate special events" the burst is meant to celebrate.
const SPECIAL_BURST_KINDS = new Set<StepKind>(["card-create", "card-delete"]);

export function isSpecialBurstKind(kind: StepKind): boolean {
  return SPECIAL_BURST_KINDS.has(kind);
}

// Pure rule for the spotlight particle burst. A burst is the EXTRA flourish layered
// on top of the always-on glow/ring: it fires only during active Play, only when
// motion is allowed, and only for a SPECIAL milestone kind (create/delete).
// Role-agnostic — keys off the descriptor's structural kind, never an opaque
// classifier value.
export function shouldBurst(
  descriptor: StepDescriptor,
  playing: boolean,
  reducedMotion: boolean,
): boolean {
  if (!playing || reducedMotion) return false;
  return isSpecialBurstKind(descriptor.kind);
}
