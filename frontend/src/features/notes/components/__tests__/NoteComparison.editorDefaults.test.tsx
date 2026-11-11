// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import RichTextEditor from "@/components/shared/RichTextEditorImpl";
import { act, renderWithProviders, waitFor } from "@/test/test-utils";
import { compareRichBlocks, richBlocks, richDocument, type RichNode } from "../../utils/note-rich-comparison";

vi.mock("@/hooks/useImageUpload", () => ({ useImageUpload: () => ({ uploadImage: vi.fn(), isUploading: false }) }));
vi.mock("@/hooks/useFileUpload", () => ({ useFileUpload: () => ({ uploadFile: vi.fn(), isUploading: false }) }));
afterEach(cleanup);

const paragraph = (text: string): RichNode => ({ type: "paragraph", content: [{ type: "text", text }] });
const image: RichNode = { type: "image", attrs: { src: "/api/media/synthetic.png", alt: "Unchanged image", title: null } };
const attachment: RichNode = { type: "fileAttachment", attrs: {
  src: "/api/media/synthetic.txt", filename: "Unchanged attachment", fileSize: 0, mimeType: "application/octet-stream",
} };
const table = (cellType: "tableCell" | "tableHeader", attrs: Record<string, unknown> = {}): RichNode => ({
  type: "table", content: [{ type: "tableRow", content: [{ type: cellType,
    attrs: { colspan: 1, rowspan: 1, colwidth: null, ...attrs }, content: [paragraph("Unchanged cell")],
  }] }],
});

describe("additional saved-node editor defaults", () => {
  it.each([
    ["image", image], ["fileAttachment", attachment], ["table cell", table("tableCell")], ["table header", table("tableHeader")],
  ] satisfies [string, RichNode][])("does not classify an untouched %s as edited", async (_name, untouched) => {
    const original = richDocument([paragraph("Original opening"), untouched, paragraph("Unchanged closing")]);
    const onChange = vi.fn();
    const rendered = renderWithProviders(<RichTextEditor content={original} onChange={onChange} />);
    await waitFor(() => expect(rendered.container.querySelector(".ProseMirror")).not.toBeNull());
    const editor = (rendered.container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor }).editor;
    expect(onChange).not.toHaveBeenCalled();
    act(() => { editor.commands.insertContentAt({ from: 1, to: "Original opening".length + 1 }, "Revised opening"); });
    expect(onChange).toHaveBeenCalledTimes(1);
    const saved = onChange.mock.calls[0]![0] as string;
    const before = richBlocks(original)!;
    const after = richBlocks(saved)!;
    expect(after[1]).not.toEqual(before[1]);
    expect(compareRichBlocks(before, after)?.filter((change) => change.kind !== "unchanged")).toEqual([
      { kind: "changed", before: [before[0]], after: [after[0]] },
    ]);
    expect(richDocument(before)).toBe(original);
    expect(richDocument(after)).toBe(saved);
  });

  it.each([
    ["image dimensions", image, { ...image, attrs: { ...image.attrs, width: 120, height: 80 } }],
    ["attachment upload state", attachment, { ...attachment, attrs: { ...attachment.attrs, uploading: true } }],
    ["cell alignment", table("tableCell"), table("tableCell", { align: "center" })],
    ["header alignment", table("tableHeader"), table("tableHeader", { align: "right" })],
  ] satisfies [string, RichNode, RichNode][])("retains an actual %s change", (_name, before, after) => {
    const snapshots = JSON.stringify([before, after]);
    expect(compareRichBlocks([before], [after])).toEqual([{ kind: "changed", before: [before], after: [after] }]);
    expect(JSON.stringify([before, after])).toBe(snapshots);
  });
});
