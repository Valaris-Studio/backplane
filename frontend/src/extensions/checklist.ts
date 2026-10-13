// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import i18n from "@/i18n/config";

// Checklists are TipTap's own taskList/taskItem nodes (MIT, @tiptap/extension-list,
// the package StarterKit already ships its lists from). Node names, the
// `checked` attr and the `- [ ]` markdown form are the storage contract shared
// with the backend normalizer/serializer — see the task-* corpus entries.
//
// On top of upstream this adds: import of a plain checkbox list (GitHub-rendered
// markdown, other editors' clipboards), translated checkbox labels, a disabled
// box on read-only surfaces, and Mod-Enter to tick the item under the cursor.

/** A checkbox before any text in `item`, not one belonging to a nested list. */
function leadingCheckbox(item: Element): HTMLInputElement | null {
  const walker = item.ownerDocument.createTreeWalker(
    item,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
  );
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.textContent ?? "").trim()) return null;
      continue;
    }
    const element = node as Element;
    if (element.tagName === "UL" || element.tagName === "OL") return null;
    if (element.tagName === "INPUT") {
      return (element as HTMLInputElement).type === "checkbox" ? (element as HTMLInputElement) : null;
    }
  }
  return null;
}

function isCheckboxList(list: Element | null): boolean {
  if (!list || list.tagName !== "UL") return false;
  const items = Array.from(list.children).filter((child) => child.tagName === "LI");
  return items.length > 0 && items.every((item) => leadingCheckbox(item) !== null);
}

function readChecked(item: HTMLElement): boolean {
  const dataChecked = item.getAttribute("data-checked");
  if (dataChecked !== null) return dataChecked === "" || dataChecked === "true";
  return leadingCheckbox(item)?.hasAttribute("checked") ?? false;
}

function checkboxLabel(node: ProseMirrorNode): string {
  const text = node.firstChild?.textContent.trim() || i18n.t("editor.taskItemEmpty");
  return i18n.t("editor.taskItemCheckbox", { text });
}

export const Checklist = TaskList.extend({
  parseHTML() {
    return [
      ...(this.parent?.() ?? []),
      { tag: "ul", priority: 52, getAttrs: (node) => (isCheckboxList(node) ? null : false) },
    ];
  },
});

export const ChecklistItem = TaskItem.extend({
  addAttributes() {
    return {
      checked: {
        default: false,
        keepOnSplit: false,
        parseHTML: (element) => readChecked(element),
        renderHTML: (attributes) => ({ "data-checked": attributes.checked }),
      },
    };
  },

  parseHTML() {
    return [
      ...(this.parent?.() ?? []),
      { tag: "li", priority: 52, getAttrs: (node) => (isCheckboxList(node.parentElement) ? null : false) },
    ];
  },

  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      // The box is outside the text flow (contenteditable=false), so without
      // this a keyboard-only author could never tick an item.
      "Mod-Enter": () => {
        // Same rule as the disabled box in the node view: read-only never ticks.
        if (!this.editor.isEditable) return false;
        const { $from } = this.editor.state.selection;
        for (let depth = $from.depth; depth > 0; depth--) {
          const node = $from.node(depth);
          if (node.type !== this.type) continue;
          const position = $from.before(depth);
          return this.editor.commands.command(({ tr }) => {
            tr.setNodeMarkup(position, undefined, { ...node.attrs, checked: !node.attrs.checked });
            return true;
          });
        }
        return false;
      },
    };
  },

  addNodeView() {
    const upstreamView = this.parent?.();
    if (!upstreamView) return null;
    return (props) => {
      const view = upstreamView(props);
      const checkbox = (view.dom as HTMLElement).querySelector<HTMLInputElement>("input[type='checkbox']");
      // Read-only surfaces show the stored state but never change it: a viewer's
      // tick would be an unsaved, unauthored edit. Disabled (not merely
      // reverted on click) so assistive tech announces it as not operable.
      if (checkbox) checkbox.disabled = !props.editor.isEditable;

      // Upstream relabels only when the node changes; a language switch (or a
      // catalog that finishes loading after first paint) must relabel too.
      let currentNode = props.node;
      const relabel = () => {
        const label = checkboxLabel(currentNode);
        checkbox?.setAttribute("aria-label", label);
        if (checkbox?.nextElementSibling) checkbox.nextElementSibling.textContent = label;
      };
      i18n.on("languageChanged", relabel);
      return {
        ...view,
        update: (node, ...rest) => {
          const kept = view.update?.(node, ...rest) ?? false;
          if (kept) currentNode = node;
          return kept;
        },
        destroy: () => {
          i18n.off("languageChanged", relabel);
          view.destroy?.();
        },
      };
    };
  },
}).configure({
  nested: true,
  a11y: { checkboxLabel },
});
