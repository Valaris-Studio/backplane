// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { SessionTokens } from "../../ipc/bindings";

// Every user-facing word about token usage, in one place so the wording is easy to revise.

export interface UsageTerm {
  field: keyof SessionTokens;
  label: string;
  tip: string;
}

export const USAGE_TERMS: readonly UsageTerm[] = [
  { field: "input", label: "New input", tip: "Prompt tokens the model hadn’t seen before." },
  { field: "output", label: "Output", tip: "Tokens the model wrote." },
  { field: "cache_read", label: "Context reused", tip: "Earlier conversation read back from the prompt cache — billed at a discount." },
  { field: "cache_write", label: "Context saved", tip: "Conversation written into the prompt cache so later turns can reuse it." },
];

export const USAGE_SCOPE_CAPTION = "Counted since Companion started capturing this session.";

export const COLD_CACHE_HINT = "Context re-cached after a pause — the whole conversation was re-sent.";

export const COUNTING_TOKENS = "Counting tokens…";

export const PENDING_USAGE_HELP = "Token counts appear once the agent reports usage.";

// A session resumed after its earlier history left Backplane, by reason
// (owner | retention | unknown, from the daemon). Never "You deleted…" unless the owner did.
export interface DeletedHistoryCopy {
  label: string;
  help: string;
  caption: string;
}

const DELETED_IN_BACKPLANE: DeletedHistoryCopy = {
  label: "Earlier history deleted in Backplane",
  help: "This session’s earlier history was deleted in Backplane. Token counts appear once the agent reports new usage.",
  caption: "Counted since the earlier history was deleted in Backplane.",
};

const DELETED_HISTORY_COPY: Record<string, DeletedHistoryCopy> = {
  owner: {
    ...DELETED_IN_BACKPLANE,
    help: "You deleted this session’s earlier history in Backplane. Token counts appear once the agent reports new usage.",
  },
  retention: {
    label: "Earlier history removed after the retention period",
    help: "Backplane removed this session’s earlier history when this device’s retention period ended. Token counts appear once the agent reports new usage.",
    caption: "Counted since the earlier history was removed after the retention period.",
  },
};

export function deletedHistoryCopy(reason: string | null): DeletedHistoryCopy | null {
  if (!reason) return null;
  return DELETED_HISTORY_COPY[reason] ?? DELETED_IN_BACKPLANE;
}
