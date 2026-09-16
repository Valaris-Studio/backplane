// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// `LoopTemplateDetail.content` is an untyped bag (the backend owns the
// authoritative TemplateContent shape and it grows per phase). These readers
// give the editor tabs a typed view of the parts they touch without pretending
// to model fields they do not edit — an unknown shape reads as empty rather
// than throwing on a template authored by a newer backend.

/** The SlotSpec fields the prompts tab reads or writes. */
export interface DraftSlot {
  name: string;
  kind: string;
  required?: boolean;
  help?: string;
  example?: string;
  // SlotVariant.fills in app/services/loop_template_render.py: a map of target
  // slot name -> fill text, NOT a single `fill` string. Widened to unknown so
  // a CatalogSlot (which types this precisely) stays assignable to a DraftSlot
  // — the two modules must not model the same backend field differently.
  variants?: { fills?: Record<string, unknown> }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function readPrompt(
  content: Record<string, unknown> | undefined,
  key: "system_prompt" | "loop_prompt",
): string {
  const value = content?.[key];
  return typeof value === "string" ? value : "";
}

export function readSlots(
  content: Record<string, unknown> | undefined,
): DraftSlot[] {
  const raw = content?.slots;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).flatMap((entry) => {
    const name = entry.name;
    // A nameless row cannot be referenced by a prompt and would render an
    // "unused <<undefined>>" chip, so it is dropped rather than surfaced.
    if (typeof name !== "string" || !name) return [];
    return [
      {
        name,
        // "scalar", not "text": an unreadable kind must still be a member of
        // the backend SlotKind literal, or this default is itself the thing
        // that fails the publish validator (card 41dc5cb8).
        kind: typeof entry.kind === "string" ? entry.kind : "scalar",
        required: entry.required === true,
        help: typeof entry.help === "string" ? entry.help : undefined,
        example: typeof entry.example === "string" ? entry.example : undefined,
        variants: Array.isArray(entry.variants)
          ? entry.variants.filter(isRecord).map((variant) => ({
              fills: isRecord(variant.fills) ? variant.fills : undefined,
            }))
          : undefined,
      },
    ];
  });
}

/** Every variant fill text across the catalog — a slot referenced here is used. */
export function variantFills(slots: readonly DraftSlot[]): string[] {
  return slots.flatMap((slot) =>
    (slot.variants ?? []).flatMap((variant) =>
      Object.values(variant.fills ?? {}).filter(
        (fill): fill is string => typeof fill === "string" && !!fill,
      ),
    ),
  );
}
