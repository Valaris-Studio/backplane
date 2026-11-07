// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { ContextLink } from "@/components/shared/ContextLink";
import { EntityLink } from "@/components/shared/EntityLink";
import { buildEntityLink } from "@/lib/entity-link";
import { formatDateTime } from "@/lib/format";
import type { OwnerSession } from "@/types/owner-session";
import { SessionStateBadge } from "./SessionStateBadge";
import { WithheldTitleGlyph } from "./SessionTitle";

export function OwnerSessionRow({ session }: { session: OwnerSession }) {
  const { t } = useTranslation();
  const title = session.title || (session.coverage === "usage_only"
    ? t("sessions.row.usageOnlyTitle", { agent: session.harness_display_name })
    : t("sessions.row.titleWithheldNoFolder"));
  const href = buildEntityLink({ type: "session", slug: session.workspace_slug, id: session.id })!.href;
  const lastActivity = formatDateTime(session.last_event_at, { dateStyle: "medium", timeStyle: "short" });
  const linkClass = "rounded-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <li id={`owner-session-${session.id}`} data-return-anchor className="grid min-w-0 gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,0.6fr)] lg:grid-cols-[minmax(0,1.3fr)_minmax(10rem,0.7fr)_minmax(10rem,0.7fr)]">
      <div className="min-w-0 space-y-1.5">
        <ContextLink id={`owner-session-link-${session.id}`} to={href} className="flex min-w-0 items-start gap-1.5 rounded-sm text-sm font-medium leading-5 text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {!session.title && session.coverage !== "usage_only" ? <WithheldTitleGlyph /> : null}
          <span className="line-clamp-2 break-words">{title}</span>
        </ContextLink>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{session.harness_display_name}</span>
          <SessionStateBadge session={{ ...session, coverage: session.coverage ?? "empty" }} />
          {session.child_count > 0 ? <span>{t("sessions.discovery.subagents", { count: session.child_count })}</span> : null}
        </div>
        <time dateTime={session.last_event_at} className="block text-xs text-muted-foreground">{t("sessions.discovery.lastActivity", { time: lastActivity })}</time>
      </div>
      <div className="flex min-w-0 flex-col items-start gap-1 text-xs leading-5">
        <EntityLink type="workspace" slug={session.workspace_slug} className={linkClass}>{session.workspace_name}</EntityLink>
        {session.board_id && session.board_name ? <EntityLink type="board" slug={session.workspace_slug} id={session.board_id} className={linkClass}>{session.board_name}</EntityLink> : null}
        {session.repository ? <span className="max-w-full truncate text-muted-foreground" title={session.repository}>{session.repository}</span> : null}
        {session.branch ? <span className="max-w-full truncate text-muted-foreground" title={session.branch}>{session.branch}</span> : null}
      </div>
      {session.link_preview.length ? (
        <div className="flex min-w-0 flex-col items-start gap-1 text-xs leading-5 sm:col-span-2 lg:col-span-1">
          {session.link_preview.map((link) => (
            <EntityLink key={`${link.entity_type}-${link.entity_id}`} type={link.entity_type} id={link.entity_id} slug={link.workspace_slug} boardId={link.board_id ?? undefined} className={`${linkClass} line-clamp-2 break-words`}>
              {link.title}
            </EntityLink>
          ))}
          {session.link_count > session.link_preview.length ? <ContextLink to={href} className={linkClass}>{t("sessions.discovery.moreWork", { count: session.link_count - session.link_preview.length })}</ContextLink> : null}
        </div>
      ) : null}
    </li>
  );
}
