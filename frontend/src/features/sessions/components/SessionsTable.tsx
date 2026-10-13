// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { GitBranch, GitFork, Info } from "lucide-react";
import { formatDate } from "@/lib/format";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import type { AgentSession } from "@/types/agent-session";
import { formatTokens, formatWallTime, sessionTotalTokens, sessionWallSeconds } from "../utils/format";
import type { SessionGroup } from "../utils/group-sessions";
import { AgentMark } from "./AgentMark";
import { CostAmount } from "./CostAmount";
import { CallContentText, PromptText } from "./PromptText";
import { SessionStateBadge } from "./SessionStateBadge";
import { useSessionTitle, WithheldTitleGlyph } from "./SessionTitle";
import { WorkChip, type WorkChipRef } from "./WorkChip";

const MAX_ROW_CHIPS = 2;
const LONG_CHIP_TITLE = 28;

// Below 640px the table becomes a list of two-line cards.
export const COMPACT_LIST_QUERY = "(max-width: 639.98px)";

interface SessionsTableProps {
  slug: string;
  groups: SessionGroup[];
  now: number;
}

export function SessionsTable(props: SessionsTableProps) {
  const compact = useMediaQuery(COMPACT_LIST_QUERY);
  return compact ? <SessionCards {...props} /> : <SessionsGrid {...props} />;
}

function groupLabel(group: SessionGroup, t: (key: string) => string): string {
  if (group.kind === "live") return t("sessions.groups.live");
  if (group.kind === "today") return t("sessions.groups.today");
  if (group.kind === "yesterday") return t("sessions.groups.yesterday");
  return formatDate(group.day ?? new Date(), { weekday: "long", month: "short", day: "numeric" });
}

function GroupHeading({ group }: { group: SessionGroup }) {
  const { t } = useTranslation();
  return (
    <span className="flex items-baseline gap-2">
      {groupLabel(group, t)}
      <span className="font-semibold tabular-nums text-muted-foreground">{group.sessions.length}</span>
      {group.kind === "live" ? (
        <span className="ml-auto text-[0.78rem] font-medium text-muted-foreground">{t("sessions.groups.liveHint")}</span>
      ) : null}
    </span>
  );
}

function SessionsGrid({ slug, groups, now }: SessionsTableProps) {
  const { t } = useTranslation();
  return (
    <table className="w-full table-fixed border-collapse text-left">
      <caption className="sr-only">{t("sessions.list.caption")}</caption>
      <colgroup>
        <col className="w-[calc(1.9rem+var(--card-padding))]" />
        <col />
        <col className="w-[30%] max-lg:w-[24%]" />
        <col className="w-[5.5rem]" />
        <col className="w-[5.5rem]" />
        <col className="w-[8rem]" />
        <col className="w-[9.75rem]" />
      </colgroup>
      <thead>
        <tr className="border-b border-border bg-[color:var(--color-surface-2)] text-[0.7rem] font-bold uppercase tracking-[0.08em] text-muted-foreground">
          <th scope="col" className="py-2.5 pl-[var(--card-padding)]">
            <span className="sr-only">{t("sessions.columns.agent")}</span>
          </th>
          <th scope="col" className="py-2.5 pl-4">{t("sessions.columns.session")}</th>
          <th scope="col" className="py-2.5 pl-4">{t("sessions.columns.linkedWork")}</th>
          <th scope="col" className="py-2.5 pl-4 text-right">{t("sessions.columns.time")}</th>
          <th scope="col" className="py-2.5 pl-4 text-right">{t("sessions.columns.tokens")}</th>
          <th scope="col" className="py-2.5 pl-4 text-right">{t("sessions.columns.cost")}</th>
          <th scope="col" className="py-2.5 pl-4 pr-[var(--card-padding)] text-right">{t("sessions.columns.state")}</th>
        </tr>
      </thead>
      {groups.map((group) => (
        <tbody key={group.key} className="[content-visibility:auto] [contain-intrinsic-size:auto_20rem]">
          {group.kind === "all" ? null : (
            <tr>
              <th scope="rowgroup" colSpan={7} className="px-[var(--card-padding)] pb-1.5 pt-4 text-[0.8rem] font-bold text-foreground">
                <GroupHeading group={group} />
              </th>
            </tr>
          )}
          {group.sessions.map((session) => (
            <SessionRow key={session.id} slug={slug} session={session} now={now} />
          ))}
        </tbody>
      ))}
    </table>
  );
}

