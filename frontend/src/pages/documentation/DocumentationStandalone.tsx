// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Link } from "react-router-dom";
import { DocumentationPage } from "@/pages/DocumentationPage";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";

// Chrome for the slug-independent /documentation route: the same docs shell
// AppShell hosts, but reachable with zero workspaces (fresh installs, OSS
// evaluators). The header height matches --topbar-height so the docs TOC's
// sticky offset keeps working outside AppShell.
export function DocumentationStandalone() {
  return (
    <div className="min-h-screen">
      <header
        aria-label="Backplane"
        className="sticky top-0 z-40 flex h-[var(--topbar-height)] items-center justify-between border-b border-border/70 bg-background/85 px-4 backdrop-blur md:px-6 lg:px-10"
      >
        <Link to="/" className="flex items-center gap-2.5">
          <BrandLogo className="h-6 w-auto" />
          <span className="text-sm font-bold tracking-tight text-foreground">
            Backplane
          </span>
        </Link>
        <div className="flex items-center gap-2">
          <ThemeSwitcher />
          <LanguageSwitcher />
        </div>
      </header>
      <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 lg:px-10">
        <DocumentationPage />
      </div>
    </div>
  );
}
