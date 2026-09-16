// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search, ShieldCheck, X } from "lucide-react";
import { useApprovals } from "../hooks/useApprovals";
import { ApprovalDecideDialog } from "./ApprovalDecideDialog";
import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/layout/EmptyState";
import { FilterMultiSelect } from "@/components/collection";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { extractPlainText } from "@/lib/text-utils";
import type { Approval, ApprovalCategory, ApprovalStatus } from "@/types/approval";

const STATUS_VARIANTS: Record<ApprovalStatus, "default" | "success" | "destructive" | "warning" | "secondary"> = {
  pending: "warning",
  approved: "success",
  rejected: "destructive",
  expired: "secondary",
  auto_approved: "default",
};

// The full set the UI can filter by, in display order. Mirrors the API enums in
// `types/approval.ts`; keep in sync if the backend grows a new status/category.
const STATUS_OPTIONS: ApprovalStatus[] = [
  "pending",
  "approved",
  "rejected",
  "auto_approved",
  "expired",
];
const CATEGORY_OPTIONS: ApprovalCategory[] = [
  "deletion",
  "bulk_change",
  "permission_change",
  "schema_change",
  "deployment",
  "external_action",
  "skill_publication",
];

// Map category to its tooltip key. Categories the heuristic knows about each
// get a dedicated tooltip explaining what triggers them and how the score
// moves. The `other` fallback (present in i18n but not in the API enum today)
// is intentionally absent — nothing in the table maps to it.
const CATEGORY_TOOLTIP_KEYS: Record<ApprovalCategory, string> = {
  deletion: "approvals.category.deletion",
  bulk_change: "approvals.category.bulk_change",
  deployment: "approvals.category.deployment",
  schema_change: "approvals.category.schema_change",
  permission_change: "approvals.category.permission_change",
  external_action: "approvals.category.external_action",
  skill_publication: "approvals.category.skill_publication",
};

function RiskIndicator({ score }: { score: number }) {
  const { t } = useTranslation();
  let label: string;
  let colorClass: string;

  if (score < 40) {
    label = t("approvals.risk.low");
    colorClass = "text-[color:var(--color-success-foreground)]";
  } else if (score <= 70) {
    label = t("approvals.risk.medium");
    colorClass = "text-[color:var(--color-warning-foreground)]";
  } else {
    label = t("approvals.risk.high");
    colorClass = "text-destructive";
  }

  return (
    <span className={cn("tabular-nums font-semibold", colorClass)}>
      {score} <span className="font-normal text-muted-foreground">({label})</span>
    </span>
  );
}

interface ApprovalListProps {
  slug: string;
}

