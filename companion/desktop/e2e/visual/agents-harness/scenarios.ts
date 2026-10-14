// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

export const AGENTS_HARNESS_SCENARIOS = ["healthy", "trouble", "idle", "restart", "trustRestart", "daemonRestart", "brokenCauses"] as const;
export type AgentsHarnessScenario = (typeof AGENTS_HARNESS_SCENARIOS)[number];

/** Must match AGENTS_NOW in src/screens/agents/agents-fixtures.ts, which the statuses are built against. */
export const AGENTS_HARNESS_NOW = new Date("2026-09-28T12:00:00Z");
