// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// The SlotSpec catalog as the Slots tab edits it — a typed mirror of the
// backend model in app/services/loop_template_render.py.
//
// `draft-content.ts` reads the few slot fields the prompts tab needs; this
// module owns the WHOLE row, because the Slots tab is the surface that writes
// slots back and a lossy read here would silently drop an author's enum
// values or variants on the next autosave.

import { referencedSlots } from "./prompt-validation";

/** SlotKind in app/services/loop_template_render.py. Order is the UI's order. */
export const SLOT_KINDS = [
  "scalar",
  "block",
  "enum",
  "variant",
  "list",
] as const;

export type SlotKind = (typeof SLOT_KINDS)[number];

/** _LOOP_LANDINGS in app/services/loop_config_validation.py. */
export const LOOP_LANDINGS = ["human", "merge_queue", "self_merge"] as const;

/**
 * The slot names the fit service can pre-fill from board facts.
 *
 * Direction (card a62cd831): autofill is a CLOSED list, never free text. The
 * card's prose named dotted source paths (`board.git_repo.url`, …) that exist
 * nowhere in the backend — the real contract is `_autofill()` in
 * app/services/loop_template_fit.py, which keys off the slot NAME. So the
 * closed list is the set of names that service knows how to fill.
 */
export const AUTOFILL_SOURCES = [
  "RUN_LABEL",
  "REPO_URL",
  "DEFAULT_BRANCH",
  "INTEGRATION_BRANCH",
  "CARD_BRANCH_PREFIX",
  "SEED_NOTE_TITLE",
  "SEED_NOTE_ID",
  "DEFINITION_KEYS",
] as const;

/** SLOT_NAME_PATTERN in app/services/loop_template_render.py — no leniency. */
export const SLOT_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** PROMPT_FIELDS in app/services/loop_template_render.py. */
export const PROMPT_FIELDS = ["system_prompt", "loop_prompt"] as const;

export type PromptField = (typeof PROMPT_FIELDS)[number];

export interface SlotVariant {
  id: string;
  label: string;
  fills: Record<string, string>;
  tools_extra: string[];
  rails: Record<string, unknown>;
}

export interface CatalogSlot {
  name: string;
  kind: SlotKind;
  required: boolean;
  label: string;
  help: string;
  example: string;
  default: unknown;
  enum_values: string[];
  items: Record<string, unknown> | null;
  join: string;
  variants: SlotVariant[];
  autofill: string | null;
  // Catalogued but no prompt reads it (backend SlotSpec.deprecated). Only
  // emitted when true: the rows are persisted verbatim and the backend reads a
  // missing key as false.
  deprecated?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function asKind(value: unknown): SlotKind {
  return SLOT_KINDS.includes(value as SlotKind)
    ? (value as SlotKind)
    : "scalar";
}

function readVariant(raw: Record<string, unknown>): SlotVariant {
  const fills = isRecord(raw.fills) ? raw.fills : {};
  return {
    id: asString(raw.id),
    label: asString(raw.label),
    // Fill VALUES are prompt text, so a non-string one is unrenderable; it is
    // coerced rather than dropped so the author can see and fix it.
    fills: Object.fromEntries(
      Object.entries(fills).map(([target, value]) => [target, asString(value)]),
    ),
    tools_extra: asStringList(raw.tools_extra),
    rails: isRecord(raw.rails) ? raw.rails : {},
  };
}

/**
 * Read the full slot catalog out of a draft's `content` bag.
 *
 * `used_in` is deliberately NOT read: the backend discards any supplied value
 * and derives it from the prompts, so carrying it here would let the UI show a
 * stale claim about text the author is editing right now.
 */
export function readCatalog(
  content: Record<string, unknown> | undefined,
): CatalogSlot[] {
  const raw = content?.slots;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).flatMap((entry) => {
    const name = entry.name;
    if (typeof name !== "string" || !name) return [];
    return [
      {
        name,
        kind: asKind(entry.kind),
        required: entry.required === true,
        label: asString(entry.label),
        help: asString(entry.help),
        example: asString(entry.example),
        default: entry.default ?? null,
        enum_values: asStringList(entry.enum_values),
        items: isRecord(entry.items) ? entry.items : null,
        join: typeof entry.join === "string" ? entry.join : "\n",
        variants: Array.isArray(entry.variants)
          ? entry.variants.filter(isRecord).map(readVariant)
          : [],
        autofill: typeof entry.autofill === "string" ? entry.autofill : null,
        ...(entry.deprecated === true ? { deprecated: true } : {}),
      },
    ];
  });
}

/** A blank row, defaulted to a kind the publish validator accepts. */
export function blankSlot(name: string): CatalogSlot {
  return {
    name,
    kind: "scalar",
    required: false,
    label: "",
    help: "",
    example: "",
    default: null,
    enum_values: [],
    items: null,
    join: "\n",
    variants: [],
    autofill: null,
  };
}

export interface SlotNameProblem {
  code: "grammar" | "duplicate" | "empty";
}

/**
 * Validate a proposed slot name against the backend grammar and the catalog.
 *
 * `index` is excluded from the duplicate scan so a row never collides with
 * itself while the author is mid-rename.
 */
export function validateSlotName(
  proposed: string,
  slots: readonly CatalogSlot[],
  index: number,
): SlotNameProblem | null {
  if (!proposed) return { code: "empty" };
  if (!SLOT_NAME_PATTERN.test(proposed)) return { code: "grammar" };
  const clash = slots.some(
    (slot, position) => position !== index && slot.name === proposed,
  );
  return clash ? { code: "duplicate" } : null;
}

/** Every variant fill text in the catalog — the other place a slot is used. */
export function catalogFills(slots: readonly CatalogSlot[]): string[] {
  return slots.flatMap((slot) =>
    slot.variants.flatMap((variant) => Object.values(variant.fills)),
  );
}

export interface SlotUsage {
  /** Prompt fields whose text references the slot. */
  fields: PromptField[];
  /** Total `<<NAME>>` occurrences across both prompts — the remove-guard count. */
  promptOccurrences: number;
  /** Referenced by a prompt OR by another slot's variant fill. */
  usedAnywhere: boolean;
}

function countOccurrences(text: string, name: string): number {
  // Built per call rather than cached: the name is author input, and a shared
  // global regex would carry `lastIndex` between rows.
  const pattern = new RegExp(`<<${name}>>`, "g");
  return text.match(pattern)?.length ?? 0;
}

/**
 * Where each catalogued slot is referenced, derived from the draft itself.
 *
 * This mirrors the backend's `used_in` derivation so the author sees the same
 * answer publish will compute, and it is what makes the remove-guard's count
 * trustworthy: both read the same prompt text.
 */
export function deriveUsage(
  slots: readonly CatalogSlot[],
  prompts: Record<PromptField, string>,
): Map<string, SlotUsage> {
  const fillTexts = catalogFills(slots);
  const referencedInFills = referencedSlots(fillTexts);

  return new Map(
    slots.map((slot) => {
      const fields = PROMPT_FIELDS.filter(
        (field) => countOccurrences(prompts[field], slot.name) > 0,
      );
      const promptOccurrences = PROMPT_FIELDS.reduce(
        (total, field) => total + countOccurrences(prompts[field], slot.name),
        0,
      );
      return [
        slot.name,
        {
          fields,
          promptOccurrences,
          usedAnywhere: fields.length > 0 || referencedInFills.has(slot.name),
        },
      ];
    }),
  );
}
