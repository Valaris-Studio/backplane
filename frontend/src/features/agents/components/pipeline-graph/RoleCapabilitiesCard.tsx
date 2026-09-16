// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import {
  ArrowRightLeft,
  Code2,
  FileText,
  GitMerge,
  GitPullRequest,
  Inbox,
  ListChecks,
  ScrollText,
  ShieldCheck,
  Tag,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { RoleCapabilities } from "@/features/agents/utils/role-capabilities";

interface RoleCapabilitiesCardProps {
  capabilities: RoleCapabilities;
}

// A grounded "what this role does" summary, derived from the role's actual
// lifecycle (see deriveRoleCapabilities) — replaces the old hardcoded glossary
// that drifted from the backend default config. Shows only the capabilities the
// role genuinely has, plus its inbox column and where it hands cards off.
export function RoleCapabilitiesCard({ capabilities: cap }: RoleCapabilitiesCardProps) {
  const { t } = useTranslation();

  const caps: { key: string; icon: typeof Code2; active: boolean }[] = [
    { key: "writesCode", icon: Code2, active: cap.writesCode },
    { key: "producesDecision", icon: ListChecks, active: cap.producesDecision },
    { key: "writesNotes", icon: ScrollText, active: cap.writesNotes },
    { key: "mutatesBacklog", icon: FileText, active: cap.mutatesBacklog },
    { key: "opensPR", icon: GitPullRequest, active: cap.opensPR },
    { key: "reviewsPR", icon: ShieldCheck, active: cap.reviewsPR },
    { key: "mergesPR", icon: GitMerge, active: cap.mergesPR },
    { key: "appliesLabels", icon: Tag, active: cap.appliesLabels },
  ];
  const activeCaps = caps.filter((c) => c.active);

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("rolePanel.capabilitiesLabel")}
        </p>
        {activeCaps.length === 0 ? (
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("rolePanel.noCapabilities")}
          </p>
        ) : (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {activeCaps.map(({ key, icon: Icon }) => (
              <Badge key={key} variant="secondary" className="gap-1 text-[0.65rem]">
                <Icon className="h-3 w-3" />
                {t(`rolePanel.caps.${key}`)}
              </Badge>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 border-t border-border/60 pt-3 sm:grid-cols-2">
        <FlowFact
          icon={Inbox}
          label={t("rolePanel.inboxLabel")}
          values={cap.discoverColumnType ? [cap.discoverColumnType] : []}
          emptyText={t("rolePanel.inboxNone")}
        />
        <FlowFact
          icon={ArrowRightLeft}
          label={t("rolePanel.handsOffLabel")}
          values={[
            ...cap.movesCardsTo.map((c) => t("rolePanel.toColumn", { column: c })),
            ...cap.wakesRoles.map((r) => t("rolePanel.wakesRole", { role: r })),
          ]}
          emptyText={t("rolePanel.handsOffNone")}
        />
      </div>

      <div className="border-t border-border/60 pt-3 text-[0.7rem] text-muted-foreground">
        {t("rolePanel.stepCount", { count: cap.stepCount })}
        {cap.usesApproval ? (
          <Badge variant="warning" className="ml-2 gap-1 text-[0.6rem]">
            <ShieldCheck className="h-3 w-3" />
            {t("rolePanel.usesApproval")}
          </Badge>
        ) : null}
      </div>
    </div>
  );
}

function FlowFact({
  icon: Icon,
  label,
  values,
  emptyText,
}: {
  icon: typeof Inbox;
  label: string;
  values: string[];
  emptyText: string;
}) {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-[0.6rem] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </p>
      {values.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <div className="mt-1 flex flex-wrap gap-1">
          {values.map((v) => (
            <code
              key={v}
              className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.65rem]"
            >
              {v}
            </code>
          ))}
        </div>
      )}
    </div>
  );
}
