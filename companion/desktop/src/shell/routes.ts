// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { ComponentType } from "react";

export interface RouteDefinition {
  /** Shown centred in the nav bar next to Back. */
  title: string;
  component: ComponentType;
}

const registry = new Map<string, RouteDefinition>();

/**
 * Adds a pushed screen. Call it at module scope in
 * src/screens/<name>/routes.ts; the shell imports every such file on its own
 * (route-modules.ts), so a new route needs no shell edit.
 */
export function registerRoute(id: string, definition: RouteDefinition): void {
  registry.set(id, definition);
}

export function routeDefinition(id: string): RouteDefinition | null {
  return registry.get(id) ?? null;
}
