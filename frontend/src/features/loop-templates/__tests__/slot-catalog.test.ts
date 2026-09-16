// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { blankSlot, readCatalog, type CatalogSlot } from "../lib/slot-catalog";

// Card 1f9f210c — SlotSpec.deprecated (backend a3c37344) marks a slot that
// stays catalogued so stored values never hit `unknown_slot`, but is exempt
// from `unused_slot` at publish. The Slots tab persists CatalogSlot rows
// verbatim (`draft.setField("content.slots", rows)`), so readCatalog IS the
// serializer: a field it drops on read is a field the next autosave deletes,
// and the fork is back behind the publish block the flag exists to lift.

const deprecatedSlot = {
  name: "RUN_HISTORY_KEY",
  kind: "scalar",
  required: false,
  label: "Run-history definition key (legacy)",
  help: "Kept so stored values keep rendering; no prompt reads it.",
  example: "loop_run_history",
  default: "",
  deprecated: true,
};

const liveSlot = {
  name: "CHARTER_KEY",
  kind: "scalar",
  required: true,
  label: "Charter definition key",
  example: "loop_charter",
};

// Read through the persisted-JSON view rather than the typed property, so the
// file typechecks before CatalogSlot grows the field and still fails at runtime.
function asPersisted(slot: CatalogSlot): Record<string, unknown> {
  return slot as unknown as Record<string, unknown>;
}

function deprecatedOf(rows: CatalogSlot[], name: string): unknown {
  const row = rows.find((slot) => slot.name === name);
  if (!row) throw new Error(`no catalog row named ${name}`);
  return asPersisted(row).deprecated;
}

describe("slot catalog round-trips SlotSpec.deprecated", () => {
  it("reads deprecated: true into the catalog row", () => {
    const rows = readCatalog({ slots: [deprecatedSlot, liveSlot] });
    expect(deprecatedOf(rows, "RUN_HISTORY_KEY")).toBe(true);
  });

  it("does not mark a slot deprecated when the JSON never said so", () => {
    const rows = readCatalog({ slots: [liveSlot] });
    expect(deprecatedOf(rows, "CHARTER_KEY")).toBeFalsy();
  });

  it("treats a non-boolean deprecated value as not deprecated", () => {
    const rows = readCatalog({ slots: [{ ...liveSlot, deprecated: "yes" }] });
    expect(deprecatedOf(rows, "CHARTER_KEY")).toBeFalsy();
  });

  it("emits deprecated: true only for the deprecated slot in what gets persisted", () => {
    // The rows ARE the persisted JSON; the backend reads a missing key as
    // false, so a dropped key silently un-deprecates the slot.
    const persisted = readCatalog({ slots: [deprecatedSlot, liveSlot] }).map(asPersisted);
    expect(persisted[0]?.deprecated).toBe(true);
    expect(persisted[1]?.deprecated).not.toBe(true);
  });

  it("gives a blank row no deprecated marking", () => {
    expect(asPersisted(blankSlot("NEW")).deprecated).toBeFalsy();
  });

  it("keeps the flag across a full read -> persist -> read cycle", () => {
    const first = readCatalog({ slots: [deprecatedSlot, liveSlot] });
    const second = readCatalog({ slots: first.map(asPersisted) });
    const flags = (rows: CatalogSlot[]) =>
      rows.map((slot) => [slot.name, asPersisted(slot).deprecated === true]);
    expect(flags(second)).toEqual(flags(first));
    expect(deprecatedOf(second, "RUN_HISTORY_KEY")).toBe(true);
    expect(deprecatedOf(second, "CHARTER_KEY")).toBeFalsy();
  });
});
