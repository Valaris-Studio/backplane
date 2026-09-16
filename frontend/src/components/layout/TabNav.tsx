// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { RichTooltip } from "@/components/ui/rich-tooltip";

interface Tab {
  label: string;
  path: string;
  icon: LucideIcon;
  disabled?: boolean;
  /**
   * Optional `ui.tooltips.<key>` lookup for a RichTooltip wrapping this tab.
   * When set, the tab anchor is wrapped; indicator math uses bounding-rects
   * instead of offsetParent so the extra wrapper doesn't skew the slider.
   */
  tooltipKey?: string;
}

interface TabNavProps {
  tabs: Tab[];
  basePath: string;
}

export function TabNav({ tabs, basePath }: TabNavProps) {
  const location = useLocation();
  const itemRefs = useRef<Record<string, HTMLAnchorElement | null>>({});
  const listRef = useRef<HTMLDivElement | null>(null);
  const [indicator, setIndicator] = useState({
    width: 0,
    height: 0,
    left: 0,
    top: 0,
    opacity: 0,
  });

  const activePath = useMemo(
    () =>
      tabs.find((tab) => location.pathname.startsWith(`${basePath}/${tab.path}`))
        ?.path,
    [basePath, location.pathname, tabs],
  );

  // Use bounding-rects relative to the list container so the indicator stays
  // correct even when tabs are wrapped by intermediate elements (e.g. a
  // RichTooltip trigger div) that would break offsetParent-based math.
  function measure(activeElement: HTMLAnchorElement) {
    const container = listRef.current;
    if (!container) return null;
    const itemRect = activeElement.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    return {
      width: itemRect.width,
      height: itemRect.height,
      left: itemRect.left - containerRect.left,
      top: itemRect.top - containerRect.top,
      opacity: 1,
    };
  }

  useEffect(() => {
    if (!activePath) {
      setIndicator((current) => ({ ...current, opacity: 0 }));
      return;
    }

    const activeElement = itemRefs.current[activePath];
    if (!activeElement) return;

    const next = measure(activeElement);
    if (next) setIndicator(next);
  }, [activePath, tabs]);

  useEffect(() => {
    function handleResize() {
      if (!activePath) return;
      const activeElement = itemRefs.current[activePath];
      if (!activeElement) return;

      const next = measure(activeElement);
      if (next) setIndicator(next);
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [activePath]);

  return (
    <nav className="rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.1rem))] border border-border/70 bg-[color:var(--color-surface-1)] p-1 shadow-soft">
      <div
        ref={listRef}
        className="relative flex gap-1 overflow-x-auto"
      >
        <div
          className="absolute z-0 rounded-[min(var(--radius-cap),calc(var(--radius-lg)-0.1rem))] border border-[color:color-mix(in_oklab,var(--color-primary)_28%,transparent)] bg-[color:color-mix(in_oklab,var(--color-primary)_16%,transparent)] shadow-sm transition-[transform,width,height,opacity] duration-300 ease-[cubic-bezier(0.3,1.4,0.4,1)] motion-reduce:transition-none"
          style={{
            opacity: indicator.opacity,
            width: indicator.width,
            height: indicator.height,
            transform: `translate(${indicator.left}px, ${indicator.top}px)`,
          }}
        />
        {tabs.map((tab) => {
          const href = `${basePath}/${tab.path}`;
          const isActive = location.pathname.startsWith(href);

          if (tab.disabled) {
            const disabled = (
              <span
                className="relative z-10 flex cursor-not-allowed items-center gap-2 rounded-[min(var(--radius-cap),calc(var(--radius-lg)-0.1rem))] px-3 py-2 text-sm font-medium text-muted-foreground/45"
              >
                <tab.icon className="h-4 w-4" />
                {tab.label}
              </span>
            );
            return tab.tooltipKey ? (
              <RichTooltip key={tab.path} i18nKey={tab.tooltipKey} side="bottom">
                {disabled}
              </RichTooltip>
            ) : (
              <span key={tab.path}>{disabled}</span>
            );
          }

          const link = (
            <Link
              to={href}
              ref={(node) => {
                itemRefs.current[tab.path] = node;
              }}
              className={cn(
                "relative z-10 flex items-center gap-2 rounded-[min(var(--radius-cap),calc(var(--radius-lg)-0.1rem))] px-3 py-2 text-sm font-medium transition-colors duration-200",
                isActive
                  ? "text-foreground"
                  : "text-muted-foreground hover:bg-card/50 hover:text-foreground",
              )}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
            </Link>
          );

          return tab.tooltipKey ? (
            <RichTooltip key={tab.path} i18nKey={tab.tooltipKey} side="bottom">
              {link}
            </RichTooltip>
          ) : (
            <span key={tab.path}>{link}</span>
          );
        })}
      </div>
    </nav>
  );
}
