// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createTestQueryClient } from "@/test/test-utils";
import { sessionKeys } from "@/lib/query-keys";
import type { ExcerptNoteDraft } from "../../utils/excerpt-note";
import { makeContent, makeSession } from "../../__tests__/fixtures";
import { HANDOFF_MAX_BYTES, HandoffDraftProvider, HandoffDraftStore, useHandoffDraft } from "../use-handoff-drafts";

const draft = (document = "Private retained text"): ExcerptNoteDraft => ({
  fingerprint: "source-identity", session: makeSession(), bodies: [{ item: makeContent({ id: "retained-source", preview: null }), text: "" }], document,
});
const state = (document?: string) => ({ selected: new Map(), draft: draft(document), form: null });

describe("Bounded handoff memory", () => {
  it("refuses a sixth draft without replacing the first five or their retry identities", () => {
    const store = new HandoffDraftStore();
    const first = state();
    expect(store.write("team/first", first)).toBe(true);
    for (let index = 1; index < 5; index++) expect(store.write(`team/${index}`, state())).toBe(true);
    expect(store.write("team/sixth", state())).toBe(false);
    expect(store.read("team/first")).toBe(first);
    expect(store.read("team/sixth").draft).toBeNull();
  });

  it("bounds retained UTF-8 bytes across sessions and rejects edits without dropping the prior text", () => {
    const store = new HandoffDraftStore();
    const first = state("é".repeat(HANDOFF_MAX_BYTES / 2));
    expect(store.write("team/first", first)).toBe(true);
    expect(store.bytes()).toBe(HANDOFF_MAX_BYTES);
    expect(store.write("team/second", state("x"))).toBe(false);
    expect(store.write("team/first", state(first.draft.document + "x"))).toBe(false);
    expect(store.read("team/first")).toBe(first);
    store.clear("team/first");
    expect(store.write("team/second", state("x"))).toBe(true);
  });

  it("bounds selection-only memory", () => {
    const store = new HandoffDraftStore();
    const item = makeContent({ preview: null });
    for (let index = 0; index < 20; index++) {
      expect(store.write(`team/${index}`, { selected: new Map([[item.id, item]]), draft: null, form: null })).toBe(true);
    }
    expect(store.write("team/overflow", { selected: new Map([[item.id, item]]), draft: null, form: null })).toBe(false);
    expect(store.write("team/0", { selected: new Map(Array.from({ length: 1025 }, (_, index) => [String(index), item])), draft: null, form: null })).toBe(false);
  });

  it("revokes old async writers when the owner memory is disposed", () => {
    const store = new HandoffDraftStore();
    const original = state();
    store.write("team/source", original);
    expect(store.current("team/source", original.draft)).toBe(true);
    store.dispose();
    expect(store.current("team/source", original.draft)).toBe(false);
    expect(store.write("team/source", original)).toBe(false);
    expect(store.bytes()).toBe(0);
  });
});

function DraftProbe() {
  const handoff = useHandoffDraft("team", "source");
  return <>
    <button onClick={() => handoff.setDraft(draft())}>Retain handoff</button>
    <output>{handoff.state.draft?.document ?? "No draft"}</output>
  </>;
}

it("warns while the draft route is absent, then clears private memory on owner change", () => {
  const client = createTestQueryClient();
  const tree = (ownerId: string | null, visible: boolean) => <QueryClientProvider client={client}>
    <HandoffDraftProvider ownerId={ownerId}>{visible ? <DraftProbe /> : <p>Other route</p>}</HandoffDraftProvider>
  </QueryClientProvider>;
  const rendered = render(tree("owner-one", true));
  fireEvent.click(screen.getByText("Retain handoff"));
  rendered.rerender(tree("owner-one", false));
  const warning = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(warning);
  expect(warning.defaultPrevented).toBe(true);
  rendered.rerender(tree("owner-two", true));
  expect(screen.getByText("No draft")).toBeVisible();
  const afterChange = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(afterChange);
  expect(afterChange.defaultPrevented).toBe(false);
});

it.each(["session", "unavailable", "withheld"])("purges a handoff on current %s source revocation", (change) => {
  const client = createTestQueryClient();
  render(<QueryClientProvider client={client}><HandoffDraftProvider ownerId="owner"><DraftProbe /></HandoffDraftProvider></QueryClientProvider>);
  fireEvent.click(screen.getByText("Retain handoff"));
  expect(screen.getByText("Private retained text")).toBeVisible();
  act(() => {
    if (change === "session") client.setQueryData(sessionKeys.detail("team", "source"), null);
    else client.setQueryData(sessionKeys.selectedMetadata("team", "source", ["retained-source"]), {
      unavailable_ids: change === "unavailable" ? ["retained-source"] : [],
      items: change === "withheld" ? [makeContent({ id: "retained-source", coverage: "withheld_by_policy" })] : [],
    });
  });
  expect(screen.getByText("No draft")).toBeVisible();
});
