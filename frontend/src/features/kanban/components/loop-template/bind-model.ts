// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { LoopTemplateAutofill } from "@/features/loop-templates/api/loop-templates";

/**
 * The SlotSpec fields the bind form needs, mirroring the backend's SlotSpec.
 * Read defensively off the untyped `content` bag: a template authored by a
 * newer backend must degrade to a usable form, never throw.
 */
export interface BindSlot {
  name: string;
  kind: "scalar" | "block" | "enum" | "variant" | "list";
  required: boolean;
  label: string;
  help: string;
  example: string;
  enum_values: string[];
  variants: BindVariant[];
  autofill?: string;
  default?: unknown;
}

export interface BindVariant {
  id: string;
  label: string;
  fills: Record<string, unknown>;
  tools_extra: string[];
  rails: Record<string, unknown>;
}

const SLOT_KINDS = ["scalar", "block", "enum", "variant", "list"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readVariants(raw: unknown): BindVariant[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).flatMap((variant) => {
    const id = variant.id;
    // A variant with no id cannot be selected or saved — dropping it beats
    // rendering a radio that produces an unsendable value.
    if (typeof id !== "string" || !id) return [];
    return [
      {
        id,
        label: str(variant.label, id),
        fills: isRecord(variant.fills) ? variant.fills : {},
        tools_extra: Array.isArray(variant.tools_extra)
          ? variant.tools_extra.filter(
              (tool): tool is string => typeof tool === "string",
            )
          : [],
        rails: isRecord(variant.rails) ? variant.rails : {},
      },
    ];
  });
}

/** The template's slot catalog, as the bind form reads it. */
export function readBindSlots(
  content: Record<string, unknown> | undefined,
): BindSlot[] {
  const raw = content?.slots;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).flatMap((entry) => {
    const name = entry.name;
    if (typeof name !== "string" || !name) return [];
    const kind = SLOT_KINDS.includes(entry.kind as (typeof SLOT_KINDS)[number])
      ? (entry.kind as BindSlot["kind"])
      : "scalar";
    return [
      {
        name,
        kind,
        required: entry.required === true,
        // The label is what the form's <label> shows; falling back to the slot
        // name keeps every field addressable even on a template that omitted it.
        label: str(entry.label, name),
        help: str(entry.help),
        example: str(entry.example),
        enum_values: Array.isArray(entry.enum_values)
          ? entry.enum_values.filter(
              (option): option is string => typeof option === "string",
            )
          : [],
        variants: readVariants(entry.variants),
        autofill:
          typeof entry.autofill === "string" ? entry.autofill : undefined,
        default: entry.default,
      },
    ];
  });
}

/** A slot the operator fills directly; `variant` slots carry an id instead. */
function isFreeText(slot: BindSlot): boolean {
  return slot.kind !== "variant";
}

/**
 * One editable line per item. `list` slots are edited as text — a line is an
 * item — so the form keeps ONE state type while the wire keeps the array the
 * renderer needs. `String(["a","b"])` would yield `"a,b"`, silently inventing
 * a separator the template never declared.
 */
function asFormText(value: unknown): string {
  if (Array.isArray(value)) return value.join("\n");
  return String(value);
}

/**
 * The form's opening values: autofill wins, then the template default, then
 * empty. A variant slot opens on its first option so the prompt it fills is
 * never left unrendered.
 */
export function initialSlotValues(
  slots: readonly BindSlot[],
  autofill: Record<string, LoopTemplateAutofill>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const slot of slots) {
    if (slot.kind === "variant") {
      values[slot.name] = slot.variants[0]?.id ?? "";
      continue;
    }
    const filled = autofill[slot.name]?.value;
    if (filled !== undefined && filled !== null) {
      values[slot.name] = asFormText(filled);
    } else if (slot.default !== undefined && slot.default !== null) {
      values[slot.name] = asFormText(slot.default);
    } else {
      values[slot.name] = "";
    }
  }
  return values;
}

/**
 * The form's text, as the wire types the backend renders from.
 *
 * A `list` slot becomes a `string[]` — one non-blank line per item. Every
 * other kind stays a string. The backend accepts a newline string for a list
 * too (compat with bindings stored before this contract), but sending the
 * array is what makes the operator's intent unambiguous: `[]` means "no
 * items", where `""` used to mean "silently render nothing".
 */
export function slotValuesForWire(
  slots: readonly BindSlot[],
  values: Record<string, string>,
): Record<string, string | string[]> {
  return Object.fromEntries(
    slots.map((slot) => {
      const text = values[slot.name] ?? "";
      if (slot.kind !== "list") return [slot.name, text];
      return [
        slot.name,
        text.split("\n").filter((line) => line.trim() !== ""),
      ];
    }),
  );
}

/**
 * Required slots the operator has not filled.
 *
 * Only free-text slots can be empty in a way the operator must fix — a variant
 * always holds one of its own ids.
 */
export function missingRequired(
  slots: readonly BindSlot[],
  values: Record<string, string>,
): string[] {
  return slots
    .filter(
      (slot) =>
        slot.required && isFreeText(slot) && !(values[slot.name] ?? "").trim(),
    )
    .map((slot) => slot.name);
}

/**
 * The rails the PUT carries, as EXPLICIT values.
 *
 * Direction (operator-set): template defaults are copied into the saved
 * config, so the runner-visible config is always complete — the server is
 * never asked to fill rails at read time. Variant rails override the
 * template's, since choosing a variant is the more specific statement.
 */
export function resolveRails(
  content: Record<string, unknown> | undefined,
  slots: readonly BindSlot[],
  values: Record<string, string>,
): Record<string, unknown> {
  const defaults = isRecord(content?.rails_defaults)
    ? content.rails_defaults
    : {};
  const fromVariants = slots.reduce<Record<string, unknown>>((acc, slot) => {
    if (slot.kind !== "variant") return acc;
    const chosen = slot.variants.find((v) => v.id === values[slot.name]);
    return chosen ? { ...acc, ...chosen.rails } : acc;
  }, {});
  return { ...defaults, ...fromVariants };
}

/**
 * Map a 422 `detail` onto the slot rows that caused it.
 *
 * The backend reports slot problems at `body.template.slot_values.<NAME>`, so
 * the form can point at the offending field instead of showing one opaque
 * banner.
 */
const SLOT_FIELD_PREFIX = "slot_values.";

/**
 * Two 422 shapes reach the bind form: Pydantic's `{loc: [...], msg}` for
 * schema violations and the renderer's `{code, field: "slot_values.NAME",
 * message}` findings (required_slot_missing, list_slot_expects_array, …).
 * Both name a slot; both must land on that slot's row.
 */
export function slotErrorsFromDetail(detail: unknown): Record<string, string> {
  if (!Array.isArray(detail)) return {};
  const errors: Record<string, string> = {};
  for (const item of detail) {
    if (!isRecord(item)) continue;
    if (Array.isArray(item.loc)) {
      const slotIndex = item.loc.indexOf("slot_values");
      const name = slotIndex >= 0 ? item.loc[slotIndex + 1] : undefined;
      if (typeof name === "string" && typeof item.msg === "string") {
        errors[name] = item.msg;
      }
      continue;
    }
    if (
      typeof item.field === "string" &&
      item.field.startsWith(SLOT_FIELD_PREFIX) &&
      typeof item.message === "string"
    ) {
      errors[item.field.slice(SLOT_FIELD_PREFIX.length)] = item.message;
    }
  }
  return errors;
}
