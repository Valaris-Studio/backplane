// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type MarkdownIt from "markdown-it";
import type { Token } from "markdown-it";

// GFM's task marker, read from the item's RAW source so an escaped `\[ ]` stays
// literal text — the same rule as the backend normalizer's `_TASK_MARKER_RE`.
const TASK_MARKER_RE = /^\[([ xX])\](?:\s+|$)/;

/** true/false for a task item's box, null when the item is not a task. */
function taskCheckedState(tokens: Token[], itemOpen: number): boolean | null {
  const paragraph = tokens[itemOpen + 1];
  const inline = tokens[itemOpen + 2];
  if (paragraph?.type !== "paragraph_open" || inline?.type !== "inline") return null;
  const match = TASK_MARKER_RE.exec(inline.content);
  if (!match || inline.children?.[0]?.type !== "text") return null;
  return match[1] !== " ";
}

function stripMarker(inline: Token): void {
  const children = inline.children ?? [];
  const lead = children[0];
  if (!lead) return;
  lead.content = lead.content.replace(TASK_MARKER_RE, "");
  for (const child of children) {
    if (child.type !== "text" && child.type !== "softbreak") break;
    if (child.type === "softbreak") {
      child.type = "text";
      child.content = "";
      continue;
    }
    child.content = child.content.trimStart();
    if (child.content) break;
  }
}

/**
 * Marks a bullet list as a checklist in the rendered HTML — `data-type`
 * attributes that the Checklist/ChecklistItem parse rules pick up — but only
 * when EVERY item carries a task marker; a mixed list stays a bullet list, as
 * in the backend normalizer.
 */
export function markdownTaskLists(md: MarkdownIt): void {
  md.core.ruler.after("inline", "task_lists", (state) => {
    const { tokens } = state;
    tokens.forEach((listOpen, listIndex) => {
      if (listOpen.type !== "bullet_list_open") return;
      const itemOpens: number[] = [];
      for (let i = listIndex + 1; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (token.type === "bullet_list_close" && token.level === listOpen.level) break;
        if (token.type === "list_item_open" && token.level === listOpen.level + 1) itemOpens.push(i);
      }
      const states = itemOpens.map((index) => taskCheckedState(tokens, index));
      if (states.length === 0 || states.includes(null)) return;
      listOpen.attrSet("data-type", "taskList");
      itemOpens.forEach((index, position) => {
        tokens[index]!.attrSet("data-type", "taskItem");
        tokens[index]!.attrSet("data-checked", String(states[position]));
        stripMarker(tokens[index + 2]!);
      });
    });
  });
}
