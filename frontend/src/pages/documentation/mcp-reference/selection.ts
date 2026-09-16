// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export type ReferenceSelection =
  | { kind: "tool"; id: string }
  | { kind: "prompt"; id: string }
  | { kind: "resource"; id: string }
  | null;

// Deep-link contract: '#tool-<name>' / '#prompt-<name>' / '#resource-<uri>'.
// Resource uris contain '/' and ':' so they travel percent-encoded.
export function parseSelectionHash(hash: string): ReferenceSelection {
  const match = /^#(tool|prompt|resource)-(.+)$/.exec(hash);
  if (!match) return null;
  // Both groups are non-optional in the pattern, but noUncheckedIndexedAccess
  // types them as possibly-undefined — narrow instead of asserting.
  const [, kind, raw] = match;
  if (kind === undefined || raw === undefined) return null;
  if (kind === "resource") {
    // External input: chat apps truncate shared URLs mid-escape, which makes
    // decodeURIComponent throw. Degrade to "nothing selected" instead.
    try {
      return { kind: "resource", id: decodeURIComponent(raw) };
    } catch {
      return null;
    }
  }
  return { kind: kind as "tool" | "prompt", id: raw };
}

export function selectionHash(selection: NonNullable<ReferenceSelection>): string {
  const id =
    selection.kind === "resource"
      ? encodeURIComponent(selection.id)
      : selection.id;
  return `#${selection.kind}-${id}`;
}

export function sameSelection(
  a: ReferenceSelection,
  b: ReferenceSelection,
): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && a.id === b.id;
}
