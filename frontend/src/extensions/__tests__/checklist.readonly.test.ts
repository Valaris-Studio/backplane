// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// The Mod-Enter tick shortcut follows the same rule as the disabled box: a
// read-only editor never toggles an item, not even in memory. A headless editor
// without HardBreak isolates the shortcut from StarterKit's own
// Mod-Enter (HardBreak), which would otherwise answer the key first.
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Checklist, ChecklistItem } from "@/extensions/checklist";

const DOC = {
  type: "doc",
  content: [{
    type: "taskList",
    content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "ship" }] }] }],
  }],
};

let editor: Editor | undefined;
afterEach(() => editor?.destroy());

function pressModEnter(target: Editor): boolean {
  const onApple = /Mac|iP(hone|ad|od)/.test(navigator.platform);
  const event = new KeyboardEvent("keydown", { key: "Enter", metaKey: onApple, ctrlKey: !onApple });
  return Boolean(target.view.someProp("handleKeyDown", (handler) => handler(target.view, event)));
}

function mount(editable: boolean): Editor {
  editor = new Editor({ extensions: [StarterKit.configure({ hardBreak: false }), Checklist, ChecklistItem], content: DOC, editable });
  editor.commands.setTextSelection(4);
  return editor;
}

describe("ChecklistItem Mod-Enter", () => {
  it("ticks the item under the cursor while editing", () => {
    const target = mount(true);
    expect(pressModEnter(target)).toBe(true);
    expect(target.state.doc.firstChild?.firstChild?.attrs.checked).toBe(true);
  });

  it("is not handled and changes nothing when the editor is read-only", () => {
    const target = mount(false);
    const before = JSON.stringify(target.getJSON());
    expect(pressModEnter(target)).toBe(false);
    expect(JSON.stringify(target.getJSON())).toBe(before);
  });
});
