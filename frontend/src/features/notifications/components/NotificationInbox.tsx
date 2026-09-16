// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BellOff, CheckCheck, Loader2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { EmptyState } from "@/components/layout/EmptyState";
import { cn } from "@/lib/utils";
import { scaleIn, staggerChildren } from "@/lib/animations";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import {
  useMarkAllRead,
  useMarkRead,
  useNotificationInbox,
  useUnreadCount,
} from "../api/use-notifications";
import { NotificationItem } from "./NotificationItem";

interface NotificationInboxProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The current route's workspace slug; the inbox defaults to it. */
  currentSlug?: string;
}

type ScopeTab = "workspace" | "all";

export function NotificationInbox({
  open,
  onOpenChange,
  currentSlug,
}: NotificationInboxProps) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const [scope, setScope] = useState<ScopeTab>("workspace");

  // "This workspace" passes the slug; "All workspaces" passes undefined (the
  // rollup). When there's no current workspace, only the rollup makes sense.
  const slug = scope === "workspace" ? currentSlug : undefined;
  const effectiveScope: ScopeTab = currentSlug ? scope : "all";

  const {
    data,
    isLoading,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useNotificationInbox(effectiveScope === "workspace" ? currentSlug : undefined);
  const unreadCount = useUnreadCount(slug).data ?? 0;
  const markRead = useMarkRead(slug);
  const markAllRead = useMarkAllRead(slug);

  const notifications = data?.pages.flat();
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const handleIntersect = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
        fetchNextPage();
      }
    },
    [hasNextPage, isFetchingNextPage, fetchNextPage],
  );

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(handleIntersect, {
      rootMargin: "120px",
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [handleIntersect, open]);

  // Calm staggered fade-in on the list — dense and quick, the "wow" lives in
  // the bell badge, not here. Re-runs when the row count changes (new arrivals).
  useEffect(() => {
    if (!open || isLoading || reducedMotion) return;
    const tween = staggerChildren(listRef.current, "[data-stagger-item]", scaleIn, {
      stagger: 0.025,
      duration: 0.16,
      offset: 6,
      maxStaggered: 12,
    });
    // progress(1) BEFORE kill: the entrance starts rows at autoAlpha 0, so a
    // bare mid-flight kill strands them invisible.
    return () => {
      tween?.progress(1).kill();
    };
  }, [open, isLoading, reducedMotion, notifications?.length, effectiveScope]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[min(26rem,calc(100vw-2rem))] gap-3 p-0"
        aria-label={t("notifications.title")}
      >
        <SheetHeader className="space-y-3 px-5 pt-6 text-left">
          <div className="flex items-center justify-between gap-2 pr-9">
            <SheetTitle className="text-xl">{t("notifications.title")}</SheetTitle>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 px-2 text-xs text-muted-foreground"
              disabled={unreadCount === 0 || markAllRead.isPending}
              onClick={() => markAllRead.mutate()}
            >
              <CheckCheck className="h-3.5 w-3.5" />
              {t("notifications.markAllRead")}
            </Button>
          </div>

          {currentSlug ? (
            <div
              role="tablist"
              aria-label={t("notifications.scopeAria")}
              className="inline-flex w-full gap-1 rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.05rem))] bg-[color:var(--color-surface-2)] p-1"
            >
              <ScopeTabButton
                active={effectiveScope === "workspace"}
                onClick={() => setScope("workspace")}
              >
                {t("notifications.tabWorkspace")}
              </ScopeTabButton>
              <ScopeTabButton
                active={effectiveScope === "all"}
                onClick={() => setScope("all")}
              >
                {t("notifications.tabAll")}
              </ScopeTabButton>
            </div>
          ) : null}
        </SheetHeader>

        <Separator />

        <ScrollArea className="flex-1 px-2 pb-4">
          {isLoading ? (
            <div className="space-y-2 px-1 pt-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex gap-3 px-2 py-3">
                  <Skeleton className="h-8 w-8 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : !notifications?.length ? (
            <div className="px-2 pt-6">
              <EmptyState
                icon={BellOff}
                title={t("notifications.emptyTitle")}
                description={t("notifications.emptyBody")}
              />
            </div>
          ) : (
            <div ref={listRef} className="space-y-1 px-1 pt-2">
              {notifications.map((notification) => (
                <NotificationItem
                  key={notification.id}
                  notification={notification}
                  slug={notification.link?.workspace_slug ?? slug}
                  onMarkRead={(id) => markRead.mutate(id)}
                  onNavigate={() => onOpenChange(false)}
                />
              ))}
              <div ref={sentinelRef} className="h-1" />
              {isFetchingNextPage ? (
                <div className="flex justify-center py-3">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : null}
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

function ScopeTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex-1 rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.15rem))] px-3 py-1.5 text-xs font-semibold transition-colors",
        active
          ? "bg-card text-foreground shadow-soft"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
