// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowLeftRight,
  Bot,
  Clock,
  FolderOpen,
  GraduationCap,
  Kanban,
  LayoutDashboard,
  MessageSquare,
  Settings,
  ShieldCheck,
  GitMerge,
  StickyNote,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ApprovalBadge } from "@/features/approvals/components/ApprovalBadge";
import { useResolvedWorkspaceSlug } from "@/features/workspaces/hooks/use-workspace-resolved";
import { BrandLogo } from "@/components/brand/BrandLogo";

const navItems = [
  { label: "nav.dashboard", icon: LayoutDashboard, path: "" },
  { label: "nav.boards", icon: Kanban, path: "/boards" },
  { label: "nav.notes", icon: StickyNote, path: "/notes" },
  { label: "nav.resources", icon: FolderOpen, path: "/resources" },
  { label: "nav.skills", icon: GraduationCap, path: "/skills" },
  { label: "nav.channels", icon: MessageSquare, path: "/channels" },
  { label: "nav.members", icon: Users, path: "/members" },
  { label: "nav.approvals", icon: ShieldCheck, path: "/approvals" },
  { label: "nav.mergeQueue", icon: GitMerge, path: "/merge-queue" },
  { label: "nav.agents", icon: Bot, path: "/runner" },
  { label: "nav.history", icon: Clock, path: "/history" },
];

