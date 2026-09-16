// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export const PROMPT_DESCRIPTION_KEYS_BY_SLUG = {
  discover: "prompts.catalog.discover.description",
  claim: "prompts.catalog.claim.description",
  implement: "prompts.catalog.implement.description",
  implement_after_approval:
    "prompts.catalog.implement_after_approval.description",
  ship: "prompts.catalog.ship.description",
  mediate_rework: "prompts.catalog.mediate_rework.description",
  rework_claim: "prompts.catalog.rework_claim.description",
  rework_implement: "prompts.catalog.rework_implement.description",
  rework_ship: "prompts.catalog.rework_ship.description",
  discover_review: "prompts.catalog.discover_review.description",
  claim_review: "prompts.catalog.claim_review.description",
  review: "prompts.catalog.review.description",
  post_review_decision: "prompts.catalog.post_review_decision.description",
  discover_shipped: "prompts.catalog.discover_shipped.description",
  claim_doc: "prompts.catalog.claim_doc.description",
  document: "prompts.catalog.document.description",
  tag_documented: "prompts.catalog.tag_documented.description",
  research: "prompts.catalog.research.description",
  plan: "prompts.catalog.plan.description",
  reconcile: "prompts.catalog.reconcile.description",
} as const;

export function lookupPromptDescriptionKey(slug: string): string | undefined {
  return PROMPT_DESCRIPTION_KEYS_BY_SLUG[
    slug as keyof typeof PROMPT_DESCRIPTION_KEYS_BY_SLUG
  ];
}
