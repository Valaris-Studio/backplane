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

const text = (value: string): RichNode => ({ type: "text", text: value });
const paragraph = (...content: RichNode[]): RichNode => ({ type: "paragraph", content });
const softBreakParagraph = paragraph(text("First line"), text("\n"), text("second line"));

describe("saved comparison across editor text-run merging", () => {
  it("does not mark an untouched Markdown soft-break paragraph as changed when the editor merges adjacent runs", async () => {
    const original = richDocument([paragraph(text("Original opening")), softBreakParagraph, paragraph(text("Unchanged closing"))]);
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
    expect(after[1]).toEqual(paragraph(text("First line\nsecond line")));
    expect(compareRichBlocks(before, after)?.filter((change) => change.kind !== "unchanged")).toEqual([
      { kind: "changed", before: [before[0]], after: [after[0]] },
    ]);
    expect(richDocument(before)).toBe(original);
    expect(richDocument(after)).toBe(saved);
  });

  it.each([
    ["literal newline", softBreakParagraph, paragraph(text("First linesecond line"))],
    ["formatting boundary", paragraph({ ...text("First "), marks: [{ type: "bold" }] }, text("line")),
      paragraph({ ...text("First line"), marks: [{ type: "bold" }] })],
    ["unknown text-run attribute", paragraph({ ...text("First "), attrs: { reviewState: "approved" } }, text("line")), paragraph(text("First line"))],
  ] satisfies [string, RichNode, RichNode][])("preserves a changed %s", (_name, before, after) => {
    const snapshots = JSON.stringify([before, after]);
    expect(compareRichBlocks([before], [after])).toEqual([{ kind: "changed", before: [before], after: [after] }]);
    expect(JSON.stringify([before, after])).toBe(snapshots);
  });
});