function useFollowLink(href: string) {
  const navigate = useNavigate();
  // The title holds the real link; a click anywhere else on the row is an
  // enhancement that follows it (never when selecting text or using a control).
  return (event: MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("a, button")) return;
    if (window.getSelection()?.toString()) return;
    navigate(href);
  };
}

function TitleLink({ session, href, clamp = false }: { session: AgentSession; href: string; clamp?: boolean }) {
  const { t } = useTranslation();
  const title = useSessionTitle(session);
  return (
    <div className="flex min-w-0 items-center gap-2">
      {title.kind === "withheld" ? <WithheldTitleGlyph /> : null}
      <Link
        to={href}
        className={cn(
          "min-w-0 rounded-[var(--radius-cap)] text-[0.95rem] font-semibold text-foreground underline-offset-[0.18em] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          clamp ? "line-clamp-2" : "truncate",
          title.kind !== "title" && "font-medium text-muted-foreground",
        )}
      >
        {title.kind === "title" ? <PromptText text={title.text} /> : title.text}
      </Link>
      {session.child_count ? (
        <span className="inline-flex shrink-0 items-center gap-0.5 text-[0.75rem] font-semibold text-muted-foreground" title={t("sessions.row.subagents", { count: session.child_count })}>
          <GitFork aria-hidden className="size-3" />
          <span aria-hidden className="tabular-nums">{session.child_count}</span>
          <span className="sr-only">{t("sessions.row.subagents", { count: session.child_count })}</span>
        </span>
      ) : null}
    </div>
  );
}

function SessionMeta({ session }: { session: AgentSession }) {
  const { t } = useTranslation();
  const title = useSessionTitle(session);
  // Device names often carry the owner's name, so presenter mode blurs them.
  const meta = [
    session.repository ? { text: session.repository, personal: false } : null,
    session.branch ? { text: session.branch, personal: false } : null,
    session.device_name ? { text: session.device_name, personal: true } : null,
  ].filter((part): part is { text: string; personal: boolean } => part !== null);
  if (title.kind === "usageOnly") {
    return (
      <p className="mt-0.5 flex items-center gap-1.5 truncate text-[0.82rem] text-muted-foreground">
        <Info aria-hidden className="size-3.5 shrink-0" />
        {t("sessions.row.usageOnlyMeta")}
      </p>
    );
  }
  if (!meta.length) return null;
  return (
    <p className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-[0.82rem] text-muted-foreground">
      <GitBranch aria-hidden className="size-3.5 shrink-0" />
      {meta.map((part, index) => (
        <span key={part.text + index} className={cn("truncate", index > 0 && "before:mr-1.5 before:opacity-50 before:content-['·']")}>
          {part.personal ? <CallContentText text={part.text} /> : part.text}
        </span>
      ))}
    </p>
  );
}

interface SessionRowProps {
  slug: string;
  session: AgentSession;
  now: number;
}

function SessionRow({ slug, session, now }: SessionRowProps) {
  const href = `/${slug}/sessions/${session.id}`;
  const followRow = useFollowLink(href);

  return (
    <tr onClick={followRow} className="cursor-pointer border-t border-border/65 transition-colors duration-150 hover:bg-accent/70">
      <td className="py-2.5 pl-[var(--card-padding)] align-middle">
        <AgentMark harness={session.harness} displayName={session.harness_display_name} />
      </td>
      <td className="min-w-0 py-2.5 pl-4 align-middle">
        <TitleLink session={session} href={href} />
        <SessionMeta session={session} />
      </td>
      <td className="min-w-0 py-2.5 pl-4 align-middle">
        <RowLinks slug={slug} session={session} />
      </td>
      <td className="py-2.5 pl-4 text-right align-middle text-[0.92rem] font-semibold tabular-nums">
        {formatWallTime(sessionWallSeconds(session, now))}
      </td>
      <td className="py-2.5 pl-4 text-right align-middle text-[0.92rem] font-semibold tabular-nums">
        {formatTokens(sessionTotalTokens(session))}
      </td>
      <td className="py-2.5 pl-4 text-right align-middle">
        <CostAmount amount={session.cost_usd} basis={session.cost_basis} source={session.cost_source} complete={session.cost_complete} />
      </td>
      <td className="py-2.5 pl-4 pr-[var(--card-padding)] text-right align-middle">
        <SessionStateBadge session={session} />
      </td>
    </tr>
  );
}

