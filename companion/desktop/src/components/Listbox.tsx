// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useId, useState, type KeyboardEvent, type ReactNode } from "react";

import { Icon } from "./Icon";

export interface ListboxOption {
  value: string;
  label: string;
  description?: string;
  /** A short flag after the label, e.g. "Linked to this repo". */
  badge?: string;
}

export interface ListboxGroup {
  id: string;
  label: string;
  options: readonly ListboxOption[];
}

interface ListboxProps {
  searchLabel: string;
  listLabel: string;
  placeholder?: string;
  groups: readonly ListboxGroup[];
  value: string | null;
  onValueChange: (value: string) => void;
  /** What to say when the query matches nothing. */
  emptyState: (query: string) => ReactNode;
}

function matches(group: ListboxGroup, option: ListboxOption, query: string): boolean {
  return option.label.toLowerCase().includes(query) || group.label.toLowerCase().includes(query);
}

/**
 * A searchable, grouped single-select (the bind sheet's board picker), as the
 * ARIA combobox pattern: focus stays in the search input and the arrows move
 * aria-activedescendant; Enter or a click selects. Escape clears a non-empty
 * query (and is marked handled, so the sheet stays open); with nothing to
 * clear it bubbles and closes the sheet.
 */
export function Listbox({ searchLabel, listLabel, placeholder, groups, value, onValueChange, emptyState }: ListboxProps) {
  const [query, setQuery] = useState("");
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const idBase = useId();
  const listId = `${idBase}-list`;
  const optionId = (optionValue: string) => `${idBase}-option-${optionValue}`;

  const normalized = query.trim().toLowerCase();
  const visibleGroups = groups
    .map((group) => ({ ...group, options: group.options.filter((option) => !normalized || matches(group, option, normalized)) }))
    .filter((group) => group.options.length > 0);
  const visibleValues = visibleGroups.flatMap((group) => group.options.map((option) => option.value));
  const active = activeValue !== null && visibleValues.includes(activeValue) ? activeValue : null;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (visibleValues.length === 0) return;
      // With nothing active yet, the first press lands on the current selection (if it is visible).
      const selectedIndex = value === null ? -1 : visibleValues.indexOf(value);
      const current = active === null ? -1 : visibleValues.indexOf(active);
      const next =
        current === -1 && selectedIndex !== -1
          ? selectedIndex
          : event.key === "ArrowDown"
            ? (current + 1) % visibleValues.length
            : current <= 0
              ? visibleValues.length - 1
              : current - 1;
      setActiveValue(visibleValues[next] ?? null);
      document.getElementById(optionId(visibleValues[next] ?? ""))?.scrollIntoView?.({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active !== null) onValueChange(active);
    } else if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      setQuery("");
      setActiveValue(null);
    }
  };

  return (
    <div>
      <div className="bp-search">
        <Icon name="search" />
        <input
          type="text"
          role="combobox"
          aria-label={searchLabel}
          aria-controls={listId}
          aria-expanded="true"
          aria-autocomplete="list"
          aria-activedescendant={active !== null ? optionId(active) : undefined}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className="bp-input"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveValue(null);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div id={listId} role="listbox" aria-label={listLabel}>
        {visibleGroups.map((group) => (
          <div key={group.id} role="group" aria-labelledby={`${idBase}-group-${group.id}`}>
            <div id={`${idBase}-group-${group.id}`} className="bp-listbox-group" role="presentation">
              {group.label}
            </div>
            {group.options.map((option) => {
              const selected = option.value === value;
              const id = optionId(option.value);
              const describedBy = [option.badge ? `${id}-badge` : null, option.description ? `${id}-description` : null].filter(Boolean).join(" ");
              return (
                // Options take clicks but never focus: focus stays in the search (combobox pattern).
                <div
                  key={option.value}
                  id={id}
                  role="option"
                  aria-selected={selected}
                  aria-labelledby={`${id}-label`}
                  aria-describedby={describedBy || undefined}
                  data-active={option.value === active ? "true" : undefined}
                  className="bp-listbox-option"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setActiveValue(option.value);
                    onValueChange(option.value);
                  }}
                >
                  <span className="bp-listbox-text">
                    <span id={`${id}-label`}>{option.label}</span>
                    {option.badge ? (
                      <>
                        {" "}
                        <span id={`${id}-badge`} className="bp-badge">
                          {option.badge}
                        </span>
                      </>
                    ) : null}
                    {option.description ? <small id={`${id}-description`}>{option.description}</small> : null}
                  </span>
                  <span className="bp-listbox-check" data-check={selected ? "" : undefined}>
                    <Icon name="check" />
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {/* Outside the listbox (it may only own options), and always mounted so the change is announced. */}
      <div role="status" data-testid="listbox-empty-status">
        {visibleGroups.length === 0 ? <p className="bp-listbox-empty">{emptyState(query)}</p> : null}
      </div>
    </div>
  );
}