export function ApprovalList({ slug }: ApprovalListProps) {
  const { t } = useTranslation();
  const { data: approvals, isLoading } = useApprovals(slug);
  const [selectedApproval, setSelectedApproval] = useState<Approval | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);

  const debouncedSearch = useDebouncedValue(search, 300);

  // Keyed on `approvals` alone: `extractPlainText` parses TipTap JSON and walks
  // the doc, so building the haystack inside the filter re-parsed every row on
  // every keystroke.
  const searchIndex = useMemo(() => {
    const index = new Map<string, string>();
    for (const a of approvals ?? []) {
      index.set(
        a.id,
        `${extractPlainText(a.action_description)} ${
          a.agent_name ?? a.agent_id
        } ${a.decided_by_name ?? ""}`.toLowerCase(),
      );
    }
    return index;
  }, [approvals]);

  const filtered = useMemo(() => {
    const list = approvals ?? [];
    const q = debouncedSearch.trim().toLowerCase();
    return list.filter((a) => {
      if (statusFilter.length && !statusFilter.includes(a.status)) return false;
      if (categoryFilter.length && !categoryFilter.includes(a.category)) return false;
      if (q && !searchIndex.get(a.id)?.includes(q)) return false;
      return true;
    });
  }, [approvals, debouncedSearch, statusFilter, categoryFilter, searchIndex]);

  if (isLoading) {
    return (
      <div className="space-y-[var(--page-section-gap)]">
        <Skeleton className="h-32 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.3rem))]" />
        <Skeleton className="h-64 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />
      </div>
    );
  }

  const hasApprovals = (approvals?.length ?? 0) > 0;

  function openApproval(approval: Approval) {
    setSelectedApproval(approval);
    setDialogOpen(true);
  }

  return (
    <div className="space-y-[var(--page-section-gap)]">
      <PageHeader
        title={t("approvals.title")}
        description={t("approvals.subtitle")}
      />

      {!hasApprovals ? (
        <EmptyState
          icon={ShieldCheck}
          title={t("approvals.title")}
          description={t("approvals.empty")}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 rounded-[min(var(--radius-cap),calc(var(--radius-xl)-0.1rem))] border border-border/70 bg-card/50 px-3 py-2.5 shadow-soft">
            <div className="relative min-w-0 flex-1 sm:max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("approvals.filter.searchPlaceholder")}
                aria-label={t("approvals.filter.searchPlaceholder")}
                className="h-9 pl-9 pr-9"
              />
              {search ? (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  aria-label={t("approvals.filter.clearSearch")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>

            <FilterMultiSelect
              label={t("approvals.filter.status")}
              options={STATUS_OPTIONS.map((v) => ({
                value: v,
                label: t(`approvals.status.${v}`),
              }))}
              value={statusFilter}
              onChange={setStatusFilter}
            />
            <FilterMultiSelect
              label={t("approvals.filter.category")}
              options={CATEGORY_OPTIONS.map((v) => ({
                value: v,
                label: t(`approvals.category.${v}`),
              }))}
              value={categoryFilter}
              onChange={setCategoryFilter}
            />

            <span className="ml-auto text-xs text-muted-foreground">
              {t("approvals.filter.resultCount", {
                count: filtered.length,
                total: approvals?.length ?? 0,
              })}
            </span>
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              icon={Search}
              title={t("approvals.noMatch")}
              description={t("approvals.noMatchHint")}
            />
          ) : (
            <div className="overflow-hidden rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))] border border-border/70 bg-[color:var(--color-surface-1)] shadow-panel">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/60 bg-muted/40 text-left text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      <th className="px-4 py-3">{t("approvals.columns.status")}</th>
                      <th className="px-4 py-3">{t("approvals.columns.category")}</th>
                      <th className="px-4 py-3">{t("approvals.columns.description")}</th>
                      <th className="px-4 py-3">{t("approvals.columns.risk")}</th>
                      <th className="px-4 py-3">{t("approvals.columns.agent")}</th>
                      <th className="px-4 py-3">{t("approvals.columns.created")}</th>
                      <th className="px-4 py-3">{t("approvals.columns.actions")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {filtered.map((approval) => (
                      <tr
                        key={approval.id}
                        className="transition-colors duration-150 hover:bg-muted/30"
                      >
                        <td className="px-4 py-3">
                          <Badge variant={STATUS_VARIANTS[approval.status]}>
                            {t(`approvals.status.${approval.status}`)}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          <RichTooltip i18nKey={CATEGORY_TOOLTIP_KEYS[approval.category]}>
                            <span>{t(`approvals.category.${approval.category}`)}</span>
                          </RichTooltip>
                        </td>
                        <td className="max-w-xs truncate px-4 py-3">
                          {extractPlainText(approval.action_description)}
                        </td>
                        <td className="px-4 py-3">
                          <RichTooltip i18nKey="approvals.riskScore">
                            <span>
                              <RiskIndicator score={approval.risk_score} />
                            </span>
                          </RichTooltip>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {approval.agent_name ?? approval.agent_id.slice(0, 8)}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          <RichTooltip i18nKey="approvals.expiry">
                            <span>{formatDate(approval.created_at)}</span>
                          </RichTooltip>
                        </td>
                        <td className="px-4 py-3">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openApproval(approval)}
                          >
                            {approval.status === "pending"
                              ? t("approvals.actions.decide")
                              : t("approvals.actions.view")}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      <ApprovalDecideDialog
        slug={slug}
        approval={selectedApproval}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </div>
  );
}
