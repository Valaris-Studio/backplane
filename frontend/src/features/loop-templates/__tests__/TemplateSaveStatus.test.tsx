// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { resolveSaveState } from "../components/TemplateSaveStatus";

// Card e5ecad48 (F2) — the indicator's precedence chain.
//
// These combinations are asserted at the resolver rather than through the
// store because the store cannot currently produce them: `persist()` sets
// `conflict` and clears `saving` in the same batched tick, so a rendered
// `saving && conflict` never occurs today. The precedence is still a real
// contract — `conflict` is LATCHED (autosaving has stopped, only a reload
// moves forward) while `saving` is transient — and a future change that lets
// the two overlap must not silently downgrade a dead autosave to "Saving…".
describe("resolveSaveState precedence (card e5ecad48)", () => {
  const state = (conflict: boolean, saving: boolean, dirty: boolean) =>
    resolveSaveState({ conflict, saving, dirty });

  it("reports conflict even while a save is still in flight", () => {
    expect(state(true, true, true)).toBe("conflict");
  });

  it("reports conflict over a merely dirty draft", () => {
    expect(state(true, false, true)).toBe("conflict");
  });

  it("reports saving over dirty while the PATCH is in flight", () => {
    // `dirty` stays true during the request so the unsaved-work guard keeps
    // blocking; the indicator must still show the more specific state.
    expect(state(false, true, true)).toBe("saving");
  });

  it("reports unsaved for a dirty, idle draft", () => {
    expect(state(false, false, true)).toBe("unsaved");
  });

  it("reports saved when nothing is pending", () => {
    expect(state(false, false, false)).toBe("saved");
  });
});
