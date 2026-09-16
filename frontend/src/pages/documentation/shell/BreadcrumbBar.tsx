// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDocumentationCopy } from "../use-documentation-copy";

interface BreadcrumbBarProps {
  rootHref: string;
  currentTitle: string;
  className?: string;
}

export function BreadcrumbBar({
  rootHref,
  currentTitle,
  className,
}: BreadcrumbBarProps) {
  const { copy } = useDocumentationCopy();

  return (
    <nav
      aria-label={copy.shell.breadcrumbAriaLabel}
      className={cn(
        "flex items-center gap-1 text-xs font-medium text-muted-foreground",
        className,
      )}
    >
      <Link
        to={rootHref}
        className="rounded px-1 py-0.5 transition-colors hover:text-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none"
      >
        {copy.shell.breadcrumbRoot}
      </Link>
      <ChevronRight className="h-3 w-3" aria-hidden />
      <span className="truncate text-foreground/85">{currentTitle}</span>
    </nav>
  );
}
