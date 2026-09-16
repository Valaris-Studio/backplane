// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Devops UX round 2 (#1): opening a rich-content card enabled Save with no
// edit. The external-sync effect called setContent with the default
// emitUpdate:true, so TipTap's own re-serialization (default attrs, key
// order) flowed back through onChange, diverged from the backend-canonical
// PM JSON, and tripped every string-compare dirty check upstream — and a
// blind Save then rewrote the stored row. External syncs must never emit.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { renderWithProviders, waitFor } from "@/test/test-utils";
import RichTextEditor from "@/components/shared/RichTextEditorImpl";

vi.mock("@/hooks/useImageUpload", () => ({
  useImageUpload: () => ({ uploadImage: vi.fn(), isUploading: false }),
}));
vi.mock("@/hooks/useFileUpload", () => ({
  useFileUpload: () => ({ uploadFile: vi.fn(), isUploading: false }),
}));

// prosemirror-view probes DOM geometry APIs jsdom doesn't implement.
beforeAll(() => {
  const rect = {
    top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect;
  Range.prototype.getBoundingClientRect = () => rect;
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  document.elementFromPoint = () => null;
});

// Backend-canonical PM JSON: minimal attrs only (heading has {level}, the
// codeBlock has none). TipTap's getJSON() re-emits these nodes WITH default
// attrs (codeBlock.language: null), so the two strings can never be equal —
// the exact shape that used to leak through onChange.
const CANONICAL_RICH = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Rich heading" }],
    },
    { type: "codeBlock", content: [{ type: "text", text: "print(1)" }] },
  ],
});

async function waitForEditor(container: HTMLElement) {
  // immediatelyRender: false — the editor mounts in an effect.
  return waitFor(() => {
    const el = container.querySelector(".tiptap-editor");
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
}

describe("RichTextEditorImpl — external content sync", () => {
  it("does not call onChange when the content PROP changes (external sync is not an edit)", async () => {
    const onChange = vi.fn();
    const utils = renderWithProviders(
      <RichTextEditor content="plain excerpt" onChange={onChange} editable />,
    );
    await waitForEditor(utils.container);

    // The card-detail placeholder swap: plain-text excerpt → canonical PM
    // JSON once the detail query lands.
    utils.rerender(
      <RichTextEditor
        content={CANONICAL_RICH}
        onChange={onChange}
        editable
      />,
    );

    await waitFor(() => {
      expect(utils.container.textContent).toContain("Rich heading");
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("mounting directly on rich canonical content never emits either", async () => {
    const onChange = vi.fn();
    const utils = renderWithProviders(
      <RichTextEditor
        content={CANONICAL_RICH}
        onChange={onChange}
        editable
      />,
    );
    await waitForEditor(utils.container);

    await waitFor(() => {
      expect(utils.container.textContent).toContain("Rich heading");
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});
