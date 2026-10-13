// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Eye, Pencil } from "lucide-react";
import { buildEntityLink } from "@/lib/entity-link";
import { cn } from "@/lib/utils";
import type { LinkProvenance, LinkRelation } from "@/types/agent-session";
import { useWorkTitle, type WorkEntityRef } from "../api/use-work-title";

export interface WorkChipRef extends WorkEntityRef {
  relation: LinkRelation;
  provenance: LinkProvenance;
  title?: string;
}

interface WorkChipProps {
  slug: string;
  work: WorkChipRef;
  className?: string;
}

// The one place brand green appears in a row: Backplane work an agent changed.
// Consulted work stays ink; a timing-matched link is dashed.
export function WorkChip({ slug, work, className }: WorkChipProps) {
  const { t } = useTranslation();
  const resolvedTitle = useWorkTitle(slug, work, work.title === undefined);
  const title = work.title ?? resolvedTitle;
  const relationLabel = t(`sessions.work.${work.relation}`);
  const correlated = work.provenance === "correlated";
  const href = buildEntityLink({
    type: work.entity_type,
    id: work.entity_id,
    slug,
    boardId: work.board_id ?? undefined,
  })?.href;

  const Icon = work.relation === "changed" ? Pencil : Eye;
  const accessibleName = title
    ? t(correlated ? "sessions.work.accessibleCorrelated" : "sessions.work.accessible", { relation: relationLabel, title })
    : t("sessions.work.loadingTitle");

  const chip = (
    <>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className={cn("truncate", !title && "w-20 rounded-[var(--radius-cap)] bg-current/15 text-transparent")}>
        {title ?? relationLabel}
      </span>
    </>
  );

  const chipClasses = cn(
    "inline-flex h-6 min-w-0 max-w-[17rem] items-center gap-1.5 rounded-[var(--radius-cap)] border px-2 text-[0.8rem] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    work.relation === "changed"
      ? "border-primary/25 bg-primary/9 text-[color:color-mix(in_oklab,var(--color-primary)_72%,var(--color-foreground))] hover:bg-primary/15"
      : "border-border bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
    correlated && "border-dashed",
    className,
  );

  if (!href) {
    return (
      <span className={chipClasses} aria-label={accessibleName} data-relation={work.relation}>
        {chip}
      </span>
    );
  }

  return (
    <Link
      to={href}
      aria-label={accessibleName}
      title={correlated ? t("sessions.work.correlatedHint") : title}
      data-relation={work.relation}
      className={chipClasses}
      onClick={(event) => event.stopPropagation()}
    >
      {chip}
    </Link>
  );
}
