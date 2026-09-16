// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Bot } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import {
  NOTE_KIND_META,
  isAgentNote,
  isBadgedKind,
  isKnownFailureClass,
  failureClassLabelKey,
  failureClassDescriptionKey,
  type NoteKind,
} from "../lib/noteKinds";

interface NoteKindBadgeProps {
  kind: string;
  failureClass?: string | null;
  className?: string;
}

// Surfaces the note's "type" and — crucially — whether it was authored by a
// runner vs a human. The agentic marker is the primary distinction the user
// asked for; the kind chip and failure-class chip add detail. Each chip uses
// RichTooltip (portal + position:fixed) so the explanatory popover never gets
// clipped by the card's overflow/line-clamp ancestors.
export function NoteKindBadge({ kind, failureClass, className }: NoteKindBadgeProps) {
  const { t } = useTranslation();
  const agentic = isAgentNote(kind);
  const showKindChip = isBadgedKind(kind);
  const meta = showKindChip ? NOTE_KIND_META[kind as NoteKind] : null;
  const showFailureChip = !!failureClass && isKnownFailureClass(failureClass);

  if (!agentic && !showKindChip && !showFailureChip) return null;

  return (
    <span className={className}>
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {agentic ? (
          <RichTooltip summary={t("notes.agentBadgeTooltip")} side="top">
            <Badge
              variant="outline"
              className="border-primary/40 text-primary"
              aria-label={t("notes.agentBadge")}
            >
              <Bot className="h-3 w-3" />
              {t("notes.agentBadge")}
            </Badge>
          </RichTooltip>
        ) : null}

        {meta ? (
          <RichTooltip summary={t(meta.descriptionKey)} side="top">
            <Badge variant={meta.variant}>{t(meta.labelKey)}</Badge>
          </RichTooltip>
        ) : null}

        {showFailureChip ? (
          <RichTooltip
            summary={t(failureClassDescriptionKey(failureClass as never))}
            side="top"
          >
            <Badge variant="destructive">
              {t(failureClassLabelKey(failureClass as never))}
            </Badge>
          </RichTooltip>
        ) : null}
      </span>
    </span>
  );
}
