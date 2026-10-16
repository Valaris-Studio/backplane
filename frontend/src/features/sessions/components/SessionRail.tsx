// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Check, Coins, Cpu, Eye, GitFork, Link2, Lock, Pencil, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useBoards } from "@/features/kanban/api/use-boards";
import type { AgentSession, CaptureLevel, SessionModelUsage, SessionWorkLink } from "@/types/agent-session";
import { useSessionChildren, useSessionLinks, useSessionUsage } from "../api/use-sessions";
import { useWorkTarget } from "../api/use-work-title";
import type { SessionWorkIdentity } from "../api/use-session-evidence";
import { displayCwd, formatTokens, formatUsd, isDevicePath, sessionTotalTokens } from "../utils/format";
import { isUsageOnly } from "../utils/group-sessions";
import { AgentMark } from "./AgentMark";
import { PromptText } from "./PromptText";
import { SessionStateBadge } from "./SessionStateBadge";

interface PanelProps {
  icon: typeof Coins;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}

function RailPanel({ icon: Icon, title, aside, children, className }: PanelProps) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "rounded-[var(--radius-cap)] border border-border/70 bg-[color:var(--color-surface-1)] px-[var(--card-padding)] py-3.5 shadow-panel",
        className,
      )}
    >
      <div className="mb-2.5 flex items-center gap-2">
        <Icon aria-hidden className="size-4 text-muted-foreground" />
        <h3 id={headingId} className="text-[0.95rem] font-bold">
          {title}
        </h3>
        {aside ? <span className="ml-auto text-[0.8rem] font-medium text-muted-foreground">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

function modelTokens(usage: SessionModelUsage): number {
  return (
    usage.input_uncached_tokens +
    usage.cache_read_tokens +
    usage.cache_write_5m_tokens +
    usage.cache_write_1h_tokens +
    usage.output_tokens
  );
}

export function CostPanel({ slug, session, loadUsage = true }: { slug: string; session: AgentSession; loadUsage?: boolean }) {
  const { t } = useTranslation();
  const usage = useSessionUsage(slug, session.id, loadUsage);
  const explanation =
    session.cost_basis === "spend"
      ? t("sessions.rail.cost.explainSpend")
      : session.auth_kind === "subscription"
        ? t("sessions.rail.cost.explainSubscription")
        : t("sessions.rail.cost.explainApiEquivalent");

  return (
    <RailPanel icon={Coins} title={t("sessions.rail.cost.title")} aside={t(`sessions.rail.cost.auth.${session.auth_kind}`)}>
      {session.cost_usd === null ? (
        <p className="text-sm text-muted-foreground">{t("sessions.rail.cost.none")}</p>
      ) : (
        <>
          <p className="flex items-baseline gap-2">
            <span className="font-display text-[1.6rem] font-bold tabular-nums tracking-[-0.03em]">{formatUsd(session.cost_usd)}</span>
            <span className="text-[0.85rem] text-muted-foreground">
              {t(session.cost_basis === "spend" ? "sessions.cost.spend" : "sessions.cost.apiEquivalent")}
            </span>
            {!session.cost_complete ? (
              <span className="text-muted-foreground" title={t("sessions.cost.incompleteHint")}>
                +
              </span>
            ) : null}
          </p>
          <p className="mt-1 text-[0.8rem] leading-snug text-muted-foreground">{explanation}</p>
        </>
      )}
      {usage.data?.items.length ? (
        <table className="mt-3 w-full border-collapse text-[0.82rem]" title={t("sessions.rail.cost.priceTable", { version: usage.data.price_table_version })}>
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th scope="col" className="py-1.5 font-semibold">{t("sessions.rail.cost.model")}</th>
              <th scope="col" className="py-1.5 text-right font-semibold">{t("sessions.rail.cost.tokens")}</th>
              <th scope="col" className="py-1.5 text-right font-semibold">{t("sessions.rail.cost.amount")}</th>
            </tr>
          </thead>
          <tbody>
            {usage.data.items.map((row, index) => (
              <tr key={`${row.model}-${row.provider}-${row.service_tier}-${index}`} className="border-b border-border/60 last:border-b-0">
                <td className="py-1.5 pr-2 [overflow-wrap:anywhere]">{row.model ?? t("sessions.rail.cost.unknownModel")}</td>
                <td className="py-1.5 text-right tabular-nums">{formatTokens(modelTokens(row))}</td>
                <td className="py-1.5 text-right tabular-nums">
                  {row.cost_usd === null ? (
                    <span title={t("sessions.rail.cost.unpriced")}>—</span>
                  ) : (
                    formatUsd(row.cost_usd)
                  )}
                  {row.cost_source === "estimated" ? (
                    <span className="ml-1 rounded-[var(--radius-cap)] border border-border px-1 text-[0.75rem] font-bold text-muted-foreground" title={t("sessions.cost.estimatedHint")}>
                      {t("sessions.cost.estimated")}
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </RailPanel>
  );
}

interface TokenPart {
  key: "cacheRead" | "input" | "cacheWrite" | "output";
  value: number;
  color: string;
}

export function TokensPanel({ session }: { session: AgentSession }) {
  const { t } = useTranslation();
  const total = sessionTotalTokens(session);
  const parts: TokenPart[] = [
    { key: "cacheRead", value: session.cache_read_tokens, color: "color-mix(in oklab, var(--color-primary) 42%, var(--color-surface-3))" },
    { key: "input", value: session.input_tokens, color: "var(--color-primary)" },
    { key: "cacheWrite", value: session.cache_creation_tokens, color: "var(--color-data-3)" },
    { key: "output", value: session.output_tokens, color: "var(--color-foreground)" },
  ];
  const summary = parts.map((part) => `${t(`sessions.rail.tokens.${part.key}`)} ${formatTokens(part.value)}`).join(", ");

  return (
    <RailPanel icon={Cpu} title={t("sessions.rail.tokens.title")} aside={<span className="tabular-nums">{formatTokens(total)}</span>}>
      {total > 0 ? (
        <div role="img" aria-label={t("sessions.rail.tokens.barLabel", { summary })} className="mb-2.5 flex h-2 gap-0.5 overflow-hidden rounded-[var(--radius-cap)]">
          {parts
            .filter((part) => part.value > 0)
            .map((part) => (
              <span key={part.key} style={{ flexGrow: part.value, backgroundColor: part.color }} />
            ))}
        </div>
      ) : null}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[0.8rem] text-muted-foreground">
        {parts.map((part) => (
          <div key={part.key} className="flex items-center gap-1.5">
            <span aria-hidden className="size-2 shrink-0 rounded-[1px]" style={{ backgroundColor: part.color }} />
            <dt>{t(`sessions.rail.tokens.${part.key}`)}</dt>
            <dd className="ml-auto font-semibold tabular-nums text-foreground">{formatTokens(part.value)}</dd>
          </div>
        ))}
        {session.reasoning_tokens > 0 ? (
          <div className="col-span-2 flex items-center gap-1.5">
            <dt>
              {t("sessions.rail.tokens.reasoning")} <span className="opacity-75">({t("sessions.rail.tokens.reasoningHint")})</span>
            </dt>
            <dd className="ml-auto font-semibold tabular-nums text-foreground">{formatTokens(session.reasoning_tokens)}</dd>
          </div>
        ) : null}
      </dl>
    </RailPanel>
  );
}

export function LinkedWorkPanel({ slug, session, onInspect }: { slug: string; session: AgentSession; onInspect?: (identity: SessionWorkIdentity) => void }) {
  const { t } = useTranslation();
  const links = useSessionLinks(slug, session.id, true);
  const items = links.data?.items ?? [];
  return (
    <RailPanel icon={Link2} title={t("sessions.rail.linked.title")} aside={links.isSuccess ? <span className="tabular-nums">{items.length}</span> : undefined}>
      {links.isPending ? <p role="status" className="text-sm text-muted-foreground">{t("sessions.evidence.linksLoading")}</p> : links.isError ? (
        <div className="grid justify-items-start gap-2 text-sm text-muted-foreground">
          <p role="alert">{t("sessions.evidence.linksError")}</p>
          <Button variant="outline" size="sm" className="max-sm:min-h-[44px]" onClick={() => void links.refetch()} disabled={links.isFetching}>{t("sessions.work.retry")}</Button>
        </div>
      ) : !items.length ? (
        <p className="text-[0.85rem] text-muted-foreground">{t("sessions.rail.linked.none")}</p>
      ) : (
        <ul className="grid gap-2.5">
          {items.map((link) => (
            <LinkedWorkRow key={`${link.workspace_id}-${link.entity_type}-${link.entity_id}-${link.relation}`} link={link} onInspect={onInspect} />
          ))}
        </ul>
      )}
    </RailPanel>
  );
}

function LinkedWorkRow({ link, onInspect }: { link: SessionWorkLink; onInspect?: (identity: SessionWorkIdentity) => void }) {
  const { t } = useTranslation();
  const target = useWorkTarget(link);
  const boards = useBoards(target.status === "available" ? target.slug : "", { enabled: target.status === "available" && link.entity_type === "card" });
  const board = target.status === "available" && boards.isSuccess ? boards.data.find((candidate) => candidate.id === link.board_id) : undefined;
  const Icon = link.relation === "changed" ? Pencil : Eye;
  const facts = [
    t(`sessions.work.${link.relation}`),
    t("sessions.rail.linked.calls", { count: link.invocation_count }),
    board ? t("sessions.rail.linked.boardName", { board: board.name }) : t(`sessions.rail.linked.${link.entity_type}`),
    ...(link.provenance === "correlated" ? [t("sessions.rail.linked.matchedByTiming")] : []),
  ];
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 text-[0.88rem]">
      <Icon aria-hidden className={cn("mt-0.5 size-4", link.relation === "changed" ? "text-primary" : "text-muted-foreground")} />
      {target.status === "available" ? (
        <Link
          to={target.href}
          className="min-w-0 break-words rounded-[var(--radius-cap)] font-semibold text-[color:color-mix(in_oklab,var(--color-primary)_70%,var(--color-foreground))] underline-offset-[0.18em] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {target.title}
        </Link>
      ) : (
        <p role={target.status === "loading" ? "status" : undefined} className="text-sm text-muted-foreground">
          {t(target.status === "loading" ? "sessions.work.loadingTitle" : target.status === "error" ? "sessions.work.loadError" : "sessions.work.unavailable")}
        </p>
      )}
      <small className="col-start-2 text-[0.78rem] text-muted-foreground">{facts.join(" · ")}</small>
      {target.status === "available" && onInspect ? (
        <Button variant="ghost" size="sm" className="col-start-2 mt-1 justify-self-start max-sm:min-h-[44px]" aria-label={t("sessions.evidence.inspectLabel", { relation: t(`sessions.work.${link.relation}`), title: target.title })}
          onClick={() => onInspect({ workspace_id: link.workspace_id, entity_type: link.entity_type, entity_id: link.entity_id, relation: link.relation })}>
          {t("sessions.evidence.inspect")}
        </Button>
      ) : target.status === "error" ? (
        <Button variant="ghost" size="sm" className="col-start-2 mt-1 justify-self-start max-sm:min-h-[44px]" onClick={() => void target.refetch()}>{t("sessions.work.retry")}</Button>
      ) : null}
    </li>
  );
}

const LEVELS: CaptureLevel[] = ["metadata", "standard", "full", "rich"];

export function CapturePanel({ session }: { session: AgentSession }) {
  const { t } = useTranslation();
  const levels = session.capture_levels;
  const level = levels?.at(-1);
  const usageOnly = isUsageOnly(session);
  const coverage = usageOnly
    ? t("sessions.rail.captured.coverageUsageOnly")
    : session.capture_gaps > 0
      ? t("sessions.rail.captured.coverageGaps", { count: session.capture_gaps })
      : t("sessions.rail.captured.coverageFull");

  return (
    <RailPanel icon={ShieldCheck} title={t("sessions.rail.captured.title")}>
      {level ? (
        <>
          <p className="text-[0.88rem] font-bold">{t(`sessions.rail.captured.levels.${level}`)}</p>
          <div
            role="img"
            aria-label={t("sessions.rail.captured.levelMeter", { level: t(`sessions.rail.captured.levels.${level}`) })}
            className="mb-2 mt-1 grid grid-cols-4 gap-0.5"
          >
            {LEVELS.map((step, index) => (
              <span
                key={step}
                className={cn("h-1.5 rounded-[1px]", index <= LEVELS.indexOf(level) ? "bg-foreground" : "bg-[color:var(--color-surface-3)]")}
              />
            ))}
          </div>
          <ul className="grid gap-1 text-[0.82rem]">
            <li className="flex items-start gap-2">
              <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-[color:var(--color-success-foreground)]" />
              {t(`sessions.rail.captured.sent.${level}`)}
            </li>
            <li className="flex items-start gap-2 text-muted-foreground">
              <Lock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              {t(`sessions.rail.captured.kept.${level}`)}
            </li>
          </ul>
        </>
      ) : (
        <p className="text-[0.85rem] text-muted-foreground">
          {t("sessions.rail.captured.legacy")}
        </p>
      )}
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[0.85rem]">
        <dt className="text-muted-foreground">{t("sessions.rail.captured.coverage")}</dt>
        <dd className="text-right font-semibold">{coverage}</dd>
        {session.cwd ? (
          <>
            <dt className="text-muted-foreground">{t("sessions.rail.captured.folder")}</dt>
            {/* The bound folder and the path inside it; an older row's device
                path shrinks to its last folder, with no hover either. */}
            <dd
              className="truncate text-right font-mono text-[0.8rem] font-semibold"
              title={isDevicePath(session.cwd) ? undefined : session.cwd}
            >
              {displayCwd(session.cwd)}
            </dd>
          </>
        ) : null}
      </dl>
    </RailPanel>
  );
}

export function SubagentsPanel({ slug, session }: { slug: string; session: AgentSession }) {
  const { t } = useTranslation();
  const children = useSessionChildren(slug, session.id, true);
  const items = children.data?.items ?? [];
  if (!items.length) return null;
  return (
    <RailPanel icon={GitFork} title={t("sessions.rail.subagents.title")} aside={<span className="tabular-nums">{items.length}</span>}>
      <ul className="grid gap-2">
        {items.map((child) => (
          <li key={child.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 text-[0.85rem]">
            <AgentMark harness={child.harness} displayName={child.harness_display_name} size="sm" />
            <Link
              to={`/${slug}/sessions/${child.id}`}
              className="truncate rounded-[var(--radius-cap)] font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {child.title ? <PromptText text={child.title} /> : t("sessions.timeline.subagent.untitled")}
            </Link>
            <SessionStateBadge session={child} />
          </li>
        ))}
      </ul>
    </RailPanel>
  );
}
