// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { Refetchable } from "../../stores/refetchable";

/**
 * Stores a value a step fetched itself (the shared stores keep fetch errors
 * to themselves, and onboarding must show them). push() alone would leave
 * the resource "unused", so an account change after pairing would forget it
 * and never refetch; ensure() on a loaded resource registers the interest
 * without another request.
 */
export function adoptInto<T>(resource: Refetchable<T>, value: T): void {
  resource.push(value);
  resource.ensure();
}
