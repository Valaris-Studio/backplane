// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  LayoutGrid,
  List,
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useDebouncedValue } from "@/hooks/use-debounced-value";

export type ViewMode = "list" | "grid";

interface ResourceToolbarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  resourceType: string | undefined;
  onResourceTypeChange: (type: string | undefined) => void;
  selectedTag: string | undefined;
  onTagChange: (tag: string | undefined) => void;
  availableTags: string[];
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
}

const TYPE_OPTIONS = [
  { value: undefined, labelKey: "resources.allTypes" },
  { value: "file", labelKey: "resources.filesOnly" },
  { value: "folder", labelKey: "resources.foldersOnly" },
] as const;

function SearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (q: string) => void;
}) {
  const { t } = useTranslation();
  const [local, setLocal] = useState(value);
  const debounced = useDebouncedValue(local);

  useEffect(() => {
    if (debounced !== value) onChange(debounced);
  }, [debounced]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        placeholder={t("resources.searchPlaceholder")}
        className="h-9 w-56 pl-9 text-xs"
      />
    </div>
  );
}

function TypeFilter({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (type: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const activeLabel =
    TYPE_OPTIONS.find((o) => o.value === value)?.labelKey ?? "resources.allTypes";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.15rem))] border border-border/75 bg-card/85 px-3.5 text-xs font-semibold text-foreground shadow-soft transition-[background-color,border-color,color,box-shadow] duration-200 hover:border-primary/30 hover:bg-accent hover:text-accent-foreground",
      )}>
        {t("resources.filterType")}:{" "}
        <span className="text-muted-foreground">{t(activeLabel)}</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t("resources.filterType")}</DropdownMenuLabel>
        {TYPE_OPTIONS.map((opt) => (
          <DropdownMenuItem
            key={opt.labelKey}
            onClick={() => onChange(opt.value)}
            className={cn(value === opt.value && "bg-accent text-accent-foreground")}
          >
            {t(opt.labelKey)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TagFilter({
  value,
  onChange,
  tags,
}: {
  value: string | undefined;
  onChange: (tag: string | undefined) => void;
  tags: string[];
}) {
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.15rem))] border border-border/75 bg-card/85 px-3.5 text-xs font-semibold text-foreground shadow-soft transition-[background-color,border-color,color,box-shadow] duration-200 hover:border-primary/30 hover:bg-accent hover:text-accent-foreground",
      )}>
        {t("resources.tags")}
        {value ? (
          <>:{" "}<span className="text-muted-foreground">{value}</span></>
        ) : null}
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t("resources.tags")}</DropdownMenuLabel>
        {!tags.length ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            {t("resources.noTags")}
          </div>
        ) : (
          <>
            <DropdownMenuItem
              onClick={() => onChange(undefined)}
              className={cn(!value && "bg-accent text-accent-foreground")}
            >
              {t("resources.allTypes")}
            </DropdownMenuItem>
            {tags.map((tag) => (
              <DropdownMenuItem
                key={tag}
                onClick={() => onChange(tag)}
                className={cn(value === tag && "bg-accent text-accent-foreground")}
              >
                {tag}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ActiveFilters({
  resourceType,
  onResourceTypeChange,
  selectedTag,
  onTagChange,
}: Pick<
  ResourceToolbarProps,
  "resourceType" | "onResourceTypeChange" | "selectedTag" | "onTagChange"
>) {
  const { t } = useTranslation();
  const chips: { label: string; onRemove: () => void }[] = [];

  if (resourceType) {
    const labelKey =
      TYPE_OPTIONS.find((o) => o.value === resourceType)?.labelKey ??
      "resources.allTypes";
    chips.push({
      label: `${t("resources.filterType")}: ${t(labelKey)}`,
      onRemove: () => onResourceTypeChange(undefined),
    });
  }

  if (selectedTag) {
    chips.push({
      label: `${t("resources.tags")}: ${selectedTag}`,
      onRemove: () => onTagChange(undefined),
    });
  }

  if (!chips.length) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <Badge key={chip.label} variant="secondary" className="gap-1 pr-1">
          {chip.label}
          <button
            type="button"
            onClick={chip.onRemove}
            className="ml-0.5 rounded-full p-0.5 transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
    </div>
  );
}

function ViewToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex rounded-[min(var(--radius-cap),calc(var(--radius-md)-0.1rem))] border border-border/75 shadow-soft">
      <Button
        variant={mode === "list" ? "default" : "ghost"}
        size="sm"
        onClick={() => onChange("list")}
        aria-label={t("resources.list")}
        className="rounded-r-none border-0 shadow-none"
      >
        <List className="h-4 w-4" />
      </Button>
      <Button
        variant={mode === "grid" ? "default" : "ghost"}
        size="sm"
        onClick={() => onChange("grid")}
        aria-label={t("resources.grid")}
        className="rounded-l-none border-0 shadow-none"
      >
        <LayoutGrid className="h-4 w-4" />
      </Button>
    </div>
  );
}

export function ResourceToolbar({
  searchQuery,
  onSearchChange,
  resourceType,
  onResourceTypeChange,
  selectedTag,
  onTagChange,
  availableTags,
  viewMode,
  onViewModeChange,
}: ResourceToolbarProps) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={searchQuery} onChange={onSearchChange} />
        <TypeFilter value={resourceType} onChange={onResourceTypeChange} />
        <TagFilter value={selectedTag} onChange={onTagChange} tags={availableTags} />
        <div className="ml-auto">
          <ViewToggle mode={viewMode} onChange={onViewModeChange} />
        </div>
      </div>
      <ActiveFilters
        resourceType={resourceType}
        onResourceTypeChange={onResourceTypeChange}
        selectedTag={selectedTag}
        onTagChange={onTagChange}
      />
    </div>
  );
}
