// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { buildActorAccents } from "../utils/actor-colors";
import { ChevronDown, ChevronLeft, ChevronRight, Bot, Drama, Search, SlidersHorizontal, UserRound, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  isFlagQueryActive,
  nextFlag,
  prevFlag,
  type ActorFacet,
  type FlagQuery,
  type CardFacet,
  type EventFacet,
} from "../utils/event-flags";

interface Props {
  query: FlagQuery;
  facets: ActorFacet[];
  flags: number[];
  actorAccents?: Record<string, string>;
  frameIndex: number;
  cardFacets?: CardFacet[];
  eventFacets?: { entityTypes: EventFacet[]; actions: EventFacet[] };
  transportControls?: ReactNode;
  viewToggle?: ReactNode;
  onQueryChange: (query: FlagQuery) => void;
  onSeek: (index: number) => void;
}

const FACET_ICONS = {
  agent: Bot,
  user: UserRound,
  role: Drama,
} as const;

// Flag bar: search + actor chips that MARK matching events on the scrubber —
// nothing is ever filtered out of the replay. Fully controlled; the simulator
// owns the query and the computed flag indices.
export function TimelineFlagBar({
  query,
  facets,
  flags,
  frameIndex,
  cardFacets = [],
  eventFacets,
  actorAccents: providedActorAccents,
  transportControls,
  viewToggle,
  onQueryChange,
  onSeek,
}: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const disclosureId = useId();
  const active = isFlagQueryActive(query);
  const secondaryCount = query.actorKeys.size + Number(Boolean(query.cardId))
    + (query.entityTypes?.size ?? 0) + (query.actions?.size ?? 0);
  const actorAccents = useMemo(
    () => providedActorAccents ?? buildActorAccents(
      facets.filter((facet) => facet.kind !== "role").map((facet) => facet.key),
    ),
    [providedActorAccents, facets],
  );

  const toggleActor = (key: string) => {
    const actorKeys = new Set(query.actorKeys);
    if (actorKeys.has(key)) actorKeys.delete(key);
    else actorKeys.add(key);
    onQueryChange({ ...query, actorKeys });
  };

  const seekTo = (index: number | null) => {
    if (index !== null) onSeek(index);
  };

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {transportControls && <div className="shrink-0">{transportControls}</div>}
        <div className="relative min-w-0 flex-1 basis-[10rem]">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70"
          />
          <input
            type="search"
            data-testid="flag-search-input"
            value={query.text}
            onChange={(e) => onQueryChange({ ...query, text: e.target.value })}
            placeholder={t("timeline.flags.searchPlaceholder")}
            aria-label={t("timeline.flags.searchLabel")}
            className="h-8 w-full min-w-0 rounded-md border border-input/85 bg-[color:var(--color-surface-1)] pl-7 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus-visible:border-primary/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/45"
          />
        </div>

        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={disclosureId}
          aria-label={secondaryCount > 0 ? t("timeline.flags.filtersActive", { count: secondaryCount }) : t("timeline.flags.filters")}
          onClick={() => setExpanded((value) => !value)}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-input/85 bg-[color:var(--color-surface-1)] px-2.5 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <SlidersHorizontal aria-hidden className="size-3.5" />
          <span>{t("timeline.flags.filters")}</span>
          {secondaryCount > 0 && <span aria-hidden className="rounded-full bg-primary/12 px-1.5 text-[0.65rem] tabular-nums">{secondaryCount}</span>}
          <ChevronDown aria-hidden className={cn("size-3 text-muted-foreground", expanded && "rotate-180")} />
        </button>
        {active && (
          <div className="flex shrink-0 items-center gap-1">
            <span
              data-testid="flag-count"
              className="whitespace-nowrap text-xs tabular-nums text-muted-foreground"
            >
              {flags.length > 0
                ? t("timeline.flags.matches", { count: flags.length })
                : t("timeline.flags.noMatches")}
            </span>
            {flags.length > 0 && (
              <>
                <button
                  type="button"
                  data-testid="flag-prev"
                  aria-label={t("timeline.flags.prev")}
                  onClick={() => seekTo(prevFlag(flags, frameIndex))}
                  className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <ChevronLeft aria-hidden className="size-3.5" />
                </button>
                <button
                  type="button"
                  data-testid="flag-next"
                  aria-label={t("timeline.flags.next")}
                  onClick={() => seekTo(nextFlag(flags, frameIndex))}
                  className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <ChevronRight aria-hidden className="size-3.5" />
                </button>
              </>
            )}
            <button
              type="button"
              data-testid="flag-clear"
              aria-label={t("timeline.flags.clear")}
              onClick={() => onQueryChange({ text: "", actorKeys: new Set() })}
              className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          </div>
        )}
        {viewToggle && <div className="shrink-0">{viewToggle}</div>}
      </div>
      <div id={disclosureId} hidden={!expanded} className="mt-2 space-y-2 rounded-md border border-border/60 bg-[color:var(--color-surface-1)]/50 p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          {cardFacets.length > 0 && (
            <select
              aria-label={t("timeline.flags.cardLabel")}
              value={query.cardId ?? ""}
              onChange={(event) => onQueryChange({ ...query, cardId: event.target.value || undefined })}
              className="h-8 max-w-52 rounded-md border border-input/85 bg-[color:var(--color-surface-1)] px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">{t("timeline.flags.allCards")}</option>
              {cardFacets.map((card) => <option key={card.id} value={card.id}>{card.title || card.id} · {card.id.slice(0, 8)}</option>)}
            </select>
          )}
          {eventFacets && (["entityTypes", "actions"] as const).map((field) => (
            <select
              key={field}
              aria-label={t(field === "entityTypes" ? "timeline.flags.eventTypeLabel" : "timeline.flags.actionLabel")}
              value={[...(query[field] ?? [])][0] ?? ""}
              onChange={(event) => onQueryChange({ ...query, [field]: new Set(event.target.value ? [event.target.value] : []) })}
              className="h-8 max-w-44 rounded-md border border-input/85 bg-[color:var(--color-surface-1)] px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">{t(field === "entityTypes" ? "timeline.flags.allEvents" : "timeline.flags.allActions")}</option>
              {eventFacets[field].map((facet) => (
                <option key={facet.value} value={facet.value}>
                  {t(`timeline.flags.${field}.${facet.value}`, { defaultValue: facet.value.replaceAll("_", " ") })} · {facet.count}
                </option>
              ))}
            </select>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {facets.length > 0 && (
            <div
              className="flex max-w-full flex-wrap items-center gap-1.5 py-0.5"
              role="group"
              aria-label={t("timeline.flags.actorsLabel")}
            >
              {facets.map((facet) => {
                const Icon = FACET_ICONS[facet.kind];
                const pressed = query.actorKeys.has(facet.key);
                return (
                  <button
                    key={facet.key}
                    type="button"
                    data-testid="flag-actor-chip"
                    aria-pressed={pressed}
                    title={facet.label}
                    style={{ "--actor-accent": actorAccents[facet.key] ?? "var(--color-muted-foreground)" } as CSSProperties}
                    onClick={() => toggleActor(facet.key)}
                    className={cn(
                      "flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[0.7rem] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                      pressed
                        ? "border-[color:var(--actor-accent)] bg-[color:color-mix(in_oklab,var(--actor-accent)_16%,transparent)] text-foreground"
                        : "border-border/70 bg-transparent text-muted-foreground hover:border-border hover:text-foreground",
                    )}
                  >
                    <Icon aria-hidden className="size-3 shrink-0 text-[color:var(--actor-accent)]" />
                    <span className="max-w-[20ch] truncate">{facet.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {active && <p className="text-[0.65rem] text-muted-foreground">{t("timeline.flags.hint")}</p>}
      </div>
    </div>
  );
}
