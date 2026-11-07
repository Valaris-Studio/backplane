// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { act, screen, stubReducedMotion, waitFor, within } from "@/test/test-utils";
import i18n from "@/i18n/config";
import { clearHistoryFixtures, CURRENT_DIGEST, deferred, expectReadOnly, makeNote, mountHistory,
  openHistory, revision, selectRevision, settled } from "./note-history-fixtures";

vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: ({ content, onChange }: { content: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Note content editor" value={content} onChange={(event) => onChange(event.target.value)} />
  ),
}));

beforeEach(async () => {
  stubReducedMotion(true);
  await i18n.changeLanguage("en");
});
afterEach(async () => {
  cleanup();
  clearHistoryFixtures();
  stubReducedMotion(false);
  await i18n.changeLanguage("en");
});

function richVersions() {
  const before = revision(1);
  const after = revision(2, { changed_fields: ["content", "title", "pinned"] });
  before.snapshot.content = JSON.stringify({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "Same words, changed formatting" }] },
    { type: "paragraph", content: [{ type: "text", text: "Runbook", marks: [{ type: "link", attrs: { href: "https://example.test/old-runbook" } }] }] },
    { type: "paragraph", content: [{ type: "text", text: "Release checklist" }] },
  ] });
  after.snapshot.content = JSON.stringify({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "Same words, changed formatting", marks: [{ type: "bold" }] }] },
    { type: "paragraph", content: [{ type: "text", text: "Runbook", marks: [{ type: "link", attrs: { href: "https://example.test/new-runbook" } }] }] },
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Release checklist" }] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Verify access" }] }] }] },
  ] });
  after.snapshot.title = "Release notes renamed";
  after.snapshot.pinned = true;
  after.title = after.snapshot.title;
  after.pinned = true;
  return [revision(3), after, before];
}

