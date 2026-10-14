// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { usePromptsHidden } from "../hooks/use-hide-prompts";

interface RedactableTextProps {
  text: string;
  hiddenLabel: string;
  className?: string;
}

// Captured content that presenter mode blurs. Hidden text keeps its shape (the
// screen still reads as a session) but cannot be read, selected or announced.
export function RedactableText({ text, hiddenLabel, className }: RedactableTextProps) {
  const hidden = usePromptsHidden();
  if (!hidden) return <span className={className}>{text}</span>;
  return (
    <span className={className} data-prompt-hidden="">
      <span aria-hidden className={cn("select-none blur-[0.55em] [-webkit-user-select:none]")}>
        {text}
      </span>
      <span className="sr-only">{hiddenLabel}</span>
    </span>
  );
}

// Every prompt and title on the sessions screens renders through here.
export function PromptText({ text, className }: { text: string; className?: string }) {
  const { t } = useTranslation();
  return <RedactableText text={text} hiddenLabel={t("sessions.hidePrompts.hidden")} className={className} />;
}

// Call arguments, output and errors.
export function CallContentText({ text, className }: { text: string; className?: string }) {
  const { t } = useTranslation();
  return <RedactableText text={text} hiddenLabel={t("sessions.hidePrompts.contentHidden")} className={className} />;
}
