// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { Building2, ChevronDown, Clock, FolderGit2, GitBranch, GitFork, Kanban, Link2, type LucideIcon } from "lucide-react";
import { ContextLink } from "@/components/shared/ContextLink";
import { EntityLink } from "@/components/shared/EntityLink";
import { Marquee } from "@/components/ui/marquee";
import { formatAbsolute, formatRelative } from "@/lib/date-format";
import { buildEntityLink } from "@/lib/entity-link";
import { cn } from "@/lib/utils";
import { useReturnNavigation } from "@/providers/ReturnNavigationProvider";
import type { OwnerSession } from "@/types/owner-session";
import { AgentMark } from "./AgentMark";
import { SessionStateBadge } from "./SessionStateBadge";
import { WithheldTitleGlyph } from "./SessionTitle";

// Hue marks the kind of information; mixing in the foreground keeps the icon
// legible on both themes while the words beside it stay plain ink.
function accent(token: string) {
  return { color: `color-mix(in oklab, var(${token}) 70%, var(--color-foreground))` };
}

const linkClass = "rounded-sm underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function Place({ icon: Icon, children, compact = false }: { icon: LucideIcon; children: ReactNode; compact?: boolean }) {
  return <><Icon aria-hidden className="size-3.5 shrink-0" style={accent("--color-info")} /><span className={cn("truncate", compact && "max-sm:sr-only")}>{children}</span></>;
}

export function OwnerSessionCompactRow({ session }: { session: OwnerSession }) {
  const { t } = useTranslation();
  const navigation = useReturnNavigation();
  const { key: entryKey } = useLocation();
  const disclosureKey = `owner-session-links:${session.id}`;
  const [disclosure, setDisclosure] = useState(() => ({
    entryKey, open: navigation?.readView<boolean>(disclosureKey) ?? false,
  }));
  const linksOpen = disclosure.entryKey === entryKey ? disclosure.open
    : navigation?.readView<boolean>(disclosureKey) ?? false;
  const linksId = useId();
  const title = session.title || (session.coverage === "usage_only"
    ? t("sessions.row.usageOnlyTitle", { agent: session.harness_display_name })
    : t("sessions.row.titleWithheldNoFolder"));
  const href = buildEntityLink({ type: "session", slug: session.workspace_slug, id: session.id })!.href;
  const lastActivity = t("sessions.discovery.lastActivity", { time: formatAbsolute(session.last_event_at) });
  const linkedItems = t("sessions.discovery.linkedItems", { count: session.link_count });
  const placeClass = "inline-flex min-h-6 min-w-6 max-w-[12rem] items-center gap-1";
  const searchHref = (query: string) => `/-/sessions?${new URLSearchParams({ q: query })}`;

  return (
    <li id={`owner-session-${session.id}`} data-return-anchor className="min-w-0 space-y-1 px-3 py-2">
      <div className="flex min-w-0 items-center gap-x-3">
        <ContextLink id={`owner-session-link-${session.id}`} to={href} className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {!session.title && session.coverage !== "usage_only" ? <WithheldTitleGlyph /> : null}
          <Marquee text={title} className="min-w-0 flex-1" textClassName="text-sm font-medium leading-5" />
        </ContextLink>
        <div className="flex min-w-0 max-w-[60%] items-center gap-x-2.5 text-xs leading-5 text-muted-foreground">
          <EntityLink type="workspace" slug={session.workspace_slug} className={cn(placeClass, linkClass)}>
            <Place icon={Building2}>{session.workspace_name}</Place>
          </EntityLink>
          {session.board_id && session.board_name ? (
            <EntityLink type="board" slug={session.workspace_slug} id={session.board_id} className={cn(placeClass, linkClass)}>
              <Place icon={Kanban}>{session.board_name}</Place>
            </EntityLink>
          ) : null}
          {session.repository ? <ContextLink to={searchHref(session.repository)} className={cn(placeClass, linkClass, "max-sm:shrink-0 max-sm:justify-center")} title={t("sessions.discovery.searchRelated", { query: session.repository })}><Place icon={FolderGit2} compact>{session.repository}</Place></ContextLink> : null}
          {session.branch ? <ContextLink to={searchHref(session.branch)} className={cn(placeClass, linkClass, "max-sm:shrink-0 max-sm:justify-center")} title={t("sessions.discovery.searchRelated", { query: session.branch })}><Place icon={GitBranch} compact>{session.branch}</Place></ContextLink> : null}
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-x-3 text-xs leading-5 text-muted-foreground">
        <AgentMark harness={session.harness} displayName={session.harness_display_name} className="size-5 text-[0.6rem]" />
        <SessionStateBadge session={{ ...session, coverage: session.coverage ?? "empty" }} />
        {session.child_count > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1">
            <GitFork aria-hidden className="size-3.5" style={accent("--color-data-5")} />
            <span className="max-sm:sr-only">{t("sessions.discovery.subagents", { count: session.child_count })}</span>
            <span aria-hidden className="tabular-nums sm:hidden">{session.child_count}</span>
          </span>
        ) : null}
        <time dateTime={session.last_event_at} title={lastActivity} className="inline-flex min-w-0 items-center gap-1">
          <Clock aria-hidden className="size-3.5 shrink-0" style={accent("--color-info")} />
          <span aria-hidden className="truncate">{formatRelative(session.last_event_at)}</span>
          <span className="sr-only">{lastActivity}</span>
        </time>
        {session.link_preview.length ? (
          <button
            type="button"
            aria-label={linkedItems}
            aria-expanded={linksOpen}
            aria-controls={linksOpen ? linksId : undefined}
            onClick={() => {
              navigation?.writeView(disclosureKey, !linksOpen);
              setDisclosure({ entryKey, open: !linksOpen });
            }}
            className={cn(linkClass, "ml-auto inline-flex min-h-6 shrink-0 items-center gap-1 px-1 font-medium")}
          >
            <Link2 aria-hidden className="size-3.5" style={accent("--color-kind-work")} />
            <span className="max-sm:hidden">{linkedItems}</span>
            <span className="tabular-nums sm:hidden">{session.link_count}</span>
            <ChevronDown aria-hidden className={cn("size-3.5 transition-transform duration-150 motion-reduce:transition-none", linksOpen && "rotate-180")} />
          </button>
        ) : null}
      </div>
      {linksOpen ? (
        <div id={linksId} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-xs leading-5 text-muted-foreground">
          {session.link_preview.map((link) => (
            <EntityLink key={`${link.entity_type}-${link.entity_id}`} type={link.entity_type} id={link.entity_id} slug={link.workspace_slug} boardId={link.board_id ?? undefined} className={cn(linkClass, "max-w-full truncate")}>
              {link.title}
            </EntityLink>
          ))}
          {session.link_count > session.link_preview.length ? <ContextLink to={href} className={linkClass}>{t("sessions.discovery.moreWork", { count: session.link_count - session.link_preview.length })}</ContextLink> : null}
        </div>
      ) : null}
    </li>
  );
}
