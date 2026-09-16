// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Suspense, useMemo, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { ChevronDown, Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/hooks/use-media-query";
import { PageHeader } from "@/components/layout/PageHeader";
import { RouteFallback } from "@/components/layout/RouteFallback";
import { TocSidebar } from "@/pages/documentation/shell/TocSidebar";
import { useDocumentationCopy } from "@/pages/documentation/use-documentation-copy";
import { useDocsBasePath } from "@/pages/documentation/use-docs-base-path";

const DESKTOP_BREAKPOINT = "(min-width: 1024px)";

export function DocumentationPage() {
  const isDesktop = useMediaQuery(DESKTOP_BREAKPOINT);
  const [mobileOpen, setMobileOpen] = useState(false);
  const basePath = useDocsBasePath();
  const { copy } = useDocumentationCopy();
  const { pathname } = useLocation();

  const currentSlug = useMemo(() => {
    if (pathname === basePath || pathname === `${basePath}/`) return undefined;
    const remainder = pathname.replace(`${basePath}/`, "");
    return remainder.split("/")[0] || undefined;
  }, [basePath, pathname]);

  return (
    <div className="space-y-[var(--page-section-gap)]">
      <PageHeader
        eyebrow={copy.shell.eyebrow}
        title={copy.shell.title}
        description={copy.shell.description}
      />

      <div
        className={cn(
          "flex gap-8",
          isDesktop ? "flex-row" : "flex-col",
        )}
      >
        {isDesktop ? (
          <aside
            className="w-[260px] shrink-0"
            aria-label={copy.shell.tableOfContentsAriaLabel}
          >
            <div
              data-toc-scroll
              className={cn(
                "sticky top-[calc(var(--topbar-height)+1rem)] max-h-[calc(100vh-var(--topbar-height)-2rem)] overflow-y-auto rounded-[var(--radius-lg)] border border-border/70 bg-[color:var(--color-surface-1)]/80 p-4 shadow-soft",
                "scroll-fade-bottom",
              )}
            >
              <TocSidebar currentSlug={currentSlug} />
            </div>
          </aside>
        ) : (
          <MobileTocDropdown
            currentSlug={currentSlug}
            tableOfContentsLabel={copy.shell.tableOfContents}
            open={mobileOpen}
            onToggle={() => setMobileOpen((prev) => !prev)}
            onNavigate={() => setMobileOpen(false)}
          />
        )}

        <main className="min-w-0 flex-1">
          <Suspense fallback={<RouteFallback />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}

interface MobileTocDropdownProps {
  currentSlug?: string;
  tableOfContentsLabel: string;
  open: boolean;
  onToggle: () => void;
  onNavigate: () => void;
}

function MobileTocDropdown({
  currentSlug,
  tableOfContentsLabel,
  open,
  onToggle,
  onNavigate,
}: MobileTocDropdownProps) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-border/70 bg-[color:var(--color-surface-1)]/85 shadow-soft">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-sm font-semibold text-foreground"
      >
        <span className="flex items-center gap-2">
          <Menu className="h-4 w-4" aria-hidden />
          {tableOfContentsLabel}
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      {open ? (
        <div
          data-toc-scroll
          className="scroll-fade-bottom max-h-[70vh] overflow-y-auto border-t border-border/60 px-4 py-4"
        >
          <TocSidebar currentSlug={currentSlug} onNavigate={onNavigate} />
        </div>
      ) : null}
    </div>
  );
}
