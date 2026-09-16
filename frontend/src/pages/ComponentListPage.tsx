// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Intentional English-only scope — this is an internal dev sandbox page.
// When the first component lifts out of /component-list into production UI,
// we add i18n keys for it. Until then literal English is fine.
// See docs/plans/phase3-component-list-page.md §2 and §9.

import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useWorkspaceAdmin } from "@/hooks/useWorkspaceAdmin";
import { ShowcaseCard } from "./component-list/ShowcaseCard";
import { PLACEHOLDER_COMPONENTS } from "./component-list/components/placeholders";

function LoadingState() {
  return (
    <div className="space-y-[var(--page-section-gap)]">
      <Skeleton className="h-32 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.3rem))]" />
      <Skeleton className="h-72 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />
    </div>
  );
}

function AdminFallback({ slug }: { slug: string }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="flex max-w-md flex-col items-center gap-4 rounded-[var(--radius-lg)] border border-border bg-[color:var(--color-surface-1)] p-8 text-center shadow-soft">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <ShieldAlert className="h-6 w-6 text-muted-foreground" aria-hidden />
        </div>
        <div className="space-y-2">
          <h2 className="text-lg font-semibold text-foreground">
            Admin access required
          </h2>
          <p className="text-sm leading-6 text-muted-foreground">
            The component list is an internal sandbox for experimental UI.
            It's visible to workspace admins only — not because it's secret,
            but because it's not production yet and would be confusing as a
            first touchpoint.
          </p>
        </div>
        <Link
          to={`/${slug}/boards`}
          className={cn(buttonVariants({ variant: "outline" }))}
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to boards
        </Link>
      </div>
    </div>
  );
}

export function ComponentListPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const { isAdmin, isLoading } = useWorkspaceAdmin(slug);

  if (isLoading) {
    return <LoadingState />;
  }

  if (!isAdmin) {
    return <AdminFallback slug={slug} />;
  }

  return (
    <div className="space-y-[var(--page-section-gap)]">
      <PageHeader
        title="Component List"
        description="A sandbox for animated components that explain what the platform does."
        eyebrow="Internal / Experimental"
        actions={<Badge variant="warning">Internal / Experimental</Badge>}
      />

      <section
        className="rounded-[var(--radius-lg)] border border-border/70 bg-[color:var(--color-surface-1)] p-[var(--card-padding)] shadow-soft"
        aria-label="About this page"
      >
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          This page is a sandbox for animated and interactive components that
          explain what the platform actually does. Each slot below is a
          component we intend to build, described in enough detail that
          future-us (or a future sub-agent) can implement it without guessing.
          Nothing here is production UI yet. If you're an operator who landed
          here by typing URLs you weren't given, you've found the right page —
          just not one that does anything yet.
        </p>
      </section>

      <div className="flex flex-col gap-[var(--page-section-gap)] lg:flex-row lg:items-start">
        <nav
          aria-label="Component list table of contents"
          className="lg:sticky lg:top-[calc(var(--topbar-height)+1rem)] lg:w-60 lg:shrink-0"
        >
          <div className="rounded-[var(--radius-lg)] border border-border bg-[color:var(--color-surface-1)] p-4 shadow-soft">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Components
            </p>
            <ol className="space-y-1.5">
              {PLACEHOLDER_COMPONENTS.map((component, idx) => (
                <li key={component.id}>
                  <a
                    href={`#${component.id}`}
                    className="block truncate text-sm text-foreground/80 transition-colors hover:text-primary"
                  >
                    <span className="mr-2 tabular-nums text-muted-foreground">
                      {String(idx + 1).padStart(2, "0")}
                    </span>
                    {component.name}
                  </a>
                </li>
              ))}
            </ol>
          </div>
        </nav>

        <div className="flex-1 space-y-[var(--page-section-gap)]">
          {PLACEHOLDER_COMPONENTS.map((component) => (
            <ShowcaseCard
              key={component.id}
              id={component.id}
              name={component.name}
              concept={component.concept}
              interaction={component.interaction}
              technicalNotes={component.technicalNotes}
              whyItMatters={component.whyItMatters}
              caption={component.caption}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
