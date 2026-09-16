// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { WorkspaceMember } from "@/types/member";

// The mention node's storage shape (contract §1). `id` is the authoritative
// identity (users.id); `label` is a denormalized display convenience the
// backend never trusts for who-to-notify (MEN-1).
export interface MentionAttrs {
  id: string;
  label: string;
}

/**
 * Map a chosen workspace member to the attrs of an inserted `mention` node.
 * Pure + dependency-free so the picker and tests share one mapping.
 */
export function memberToMentionAttrs(member: WorkspaceMember): MentionAttrs {
  const name = member.name?.trim();
  return {
    id: member.user_id,
    label: name || member.email,
  };
}
