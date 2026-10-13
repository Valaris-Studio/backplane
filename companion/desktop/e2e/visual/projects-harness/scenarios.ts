// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

export const PROJECTS_SCENARIOS = ["bound", "bound-agents", "bound-agents-blocked", "found", "found-empty", "found-scope", "bind", "bind-no-boards", "ignored", "rules"] as const;
export type ProjectsScenario = (typeof PROJECTS_SCENARIOS)[number];