function SessionCards({ slug, groups, now }: SessionsTableProps) {
  const { t } = useTranslation();
  return (
    <div aria-label={t("sessions.list.caption")} role="region">
      {groups.map((group) => (
        <section key={group.key} aria-label={group.kind === "all" ? undefined : groupLabel(group, t)} className="[content-visibility:auto] [contain-intrinsic-size:auto_24rem]">
          {group.kind === "all" ? null : (
            <h2 className="border-b border-border/65 px-[var(--card-padding)] pb-2 pt-3.5 font-sans text-[0.8rem] font-bold tracking-normal text-foreground">
              <GroupHeading group={group} />
            </h2>
          )}
          <ul>
            {group.sessions.map((session) => (
              <SessionCard key={session.id} slug={slug} session={session} now={now} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function SessionCard({ slug, session, now }: SessionRowProps) {
  const href = `/${slug}/sessions/${session.id}`;
  const followCard = useFollowLink(href);
  return (
    <li
      onClick={followCard}
      className="grid cursor-pointer grid-cols-[1.9rem_minmax(0,1fr)_auto] gap-x-3 border-b border-border/65 px-[var(--card-padding)] py-3 last:border-b-0 active:bg-accent/70"
    >
      <AgentMark harness={session.harness} displayName={session.harness_display_name} />
      <div className="min-w-0">
        <TitleLink session={session} href={href} clamp />
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.82rem] tabular-nums text-muted-foreground">
          <SessionStateBadge session={session} />
          <span>{formatWallTime(sessionWallSeconds(session, now))}</span>
          <span aria-hidden className="opacity-50">·</span>
          <span>{formatTokens(sessionTotalTokens(session))}</span>
        </div>
        <div className="mt-2 empty:hidden">
          <RowLinks slug={slug} session={session} hideEmpty />
        </div>
      </div>
      <CostAmount amount={session.cost_usd} basis={session.cost_basis} source={session.cost_source} complete={session.cost_complete} />
    </li>
  );
}

interface RowLinksProps {
  slug: string;
  session: AgentSession;
  hideEmpty?: boolean;
}

// The list sends up to two previews per row (changed first, then the most
// recently touched) and the full count: no request per row.
function RowLinks({ slug, session, hideEmpty = false }: RowLinksProps) {
  const { t } = useTranslation();
  const chips: WorkChipRef[] = session.link_preview ?? [];
  const total = session.link_count ?? chips.length;

  if (total === 0) {
    return hideEmpty ? null : <span className="text-[0.82rem] text-muted-foreground">{t("sessions.row.noLinkedWork")}</span>;
  }

  // A long first title gets the cell to itself; two truncated chips read as neither.
  const shownCount = (chips[0]?.title?.length ?? 0) > LONG_CHIP_TITLE ? 1 : MAX_ROW_CHIPS;
  const shown = chips.slice(0, shownCount);
  const hidden = total - shown.length;
  return (
    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      {shown.map((chip) => (
        <WorkChip key={`${chip.entity_type}-${chip.entity_id}`} slug={slug} work={chip} className="shrink" />
      ))}
      {hidden > 0 ? (
        <span className="shrink-0 text-[0.8rem] font-semibold text-muted-foreground">
          <span aria-hidden>{t("sessions.row.moreLinks", { count: hidden })}</span>
          <span className="sr-only">{t("sessions.row.moreLinksLabel", { count: hidden })}</span>
        </span>
      ) : null}
    </div>
  );
}
