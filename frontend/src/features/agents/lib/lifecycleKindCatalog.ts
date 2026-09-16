// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { LifecycleKindDoc } from "../api/lifecycleKinds";
import type { LifecycleKindName } from "../api/pipelineConfig";

interface LifecycleKindCopyKeys {
  summary: string;
  whenToUse: string;
  gotcha?: string;
}

export const LIFECYCLE_KIND_COPY_KEYS_BY_KIND = {
  discover: {
    summary: "lifecycleKindCatalog.discover.summary",
    whenToUse: "lifecycleKindCatalog.discover.whenToUse",
    gotcha: "lifecycleKindCatalog.discover.gotcha",
  },
  claim: {
    summary: "lifecycleKindCatalog.claim.summary",
    whenToUse: "lifecycleKindCatalog.claim.whenToUse",
    gotcha: "lifecycleKindCatalog.claim.gotcha",
  },
  git_setup: {
    summary: "lifecycleKindCatalog.git_setup.summary",
    whenToUse: "lifecycleKindCatalog.git_setup.whenToUse",
    gotcha: "lifecycleKindCatalog.git_setup.gotcha",
  },
  skills_setup: {
    summary: "lifecycleKindCatalog.skills_setup.summary",
    whenToUse: "lifecycleKindCatalog.skills_setup.whenToUse",
    gotcha: "lifecycleKindCatalog.skills_setup.gotcha",
  },
  llm: {
    summary: "lifecycleKindCatalog.llm.summary",
    whenToUse: "lifecycleKindCatalog.llm.whenToUse",
    gotcha: "lifecycleKindCatalog.llm.gotcha",
  },
  sensor: {
    summary: "lifecycleKindCatalog.sensor.summary",
    whenToUse: "lifecycleKindCatalog.sensor.whenToUse",
    gotcha: "lifecycleKindCatalog.sensor.gotcha",
  },
  move_card: {
    summary: "lifecycleKindCatalog.move_card.summary",
    whenToUse: "lifecycleKindCatalog.move_card.whenToUse",
    gotcha: "lifecycleKindCatalog.move_card.gotcha",
  },
  apply_label: {
    summary: "lifecycleKindCatalog.apply_label.summary",
    whenToUse: "lifecycleKindCatalog.apply_label.whenToUse",
    gotcha: "lifecycleKindCatalog.apply_label.gotcha",
  },
  remove_label: {
    summary: "lifecycleKindCatalog.remove_label.summary",
    whenToUse: "lifecycleKindCatalog.remove_label.whenToUse",
  },
  create_note: {
    summary: "lifecycleKindCatalog.create_note.summary",
    whenToUse: "lifecycleKindCatalog.create_note.whenToUse",
    gotcha: "lifecycleKindCatalog.create_note.gotcha",
  },
  enqueue_for_merge: {
    summary: "lifecycleKindCatalog.enqueue_for_merge.summary",
    whenToUse: "lifecycleKindCatalog.enqueue_for_merge.whenToUse",
    gotcha: "lifecycleKindCatalog.enqueue_for_merge.gotcha",
  },
  mcp_call: {
    summary: "lifecycleKindCatalog.mcp_call.summary",
    whenToUse: "lifecycleKindCatalog.mcp_call.whenToUse",
    gotcha: "lifecycleKindCatalog.mcp_call.gotcha",
  },
  create_fix_cards: {
    summary: "lifecycleKindCatalog.create_fix_cards.summary",
    whenToUse: "lifecycleKindCatalog.create_fix_cards.whenToUse",
    gotcha: "lifecycleKindCatalog.create_fix_cards.gotcha",
  },
  branch: {
    summary: "lifecycleKindCatalog.branch.summary",
    whenToUse: "lifecycleKindCatalog.branch.whenToUse",
    gotcha: "lifecycleKindCatalog.branch.gotcha",
  },
  wake_role: {
    summary: "lifecycleKindCatalog.wake_role.summary",
    whenToUse: "lifecycleKindCatalog.wake_role.whenToUse",
    gotcha: "lifecycleKindCatalog.wake_role.gotcha",
  },
  create_pr: {
    summary: "lifecycleKindCatalog.create_pr.summary",
    whenToUse: "lifecycleKindCatalog.create_pr.whenToUse",
    gotcha: "lifecycleKindCatalog.create_pr.gotcha",
  },
  enable_auto_merge: {
    summary: "lifecycleKindCatalog.enable_auto_merge.summary",
    whenToUse: "lifecycleKindCatalog.enable_auto_merge.whenToUse",
    gotcha: "lifecycleKindCatalog.enable_auto_merge.gotcha",
  },
  merge_pr: {
    summary: "lifecycleKindCatalog.merge_pr.summary",
    whenToUse: "lifecycleKindCatalog.merge_pr.whenToUse",
    gotcha: "lifecycleKindCatalog.merge_pr.gotcha",
  },
  post_pr_review: {
    summary: "lifecycleKindCatalog.post_pr_review.summary",
    whenToUse: "lifecycleKindCatalog.post_pr_review.whenToUse",
    gotcha: "lifecycleKindCatalog.post_pr_review.gotcha",
  },
  ship: {
    summary: "lifecycleKindCatalog.ship.summary",
    whenToUse: "lifecycleKindCatalog.ship.whenToUse",
    gotcha: "lifecycleKindCatalog.ship.gotcha",
  },
  end: {
    summary: "lifecycleKindCatalog.end.summary",
    whenToUse: "lifecycleKindCatalog.end.whenToUse",
  },
} satisfies Record<LifecycleKindName, LifecycleKindCopyKeys>;

export function localizeLifecycleKindDoc(
  kind: string,
  backendDoc: LifecycleKindDoc,
  translate: (key: string) => string,
): LifecycleKindDoc {
  const copyKeys = LIFECYCLE_KIND_COPY_KEYS_BY_KIND[
    kind as LifecycleKindName
  ] as LifecycleKindCopyKeys | undefined;
  if (!copyKeys) return backendDoc;

  return {
    summary: translate(copyKeys.summary),
    when_to_use: translate(copyKeys.whenToUse),
    ...(backendDoc.gotcha && copyKeys.gotcha
      ? { gotcha: translate(copyKeys.gotcha) }
      : {}),
  };
}