describe("readable exact saved-note comparisons", () => {
  it("compares previous→selected with real formatting, changed link targets, headings, lists and metadata", async () => {
    const { state } = mountHistory({ revisions: richVersions() });
    const { dialog } = await openHistory();
    await selectRevision(dialog, 2);
    const texts = await within(dialog).findAllByText("Same words, changed formatting");
    expect(texts).toHaveLength(2);
    expect(texts.filter((text) => text.closest("strong"))).toHaveLength(1);
    const links = within(dialog).getAllByRole("link", { name: "Runbook" });
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://example.test/old-runbook", "https://example.test/new-runbook",
    ]);
    expect(within(dialog).getByText("https://example.test/old-runbook")).toBeVisible();
    expect(within(dialog).getByText("https://example.test/new-runbook")).toBeVisible();
    expect(within(dialog).getByRole("heading", { name: "Release checklist", level: 2 })).toBeVisible();
    expect(within(dialog).getByText("Verify access").closest("li")).not.toBeNull();
    expect(within(dialog).getAllByText("Release notes renamed").length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/^Unpinned$/i)).toBeVisible();
    expect(within(dialog).getByText(/^Pinned$/i)).toBeVisible();
    expect(within(dialog).queryByText(/"type":"doc"/)).not.toBeInTheDocument();
    const comparison = state.historyRequests.find((url) => url.pathname.endsWith("/compare"));
    expect(comparison?.searchParams.get("from_revision")).toBe("1");
    expect(comparison?.searchParams.get("to_revision")).toBe("2");
    expectReadOnly(state);
  });

  it("replaces both rendered snapshots when the selected pair changes, including the end of a long note", async () => {
    const versions = [revision(3), revision(2), revision(1)];
    versions[0]!.snapshot.content = `<p>${"Long saved passage. ".repeat(4000)}</p><p>End of third revision</p>`;
    versions[1]!.snapshot.content = "<p>Only second revision</p>";
    versions[2]!.snapshot.content = "<p>Only first revision</p>";
    const { state } = mountHistory({ revisions: versions });
    const { dialog } = await openHistory();
    await selectRevision(dialog, 2);
    expect(await within(dialog).findByText("Only first revision")).toBeVisible();
    expect(within(dialog).getByText("Only second revision")).toBeVisible();
    await selectRevision(dialog, 3);
    expect(await within(dialog).findByText("End of third revision")).toBeVisible();
    expect(within(dialog).queryByText("Only first revision")).not.toBeInTheDocument();
    expect(within(dialog).getByText("Only second revision")).toBeVisible();
    expectReadOnly(state);
  });

  it("discloses changed stored bytes when both rich structures render identically", async () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Same rendered release note" }] }] };
    const before = revision(1, { content_sha256: "a".repeat(64) });
    const after = revision(2, { content_sha256: "b".repeat(64) });
    before.snapshot.content = JSON.stringify(doc);
    after.snapshot.content = JSON.stringify(doc, null, 2);
    const { state } = mountHistory({ revisions: [revision(3), after, before] });
    const { dialog } = await openHistory();
    await selectRevision(dialog, 2);
    expect(await within(dialog).findByText(/stored content changed.*(?:rendered structure|rendering).*equivalent/i)).toBeVisible();
    expect(within(dialog).queryByText(/^no changes$/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/"type":\s*"doc"/)).not.toBeInTheDocument();
    expectReadOnly(state);
  });

  it("names the bounded-alignment fallback and exposes complete before/after snapshots including their tails", async () => {
    const before = revision(1);
    const after = revision(2);
    before.snapshot.content = JSON.stringify({ type: "doc", content: Array.from({ length: 1001 }, (_, index) => (
      { type: "paragraph", content: [{ type: "text", text: `Before block ${index + 1}` }] }
    )) });
    after.snapshot.content = JSON.stringify({ type: "doc", content: Array.from({ length: 1001 }, (_, index) => (
      { type: "paragraph", content: [{ type: "text", text: `After block ${index + 1}` }] }
    )) });
    const { state } = mountHistory({ revisions: [revision(3), after, before] });
    const { dialog } = await openHistory();
    await selectRevision(dialog, 2);
    expect(await within(dialog).findByText(/(?:detailed |block )?alignment.*unavailable.*large|large.*(?:detailed |block )?alignment.*unavailable/i)).toBeVisible();
    for (const side of ["Before", "After"]) {
      const tail = `${side} block 1001`;
      const name = new RegExp(`^(?:(?:view|show|open).*?)?(?:complete |full )?${side}(?: snapshot)?$`, "i");
      const reveal = within(dialog).queryByRole("button", { name }) ?? within(dialog).queryByRole("tab", { name });
      if (reveal) fireEvent.click(reveal);
      expect(await within(dialog).findByText(`${side} block 1`)).toBeVisible();
      expect(within(dialog).getByText(tail)).toBeVisible();
    }
    expect(within(dialog).queryByText(/"type":\s*"doc"/)).not.toBeInTheDocument();
    expectReadOnly(state);
  });

  it("compares selected→current saved only after digest equality, keeping unpublished edits out of the comparison", async () => {
    const versions = [revision(3), revision(2), revision(1)];
    const saved = makeNote({ history_revision: 3, revision_digest: CURRENT_DIGEST, content: versions[0]!.snapshot.content });
    const { state } = mountHistory({ revisions: versions, note: saved });
    fireEvent.change(screen.getByRole("textbox", { name: "Note content editor" }), { target: { value: "Unpublished draft must stay private" } });
    const { dialog } = await openHistory();
    await selectRevision(dialog, 2);
    fireEvent.click(await within(dialog).findByRole("button", { name: /^Current saved revision(?: · Revision \d+)?$/i }));
    expect(await within(dialog).findByText("Saved revision 3 body")).toBeVisible();
    expect(within(dialog).getByText("Saved revision 2 body")).toBeVisible();
    expect(within(dialog).queryByText("Saved revision 1 body")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Unpublished draft must stay private")).not.toBeInTheDocument();
    const comparison = state.historyRequests.filter((url) => url.pathname.endsWith("/compare")).at(-1);
    expect(comparison?.searchParams.get("from_revision")).toBe("2");
    expect(comparison?.searchParams.get("to_revision")).toBe("3");
    expect(state.currentRequests.length).toBeGreaterThan(0);
    expectReadOnly(state);
  });

  it("keeps the newer selected comparison when an older pair resolves late", async () => {
    const { state, client } = mountHistory();
    const { dialog } = await openHistory();
    const gate = deferred();
    state.detailGate = gate;
    await selectRevision(dialog, 2);
    await waitFor(() => expect(state.detailGate).toBeNull());
    await selectRevision(dialog, 3);
    expect(await within(dialog).findByText("Saved revision 3 body")).toBeVisible();
    await act(async () => gate.release());
    await settled(client);
    expect(within(dialog).getByText("Saved revision 3 body")).toBeVisible();
    expect(within(dialog).getByText("Saved revision 2 body")).toBeVisible();
    expect(within(dialog).queryByText("Saved revision 1 body")).not.toBeInTheDocument();
    expectReadOnly(state);
  });

  it.each(["digest", "counter"])("does not trust stale editor props when the fresh current %s differs from the recorded head", async (mismatch) => {
    const { state, client } = mountHistory({ note: makeNote() });
    state.savedNote = makeNote({ history_revision: mismatch === "counter" ? 2 : 3,
      revision_digest: mismatch === "digest" ? "f".repeat(64) : CURRENT_DIGEST, content: "<p>Unrecorded current text</p>" });
    const { dialog } = await openHistory();
    await selectRevision(dialog, 2);
    const current = await within(dialog).findByRole("button", { name: /^Current saved revision(?: · Revision \d+)?$/i });
    expect(current).toBeDisabled();
    expect(await within(dialog).findByText(/current.*(?:differs|unavailable|not recorded|unrecorded)|unrecorded.*current/i)).toBeVisible();
    await settled(client);
    expect(state.historyRequests.filter((url) => url.pathname.endsWith("/compare") && url.searchParams.get("to_revision") === "3")).toHaveLength(0);
    expect(state.currentRequests.length).toBeGreaterThan(0);
    expect(within(dialog).queryByText("Unrecorded current text")).not.toBeInTheDocument();
    expectReadOnly(state);
  });

  it("invalidates current-state proof on live activity without swapping the selected saved snapshots", async () => {
    const { state, socket, client } = mountHistory();
    const { dialog } = await openHistory();
    await selectRevision(dialog, 2);
    const current = await within(dialog).findByRole("button", { name: /^Current saved revision(?: · Revision \d+)?$/i });
    await waitFor(() => expect(current).toBeEnabled());
    fireEvent.click(current);
    expect(await within(dialog).findByText("Saved revision 3 body")).toBeVisible();
    const pairsBeforeEvent = state.historyRequests.filter((url) => url.pathname.endsWith("/compare")).map((url) => url.search);
    const currentReadsBeforeEvent = state.currentRequests.length;
    state.savedNote = makeNote({ revision_digest: "f".repeat(64), content: "<p>Unrecorded live saved content</p>" });
    act(() => socket.emit("activity.note.updated"));
    expect(await within(dialog).findByText(/new (?:saved )?changes/i)).toBeVisible();
    expect(current).toBeDisabled();
    expect(within(dialog).getByText("Saved revision 2 body")).toBeVisible();
    expect(within(dialog).getByText("Saved revision 3 body")).toBeVisible();
    expect(within(dialog).queryByText("Unrecorded live saved content")).not.toBeInTheDocument();
    expect(state.historyRequests.filter((url) => url.pathname.endsWith("/compare")).map((url) => url.search)).toEqual(pairsBeforeEvent);
    fireEvent.click(within(dialog).getByRole("button", { name: /^Refresh$/i }));
    await settled(client);
    expect(state.currentRequests.length).toBeGreaterThan(currentReadsBeforeEvent);
    expect(current).toBeDisabled();
    expect(await within(dialog).findByText(/current.*(?:differs|unavailable|not recorded|unrecorded)|unrecorded.*current/i)).toBeVisible();
    expect(within(dialog).getByText("Saved revision 2 body")).toBeVisible();
    expect(within(dialog).getByText("Saved revision 3 body")).toBeVisible();
    expect(within(dialog).queryByText("Saved revision 1 body")).not.toBeInTheDocument();
    expectReadOnly(state);
  });

  it("keeps a corrupt historical snapshot unavailable and retries without substituting today's body", async () => {
    const { state } = mountHistory();
    state.detailStatus = 503;
    state.compareStatus = 503;
    const { dialog } = await openHistory();
    await selectRevision(dialog, 2);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/unavailable|could not|failed/i);
    expect(within(dialog).queryByText("Current saved body")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Saved revision 2 body")).not.toBeInTheDocument();
    state.detailStatus = 200;
    state.compareStatus = 200;
    fireEvent.click(within(dialog).getByRole("button", { name: /retry|try again/i }));
    expect(await within(dialog).findByText("Saved revision 2 body")).toBeVisible();
    expectReadOnly(state);
  });

  it("reports no recorded history without fabricating a baseline, comparison or write", async () => {
    const { state, client } = mountHistory({ revisions: [], note: makeNote({ history_revision: 0 }) });
    const { dialog } = await openHistory();
    expect(await within(dialog).findByText(/no (?:recorded )?(?:history|revisions)|history.*not.*recorded/i)).toBeVisible();
    await settled(client);
    expect(state.historyRequests).toHaveLength(1);
    expect(within(dialog).queryByRole("button", { name: /^Revision /i })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /original handoff/i })).not.toBeInTheDocument();
    expectReadOnly(state);
  });

  it("keeps an unknown baseline honest instead of comparing it with invented earlier content", async () => {
    const baseline = revision(1, { capture_kind: "baseline", actor: null, operation: "capture" });
    const { state } = mountHistory({ revisions: [revision(2), baseline], note: makeNote({ history_revision: 2 }) });
    const { dialog } = await openHistory();
    await selectRevision(dialog, 1);
    expect(await within(dialog).findByText("Saved revision 1 body")).toBeVisible();
    expect(within(dialog).getByText(/no (?:earlier|previous) revision|earlier.*(?:not recorded|unavailable)/i)).toBeVisible();
    await waitFor(() => expect(state.historyRequests.some((url) => url.pathname.endsWith("/1"))).toBe(true));
    expect(state.historyRequests.some((url) => url.searchParams.get("from_revision") === "0")).toBe(false);
    expectReadOnly(state);
  });

  it("compares a captured gap with its real preceding revision while disclosing the unknown interval", async () => {
    const gap = revision(2, { capture_kind: "gap_baseline", operation: "capture", actor: null });
    const { state } = mountHistory({ revisions: [revision(3), gap, revision(1)] });
    const { dialog } = await openHistory();
    await selectRevision(dialog, 2);
    expect(await within(dialog).findByText("Saved revision 2 body")).toBeVisible();
    expect(within(dialog).getByText("Saved revision 1 body")).toBeVisible();
    const comparison = state.historyRequests.find((url) => url.pathname.endsWith("/compare"));
    expect(comparison?.searchParams.get("from_revision")).toBe("1");
    expect(comparison?.searchParams.get("to_revision")).toBe("2");
    expect(within(dialog).getAllByText(/unrecorded changes|gap in/i)[0]).toBeVisible();
    expect(within(dialog).getAllByText(/(?:actor|author).*(?:time.*)?unknown|unknown.*(?:actor|author)/i)[0]).toBeVisible();
    expect(within(dialog).queryByText(/no (?:earlier|previous) revision|earlier.*(?:not recorded|unavailable)/i)).not.toBeInTheDocument();
    expectReadOnly(state);
  });

  it("discloses unsupported rich structures while retaining both snapshots, type names and changed attributes", async () => {
    const before = revision(1);
    const after = revision(2);
    before.snapshot.content = JSON.stringify({ type: "doc", content: [
      { type: "futureBlock", attrs: { workflowState: "draft-only" }, content: [
        { type: "paragraph", content: [{ type: "text", text: "Before future block payload" }] },
      ] },
      { type: "paragraph", content: [{ type: "text", text: "Before future marked text", marks: [{ type: "futureMark" }] }] },
    ] });
    after.snapshot.content = JSON.stringify({ type: "doc", content: [
      { type: "futureBlock", attrs: { workflowState: "approved-by-operator" }, content: [
        { type: "paragraph", content: [{ type: "text", text: "After future block payload" }] },
      ] },
      { type: "paragraph", content: [{ type: "text", text: "After future marked text", marks: [{ type: "futureMark" }] }] },
    ] });
    const { state } = mountHistory({ revisions: [revision(3), after, before] });
    const { dialog } = await openHistory();
    await selectRevision(dialog, 2);
    expect(await within(dialog).findByText("Before future block payload")).toBeVisible();
    expect(within(dialog).getByText("After future block payload")).toBeVisible();
    expect(within(dialog).getByText("Before future marked text")).toBeVisible();
    expect(within(dialog).getByText("After future marked text")).toBeVisible();
    expect(within(dialog).getAllByText(/unsupported|not supported|cannot.*(?:render|display)/i)[0]).toBeVisible();
    dialog.querySelectorAll("details:not([open]) > summary").forEach((summary) => fireEvent.click(summary));
    expect(within(dialog).getAllByText(/futureBlock/)[0]).toBeVisible();
    expect(within(dialog).getAllByText(/futureMark/)[0]).toBeVisible();
    expect(within(dialog).getAllByText(/workflowState/)[0]).toBeVisible();
    expect(within(dialog).getByText("draft-only")).toBeVisible();
    expect(within(dialog).getByText("approved-by-operator")).toBeVisible();
    expect(within(dialog).queryByText(/^\s*(?:no changes|content unchanged|no content changes)[.!]?\s*$/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/"type"\s*:\s*"doc"/)).not.toBeInTheDocument();
    expectReadOnly(state);
  });

  it("keeps a malformed historical document inspectable without crashing or inventing an empty comparison", async () => {
    const malformed = revision(1);
    malformed.snapshot.content = JSON.stringify({ type: "doc", content: {
      unexpected: "<strong>Retained malformed historical text</strong>",
    } });
    const { state } = mountHistory({ revisions: [revision(3), revision(2), malformed] });
    const { dialog } = await openHistory();
    await selectRevision(dialog, 2);
    expect((await within(dialog).findAllByText(/unsupported|not supported|unavailable|cannot.*(?:render|display)/i))[0]).toBeVisible();
    expect(dialog).toBeInTheDocument();
    dialog.querySelectorAll("details:not([open]) > summary").forEach((summary) => fireEvent.click(summary));
    const retained = within(dialog).getByText(/Retained malformed historical text/);
    expect(retained).toBeVisible();
    expect(retained).toHaveTextContent("<strong>Retained malformed historical text</strong>");
    expect(retained.querySelector("strong")).toBeNull();
    expect(within(dialog).queryByText("Current saved body")).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/^\s*(?:no changes|content unchanged|no content changes|empty revision)[.!]?\s*$/i)).not.toBeInTheDocument();
    expectReadOnly(state);
  });

  it.each(["empty", "missing"] as const)("preserves the saved paragraph through an honest fallback when a text node is %s", async (textState) => {
    const malformed = revision(1);
    malformed.snapshot.content = JSON.stringify({ type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "Retained valid historical paragraph" }] },
      { type: textState === "empty" ? "codeBlock" : "paragraph", content: [textState === "empty" ? { type: "text", text: "" } : { type: "text" }] },
    ] });
    const { state } = mountHistory({ revisions: [revision(3), revision(2), malformed] });
    const { dialog } = await openHistory();
    await selectRevision(dialog, 2);
    expect(await within(dialog).findByText("Saved revision 2 body")).toBeVisible();
    dialog.querySelectorAll("details:not([open]) > summary").forEach((summary) => fireEvent.click(summary));
    expect(within(dialog).getByText(/Retained valid historical paragraph/)).toBeVisible();
    expect(within(dialog).getAllByText(/unsupported|not supported|malformed|unavailable|cannot.*(?:render|display)/i)[0]).toBeVisible();
    expect(within(dialog).queryByText("Current saved body")).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/^\s*(?:no changes|content unchanged|no content changes|empty revision|empty snapshot)[.!]?\s*$/i)).not.toBeInTheDocument();
    expectReadOnly(state);
  });

  it("names the freshly verified target revision before activating current comparison", async () => {
    const { state } = mountHistory({ note: makeNote({ history_revision: 99, revision_digest: "9".repeat(64) }) });
    state.savedNote = makeNote({ history_revision: 3, revision_digest: CURRENT_DIGEST });
    const { dialog } = await openHistory();
    await selectRevision(dialog, 2);
    expect(await within(dialog).findByText("Saved revision 2 body")).toBeVisible();
    const current = within(dialog).getByRole("button", { name: /^Current saved revision/i });
    await waitFor(() => expect(current).toBeEnabled());
    expect(state.currentRequests.length).toBeGreaterThan(0);
    expect(current).toHaveTextContent(/\bRevision 3\b/i);
    expect(current).toHaveAccessibleName(/^Current saved revision.*\bRevision 3\b/i);
    expect(current).not.toHaveTextContent(/\bRevision 99\b/i);
    expect(state.historyRequests.some((url) => url.pathname.endsWith("/compare") && url.searchParams.get("to_revision") === "3")).toBe(false);
    fireEvent.click(current);
    expect(await within(dialog).findByText("Saved revision 3 body")).toBeVisible();
    const comparison = state.historyRequests.filter((url) => url.pathname.endsWith("/compare")).at(-1);
    expect(comparison?.searchParams.get("from_revision")).toBe("2");
    expect(comparison?.searchParams.get("to_revision")).toBe("3");
    expectReadOnly(state);
  });
});