interface SidebarProps {
  collapsed: boolean;
  isMobile: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

interface IndicatorStyle {
  opacity: number;
  top: number;
  height: number;
}

export function Sidebar({
  collapsed,
  isMobile,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const { slug = "" } = useParams();
  // Nav hrefs use the ROUTE slug (links must work on the not-found screen);
  // the badge uses the RESOLVED one, so it never queries a workspace the
  // gate has not confirmed exists.
  const resolvedSlug = useResolvedWorkspaceSlug(slug);
  const location = useLocation();
  const { t } = useTranslation();
  const itemRefs = useRef<Record<string, HTMLAnchorElement | null>>({});
  const [indicator, setIndicator] = useState<IndicatorStyle>({
    opacity: 0,
    top: 0,
    height: 0,
  });

  const activeKey = useMemo(
    () =>
      navItems.find((item) => {
        const href = `/${slug}${item.path}`;
        return (
          location.pathname === href ||
          (item.path !== "" && location.pathname.startsWith(href))
        );
      })?.label,
    [location.pathname, slug],
  );

  useEffect(() => {
    if (!activeKey) {
      setIndicator((current) => ({ ...current, opacity: 0 }));
      return;
    }

    const activeElement = itemRefs.current[activeKey];
    if (!activeElement) return;

    setIndicator({
      opacity: 1,
      top: activeElement.offsetTop,
      height: activeElement.offsetHeight,
    });
  }, [activeKey, collapsed, isMobile, mobileOpen]);

  useEffect(() => {
    function handleResize() {
      if (!activeKey) return;
      const activeElement = itemRefs.current[activeKey];
      if (!activeElement) return;

      setIndicator({
        opacity: 1,
        top: activeElement.offsetTop,
        height: activeElement.offsetHeight,
      });
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [activeKey]);

  const shellClasses = cn(
    "z-40 flex flex-col overflow-hidden border border-sidebar-border/80 bg-sidebar-background/94 text-sidebar-foreground shadow-panel backdrop-blur-xl transition-[width,transform,opacity] duration-300",
    isMobile
      ? cn(
          "fixed inset-y-0 left-0 h-screen w-[min(19rem,calc(100vw-1.5rem))] rounded-r-[min(var(--radius-cap),calc(var(--radius-xl)+0.4rem))]",
          mobileOpen ? "translate-x-0" : "-translate-x-[110%]",
        )
      : cn(
          "sticky top-4 h-[calc(100vh-2rem)] rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.4rem))]",
          collapsed
            ? "w-[var(--sidebar-collapsed-width)]"
            : "w-[var(--sidebar-width)]",
        ),
  );

  return (
    <>
      {isMobile && mobileOpen ? (
        <button
          type="button"
          aria-label={t("a11y.sidebar.closeMobile")}
          className="fixed inset-0 z-30 bg-background/40 backdrop-blur-sm"
          onClick={onCloseMobile}
        />
      ) : null}
      <aside className={shellClasses}>
        <div className="border-b border-sidebar-border/70 p-2">
          {/* Two affordances for "back to root" depending on rail state:
              - Expanded: the logo itself is the link (button would duplicate it).
              - Collapsed: a compact icon button (the logo can't fit in the rail). */}
          {collapsed && !isMobile ? (
            <Link
              to="/"
              title={t("nav.workspaces")}
              className="mx-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent/85 hover:text-sidebar-foreground"
              onClick={() => isMobile && onCloseMobile()}
            >
              <ArrowLeftRight className="h-4 w-4" />
            </Link>
          ) : (
            <Link
              to="/"
              title={t("nav.workspaces")}
              className="group flex min-w-0 flex-1 items-center gap-2 rounded-[min(var(--radius-cap),calc(var(--radius-lg)+0.15rem))] px-2 py-2 transition-[background-color,transform] duration-200 hover:bg-sidebar-accent/85"
              onClick={() => isMobile && onCloseMobile()}
            >
              <BrandLogo className="h-6 w-auto shrink-0" />
              <span className="truncate text-base font-bold tracking-tight text-sidebar-foreground">
                Backplane
              </span>
            </Link>
          )}
          {!collapsed || isMobile ? (
            <div className="mt-1 px-2">
              <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-sidebar-foreground/55">
                {t("common.workspace")}
              </p>
              <p className="truncate text-sm font-semibold tracking-[-0.02em] text-sidebar-foreground">
                {slug || t("nav.home")}
              </p>
            </div>
          ) : null}
        </div>

        <div className="flex-1 px-1.5 py-3">
          <div className="relative flex h-full flex-col gap-1">
            <div
              className="absolute left-1 right-1 rounded-[min(var(--radius-cap),calc(var(--radius-lg)+0.1rem))] bg-sidebar-accent shadow-[inset_0_1px_0_color-mix(in_oklab,white_14%,transparent)] transition-[transform,height,opacity] duration-300"
              style={{
                opacity: indicator.opacity,
                height: indicator.height,
                transform: `translateY(${indicator.top}px)`,
              }}
            />
            {navItems.map((item) => {
              const href = `/${slug}${item.path}`;
              const isActive =
                location.pathname === href ||
                (item.path !== "" && location.pathname.startsWith(href));

              return (
                <Link
                  key={item.label}
                  to={href}
                  ref={(node) => {
                    itemRefs.current[item.label] = node;
                  }}
                  title={collapsed && !isMobile ? t(item.label) : undefined}
                  className={cn(
                    "relative z-10 flex h-10 items-center gap-3 rounded-[min(var(--radius-cap),calc(var(--radius-lg)+0.1rem))] px-3 text-sm font-medium transition-[color,transform] duration-200",
                    // When collapsed, the label collapses to w-0 but flex `gap`
                    // still reserves space between flex items. That pushes the
                    // icon off-center. Drop the gap AND padding in collapsed
                    // mode so `justify-center` actually centers the icon.
                    collapsed && !isMobile && "justify-center gap-0 px-0",
                    isActive
                      ? "text-sidebar-primary"
                      : "text-sidebar-foreground/78 hover:text-sidebar-accent-foreground",
                  )}
                  onClick={() => isMobile && onCloseMobile()}
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  <span
                    className={cn(
                      "truncate transition-[width,opacity,transform] duration-200",
                      collapsed && !isMobile && "w-0 -translate-x-2 opacity-0",
                    )}
                  >
                    {t(item.label)}
                  </span>
                  {item.label === "nav.approvals" &&
                    !collapsed &&
                    resolvedSlug && (
                      <ApprovalBadge slug={resolvedSlug} />
                    )}
                </Link>
              );
            })}
          </div>
        </div>

        <div className="border-t border-sidebar-border/70 p-2">
          <Link
            to={`/${slug}/settings`}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground",
              location.pathname === `/${slug}/settings` &&
                "bg-sidebar-accent text-sidebar-foreground",
              collapsed && !isMobile && "justify-center gap-0 px-0",
            )}
          >
            <Settings className="h-4 w-4 shrink-0" />
            <span
              className={cn(
                "truncate transition-[width,opacity,transform] duration-200",
                collapsed && !isMobile && "w-0 -translate-x-2 opacity-0",
              )}
            >
              {t("nav.settings")}
            </span>
          </Link>
        </div>
      </aside>
    </>
  );
}
