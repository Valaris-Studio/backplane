// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CodeBlock } from "@tiptap/extension-code-block";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { MermaidCodeBlockView } from "./MermaidCodeBlockView";

// The node NAME stays "codeBlock" — this only swaps the view, never the schema.
// That is the whole storage contract: a diagram persists as an ordinary code
// block with attrs.language "mermaid" (a ```mermaid fence), so the frontend
// walker, the backend serializer, the normalizer and the MCP surface need no
// change at all. See the code-block-mermaid corpus entry, which is green on
// both engines without a line of serializer code.
//
// Register it with `StarterKit.configure({ codeBlock: false })` beside it,
// otherwise two extensions claim the same node name.
//
// This is the ONE mermaid code-block extension: editor P1-2 extends THIS
// export to add markdown emission rather than declaring a second
// CodeBlock.extend (which would collide on the node name).
export const MermaidCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MermaidCodeBlockView);
  },
});
