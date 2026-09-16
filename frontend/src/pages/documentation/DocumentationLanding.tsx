// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Link } from "react-router-dom";
import { ArrowRight, BookOpen, Compass } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  LANDING_FEATURED_SLUG,
  findSection,
  getDocGroups,
  sectionsByGroup,
} from "./routes";
import { useDocumentationCopy } from "./use-documentation-copy";
import { useDocsBasePath } from "./use-docs-base-path";

export function DocumentationLanding() {
  const basePath = useDocsBasePath();
  const { copy, locale } = useDocumentationCopy();
  const featured = findSection(LANDING_FEATURED_SLUG, locale);
  const groups = getDocGroups(locale);

  return (
    <div className="space-y-10">
      <section className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary/70">
          {copy.landing.eyebrow}
        </p>
        <h1 className="text-balance text-3xl font-bold text-foreground sm:text-4xl">
          {copy.landing.title}
        </h1>
        <p className="max-w-3xl text-base leading-7 text-muted-foreground">
          {copy.landing.description}
        </p>
      </section>

      {featured ? (
        <Link
          to={`${basePath}/${featured.slug}`}
          className={cn(
            "group flex items-center gap-4 rounded-[var(--radius-xl)] border border-primary/50 bg-[linear-gradient(120deg,color-mix(in_oklab,var(--color-primary)_14%,transparent),color-mix(in_oklab,var(--color-surface-1)_85%,transparent))] p-5 shadow-soft transition-transform hover:-translate-y-0.5",
          )}
        >
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-primary/40 bg-[color:var(--color-surface-1)] text-primary">
            <Compass className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">
              {copy.landing.featuredLabel}
            </p>
            <p className="text-lg font-semibold tracking-[-0.02em] text-foreground">
              {featured.title}
            </p>
            <p className="text-sm text-muted-foreground">
              {copy.landing.featuredDescription}
            </p>
          </div>
          <ArrowRight
            className="h-5 w-5 shrink-0 text-primary transition-transform group-hover:translate-x-1"
            aria-hidden
          />
        </Link>
      ) : null}

      <div className="grid gap-8 md:grid-cols-2">
        {groups.map((group) => {
          const sections = sectionsByGroup(group.id, locale);
          return (
            <section key={group.id} className="space-y-3">
              <div className="flex items-center gap-2">
                <BookOpen
                  className="h-4 w-4 text-muted-foreground"
                  aria-hidden
                />
                <h2 className="text-lg font-semibold tracking-[-0.02em] text-foreground">
                  {group.title}
                </h2>
              </div>
              <ul className="space-y-1.5">
                {sections.map((section) => (
                  <li key={section.slug}>
                    <Link
                      to={`${basePath}/${section.slug}`}
                      className={cn(
                        "group flex items-center justify-between gap-3 rounded-md px-3 py-2 text-sm text-foreground/85 transition-colors",
                        "hover:bg-[color:var(--color-accent)] hover:text-accent-foreground",
                      )}
                    >
                      <span className="truncate">{section.title}</span>
                      <ArrowRight
                        className="h-3.5 w-3.5 shrink-0 opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100"
                        aria-hidden
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
