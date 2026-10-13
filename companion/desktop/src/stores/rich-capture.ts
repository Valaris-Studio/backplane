// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { CompanionStatus } from "../ipc/bindings";
import type { PrivacyLevel } from "../components/privacy-levels";
import { statusStore } from "./daemon-stream";
import { useStoreSelector } from "./external-store";

/**
 * Whether the current Backplane takes rich capture: offered, not_offered
 * (the server answered null), unknown (no readable policy yet, or a server
 * that sent no answer), or unsupported (this daemon reports no offer state,
 * so it predates rich capture).
 */
export type RichCaptureOffer = "offered" | "not_offered" | "unknown" | "unsupported";

const OFFERS: ReadonlySet<string> = new Set(["offered", "not_offered", "unknown"]);

/**
 * Read from the current connection's own status, never a device-wide flag,
 * so each Backplane answers for itself once there are several (contract §12).
 */
export function richCaptureOffer(status: CompanionStatus | null): RichCaptureOffer {
  if (!status) return "unknown";
  const current = status.connections?.find((connection) => connection.installation_id === status.installation_id);
  const offer = current?.rich_capture?.offer;
  if (offer === undefined) return "unsupported";
  return OFFERS.has(offer) ? (offer as RichCaptureOffer) : "unknown";
}

export function useRichCaptureOffer(): RichCaptureOffer {
  return useStoreSelector(statusStore, richCaptureOffer);
}

/** A new binding's level: rich where offered; otherwise Standard, with Rich shown unavailable. */
export function defaultBindLevel(offer: RichCaptureOffer): PrivacyLevel {
  return offer === "offered" ? "rich" : "standard";
}
