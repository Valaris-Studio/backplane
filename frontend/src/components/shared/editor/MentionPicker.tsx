// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useWorkspaceMemberSearch } from "@/features/mentions/api/use-workspace-member-search";
import { memberToMentionAttrs } from "@/features/mentions/utils/mention-attrs";
import type { WorkspaceMember } from "@/types/member";
import { cn } from "@/lib/utils";

export interface MentionPickerProps {
  slug: string;
  query: string;
  clientRect: () => DOMRect | null;
  onSelect: (attrs: { id: string; label: string }) => void;
  // Imperative handle so the editor's keydown handler can drive nav/commit and
  // tell whether the popover consumed the key.
  controllerRef: React.MutableRefObject<MentionPickerController | null>;
}

export interface MentionPickerController {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

// Popover for the @mention autocomplete. RoleCombobox dropdown aesthetic
// (bg-popover shadow-soft border-border/70, hover:bg-accent) — deliberately no
// cmdk dependency (none in the repo). Anchored at the caret via a viewport-fixed
// box; sober, display-only motion (none here).
export function MentionPicker({
  slug,
  query,
  clientRect,
  onSelect,
  controllerRef,
}: MentionPickerProps) {
  const { t } = useTranslation();
  const { data, isFetching } = useWorkspaceMemberSearch(slug, query);
  const items: WorkspaceMember[] = data ?? [];
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // Reset highlight whenever the result set changes so the first row is active.
  useEffect(() => {
    setHighlight(0);
  }, [query, items.length]);

  const commit = (member: WorkspaceMember) => {
    onSelect(memberToMentionAttrs(member));
  };

  // The plugin's keydown fires from an imperative ProseMirror handler, so the
  // controller must always read the LATEST items/highlight/onSelect rather than
  // a closed-over snapshot. A live ref avoids both the stale-closure class and
  // a per-keystroke effect re-bind.
  const latest = useRef({ items, highlight, onSelect });
  latest.current = { items, highlight, onSelect };

  // Bind the keyboard controller once; it reads through the live ref.
  useEffect(() => {
    controllerRef.current = {
      onKeyDown: (event: KeyboardEvent) => {
        const cur = latest.current;
        const len = cur.items.length;
        if (event.key === "ArrowDown") {
          setHighlight((h) => (len ? (h + 1) % len : 0));
          return true;
        }
        if (event.key === "ArrowUp") {
          setHighlight((h) => (len ? (h - 1 + len) % len : 0));
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          const member = cur.items[cur.highlight];
          if (member) {
            cur.onSelect(memberToMentionAttrs(member));
            return true;
          }
          return false;
        }
        return false;
      },
    };
    return () => {
      controllerRef.current = null;
    };
  }, [controllerRef]);

  const rect = clientRect();
  // z-[60] sits above the Sheet/Dialog overlay (z-50) so a mention inside a card
  // detail Sheet isn't hidden behind it.
  const style: React.CSSProperties = rect
    ? { position: "fixed", left: rect.left, top: rect.bottom + 4, zIndex: 60 }
    : { display: "none" };

  // Portal to <body>: the card-description editor lives inside a Sheet whose
  // slide-in `transform` would otherwise become the containing block for this
  // `position: fixed` popover (a transformed ancestor re-roots `fixed`), placing
  // it relative to the Sheet instead of the viewport — off-screen at wide widths
  // (visible only when the Sheet nearly fills a narrow viewport). The portal
  // hoists it out of the transform so the caret's viewport coords land true.
  return createPortal(
    <div style={style} className="w-64">
      <ul
        ref={listRef}
        role="listbox"
        aria-label={t("mentions.listLabel")}
        className={cn(
          "max-h-56 overflow-y-auto rounded-[var(--radius-md)]",
          "border border-border/70 bg-popover shadow-soft py-1 text-sm",
        )}
      >
        {items.map((member, i) => (
          <li
            key={member.user_id}
            role="option"
            aria-selected={i === highlight}
            onMouseDown={(e) => {
              e.preventDefault();
              commit(member);
            }}
            onMouseEnter={() => setHighlight(i)}
            className={cn(
              "flex cursor-pointer flex-col px-3 py-1.5",
              i === highlight
                ? "bg-accent text-accent-foreground"
                : "hover:bg-accent hover:text-accent-foreground",
            )}
          >
            <span className="truncate font-medium">
              {member.name || member.email}
            </span>
            {member.name && (
              <span className="truncate text-xs text-muted-foreground">
                {member.email}
              </span>
            )}
          </li>
        ))}
        {items.length === 0 && (
          <li className="px-3 py-1.5 text-muted-foreground">
            {isFetching ? t("mentions.searching") : t("mentions.empty")}
          </li>
        )}
      </ul>
    </div>,
    document.body,
  );
}
