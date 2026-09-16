// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Bot, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

type AgentInfoSectionProps = {
  title?: string;
  icon?: React.ReactNode;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
  className?: string;
};

type AgentInfoSubtabProps = {
  title?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
};

// Visual token that marks a surface as agent-owned. A subtle left border keeps
// the section legible inside mixed PM/agent contexts without coupling to a
// specific color palette — can be restyled without touching the API.
const AGENTIC_SURFACE =
  "rounded-md border border-border/70 border-l-2 border-l-primary/60 bg-[color:var(--color-surface-1)]/40";

function AgentInfoIcon({
  icon,
  altText,
}: {
  icon?: React.ReactNode;
  altText: string;
}) {
  if (icon) {
    return (
      <span aria-label={altText} className="inline-flex size-4 items-center justify-center text-primary">
        {icon}
      </span>
    );
  }
  return <Bot aria-label={altText} className="size-4 text-primary" />;
}

export function AgentInfoSection({
  title,
  icon,
  defaultCollapsed = true,
  children,
  className,
}: AgentInfoSectionProps) {
  const { t } = useTranslation();
  const resolvedTitle = title ?? t("agentic.section.title");
  const iconAlt = t("agentic.section.icon_alt");
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed);

  const regionId = React.useId();

  return (
    <section className={cn(AGENTIC_SURFACE, "p-0", className)} data-slot="agent-info-section">
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls={regionId}
        onClick={() => setCollapsed((c) => !c)}
        data-slot="agent-info-header"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold tracking-[-0.01em] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <AgentInfoIcon icon={icon} altText={iconAlt} />
        <span className="flex-1">{resolvedTitle}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-4 text-muted-foreground transition-transform duration-200",
            collapsed ? "rotate-0" : "rotate-180",
          )}
        />
      </button>
      <div
        id={regionId}
        hidden={collapsed}
        data-slot="agent-info-content"
        className="px-3 pb-3 pt-0"
      >
        {children}
      </div>
    </section>
  );
}

export function AgentInfoSubtab({
  title,
  icon,
  children,
  className,
}: AgentInfoSubtabProps) {
  const { t } = useTranslation();
  const resolvedTitle = title ?? t("agentic.section.title");
  const iconAlt = t("agentic.section.icon_alt");

  return (
    <section className={cn(AGENTIC_SURFACE, className)} data-slot="agent-info-subtab">
      <div
        data-slot="agent-info-header"
        className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-sm font-semibold tracking-[-0.01em] text-foreground"
      >
        <AgentInfoIcon icon={icon} altText={iconAlt} />
        <span>{resolvedTitle}</span>
      </div>
      <div data-slot="agent-info-content" className="p-3">
        {children}
      </div>
    </section>
  );
}
