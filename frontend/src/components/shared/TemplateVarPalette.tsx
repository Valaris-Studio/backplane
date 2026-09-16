// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRef, useState, type KeyboardEvent } from "react";

import { RichTooltip } from "@/components/ui/rich-tooltip";
import { cn } from "@/lib/utils";

export type PaletteItem = {
  // The literal string to splice into the prompt — `{{.BoardID}}` for a runner
  // var, `<<RUN_LABEL>>` for a slot. Token-first because the two grammars
  // differ; a caller re-deriving one from a name would break for the other.
  token: string;
  label: string;
  // RichTooltip i18n key, e.g. "loopTemplates.palette.text". Items without one
  // render as a bare chip rather than an empty popover.
  help?: string;
  kind?: string;
  required?: boolean;
};

export type PaletteGroup = {
  id: "runner" | "slots";
  label: string;
  items: PaletteItem[];
};

const CHIP_CLASS =
  "rounded-[var(--radius-sm)] border border-border/70 bg-surface-1/60 px-1.5 py-0.5 font-mono text-[0.7rem] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground";

// One group = one tab stop. Arrow keys move within it and wrap, so a keyboard
// user tabs past a 58-slot catalog in a single press instead of 58.
function PaletteGroupRow({
  group,
  onInsert,
  onNewSlot,
  newSlotLabel,
  insertAria,
}: {
  group: PaletteGroup;
  onInsert: (token: string) => void;
  onNewSlot?: () => void;
  newSlotLabel?: string;
  insertAria: (token: string) => string;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const count = group.items.length + (onNewSlot ? 1 : 0);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const delta =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (delta === 0 || count === 0) return;
    event.preventDefault();
    const next = (activeIndex + delta + count) % count;
    setActiveIndex(next);
    buttonsRef.current[next]?.focus();
  }

  return (
    <div
      role="group"
      aria-label={group.label}
      onKeyDown={handleKeyDown}
      className="flex flex-wrap items-center gap-1.5"
    >
      {group.items.map((item, index) => {
        const chip = (
          <button
            key={item.token}
            ref={(node) => {
              buttonsRef.current[index] = node;
            }}
            type="button"
            tabIndex={index === activeIndex ? 0 : -1}
            aria-label={insertAria(item.token)}
            data-kind={item.kind}
            data-required={item.required ? "true" : undefined}
            onFocus={() => setActiveIndex(index)}
            onClick={() => onInsert(item.token)}
            className={CHIP_CLASS}
          >
            {item.token}
          </button>
        );
        return item.help ? (
          <RichTooltip key={item.token} i18nKey={item.help}>
            {chip}
          </RichTooltip>
        ) : (
          chip
        );
      })}
      {onNewSlot ? (
        <button
          ref={(node) => {
            buttonsRef.current[group.items.length] = node;
          }}
          type="button"
          tabIndex={group.items.length === activeIndex ? 0 : -1}
          onFocus={() => setActiveIndex(group.items.length)}
          onClick={onNewSlot}
          className={cn(CHIP_CLASS, "border-dashed")}
        >
          {newSlotLabel}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Click-to-insert chips for the tokens a prompt may reference.
 *
 * Two shapes, one component:
 *  - `groups` — the token-first API the template manager and the bind step use.
 *    Each group is its own roving-tabindex region.
 *  - `vars` — the original name-first API the board dialog was built on.
 *    `onInsert` receives the bare NAME and `render` decides how it is shown.
 *
 * It owns no i18n: legends, aria text and titles come from the caller, which is
 * what lets the same component serve the dialog and the manager.
 */
export function TemplateVarPalette({
  vars,
  groups,
  onInsert,
  render = (name) => `{{.${name}}}`,
  legend,
  groupLabel,
  titleFor,
  testIdFor,
  onNewSlot,
  newSlotLabel,
  insertAria = (token) => `Insert ${token}`,
  className = "flex flex-wrap items-center gap-1.5",
}: {
  vars?: readonly string[];
  groups?: readonly PaletteGroup[];
  onInsert: (value: string) => void;
  render?: (name: string) => string;
  legend?: string;
  groupLabel?: string;
  titleFor?: (name: string) => string;
  testIdFor?: (name: string) => string;
  onNewSlot?: () => void;
  newSlotLabel?: string;
  insertAria?: (token: string) => string;
  className?: string;
}) {
  if (groups) {
    return (
      <div className="flex flex-col gap-1.5">
        {legend ? (
          <span className="text-[0.7rem] text-muted-foreground">{legend}</span>
        ) : null}
        {groups.map((group) => (
          <PaletteGroupRow
            key={group.id}
            group={group}
            onInsert={onInsert}
            onNewSlot={group.id === "slots" ? onNewSlot : undefined}
            newSlotLabel={newSlotLabel}
            insertAria={insertAria}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={className} role="group" aria-label={groupLabel}>
      {legend ? (
        <span className="text-[0.7rem] text-muted-foreground">{legend}</span>
      ) : null}
      {(vars ?? []).map((name) => (
        <button
          key={name}
          type="button"
          data-testid={testIdFor?.(name)}
          aria-label={name}
          title={titleFor?.(name)}
          onClick={() => onInsert(name)}
          className={CHIP_CLASS}
        >
          {render(name)}
        </button>
      ))}
    </div>
  );
}
