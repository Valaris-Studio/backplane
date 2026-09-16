// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TFunction } from "i18next";

// Opaque-classifier humanizers. Every classifier field (card_type / priority /
// role / status) is an OPAQUE string: the four known card_type/priority values
// have i18n labels, but any user-defined value must round-trip. We look up the
// i18n key with a humanized `defaultValue` so unknown values surface verbatim
// (underscores/dashes -> spaces) — never an "unknown" placeholder, never an
// enumerated set.

function prettify(value: string): string {
  return value.replace(/[_-]+/g, " ").trim();
}

export function humanizeCardType(type: string, t: TFunction): string {
  if (!type) return "";
  return t(`cards.types.${type}`, { defaultValue: prettify(type) });
}

export function humanizePriority(priority: string, t: TFunction): string {
  if (!priority) return "";
  return t(`cards.priorities.${priority}`, { defaultValue: prettify(priority) });
}

export function humanizeRole(role: string, t: TFunction): string {
  if (!role) return "";
  return t(`timeline.roles.${role}`, { defaultValue: prettify(role) });
}

export { getInitials as initials } from "@/lib/initials";
