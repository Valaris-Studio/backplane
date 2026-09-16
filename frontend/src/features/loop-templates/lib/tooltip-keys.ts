// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// The RichTooltip keys the loop-template screens request, as one manifest.
//
// The components build their keys by interpolation (`loopTemplates.rails.${rail}`),
// so a rail added to `rails-catalog.ts` silently renders an EMPTY panel when no
// copy exists — `useTooltipContent` falls back to `{summary: ""}` rather than
// throwing. This list is what the drift test enumerates; it is the only place
// that knows the full key surface, guarded the way VALARIS_MCP_NAMES is.

import {
  NUMERIC_RAILS,
  ENUM_RAIL_NAMES,
  CONTRACT_FLAGS,
  CONTRACT_CHIP_LISTS,
} from "./rails-catalog";

/**
 * The two free-text rails the Rails tab renders below the enum group. They are
 * not in NUMERIC_RAILS/ENUM_RAIL_NAMES because neither is a number nor a closed
 * vocabulary — `model` accepts a tier alias OR a concrete id, `provider` is a
 * free string the runner resolves.
 */
export const FREE_TEXT_RAILS = ["model", "provider"] as const;

/** Every `loopTemplates.rails.*` key a tab can ask for, in render order. */
export const RAIL_TOOLTIP_RAILS = [
  ...NUMERIC_RAILS,
  ...ENUM_RAIL_NAMES,
  ...FREE_TEXT_RAILS,
] as const;

const railKeys = RAIL_TOOLTIP_RAILS.map(
  (rail) => `loopTemplates.rails.${rail}`,
);

// The Contract tab keys both column-type buckets off the bucket name, so the
// key is `<bucket>_column_types`, not the bucket alone.
const contractKeys = [
  "loopTemplates.contract.required_column_types",
  "loopTemplates.contract.optional_column_types",
  ...CONTRACT_FLAGS.map((flag) => `loopTemplates.contract.${flag}`),
  ...CONTRACT_CHIP_LISTS.map((list) => `loopTemplates.contract.${list}`),
];

const promptKeys = ["loopTemplates.system_prompt", "loopTemplates.loop_prompt"];

/**
 * The SlotSpec fields the Slots tab explains. `variant` is the PRESET editor —
 * the key keeps the wire vocabulary (card d73aa054 renamed the copy only), so
 * the manifest and the SlotKind enum stay in step.
 */
export const SLOT_TOOLTIP_FIELDS = [
  "name",
  "kind",
  "required",
  "autofill",
  "default",
  "variant",
] as const;

const slotKeys = SLOT_TOOLTIP_FIELDS.map(
  (field) => `loopTemplates.slots.${field}`,
);

const paletteKeys = [
  "loopTemplates.palette.runnerVar",
  "loopTemplates.palette.slot",
  "loopTemplates.palette.unknownSlot",
];

/**
 * Every key that must resolve to a panel with a non-empty summary in BOTH
 * locales. Order is stable so a diff on this file reads as a real change.
 */
export const TOOLTIP_KEYS: readonly string[] = [
  ...railKeys,
  ...contractKeys,
  ...promptKeys,
  ...paletteKeys,
  ...slotKeys,
];
