// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RefObject } from "react";
import { cn } from "@/lib/utils";
import { useDocumentationSectionTranslator } from "../section-localization";
import { useDocumentationCopy } from "../use-documentation-copy";
import { CATEGORIES, GROUPS } from "./data";
import type { PromptDoc, ResourceDoc, ToolDoc, ToolKind } from "./data";
import type { ReferenceSelection } from "./selection";

export type KindFilter = ToolKind | "all";

const KIND_FILTERS: KindFilter[] = ["all", "read", "write", "composite"];

interface ReferenceNavProps {
  tools: ToolDoc[];
  prompts: PromptDoc[];
  resources: ResourceDoc[];
  selection: ReferenceSelection;
  onSelect: (selection: NonNullable<ReferenceSelection>) => void;
  search: string;
  onSearchChange: (value: string) => void;
  kindFilter: KindFilter;
  onKindFilterChange: (value: KindFilter) => void;
  searchRef: RefObject<HTMLInputElement | null>;
}

function GroupHeading({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
      <span aria-hidden className="h-3 w-[3px] shrink-0 bg-primary" />
      {label}
    </p>
  );
}

function NavItemButton({
  label,
  selected,
  onClick,
  selectionId,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  // '<kind>-<id>' handle so the mobile back transition can restore focus here.
  selectionId: string;
}) {
  return (
    <button
      type="button"
      data-doc-technical
      onClick={onClick}
      data-selection={selectionId}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "w-full truncate rounded-[var(--radius-md)] px-2 py-1 text-left font-mono text-[0.78rem] transition-colors",
        selected
          ? "bg-[color:var(--color-accent)] font-medium text-accent-foreground"
          : "text-foreground/80 hover:bg-[color:var(--color-muted)] hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

export function ReferenceNav({
  tools,
  prompts,
  resources,
  selection,
  onSelect,
  search,
  onSearchChange,
  kindFilter,
  onKindFilterChange,
  searchRef,
}: ReferenceNavProps) {
  const { copy } = useDocumentationCopy();
  const translate = useDocumentationSectionTranslator();
  const isSelected = (kind: NonNullable<ReferenceSelection>["kind"], id: string) =>
    selection?.kind === kind && selection.id === id;

  return (
    <nav aria-label={copy.mcpReference.navAriaLabel} className="space-y-5">
      <input
        ref={searchRef}
        type="search"
        aria-label={copy.mcpReference.searchAriaLabel}
        placeholder={copy.mcpReference.searchPlaceholder}
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
        className="w-full rounded-[var(--radius-md)] border border-border bg-[color:var(--color-surface-1)] px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/60"
      />

      <div
        className="flex flex-wrap gap-1.5"
        role="group"
        aria-label={copy.mcpReference.filterAriaLabel}
      >
        {KIND_FILTERS.map((filter) => (
          <button
            key={filter}
            type="button"
            aria-pressed={kindFilter === filter}
            onClick={() => onKindFilterChange(filter)}
            className={cn(
              "rounded-[var(--radius-md)] border px-2 py-0.5 text-[0.7rem] font-semibold uppercase tracking-[0.1em] transition-colors",
              kindFilter === filter
                ? "border-primary/60 bg-[color:var(--color-accent)] text-accent-foreground"
                : "border-border/70 text-muted-foreground hover:text-foreground",
            )}
          >
            {copy.mcpReference.filterLabels[filter]}
          </button>
        ))}
      </div>

      {tools.length === 0 && prompts.length === 0 && resources.length === 0 ? (
        <div className="space-y-2 rounded-[var(--radius-md)] border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
          <p>
            {search.trim()
              ? copy.mcpReference.noMatchesFor.replace(
                  "{{query}}",
                  search.trim(),
                )
              : copy.mcpReference.noMatches}
          </p>
          <button
            type="button"
            onClick={() => {
              onSearchChange("");
              onKindFilterChange("all");
            }}
            className="text-sm font-medium text-primary hover:underline"
          >
            {copy.mcpReference.clearSearchAndFilters}
          </button>
        </div>
      ) : null}

      {GROUPS.map((group) => {
        const groupCategories = CATEGORIES.map((category) => ({
          ...category,
          tools: tools.filter((tool) => tool.category === category.id),
        })).filter(
          (category) => category.group === group && category.tools.length > 0,
        );
        if (groupCategories.length === 0) return null;
        return (
          <div key={group} className="space-y-3">
            <GroupHeading label={translate(group)} />
            {groupCategories.map((category) => (
              <div
                key={category.id}
                data-testid={`mcp-cat-${category.id}`}
                className="space-y-1"
              >
                <div className="flex items-baseline justify-between gap-2 px-2">
                  <span className="text-xs font-medium text-foreground/90">
                    {translate(category.title)}
                  </span>
                  <span className="font-mono text-[0.65rem] text-muted-foreground">
                    {category.tools.length}
                  </span>
                </div>
                <ul className="space-y-0.5">
                  {category.tools.map((tool) => (
                    <li key={tool.name}>
                      <NavItemButton
                        label={tool.name}
                        selected={isSelected("tool", tool.name)}
                        onClick={() => onSelect({ kind: "tool", id: tool.name })}
                        selectionId={`tool-${tool.name}`}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        );
      })}

      {prompts.length > 0 ? (
        <div className="space-y-1.5">
          <GroupHeading label={copy.mcpReference.promptsGroup} />
          <ul className="space-y-0.5">
            {prompts.map((prompt) => (
              <li key={prompt.name}>
                <NavItemButton
                  label={prompt.name}
                  selected={isSelected("prompt", prompt.name)}
                  onClick={() => onSelect({ kind: "prompt", id: prompt.name })}
                  selectionId={`prompt-${prompt.name}`}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {resources.length > 0 ? (
        <div className="space-y-1.5">
          <GroupHeading label={copy.mcpReference.resourcesGroup} />
          <ul className="space-y-0.5">
            {resources.map((resource) => (
              <li key={resource.uri}>
                <NavItemButton
                  label={resource.uri}
                  selected={isSelected("resource", resource.uri)}
                  onClick={() => onSelect({ kind: "resource", id: resource.uri })}
                  selectionId={`resource-${resource.uri}`}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </nav>
  );
}
