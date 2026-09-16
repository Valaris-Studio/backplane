// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { MentionView } from "./MentionView";
import {
  createMentionSuggestionPlugin,
  type MentionSuggestionRenderer,
} from "./mention-suggestion-plugin";

// THE single shared @mention primitive (contract §1, §7a). Storage = a
// ProseMirror inline atom node `{ type: "mention", attrs: { id, label } }` — the
// content JSON is the source of truth for who was mentioned; the backend walks
// the doc tree by `attrs.id` (MEN-1). Registered once in the shared
// RichTextEditorImpl + RichTextRenderer so card descriptions, notes, and any
// future TipTap field inherit mentions from one wiring point.

export interface MentionExtensionOptions {
  // Supplied by the editor: builds the React-driven picker renderer for one
  // editor instance (it owns the React-Query member-search hook + popover).
  buildRenderer?: () => MentionSuggestionRenderer | null;
}

export const Mention = Node.create<MentionExtensionOptions>({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { buildRenderer: undefined };
  },

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-mention-id"),
        renderHTML: (attrs) =>
          attrs.id ? { "data-mention-id": attrs.id as string } : {},
      },
      label: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-mention-label") ?? "",
        renderHTML: (attrs) =>
          attrs.label ? { "data-mention-label": attrs.label as string } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-mention]" }];
  },

  // Server/copy-paste fallback render. The interactive chip is the node-view;
  // this is the non-React-context serialization (atom carries "@label" text).
  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-mention": "" }),
      `@${(node.attrs.label as string) || ""}`,
    ];
  },

  renderText({ node }) {
    return `@${(node.attrs.label as string) || ""}`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(MentionView);
  },

  addProseMirrorPlugins() {
    const renderer = this.options.buildRenderer?.();
    if (!renderer) return [];
    return [createMentionSuggestionPlugin(this.editor, renderer)];
  },
});
