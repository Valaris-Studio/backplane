// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { ContextLink } from "@/components/shared/ContextLink";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { buildEntityLink } from "@/lib/entity-link";
import { DwellBars } from "./DwellBars";
import { HoldersList } from "./HoldersList";
import { humanizeCardType, humanizePriority, humanizeRole, initials } from "../utils/humanize";
import type { CardAnalytics, CardSnapshot } from "../types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  card: CardSnapshot | null;
  analytics: CardAnalytics | null;
  columnNames: Record<string, string>;
  analyticsScope?: string;
  slug?: string;
  boardId?: string;
  onOpenCurrent?: () => void;
}

// Read-only card detail. Deliberately NOT CardDetailSheet (which pulls in 6+
// mutation hooks): this renders the snapshot AT the current frame plus the
// derived analytics, with zero edit affordances.
export function TimelineCardDetail({
  open,
  onOpenChange,
  card,
  analytics,
  columnNames,
  analyticsScope,
  slug,
  boardId,
  onOpenCurrent,
}: Props) {
  const { t } = useTranslation();
  if (!card) return null;

  const participants = card.participants ?? [];
  const labels = card.labels ?? [];
  const currentColumn = card.column_id ? columnNames[card.column_id] : undefined;
  const currentDestination = slug && boardId
    ? buildEntityLink({ type: "card", id: card.id, slug, boardId })
    : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" data-testid="timeline-card-detail">
        <SheetHeader>
          <SheetTitle>{card.title || t("timeline.untitledCard")}</SheetTitle>
          <div className="flex flex-wrap items-center gap-2">
            {card.card_type ? (
              <Badge variant="info" className="lowercase tracking-normal">
                {humanizeCardType(card.card_type, t)}
              </Badge>
            ) : null}
            {card.priority ? (
              <Badge variant="outline" className="lowercase tracking-normal">
                {humanizePriority(card.priority, t)}
              </Badge>
            ) : null}
            {card.status ? (
              <Badge variant="secondary" className="lowercase tracking-normal">
                {card.status}
              </Badge>
            ) : null}
          </div>
          {currentColumn ? (
            <p className="text-xs text-muted-foreground">
              {t("timeline.detail.currentColumn", { column: currentColumn })}
            </p>
          ) : null}
          {currentDestination ? (
            <div className="flex flex-wrap items-center">
              <ContextLink
                id={`timeline-card-current-${card.id}`}
                to={currentDestination.href}
                onClick={(click) => {
                  if (!click.defaultPrevented && click.button === 0 && !click.metaKey && !click.ctrlKey && !click.altKey && !click.shiftKey && click.currentTarget.target !== "_blank") onOpenCurrent?.();
                }}
                className="inline-flex min-h-11 items-center rounded px-2 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t("timeline.current.card")}
              </ContextLink>
            </div>
          ) : null}
        </SheetHeader>

        {participants.length > 0 ? (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {t("timeline.detail.participants")}
            </h3>
            <ul className="space-y-2">
              {participants.map((participant) => (
                <li
                  key={participant.agent_id ?? participant.user_id}
                  className="flex items-center gap-3"
                >
                  <Avatar className="h-7 w-7">
                    {participant.avatar_url ? (
                      <AvatarImage src={participant.avatar_url} alt={participant.name} />
                    ) : null}
                    <AvatarFallback>{initials(participant.name)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="truncate text-sm text-foreground">{participant.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {humanizeRole(participant.role, t)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {labels.length > 0 ? (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {t("timeline.detail.labels")}
            </h3>
            <div className="flex flex-wrap gap-1">
              {labels.map((label) => (
                <span
                  key={label}
                  className="rounded-full bg-muted px-2 py-0.5 text-[0.65rem] text-muted-foreground"
                >
                  {label}
                </span>
              ))}
            </div>
          </section>
        ) : null}

        {analyticsScope && <p className="text-xs text-muted-foreground">{analyticsScope}</p>}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {t("timeline.detail.dwellTitle")}
          </h3>
          <DwellBars
            dwellByColumn={analytics?.dwellByColumn ?? {}}
            columnNames={columnNames}
          />
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {t("timeline.detail.holdersTitle")}
          </h3>
          <HoldersList holders={analytics?.holders ?? []} />
        </section>

        <p className="mt-auto text-xs italic text-muted-foreground">
          {t("timeline.detail.readonlyNote")}
        </p>
      </SheetContent>
    </Sheet>
  );
}
