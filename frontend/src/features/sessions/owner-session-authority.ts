// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { OwnerSession } from "@/types/owner-session";

export interface OwnerSessionEvidence {
  session: OwnerSession;
  requestedAt: number;
}

export interface OwnerSessionWorkspaceInventory {
  ids: ReadonlySet<string>;
  updatedAt: number;
}

export function projectOwnerSession(
  evidence: OwnerSessionEvidence, inventory: OwnerSessionWorkspaceInventory | undefined,
): OwnerSessionEvidence | undefined {
  // Only a request started after the inventory was observed can supersede it.
  // Late arrival cannot renew pre-revocation authority; ties stay conservative.
  if (!inventory || evidence.requestedAt > inventory.updatedAt) return evidence;
  if (!inventory.ids.has(evidence.session.workspace_id)) return undefined;
  const links = evidence.session.link_preview.filter((link) => inventory.ids.has(link.workspace_id));
  return links.length === evidence.session.link_preview.length ? evidence
    : { ...evidence, session: { ...evidence.session, link_preview: links } };
}
