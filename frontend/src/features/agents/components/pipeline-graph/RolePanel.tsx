// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { StageConfig } from "@/features/agents/api/pipelineConfig";
import { deriveRoleCapabilities } from "@/features/agents/utils/role-capabilities";
import { RolePromptsPanel } from "@/features/agents/components/prompts/RolePromptsPanel";
import { RoleCapabilitiesCard } from "./RoleCapabilitiesCard";

type RolePanelTab = "overview" | "prompts";

interface RolePanelProps {
  slug: string;
  stage: StageConfig;
}

// The role detail surface the graph opens when a role node is drilled into.
// Folds the (formerly separate) Roles glossary + Prompts editor into one place
// scoped to a single role: a grounded capability summary derived from the role's
// real lifecycle, and its per-stage prompts. The lifecycle STEP graph renders
// alongside this (in PipelineGraphView); this panel is the "what + prompts" half.
export function RolePanel({ slug, stage }: RolePanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<RolePanelTab>("overview");
  const capabilities = deriveRoleCapabilities(stage);

  const tabs: { id: RolePanelTab; label: string }[] = [
    { id: "overview", label: t("rolePanel.tabOverview") },
    { id: "prompts", label: t("rolePanel.tabPrompts") },
  ];

  return (
    <div className="flex h-full w-full flex-col gap-3 overflow-hidden rounded-[min(var(--radius-cap),calc(var(--radius-xl)-0.1rem))] border border-border/70 bg-card/40 p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm font-semibold text-foreground">{stage.role}</span>
      </div>
      <div className="inline-flex w-fit rounded-[var(--radius-md)] border border-border/70 bg-card p-0.5">
        {tabs.map((tabItem) => (
          <button
            key={tabItem.id}
            type="button"
            onClick={() => setTab(tabItem.id)}
            aria-pressed={tab === tabItem.id}
            className={cn(
              "rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.1rem))] px-3 py-1 text-xs font-medium transition-colors",
              tab === tabItem.id
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tabItem.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto pr-1">
        {tab === "overview" ? (
          <RoleCapabilitiesCard capabilities={capabilities} />
        ) : (
          <RolePromptsPanel slug={slug} role={stage.role} />
        )}
      </div>
    </div>
  );
}
