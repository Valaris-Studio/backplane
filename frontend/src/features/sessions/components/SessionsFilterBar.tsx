// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownUp, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import { useBoards } from "@/features/kanban/api/use-boards";
import { displayStateFor, SORTS, STATE_FILTERS, type Period, type SessionFilters } from "../hooks/use-session-filters";
import { AgentMark } from "./AgentMark";
import { SessionSearch } from "./SessionSearch";
import { COMPACT_LIST_QUERY } from "./SessionsTable";
import { Segmented, Switch } from "./controls";

const ANY = "any";

export interface AgentOption {
  key: string;
  harness: string;
  displayName: string;
}

interface PeriodPickerProps {
  period: Period;
  onChange: (period: Period) => void;
}

export function PeriodPicker({ period, onChange }: PeriodPickerProps) {
  const { t } = useTranslation();
  return (
    <Segmented
      label={t("sessions.period.label")}
      value={period}
      onChange={onChange}
      options={[
        { value: "today", label: t("sessions.period.today") },
        { value: "7d", label: t("sessions.period.d7") },
        { value: "30d", label: t("sessions.period.d30") },
      ]}
    />
  );
}

interface SortSelectProps {
  sort: SessionFilters["sort"];
  onChange: (sort: SessionFilters["sort"]) => void;
}

export function SortSelect({ sort, onChange }: SortSelectProps) {
  const { t } = useTranslation();
  return (
    <Select value={sort} onValueChange={(value) => onChange(value as SessionFilters["sort"])}>
      <SelectTrigger aria-label={t("sessions.filters.sort")} className="h-9 w-auto min-w-[10.5rem] gap-2">
        <ArrowDownUp aria-hidden className="size-4 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SORTS.map((option) => (
          <SelectItem key={option} value={option}>
            {t(`sessions.filters.sorts.${option}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

interface SessionsFilterBarProps {
  slug: string;
  filters: SessionFilters;
  agents: AgentOption[];
  onChange: (patch: Partial<SessionFilters>) => void;
  // Right edge of the same row (the sort control).
  trailing?: ReactNode;
}

export function SessionsFilterBar({ slug, filters, agents, onChange, trailing }: SessionsFilterBarProps) {
  const { t } = useTranslation();
  const boards = useBoards(slug);
  const compact = useMediaQuery(COMPACT_LIST_QUERY);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreId = useId();
  // On a phone the first screen keeps agents, state and sort; the rest folds
  // behind "Filters", which counts what is set in it.
  const folded = [filters.q.trim(), filters.board, filters.linkedOnly, filters.subagents].filter(Boolean).length;

  const agentToggles = agents.length ? (
    <div role="group" aria-label={t("sessions.filters.agents")} className="inline-flex gap-0.5 rounded-[var(--radius-cap)] border border-border bg-card p-0.5">
      {agents.map((agent) => {
        const pressed = filters.agent === agent.key;
        return (
          <button
            key={agent.key}
            type="button"
            aria-pressed={pressed}
            aria-label={t("sessions.filters.agentToggle", { agent: agent.displayName })}
            title={agent.displayName}
            onClick={() => onChange({ agent: pressed ? null : agent.key })}
            className={cn(
              "rounded-[var(--radius-cap)] transition-[opacity,filter] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              filters.agent && !pressed && "opacity-45 saturate-[0.3] hover:opacity-80",
            )}
          >
            <AgentMark harness={agent.harness} displayName={agent.displayName} decorative className="h-7" />
          </button>
        );
      })}
    </div>
  ) : null;

  const stateSelect = (
    <Select value={filters.state ?? ANY} onValueChange={(value) => onChange({ state: value === ANY ? null : (value as SessionFilters["state"]) })}>
      <SelectTrigger
        aria-label={t("sessions.filters.state")}
        className={cn("h-9 w-auto min-w-[9.5rem] gap-2", filters.state && "border-foreground/35 bg-accent")}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>{t("sessions.filters.stateAny")}</SelectItem>
        {STATE_FILTERS.map((state) => (
          <SelectItem key={state} value={state}>
            {t(`sessions.states.${displayStateFor(state)}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const secondary = (
    <>
      <SessionSearch value={filters.q} onChange={(q) => onChange({ q })} />
      {boards.data?.length ? (
        <Select value={filters.board ?? ANY} onValueChange={(value) => onChange({ board: value === ANY ? null : value })}>
          <SelectTrigger
            aria-label={t("sessions.filters.board")}
            className={cn("h-9 w-auto min-w-[9.5rem] max-w-[16rem] gap-2", filters.board && "border-foreground/35 bg-accent")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{t("sessions.filters.boardAny")}</SelectItem>
            {boards.data.map((board) => (
              <SelectItem key={board.id} value={board.id}>
                {board.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <Switch label={t("sessions.filters.linkedOnly")} checked={filters.linkedOnly} onChange={(linkedOnly) => onChange({ linkedOnly })} />
      <Switch label={t("sessions.filters.showSubagents")} checked={filters.subagents} onChange={(subagents) => onChange({ subagents })} />
    </>
  );

  if (compact) {
    return (
      <div role="search" aria-label={t("sessions.filters.label")} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {agentToggles}
          {stateSelect}
          {trailing}
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            aria-expanded={moreOpen}
            aria-controls={moreId}
            onClick={() => setMoreOpen((open) => !open)}
          >
            <SlidersHorizontal aria-hidden />
            {t("sessions.filters.more")}
            {folded ? <span className="tabular-nums">({folded})</span> : null}
          </Button>
        </div>
        {moreOpen ? (
          <div id={moreId} className="flex flex-wrap items-center gap-2">
            {secondary}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div role="search" aria-label={t("sessions.filters.label")} className="flex flex-wrap items-center gap-2">
      {agentToggles}
      {stateSelect}
      {secondary}
      {trailing ? <div className="ml-auto flex items-center gap-2">{trailing}</div> : null}
    </div>
  );
}
