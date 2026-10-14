// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Authoring checklists in the shared editor: toolbar toggle, the `[ ] ` input
// rule, Tab nesting, a mouse click on the box, and Mod-Enter for keyboard users
// (the box itself sits outside the editable text flow).
import { describe, it, expect, beforeAll, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test/test-utils";
import RichTextEditor from "@/components/shared/RichTextEditorImpl";

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

type PMNode = { type?: string; attrs?: Record<string, unknown>; content?: PMNode[]; text?: string };

const PARAGRAPH = JSON.stringify({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Buy milk" }] }],
});

const TWO_TASKS = JSON.stringify({
  type: "doc",
  content: [{
    type: "taskList",
    content: [
      { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }] },
      { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "second" }] }] },
    ],
  }],
});

async function mount(content: string) {
  const onChange = vi.fn();
  const utils = renderWithProviders(<RichTextEditor content={content} onChange={onChange} editable />);
  await waitFor(() => expect(utils.container.querySelector(".ProseMirror")).not.toBeNull());
  const dom = utils.container.querySelector(".ProseMirror") as HTMLElement & { editor?: Editor };
  const editor = dom.editor;
  if (!editor) throw new Error("editor not mounted");
  return { ...utils, editor, onChange };
}

function lastDoc(onChange: ReturnType<typeof vi.fn>): PMNode {
  const calls = onChange.mock.calls;
  return JSON.parse(calls[calls.length - 1]?.[0] as string) as PMNode;
}

describe("RichTextEditor — checklists", () => {
  it("toolbar Checklist button turns the paragraph into a task item", async () => {
    const { onChange } = await mount(PARAGRAPH);

    await userEvent.setup().click(screen.getByRole("button", { name: "Checklist" }));

    const [list] = lastDoc(onChange).content ?? [];
    expect(list?.type).toBe("taskList");
    expect(list?.content?.[0]).toMatchObject({ type: "taskItem", attrs: { checked: false } });
  });

  it("typing `[ ] ` at the start of a line starts a checklist", async () => {
    const { editor, onChange } = await mount(JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }));
    editor.commands.focus("start");
    const { view } = editor;
    const from = view.state.selection.from;
    // Input rules hook handleTextInput, which jsdom's contenteditable never fires.
    const handled = view.someProp("handleTextInput", (handler) => handler(view, from, from, " ", () => view.state.tr));
    expect(handled).toBeFalsy();
    editor.commands.insertContent("[ ]");
    const at = view.state.selection.from;
    view.someProp("handleTextInput", (handler) => handler(view, at, at, " ", () => view.state.tr));

    expect(lastDoc(onChange).content?.[0]?.type).toBe("taskList");
  });

  it("clicking a box in the editor ticks it", async () => {
    const { onChange } = await mount(TWO_TASKS);

    const first = screen.getByRole("checkbox", { name: "Checklist item: first" });
    expect(first).toBeEnabled();
    await userEvent.setup().click(first);

    expect(lastDoc(onChange).content?.[0]?.content?.[0]?.attrs?.checked).toBe(true);
  });

  it("Mod-Enter toggles the item under the cursor", async () => {
    const { editor, onChange } = await mount(TWO_TASKS);
    editor.commands.focus("end");

    // ProseMirror resolves `Mod` to Meta on Apple platforms and Ctrl elsewhere.
    const onApple = /Mac|iP(hone|ad|od)/.test(navigator.platform);
    editor.view.someProp("handleKeyDown", (handler) =>
      handler(editor.view, new KeyboardEvent("keydown", { key: "Enter", metaKey: onApple, ctrlKey: !onApple })),
    );

    const items = lastDoc(onChange).content?.[0]?.content ?? [];
    expect(items.map((item) => item.attrs?.checked)).toEqual([false, true]);
  });

  it("Tab nests a task item under the previous one", async () => {
    const { editor, onChange } = await mount(TWO_TASKS);
    editor.commands.focus("end");

    editor.view.someProp("handleKeyDown", (handler) =>
      handler(editor.view, new KeyboardEvent("keydown", { key: "Tab" })),
    );

    const items = lastDoc(onChange).content?.[0]?.content ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.content?.[1]?.type).toBe("taskList");
  });
});
