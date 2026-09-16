// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  ActivityAction,
  ActivityEntityType,
  ActivityFilters as Filters,
} from "@/types/activity";

const ENTITY_TYPES = [
  "board", "column", "card", "note", "resource", "definition",
  "channel", "git_repo", "workspace", "member", "agent",
] as const satisfies readonly ActivityEntityType[];

const ACTIONS = [
  "created", "updated", "deleted", "moved", "uploaded", "archived",
  "added_member", "removed_member", "dependency_added", "dependency_removed",
  "dependencies_replaced",
] as const satisfies readonly ActivityAction[];

interface ActivityFiltersProps {
  filters: Filters;
  onChange: (filters: Filters) => void;
}

export function ActivityFiltersBar({ filters, onChange }: ActivityFiltersProps) {
  const { t } = useTranslation();
  const [searchInput, setSearchInput] = useState(filters.search ?? "");

  useEffect(() => {
    const timer = setTimeout(() => {
      onChange({ ...filters, search: searchInput || undefined });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select
        value={filters.entity_type ?? "all"}
        onValueChange={(v) =>
          onChange({ ...filters, entity_type: v === "all" ? undefined : (v as Filters["entity_type"]) })
        }
      >
        <SelectTrigger className="w-40">
          <SelectValue placeholder={t("activity.filterByType")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("activity.allTypes")}</SelectItem>
          {ENTITY_TYPES.map((type) => (
            <SelectItem key={type} value={type}>
              {t(`activity.entityTypes.${type}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filters.action ?? "all"}
        onValueChange={(v) =>
          onChange({ ...filters, action: v === "all" ? undefined : (v as Filters["action"]) })
        }
      >
        <SelectTrigger className="w-44">
          <SelectValue placeholder={t("activity.filterByAction")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("activity.allActions")}</SelectItem>
          {ACTIONS.map((action) => (
            <SelectItem key={action} value={action}>
              {t(`activity.actions.${action}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="relative flex-1 min-w-[200px]">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={t("activity.searchPlaceholder")}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="pl-9"
        />
      </div>
    </div>
  );
}
