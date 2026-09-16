// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { RouteFallback } from "./RouteFallback";
import { useMediaQuery } from "@/hooks/use-media-query";
import { fadeInUp } from "@/lib/animations";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { useCostAlerts } from "@/features/alerts/hooks/useCostAlerts";
import { CostAlertBanner } from "@/features/workspaces/components/CostAlertBanner";

// `children` overrides the routed outlet. WorkspaceLayout uses it to swap the
// page body (fallback / not-found / the route) while keeping ONE AppShell
// instance mounted — remounting the shell per state would tear down the
// sidebar and re-run its animations on every workspace resolve. Unset, the
// shell behaves exactly as before: a plain routed layout element.
export function AppShell({ children }: { children?: ReactNode }) {
  const location = useLocation();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const isTablet = useMediaQuery("(max-width: 1023px)");
  const reducedMotion = useReducedMotion();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(isTablet);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);

  useCostAlerts();

  useEffect(() => {
    if (isTablet && !isMobile) {
      setSidebarCollapsed(true);
    }
    if (isMobile) {
      setMobileSidebarOpen(false);
    }
  }, [isMobile, isTablet]);

  useEffect(() => {
    if (reducedMotion) return;
    const tween = fadeInUp(contentRef.current, {
      duration: 0.2,
      offset: 10,
      stagger: 0,
    });
    return () => { tween?.kill(); };
  }, [location.pathname, reducedMotion]);

  function handleSidebarToggle() {
    if (isMobile) {
      setMobileSidebarOpen((open) => !open);
      return;
    }

    setSidebarCollapsed((collapsed) => !collapsed);
  }

  // Gutter starts at md (768px) — the same breakpoint where the sidebar
  // switches to its floating `sticky top-4` branch (isMobile = <768px). The
  // TopBar aligns to this gutter, so the two must appear together; a lg-only
  // gutter left the bar flush to the viewport top on tablet widths while the
  // sidebar was already floating.
  return (
    <div className="relative min-h-screen md:p-4">
      <div className="flex min-h-screen">
        <Sidebar
          collapsed={sidebarCollapsed}
          isMobile={isMobile}
          mobileOpen={mobileSidebarOpen}
          onCloseMobile={() => setMobileSidebarOpen(false)}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            isMobile={isMobile}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={handleSidebarToggle}
          />
          <CostAlertBanner />
          {/* Overflow must stay visible: the shell is window-scrolled (TopBar
              reads window.scrollY), and any non-visible overflow would make
              main the scrollport, detaching every sticky descendant. */}
          <main className="flex-1 px-[var(--page-gutter)] pb-[var(--page-gutter)]">
            <div
              ref={(node) => {
                contentRef.current = node;
              }}
              className="mx-auto flex h-full min-h-0 w-full max-w-[var(--page-shell-max)] flex-col gap-[var(--page-section-gap)] py-4 md:py-5"
            >
              {/* Boundary inside the chrome: navigating between top-level pages
                  suspends HERE so the sidebar/topbar stay put while the next
                  page's chunk loads. */}
              <Suspense fallback={<RouteFallback />}>
                {children ?? <Outlet />}
              </Suspense>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
