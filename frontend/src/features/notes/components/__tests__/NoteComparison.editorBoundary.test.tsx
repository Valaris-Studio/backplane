// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import RichTextEditor from "@/components/shared/RichTextEditorImpl";
import { act, renderWithProviders, screen, waitFor } from "@/test/test-utils";
import i18n from "@/i18n/config";
import { NoteComparison } from "../NoteComparison";
import type { NoteRevisionDetail } from "../../api/note-history-types";
import { compareRichBlocks, richBlocks, richDocument, type RichNode } from "../../utils/note-rich-comparison";
import { revision } from "./note-history-fixtures";

vi.mock("@/hooks/useImageUpload", () => ({
  useImageUpload: () => ({ uploadImage: vi.fn(), isUploading: false }),
}));
vi.mock("@/hooks/useFileUpload", () => ({
  useFileUpload: () => ({ uploadFile: vi.fn(), isUploading: false }),
}));

beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(cleanup);

const paragraph = (text: string): RichNode => ({ type: "paragraph", content: [{ type: "text", text }] });
const link = (attrs: Record<string, unknown>): RichNode => ({ type: "paragraph", content: [
  { type: "text", text: "Unchanged runbook", marks: [{ type: "link", attrs }] },
] });
const orderedList = (attrs?: Record<string, unknown>): RichNode => ({ type: "orderedList",
  ...(attrs ? { attrs } : {}), content: [{ type: "listItem", content: [paragraph("Unchanged ordered item")] }],
});
const codeBlock = (attrs?: Record<string, unknown>): RichNode => ({ type: "codeBlock",
  ...(attrs ? { attrs } : {}), content: [{ type: "text", text: "Unchanged code\n" }],
});

// These minimal nodes are emitted by the backend's Markdown normalizer; the
// real editor adds schema defaults while saving an unrelated paragraph edit.
const BACKEND_BLOCKS: RichNode[] = [
  paragraph("Original opening"),
  paragraph("Unchanged paragraph"),
  link({ href: "https://example.test/runbook" }),
  orderedList(),
  codeBlock(),
  paragraph("Unchanged closing"),
];

async function editOpening(content: string) {
  const onChange = vi.fn();
  const rendered = renderWithProviders(<RichTextEditor content={content} onChange={onChange} />);
  await waitFor(() => expect(rendered.container.querySelector(".ProseMirror")).not.toBeNull());
  const editor = (rendered.container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor }).editor;
  expect(onChange).not.toHaveBeenCalled();
  act(() => { editor.commands.insertContentAt({ from: 1, to: "Original opening".length + 1 }, "Revised opening"); });
  expect(onChange).toHaveBeenCalledTimes(1);
  const saved = onChange.mock.calls[0]![0] as string;
  rendered.unmount();
  return saved;
}

describe("saved comparison across the real note editor boundary", () => {
  it.each([
    ["link defaults", link({ href: "https://example.test/runbook" })],
    ["ordered-list defaults", orderedList()],
    ["code-block defaults", codeBlock()],
  ] as const)("does not present untouched %s as an edit", async (_name, untouched) => {
    const original = richDocument([paragraph("Original opening"), untouched, paragraph("Unchanged closing")]);
    const saved = await editOpening(original);
    const before = richBlocks(original)!;
    const after = richBlocks(saved)!;
    expect(after[1]).not.toEqual(before[1]);
    const changes = compareRichBlocks(before, after);
    expect(changes?.filter((change) => change.kind !== "unchanged")).toEqual([
      { kind: "changed", before: [before[0]], after: [after[0]] },
    ]);
    expect(richDocument(before)).toBe(original);
    expect(richDocument(after)).toBe(saved);
  });

  it("keeps untouched nested formatting collapsed when the editor reorders the same marks", async () => {
    const untouched: RichNode = { type: "paragraph", content: [
      { type: "text", text: "Same bold and italic words", marks: [{ type: "italic" }, { type: "bold" }] },
    ] };
    const original = richDocument([paragraph("Original opening"), untouched, paragraph("Unchanged closing")]);
    const saved = await editOpening(original);
    const before = richBlocks(original)!;
    const after = richBlocks(saved)!;
    expect(after[1]).not.toEqual(before[1]);
    expect(compareRichBlocks(before, after)?.filter((change) => change.kind !== "unchanged")).toEqual([
      { kind: "changed", before: [before[0]], after: [after[0]] },
    ]);
  });

  it("shows only the authored paragraph change and collapses the untouched rich remainder", async () => {
    const before = revision(1);
    const after = revision(2);
    before.snapshot.content = richDocument(BACKEND_BLOCKS);
    after.snapshot.content = await editOpening(before.snapshot.content);
    const snapshots = JSON.stringify([before, after]);
    renderWithProviders(<NoteComparison before={before as NoteRevisionDetail} after={after as NoteRevisionDetail} identity="editor-boundary" />);
    expect(await screen.findByText("Original opening")).toBeVisible();
    expect(screen.getByText("Revised opening")).toBeVisible();
    for (const text of ["Unchanged paragraph", "Unchanged runbook", "Unchanged ordered item", "Unchanged code", "Unchanged closing"]) {
      const retained = screen.getAllByText(text);
      expect(retained).toHaveLength(1);
      expect(retained[0]).not.toBeVisible();
      expect(retained[0]!.closest("details")).not.toHaveAttribute("open");
    }
    expect(JSON.stringify([before, after])).toBe(snapshots);
  });

  it.each([
    ["link destination", link({ href: "https://example.test/old" }), link({ href: "https://example.test/new" })],
    ["link target", link({ href: "https://example.test/runbook" }), link({ href: "https://example.test/runbook", target: "_self" })],
    ["explicit null link target", link({ href: "https://example.test/runbook" }), link({ href: "https://example.test/runbook", target: null })],
    ["link relationship", link({ href: "https://example.test/runbook" }), link({ href: "https://example.test/runbook", rel: "nofollow" })],
    ["list numbering", orderedList(), orderedList({ start: 4 })],
    ["code language", codeBlock(), codeBlock({ language: "typescript" })],
    ["custom attribute", paragraph("Same text"), { ...paragraph("Same text"), attrs: { reviewState: "approved" } }],
    ["unknown null attribute", paragraph("Same text"), { ...paragraph("Same text"), attrs: { futureSetting: null } }],
    ["formatting", paragraph("Same text"), { type: "paragraph", content: [{ type: "text", text: "Same text", marks: [{ type: "bold" }] }] }],
    ["literal whitespace", paragraph("Same text"), paragraph("Same  text")],
  ] satisfies [string, RichNode, RichNode][])("retains a real %s change", (_name, before, after) => {
    const snapshots = JSON.stringify([before, after]);
    expect(compareRichBlocks([before], [after])).toEqual([{ kind: "changed", before: [before], after: [after] }]);
    expect(JSON.stringify([before, after])).toBe(snapshots);
  });
});
