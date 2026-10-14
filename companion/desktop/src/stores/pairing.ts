// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { PairingEvent } from "../ipc/bindings";
import { createExternalStore, useStoreSelector } from "./external-store";

/** The latest SSE `pairing` event: pending, then connected | denied | expired | failed. */
export const pairingStore = createExternalStore<PairingEvent | null>(null);

export function applyPairingEvent(event: PairingEvent): void {
  pairingStore.set(event);
}

/** The latest pairing event, only for `pairingId` when given. */
export function usePairingEvents(pairingId?: string | null): PairingEvent | null {
  return useStoreSelector(pairingStore, (event) => (event && (pairingId == null || event.pairing_id === pairingId) ? event : null));
}

export function resetPairingForTests(): void {
  pairingStore.set(null);
}
