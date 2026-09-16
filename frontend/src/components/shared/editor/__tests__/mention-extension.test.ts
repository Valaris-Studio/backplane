// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Mention } from "../mention-extension";

// The Mention node is the storage contract (§1): an inline atom carrying
// { id, label }. These assert the schema-level guarantees the backend resolver
// and plain-text projection depend on — without needing a DOM/node-view.
// StarterKit supplies document/paragraph/text (same base as the real editor).
function makeEditor() {
  return new Editor({
    // Mention's addNodeView (ReactNodeViewRenderer) is inert headlessly; the
    // node schema + renderText still work.
    extensions: [StarterKit, Mention],
    content: "",
  });
}

describe("Mention extension — schema", () => {
  it("registers an inline atom node named 'mention'", () => {
    const editor = makeEditor();
    const type = editor.schema.nodes.mention;
    expect(type).toBeDefined();
    // schema.nodes[name] is typed as possibly-undefined; assert presence so the
    // isInline/isAtom reads below narrow (the toBeDefined above is a runtime
    // guard, not a TS narrowing).
    if (!type) throw new Error("mention node not registered");
    expect(type.isInline).toBe(true);
    expect(type.isAtom).toBe(true);
    editor.destroy();
  });

  it("round-trips a mention node carrying {id, label} in the doc JSON", () => {
    const editor = makeEditor();
    editor.commands.insertContent({
      type: "mention",
      attrs: { id: "user-7", label: "Alice Adams" },
    });
    const node: JSONContent | undefined =
      editor.getJSON().content?.[0]?.content?.[0];
    expect(node?.type).toBe("mention");
    expect(node?.attrs).toMatchObject({ id: "user-7", label: "Alice Adams" });
    editor.destroy();
  });

  it("serializes a mention to '@Label' plain text (renderText)", () => {
    const editor = makeEditor();
    editor.commands.insertContent([
      { type: "text", text: "hi " },
      { type: "mention", attrs: { id: "u-1", label: "Bob" } },
    ]);
    expect(editor.getText()).toContain("@Bob");
    editor.destroy();
  });
});
