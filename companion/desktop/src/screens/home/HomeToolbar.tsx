// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useState, type KeyboardEvent, type RefObject } from "react";

import { AgentTile } from "../../components/AgentTile";
import { Icon } from "../../components/Icon";
import { RadioMenuButton, type RadioMenuItem } from "../../components/Menu";
import { nextRovingIndex } from "../../components/roving-focus";
import { agentLabel } from "./agent-label";
import { HOME_SORT_LABEL, HOME_SORTS, type HomeSort } from "./session-view";

const SORT_ITEMS: readonly RadioMenuItem<HomeSort>[] = HOME_SORTS.map((sort) => ({ value: sort, label: HOME_SORT_LABEL[sort].long }));

interface FilterFieldProps {
  query: string;
  onQueryChange: (query: string) => void;
  fieldRef: RefObject<HTMLInputElement | null>;
  onArrowDown: () => void;
}

function FilterField({ query, onQueryChange, fieldRef, onArrowDown }: FilterFieldProps) {
  const clear = () => {
    onQueryChange("");
    fieldRef.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Escape with something to clear is handled here, so the popover stays open; an empty field lets it through.
    if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      onQueryChange("");
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onArrowDown();
    }
  };
  return (
    <div className="home-filter">
      <Icon name="search" />
      <input
        ref={fieldRef}
        type="search"
        className="bp-input"
        aria-label="Filter sessions by repository, board or agent"
        placeholder="Filter"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {query !== "" ? (
        <button type="button" className="home-filter-clear" aria-label="Clear filter" onClick={clear}>
          <Icon name="x" />
        </button>
      ) : (
        <kbd className="home-filter-key" aria-hidden="true">
          /
        </kbd>
      )}
    </div>
  );
}

interface AgentSoloProps {
  agents: readonly string[];
  solo: string | null;
  onSoloChange: (solo: string | null) => void;
}

/** The row tiles themselves are the toggles: single-select, and pressing the soloed tile clears it. */
function AgentSolo({ agents, solo, onSoloChange }: AgentSoloProps) {
  const [focused, setFocused] = useState<string | null>(null);
  const preferred = solo ?? focused;
  const tabStop = preferred !== null && agents.includes(preferred) ? preferred : agents[0];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tiles = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const next = nextRovingIndex(event.key, tiles.indexOf(event.target as HTMLButtonElement), tiles.length);
    if (next === null) return;
    event.preventDefault();
    tiles[next]?.focus();
  };

  return (
    <div className="home-agents" role="group" aria-label="Show one agent" data-solo={solo !== null} onKeyDown={onKeyDown}>
      {agents.map((agent) => (
        <button
          key={agent}
          type="button"
          className="home-agent"
          aria-pressed={agent === solo}
          aria-label={`Only ${agentLabel(agent)}`}
          title={`Only ${agentLabel(agent)}`}
          tabIndex={agent === tabStop ? 0 : -1}
          onFocus={() => setFocused(agent)}
          onClick={() => onSoloChange(agent === solo ? null : agent)}
        >
          <AgentTile agent={agent} size="sm" />
        </button>
      ))}
    </div>
  );
}

interface HomeToolbarProps extends FilterFieldProps, AgentSoloProps {
  showAgents: boolean;
  sort: HomeSort;
  onSortChange: (sort: HomeSort) => void;
}

export function HomeToolbar({ query, onQueryChange, fieldRef, onArrowDown, agents, solo, onSoloChange, showAgents, sort, onSortChange }: HomeToolbarProps) {
  return (
    <div className="home-tools" role="search" aria-label="Sessions">
      <FilterField query={query} onQueryChange={onQueryChange} fieldRef={fieldRef} onArrowDown={onArrowDown} />
      {showAgents ? <AgentSolo agents={agents} solo={solo} onSoloChange={onSoloChange} /> : null}
      <RadioMenuButton
        className="home-sort"
        buttonLabel={`Sort sessions: ${HOME_SORT_LABEL[sort].short}`}
        menuLabel="Sort sessions"
        items={SORT_ITEMS}
        value={sort}
        onValueChange={onSortChange}
        footer="Totals below always count all of today."
      >
        <Icon name="sort" />
        <span>{HOME_SORT_LABEL[sort].short}</span>
      </RadioMenuButton>
    </div>
  );
}
