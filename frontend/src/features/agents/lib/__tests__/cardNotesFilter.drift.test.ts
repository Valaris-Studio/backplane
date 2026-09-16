// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CARD_NOTE_KINDS } from "../contextSourceCatalog";

const NOTE_KINDS_PATH = path.resolve(
  __dirname,
  "../../../../../../backend/app/models/notes/kinds.py",
);

function backendNoteKinds(): string[] {
  const source = readFileSync(NOTE_KINDS_PATH, "utf8");
  // Public string constants only — UPPER_NAME = "snake_value". Skip
  // private (_PREFIXED) and frozenset/list aggregates. Mirrors the backend
  // validator's discovery (see _validate_context_source_filter, which uses
  // `vars(note_kinds_module)` filtered by isinstance(v, str)).
  const kinds: string[] = [];
  for (const match of source.matchAll(/^([A-Z][A-Z0-9_]*)\s*=\s*"([^"]+)"/gm)) {
    const name = match[1];
    const value = match[2];
    if (name === undefined || value === undefined) continue;
    if (name.startsWith("_")) continue;
    kinds.push(value);
  }
  return kinds;
}

describe("card notes filter drift", () => {
  it("frontend CARD_NOTE_KINDS === backend public note-kind constants", () => {
    const backend = backendNoteKinds().slice().sort();
    const frontend = [...CARD_NOTE_KINDS].sort();
    expect(frontend).toEqual(backend);
  });
});
