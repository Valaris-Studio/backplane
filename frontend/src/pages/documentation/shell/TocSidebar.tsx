// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { getDocGroups, sectionsByGroup, type DocGroupId } from "../routes";
import { useDocumentationCopy } from "../use-documentation-copy";
import { useDocsBasePath } from "../use-docs-base-path";

interface TocSidebarProps {
  currentSlug?: string;
  className?: string;
  onNavigate?: () => void;
}

export function TocSidebar({
  currentSlug,
  className,
  onNavigate,
}: TocSidebarProps) {
  const basePath = useDocsBasePath();
  const { copy, locale } = useDocumentationCopy();
  const groups = getDocGroups(locale);

  return (
    <nav
      aria-label={copy.shell.sectionsAriaLabel}
      // The sidebar is taller than the viewport at every locale, so it lives in
      // a scroll container. tabIndex makes that scroll reachable by keyboard
      // (a scrollable region with no focusable ancestor is a WCAG 2.1.1 trap),
      // and the trailing padding stops the last row being sliced flush against
      // the container edge, which read as "the nav ends here".
      tabIndex={0}
      className={cn(
        "flex flex-col gap-6 pb-6 text-sm focus-visible:outline-none",
        className,
      )}
    >
      <Link
        to={basePath}
        onClick={onNavigate}
        className={cn(
          "rounded-md px-2 py-1.5 font-semibold tracking-[-0.01em] transition-colors",
          !currentSlug
            ? "bg-[color:var(--color-accent)] text-accent-foreground"
            : "text-foreground/80 hover:bg-[color:var(--color-accent)]/60 hover:text-foreground",
        )}
      >
        {copy.shell.startHere}
      </Link>
      {groups.map((group) => (
        <TocGroup
          key={group.id}
          groupId={group.id}
          title={group.title}
          locale={locale}
          basePath={basePath}
          currentSlug={currentSlug}
          onNavigate={onNavigate}
        />
      ))}
    </nav>
  );
}

interface TocGroupProps {
  groupId: DocGroupId;
  title: string;
  locale: string;
  basePath: string;
  currentSlug?: string;
  onNavigate?: () => void;
}

function TocGroup({
  groupId,
  title,
  locale,
  basePath,
  currentSlug,
  onNavigate,
}: TocGroupProps) {
  const sections = sectionsByGroup(groupId, locale);

  return (
    <div className="space-y-1.5">
      <h3 className="px-2 text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {title}
      </h3>
      <ul className="space-y-0.5">
        {sections.map((section) => {
          const active = section.slug === currentSlug;
          return (
            <li key={section.slug}>
              <Link
                to={`${basePath}/${section.slug}`}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "block rounded-md px-2 py-1 leading-5 transition-colors",
                  active
                    ? "bg-[color:var(--color-accent)] font-medium text-accent-foreground"
                    : "text-foreground/75 hover:bg-[color:var(--color-accent)]/60 hover:text-foreground",
                )}
              >
                {section.title}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
