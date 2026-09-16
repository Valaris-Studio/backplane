// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface FilterMultiSelectOption {
  value: string;
  label: string;
}

interface FilterMultiSelectProps {
  label: string;
  options: FilterMultiSelectOption[];
  value: string[];
  onChange: (value: string[]) => void;
}

// Past this many options the menu gets a type-to-filter box — label-heavy
// boards produce far more entries than are scannable in a bounded list.
const SEARCH_THRESHOLD = 8;

// Lives inside DropdownMenuContent so it unmounts when the menu closes,
// resetting the query for the next open.
function FilterOptionList({
  options,
  value,
  onToggle,
}: {
  options: FilterMultiSelectOption[];
  value: string[];
  onToggle: (option: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");

  const searchable = options.length > SEARCH_THRESHOLD;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (opt) =>
        opt.label.toLowerCase().includes(q) ||
        opt.value.toLowerCase().includes(q),
    );
  }, [options, query]);

  return (
    <>
      {searchable && (
        <div className="px-1.5 pb-1.5">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("collection.searchPlaceholder")}
            aria-label={t("collection.searchPlaceholder")}
            className="h-8 text-xs"
            data-testid="filter-multi-select-search"
          />
        </div>
      )}
      <div
        className="max-h-64 overflow-y-auto"
        data-testid="filter-multi-select-options"
      >
        {filtered.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            {t("collection.noResults")}
          </div>
        ) : (
          filtered.map((opt) => {
            const selected = value.includes(opt.value);
            return (
              <DropdownMenuItem
                key={opt.value}
                // Multi-select: toggling one entry must not dismiss the menu.
                closeOnClick={false}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(opt.value);
                }}
              >
                <span
                  className={cn(
                    "flex h-4 w-4 items-center justify-center rounded-sm border border-border/70",
                    selected && "border-primary bg-primary text-primary-foreground",
                  )}
                >
                  {selected ? <Check className="h-3 w-3" /> : null}
                </span>
                <span className="truncate">{opt.label}</span>
              </DropdownMenuItem>
            );
          })
        )}
      </div>
    </>
  );
}

export function FilterMultiSelect({
  label,
  options,
  value,
  onChange,
}: FilterMultiSelectProps) {
  const { t } = useTranslation();
  const active = value.length > 0;

  function toggle(option: string) {
    onChange(
      value.includes(option)
        ? value.filter((v) => v !== option)
        : [...value, option],
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-full border border-border/80 bg-card px-3 text-xs font-medium text-foreground hover:bg-accent",
          active && "border-primary/40 bg-primary/10 text-primary",
        )}
      >
        <span>{label}</span>
        {active ? (
          <span className="rounded-full bg-primary/20 px-1.5 text-[0.65rem] leading-4 text-primary">
            {value.length}
          </span>
        ) : null}
        <ChevronDown className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[14rem]">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {options.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            {t("collection.noOptions")}
          </div>
        ) : (
          <FilterOptionList options={options} value={value} onToggle={toggle} />
        )}
        {active ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onChange([])} className="text-muted-foreground">
              {t("collection.clear")}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
