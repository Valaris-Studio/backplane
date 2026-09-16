// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Avatar } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { TitleInput } from "@/components/ui/title-input";
import { cn } from "@/lib/utils";
import { useOptionalTemplateDraftContext } from "../hooks/TemplateDraftProvider";
import type { LoopTemplateProfile } from "../api/loop-templates";
import {
  FALLBACK_EMOJI,
  firstGrapheme,
  TEMPLATE_EMOJI,
} from "../lib/emoji-catalog";

// The profile page's identity header (F9): the template's FACE, not a section.
//
// Every field here writes through the shell's one draft store, which is what
// lets the shell <h1> and this header show the same name with no refetch and
// no second lock token. `readOnly` is the store's own gate (system template or
// non-admin), so the affordances are absent rather than present-and-failing.

function EmojiPicker({
  value,
  onPick,
}: {
  value: string;
  onPick: (emoji: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  /** Uncommitted free-text; `null` means the field mirrors the stored value. */
  const [typed, setTyped] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes: the panel traps nothing, so the keyboard user's only other
  // exit is tabbing through ~48 buttons.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div className="relative">
      <button
        type="button"
        data-testid="loop-template-profile-emoji-trigger"
        aria-label={t("loopTemplates.profile.header.emojiPickerLabel")}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <EmojiAvatar emoji={value} interactive />
      </button>

      {open && (
        <div
          ref={panelRef}
          data-testid="loop-template-profile-emoji-picker"
          role="dialog"
          aria-label={t("loopTemplates.profile.header.emojiPickerLabel")}
          className="absolute left-0 top-full z-20 mt-2 w-72 rounded-lg border border-border/70 bg-[color:var(--color-surface-1)] p-3 shadow-lg"
        >
          <div className="grid grid-cols-8 gap-1">
            {TEMPLATE_EMOJI.map((emoji) => (
              <button
                key={emoji}
                type="button"
                data-testid={`loop-template-profile-emoji-option-${emoji}`}
                aria-label={emoji}
                aria-pressed={emoji === value}
                onClick={() => {
                  onPick(emoji);
                  setOpen(false);
                }}
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-md text-lg hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  emoji === value && "bg-primary/14",
                )}
              >
                {emoji}
              </button>
            ))}
          </div>
          <label className="mt-3 block text-xs text-muted-foreground">
            {t("loopTemplates.profile.header.emojiCustomLabel")}
            <Input
              data-testid="loop-template-profile-emoji-custom"
              className="mt-1 h-8"
              value={typed ?? value}
              // The field holds RAW text while it is being composed and only
              // caps to one grapheme on commit. Capping per keystroke would
              // make a ZWJ sequence unenterable: each code point of
              // 👩‍👩‍👧 arrives separately, and truncating after every one
              // throws away the very joiners that assemble the glyph.
              onChange={(event) => setTyped(event.target.value)}
              onBlur={() => {
                if (typed === null) return;
                onPick(firstGrapheme(typed));
                setTyped(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </label>
        </div>
      )}
    </div>
  );
}

function EmojiAvatar({
  emoji,
  interactive = false,
}: {
  emoji: string;
  interactive?: boolean;
}) {
  const { t } = useTranslation();
  const shown = emoji || FALLBACK_EMOJI;

  return (
    <Avatar
      data-testid="loop-template-profile-emoji"
      // The emoji is the template's identity, not decoration, so it is
      // labelled rather than aria-hidden. AvatarFallback's uppercase tracking
      // and 0.68rem type would mangle the glyph, so this styles the surface
      // directly instead.
      role="img"
      aria-label={
        emoji
          ? `${t("loopTemplates.profile.header.emojiLabel")}: ${emoji}`
          : t("loopTemplates.profile.header.emojiFallback")
      }
      className={cn(
        "h-16 w-16 items-center justify-center text-3xl leading-none",
        interactive && "transition-colors hover:border-primary/60",
      )}
    >
      <span className="flex h-full w-full items-center justify-center">
        {shown}
      </span>
    </Avatar>
  );
}

export function LoopTemplateProfileHeader({
  fallbackName,
  fallbackProfile,
  tags,
}: {
  /** The server row's name, shown until the draft hydrates. */
  fallbackName: string;
  /** The relayed profile bag, for surfaces that have no draft store. */
  fallbackProfile: LoopTemplateProfile;
  tags: string[];
}) {
  const { t } = useTranslation();
  // The board dialog's profile SHEET reuses this body outside the detail
  // shell, where there is no template open to edit. No store means no write
  // path, which is exactly read-only — not a reason to crash the viewer.
  const store = useOptionalTemplateDraftContext();

  const name = store?.draft?.name ?? fallbackName;
  // The draft's bag is untyped (it round-trips whatever the server stored);
  // the relayed one is the typed read. Both are read through the same narrow
  // check, so an unexpected shape renders blank rather than "[object Object]".
  const profile: Record<string, unknown> =
    store?.draft?.profile ?? (fallbackProfile as Record<string, unknown>);
  const emoji = typeof profile.emoji === "string" ? profile.emoji : "";
  const tagline = typeof profile.tagline === "string" ? profile.tagline : "";
  const readOnly = store ? store.readOnly : true;
  const setField = store?.setField ?? (() => {});

  return (
    <div
      data-testid="loop-template-profile-header"
      className="flex flex-wrap items-start gap-4 rounded-lg border border-border/70 bg-[color:var(--color-surface-1)] p-4"
    >
      {readOnly ? (
        <EmojiAvatar emoji={emoji} />
      ) : (
        <EmojiPicker
          value={emoji}
          onPick={(next) => setField("profile.emoji", next)}
        />
      )}

      <div className="min-w-0 flex-1 space-y-1">
        {readOnly ? (
          <>
            <p className="text-2xl font-bold tracking-[-0.04em] text-foreground">
              {name}
            </p>
            {tagline && (
              <p className="text-sm text-muted-foreground">{tagline}</p>
            )}
          </>
        ) : (
          <>
            <TitleInput
              data-testid="loop-template-profile-name-input"
              aria-label={t("loopTemplates.detail.rename.label")}
              placeholder={t("loopTemplates.profile.header.namePlaceholder")}
              value={name}
              onChange={(event) => setField("name", event.target.value)}
            />
            <Input
              data-testid="loop-template-profile-tagline-input"
              aria-label={t("loopTemplates.profile.sections.who_am_i")}
              placeholder={t("loopTemplates.profile.header.taglinePlaceholder")}
              value={tagline}
              onChange={(event) =>
                setField("profile.tagline", event.target.value)
              }
              className="h-8 border-transparent bg-transparent px-0 text-sm shadow-none focus-visible:border-border"
            />
          </>
        )}

        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {tags.map((tag) => (
              <Pill key={tag} tint="primary">
                {tag}
              </Pill>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
