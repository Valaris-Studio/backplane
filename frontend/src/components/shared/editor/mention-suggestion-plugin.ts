// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { Editor, Range } from "@tiptap/core";

// Minimal, self-contained `@`-trigger suggestion plugin. The repo does NOT have
// `@tiptap/suggestion` or `@tiptap/extension-mention` installed (verified
// against package.json / node_modules), so this reimplements just the slice the
// mention picker needs against `@tiptap/pm` (which IS installed): detect a
// `@query` token at the caret, expose its range + query, and drive a renderer's
// lifecycle (onStart / onUpdate / onExit / onKeyDown). Adding the upstream
// package would require touching the (locked) pnpm-lock — out of scope.

export interface MentionSuggestionState {
  active: boolean;
  query: string;
  range: Range;
  /** Caret rect in viewport coords, for popover anchoring. */
  clientRect: () => DOMRect | null;
}

export interface MentionSuggestionRenderer {
  onStart: (props: MentionRenderProps) => void;
  onUpdate: (props: MentionRenderProps) => void;
  onExit: () => void;
  /** Return true to consume the key (arrow nav / enter / escape). */
  onKeyDown: (event: KeyboardEvent) => boolean;
}

export interface MentionRenderProps {
  editor: Editor;
  query: string;
  range: Range;
  clientRect: () => DOMRect | null;
  command: (attrs: { id: string; label: string }) => void;
}

export const mentionPluginKey = new PluginKey<MentionPluginState>("mention");

interface MentionPluginState {
  active: boolean;
  range: Range | null;
  query: string;
}

const TRIGGER = "@";
// Allow names with spaces/dots after the trigger up to a soft cap; bail on a
// second whitespace run so "@a b c d" doesn't grow an unbounded query.
const MAX_QUERY_LEN = 40;

function findMentionMatch(
  state: EditorState,
): { range: Range; query: string } | null {
  const { $from } = state.selection;
  // Only inside textblocks where a mention atom is allowed.
  const textBefore = $from.parent.textBetween(
    0,
    $from.parentOffset,
    undefined,
    "￼",
  );
  const triggerIndex = textBefore.lastIndexOf(TRIGGER);
  if (triggerIndex === -1) return null;

  // The trigger must be at a word boundary (start or preceded by whitespace) so
  // emails like "a@b" never open the picker.
  const charBefore = triggerIndex > 0 ? textBefore[triggerIndex - 1] : "";
  if (charBefore && !/\s/.test(charBefore)) return null;

  const query = textBefore.slice(triggerIndex + 1);
  if (query.length > MAX_QUERY_LEN) return null;
  // A newline in the query closes the suggestion.
  if (/[\n\r]/.test(query)) return null;

  const from = $from.start() + triggerIndex;
  const to = $from.pos;
  return { range: { from, to }, query };
}

export function createMentionSuggestionPlugin(
  editor: Editor,
  renderer: MentionSuggestionRenderer,
): Plugin<MentionPluginState> {
  let activeRange: Range | null = null;

  const command = (attrs: { id: string; label: string }) => {
    if (!activeRange) return;
    editor
      .chain()
      .focus()
      .insertContentAt(activeRange, [
        { type: "mention", attrs },
        { type: "text", text: " " },
      ])
      .run();
  };

  const buildProps = (
    view: EditorView,
    range: Range,
    query: string,
  ): MentionRenderProps => ({
    editor,
    query,
    range,
    clientRect: () => {
      try {
        const rect = view.coordsAtPos(range.from);
        return new DOMRect(rect.left, rect.top, 0, rect.bottom - rect.top);
      } catch {
        return null;
      }
    },
    command,
  });

  return new Plugin<MentionPluginState>({
    key: mentionPluginKey,

    state: {
      init: () => ({ active: false, range: null, query: "" }),
      apply(_tr, _prev, _oldState, newState) {
        const match = findMentionMatch(newState);
        if (!match) return { active: false, range: null, query: "" };
        return { active: true, range: match.range, query: match.query };
      },
    },

    view() {
      let wasActive = false;
      return {
        update: (view) => {
          const next = mentionPluginKey.getState(view.state);
          if (!next) return;
          const isActive = next.active && view.hasFocus();

          if (isActive && next.range) {
            activeRange = next.range;
            const props = buildProps(view, next.range, next.query);
            if (!wasActive) renderer.onStart(props);
            else renderer.onUpdate(props);
            wasActive = true;
          } else if (wasActive) {
            activeRange = null;
            renderer.onExit();
            wasActive = false;
          }
        },
        destroy: () => {
          if (wasActive) {
            renderer.onExit();
            wasActive = false;
          }
        },
      };
    },

    props: {
      handleKeyDown(_view, event) {
        const state = mentionPluginKey.getState(_view.state);
        if (!state?.active) return false;
        return renderer.onKeyDown(event);
      },
    },
  });
}
