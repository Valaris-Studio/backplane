// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Bot, ChevronRight } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/date-format";
import { initials } from "@/features/timeline/utils/humanize";
import type { NotificationRead } from "../api/notifications-api";
import { isUnread, notificationCopy } from "../utils/category-copy";
import { linkToRoute } from "../utils/link-to-route";

interface NotificationItemProps {
  notification: NotificationRead;
  /** The inbox's current workspace scope; the link's own slug still wins. */
  slug?: string;
  onMarkRead: (id: string) => void;
  onNavigate: () => void;
}

export function NotificationItem({
  notification,
  slug,
  onMarkRead,
  onNavigate,
}: NotificationItemProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const unread = isUnread(notification);
  const { title, body } = notificationCopy(notification, t);
  const route = linkToRoute(notification.link, slug);

  const actorName =
    (notification.params.actor_name as string | undefined) ??
    (notification.params.actor_email as string | undefined) ??
    null;

  function activate() {
    if (unread) onMarkRead(notification.id);
    if (route) {
      navigate(route);
      onNavigate();
    }
  }

  return (
    <div
      data-stagger-item
      data-unread={unread || undefined}
      className={cn(
        "group relative flex gap-3 rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.05rem))] border border-transparent px-3 py-3 text-left transition-colors",
        unread
          ? "bg-[color:color-mix(in_oklab,var(--color-primary)_6%,var(--color-card))] hover:border-border/60"
          : "opacity-70 hover:bg-accent/40 hover:opacity-100",
      )}
    >
      {/* Unread dot — read rows reserve the same column so titles stay aligned. */}
      <span
        aria-hidden
        className={cn(
          "mt-2 h-2 w-2 shrink-0 rounded-full",
          unread ? "bg-primary" : "bg-transparent",
        )}
      />

      <Avatar className="h-8 w-8">
        <AvatarFallback className="text-[0.62rem]">
          {notification.is_agent_actor ? (
            <Bot className="h-3.5 w-3.5" />
          ) : actorName ? (
            initials(actorName)
          ) : (
            "•"
          )}
        </AvatarFallback>
      </Avatar>

      <button
        type="button"
        onClick={activate}
        className="min-w-0 flex-1 space-y-0.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      >
        <div className="flex items-baseline justify-between gap-2">
          <p
            className={cn(
              "truncate text-sm",
              unread ? "font-semibold text-foreground" : "text-foreground/90",
            )}
          >
            {title}
          </p>
          <span className="shrink-0 text-[0.68rem] uppercase tracking-[0.12em] text-muted-foreground">
            {formatRelative(notification.created_at)}
          </span>
        </div>
        {body ? (
          <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
            {body}
          </p>
        ) : null}
        {route ? (
          <span className="mt-1 inline-flex items-center gap-0.5 text-xs font-medium text-primary">
            {t("notifications.open")}
            <ChevronRight className="h-3 w-3" />
          </span>
        ) : null}
      </button>

      {unread ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 self-start px-2 text-xs text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
          onClick={() => onMarkRead(notification.id)}
        >
          {t("notifications.markRead")}
        </Button>
      ) : null}
    </div>
  );
}
