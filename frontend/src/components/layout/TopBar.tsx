// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  ChevronRight,
  Ellipsis,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { AccountMenu } from "@/components/layout/AccountMenu";
import { ConnectionStatusIndicator } from "@/components/layout/ConnectionStatusIndicator";
import { NotificationBell } from "@/features/notifications";
import { useResolvedWorkspaceSlug } from "@/features/workspaces/hooks/use-workspace-resolved";
import { ObserverPanel } from "@/features/observer";
import { Button, buttonVariants } from "@/components/ui/button";
import { boardKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import type { BoardDetail } from "@/types/kanban";

interface TopBarProps {
  isMobile: boolean;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

function formatSegment(segment: string) {
  return decodeURIComponent(segment).replace(/-/g, " ");
}

// Static route segments carry product vocabulary, so they need the same
// translations the tabs and sidebar already use — a breadcrumb reading
// "Overview" under a tab reading "Resumen" is the bug this map fixes.
// Only segments listed here are localized; anything else (workspace slugs,
// board ids, execution uuids) is user data and passes through verbatim.
const ROUTE_SEGMENT_LABEL_KEYS: Record<string, string> = {
  boards: "nav.boards",
  notes: "nav.notes",
  resources: "nav.resources",
  channels: "nav.channels",
  members: "nav.members",
  approvals: "nav.approvals",
  history: "nav.history",
  documentation: "nav.documentation",
  settings: "nav.settings",
  "merge-queue": "nav.mergeQueue",
  runner: "nav.agents",
  overview: "runnerTabs.overview",
  pipeline: "runnerTabs.pipeline",
  roles: "runnerTabs.roles",
  prompts: "runnerTabs.prompts",
  runners: "runnerTabs.runners",
  teams: "runnerTabs.teams",
  activity: "runnerTabs.activity",
};

export function TopBar({
  isMobile,
  sidebarCollapsed,
  onToggleSidebar,
}: TopBarProps) {
  const { slug: routeSlug, boardId } = useParams();
  // Breadcrumbs read the ROUTE slug (they label the URL even when it is
  // wrong); the workspace-scoped widgets read the RESOLVED one, so a bad
  // slug costs no badge traffic.
  const resolvedSlug = useResolvedWorkspaceSlug(routeSlug);
  const slug = routeSlug ?? "default";
  const location = useLocation();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const mobileToolsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (mobileToolsRef.current) mobileToolsRef.current.open = false;
  }, [location.pathname]);

  const boardName = boardId
    ? queryClient.getQueryData<BoardDetail>(boardKeys.detail(slug, boardId))?.name
    : undefined;

  const segments = location.pathname.split("/").filter(Boolean);
  const crumbs = segments.map((segment, index) => {
    const labelKey = index > 0 ? ROUTE_SEGMENT_LABEL_KEYS[segment] : undefined;
    const label =
      segment === boardId && boardName
        ? boardName
        : labelKey
          ? t(labelKey)
          : formatSegment(segment);
    return { label, path: "/" + segments.slice(0, index + 1).join("/") };
  });

  // Compact the bar once the user has scrolled past the initial landing.
  //
  // Two anti-flicker mechanisms layered together:
  //
  // 1. Wide hysteresis (enter >40, exit <4). The compact↔full transition
  //    swings header height ~32px (pt-4→0 plus h-3.5rem→2.5rem). Without
  //    a wide gap, natural trackpad oscillation near the threshold or the
  //    height change itself bounces scrollY back across a single threshold.
  //
  // 2. Cooldown lockout. After any state flip we ignore further scroll
  //    events for the duration of the CSS transition (200 ms) PLUS a small
  //    settle margin. This prevents a true scroll-position oscillation
  //    around the boundary from triggering a ping-pong loop while the
  //    height/padding transitions are still settling.
  const ENTER_AT = 40;
  const EXIT_AT = 4;
  const COOLDOWN_MS = 260;
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    let frame = 0;
    let lockedUntil = 0;
    const tick = () => {
      frame = 0;
      if (Date.now() < lockedUntil) return;
      const y = window.scrollY;
      setScrolled((prev) => {
        const next = prev ? y >= EXIT_AT : y > ENTER_AT;
        if (next !== prev) lockedUntil = Date.now() + COOLDOWN_MS;
        return next;
      });
    };
    const onScroll = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(tick);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);

  const utilities = (
    <>
      <ThemeSwitcher />
      {resolvedSlug ? <ObserverPanel slug={resolvedSlug} /> : null}
      <NotificationBell slug={resolvedSlug} />
      <ConnectionStatusIndicator />
      <Link
        to={`/${slug}/documentation`}
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-2")}
        aria-label={t("nav.documentation")}
      >
        <BookOpen className="h-4 w-4" />
        <span className={isMobile ? undefined : "hidden xl:inline"}>{t("nav.docs")}</span>
      </Link>
      <LanguageSwitcher />
    </>
  );

  return (
    <header
      className={cn(
        // No top padding at rest: the bar aligns with the top edge of the
        // floating sidebar (both sit at the shell's md:p-4 gutter, 1rem from
        // the viewport). The sidebar fills the gutter with no extra offset, so
        // the TopBar must not add one either — a `pt-4` here left the bar
        // sitting 1rem lower than the menu whenever the page could scroll.
        "sticky top-0 z-20 px-[var(--page-gutter)]",
      )}
    >
      <div
        className={cn(
          "mx-auto flex max-w-[var(--page-shell-max)] items-center gap-3 border border-border/70 bg-background/85 shadow-soft backdrop-blur-xl transition-[height,padding,border-radius,background-color] duration-200",
          scrolled
            ? "h-10 rounded-none rounded-b-[var(--radius-lg)] border-t-0 px-3 bg-background/92"
            : "h-[var(--topbar-height)] rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))] px-4",
          isMobile && "gap-1 px-2",
        )}
      >
        <Button
          variant="ghost"
          size="icon"
          className={cn("shrink-0", scrolled && "h-7 w-7")}
          onClick={onToggleSidebar}
          aria-label={t("a11y.topbar.toggleSidebar")}
        >
          {isMobile || sidebarCollapsed ? (
            <PanelLeftOpen className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </Button>

        {/* The trail SCROLLS, it never wraps. A multi-word localized root
            crumb ("Espacios de trabajo") wrapped to three lines and blew the
            bar's fixed height open on a 390px viewport. Two rules keep it on
            one line: `flex-nowrap` + `shrink-0` on every crumb make the row
            wider than its box rather than reflowing it, and `min-w-0` on the
            nav lets that overwide row be clipped instead of pushing the whole
            header past the viewport. */}
        <nav
          aria-label={t("a11y.topbar.breadcrumb")}
          className="min-w-0 flex-1 overflow-hidden"
        >
          <div
            key={location.pathname}
            className={cn(
              "no-scrollbar flex flex-nowrap items-center gap-1.5 overflow-x-auto text-muted-foreground",
              scrolled ? "text-xs" : "text-sm",
            )}
          >
            <Link
              to="/"
              className="shrink-0 whitespace-nowrap rounded-full px-2 py-1 font-medium transition-colors hover:text-foreground"
            >
              {t("nav.workspaces")}
            </Link>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
            <Link
              to={`/${slug}`}
              className="shrink-0 whitespace-nowrap rounded-full px-2 py-1 font-medium capitalize transition-colors hover:text-foreground"
            >
              {formatSegment(slug)}
            </Link>
            {crumbs.slice(1).map((crumb, index) => (
              <span
                key={crumb.path}
                className="flex shrink-0 items-center gap-1.5 whitespace-nowrap"
              >
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                <Link
                  to={crumb.path}
                  className={cn(
                    "rounded-full px-2 py-1 capitalize transition-colors hover:text-foreground",
                    index === crumbs.slice(1).length - 1 && "text-foreground",
                  )}
                >
                  {crumb.label}
                </Link>
              </span>
            ))}
          </div>
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          {isMobile ? (
            <details
              ref={mobileToolsRef}
              className="relative"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.currentTarget.open = false;
                  event.currentTarget.querySelector("summary")?.focus();
                }
              }}
            >
              <summary
                aria-label={t("a11y.topbar.moreControls")}
                className={cn(
                  buttonVariants({ variant: "ghost", size: "icon" }),
                  "cursor-pointer list-none [&::-webkit-details-marker]:hidden",
                )}
              >
                <Ellipsis className="h-4 w-4" />
              </summary>
              <div className="absolute right-0 top-full z-30 mt-2 flex w-56 max-w-[calc(100vw-2rem)] flex-wrap items-center gap-2 rounded-lg border bg-popover p-3 shadow-panel">
                {utilities}
              </div>
            </details>
          ) : utilities}
          <AccountMenu />
        </div>
      </div>
    </header>
  );
}
