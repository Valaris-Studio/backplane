// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

export const HOME_SCENARIOS = ["capturing", "attention", "paused", "paused-server", "offline", "revoked", "empty", "usage", "busy"] as const;
export type HomeScenario = (typeof HOME_SCENARIOS)[number];

/** Noon UTC; the spec pins the page to UTC so the Earlier today times match. */
export const HOME_HARNESS_NOW = new Date("2026-09-28T12:00:00Z");
