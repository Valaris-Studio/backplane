// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  NOTE_KINDS,
  FAILURE_CLASSES,
  IMMUTABLE_NOTE_KINDS,
} from "../noteKinds";

const NOTE_KINDS_PATH = path.resolve(
  __dirname,
  "../../../../../../backend/app/models/notes/kinds.py",
);
const FAILURE_CLASS_PATH = path.resolve(
  __dirname,
  "../../../../../../backend/app/models/notes/failure_class.py",
);

function backendNoteKinds(): string[] {
  const source = readFileSync(NOTE_KINDS_PATH, "utf8");
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

function backendImmutableKinds(): string[] {
  const source = readFileSync(NOTE_KINDS_PATH, "utf8");
  // Constant name -> kind value, so the frozenset's member NAMES resolve.
  const valuesByName = new Map<string, string>();
  for (const match of source.matchAll(/^([A-Z][A-Z0-9_]*)\s*=\s*"([^"]+)"/gm)) {
    if (match[1] && match[2]) valuesByName.set(match[1], match[2]);
  }
  const frozen = source.match(/IMMUTABLE_KINDS\s*=\s*frozenset\(\{([^}]*)\}\)/);
  if (!frozen?.[1]) throw new Error("IMMUTABLE_KINDS frozenset not found");
  return frozen[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => {
      const value = valuesByName.get(name);
      if (!value) throw new Error(`IMMUTABLE_KINDS member ${name} unresolved`);
      return value;
    });
}

function backendFailureClasses(): string[] {
  const source = readFileSync(FAILURE_CLASS_PATH, "utf8");
  const values: string[] = [];
  // Enum members: `NAME = "VALUE"` inside the ReviewFailureClass body.
  for (const match of source.matchAll(/^\s{4}[A-Z_]+\s*=\s*"([^"]+)"/gm)) {
    if (match[1]) values.push(match[1]);
  }
  return values;
}

describe("note kinds catalog drift", () => {
  it("frontend NOTE_KINDS === backend public note-kind constants", () => {
    expect([...NOTE_KINDS].sort()).toEqual(backendNoteKinds().slice().sort());
  });

  it("frontend IMMUTABLE_NOTE_KINDS === backend IMMUTABLE_KINDS", () => {
    expect([...IMMUTABLE_NOTE_KINDS].sort()).toEqual(
      backendImmutableKinds().sort(),
    );
  });

  it("frontend FAILURE_CLASSES === backend ReviewFailureClass values", () => {
    expect([...FAILURE_CLASSES].sort()).toEqual(
      backendFailureClasses().slice().sort(),
    );
  });
});
