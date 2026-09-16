// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Two-pane searchable explorer for the MCP tool/prompt/resource reference.
// Data defaults come from ./data (filled by the docs authoring pipeline);
// tests inject fixtures via props.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useDocumentationSectionTranslator } from "../section-localization";
import { useDocumentationCopy } from "../use-documentation-copy";
import { CATEGORIES_BY_ID, PROMPT_DOCS, RESOURCE_DOCS, TOOL_DOCS } from "./data";
import type { PromptDoc, ResourceDoc, ToolDoc } from "./data";
import { DetailPane, type ResolvedSelection } from "./DetailPane";
import { ReferenceNav, type KindFilter } from "./ReferenceNav";
import {
  parseSelectionHash,
  sameSelection,
  selectionHash,
  type ReferenceSelection,
} from "./selection";

interface McpToolReferenceProps {
  tools?: ToolDoc[];
  prompts?: PromptDoc[];
  resources?: ResourceDoc[];
}

export function McpToolReference({
  tools = TOOL_DOCS,
  prompts = PROMPT_DOCS,
  resources = RESOURCE_DOCS,
}: McpToolReferenceProps = {}) {
  const { copy } = useDocumentationCopy();
  const translate = useDocumentationSectionTranslator();
  const location = useLocation();
  const navigate = useNavigate();
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  // Mobile pane swaps unmount the element that held focus; this remembers
  // where to land it — set ONLY on user-initiated select() calls so hash
  // deep-links and browser back/forward never steal focus.
  const pendingFocusRef = useRef<
    | { target: "detail" }
    | { target: "nav"; previous: NonNullable<ReferenceSelection> }
    | null
  >(null);

  const [selection, setSelection] = useState<ReferenceSelection>(() =>
    parseSelectionHash(location.hash),
  );
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");

  // Hash is the source of truth for deep links: external '#tool-x' URLs land
  // here. Entering a selection pushes a history entry (so mobile browser back
  // returns to the list); selection switches replace to keep history clean.
  useEffect(() => {
    const fromHash = parseSelectionHash(location.hash);
    setSelection((current) =>
      sameSelection(current, fromHash) ? current : fromHash,
    );
  }, [location.hash]);

  const select = useCallback(
    (next: ReferenceSelection) => {
      if (!isDesktop) {
        pendingFocusRef.current =
          next !== null
            ? { target: "detail" }
            : selection !== null
              ? { target: "nav", previous: selection }
              : null;
      }
      const enteringSelection = selection === null && next !== null;
      setSelection(next);
      navigate(
        `${location.pathname}${location.search}${next ? selectionHash(next) : ""}`,
        { replace: !enteringSelection },
      );
    },
    [navigate, location.pathname, location.search, selection, isDesktop],
  );

  // '/' focuses search unless the user is already typing somewhere.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const query = search.trim().toLowerCase();
  const matchesQuery = useCallback(
    (...fields: string[]) =>
      !query ||
      fields.some(
        (field) =>
          field.toLowerCase().includes(query) ||
          translate(field).toLowerCase().includes(query),
      ),
    [query, translate],
  );

  const visibleTools = useMemo(
    () =>
      tools.filter((tool) => {
        if (kindFilter !== "all" && tool.kind !== kindFilter) return false;
        const categoryTitle = CATEGORIES_BY_ID.get(tool.category)?.title ?? "";
        return matchesQuery(tool.name, tool.description, categoryTitle);
      }),
    [tools, kindFilter, matchesQuery],
  );
  const visiblePrompts = useMemo(
    () =>
      prompts.filter((prompt) =>
        matchesQuery(prompt.name, prompt.description),
      ),
    [prompts, matchesQuery],
  );
  const visibleResources = useMemo(
    () =>
      resources.filter((resource) =>
        matchesQuery(resource.uri, resource.description),
      ),
    [resources, matchesQuery],
  );

  // Consume the pending focus target once the pane swap has rendered.
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    pendingFocusRef.current = null;
    if (isDesktop) return;
    if (pending.target === "detail") {
      detailRef.current?.focus();
      return;
    }
    // A related-tool chip can select a tool the current search/filter hides,
    // so its nav button may not exist after back — land on search instead.
    const navButton = document.querySelector<HTMLElement>(
      `[data-selection="${CSS.escape(`${pending.previous.kind}-${pending.previous.id}`)}"]`,
    );
    (navButton ?? searchRef.current)?.focus();
  }, [selection, isDesktop]);

  const resolved: ResolvedSelection | null = useMemo(() => {
    if (!selection) return null;
    if (selection.kind === "tool") {
      const tool = tools.find((t) => t.name === selection.id);
      return tool ? { kind: "tool", tool } : null;
    }
    if (selection.kind === "prompt") {
      const prompt = prompts.find((p) => p.name === selection.id);
      return prompt ? { kind: "prompt", prompt } : null;
    }
    const resource = resources.find((r) => r.uri === selection.id);
    return resource ? { kind: "resource", resource } : null;
  }, [selection, tools, prompts, resources]);

  const selectTool = useCallback(
    (name: string) => select({ kind: "tool", id: name }),
    [select],
  );

  const navPane = (
    <ReferenceNav
      tools={visibleTools}
      prompts={visiblePrompts}
      resources={visibleResources}
      selection={selection}
      onSelect={select}
      search={search}
      onSearchChange={setSearch}
      kindFilter={kindFilter}
      onKindFilterChange={setKindFilter}
      searchRef={searchRef}
    />
  );

  const noMatches =
    visibleTools.length === 0 &&
    visiblePrompts.length === 0 &&
    visibleResources.length === 0;

  if (!isDesktop) {
    return resolved ? (
      <DetailPane
        resolved={resolved}
        onSelectTool={selectTool}
        onBack={() => select(null)}
        focusRef={detailRef}
      />
    ) : (
      navPane
    );
  }

  return (
    <div className="grid items-start gap-8 md:grid-cols-[270px_minmax(0,1fr)]">
      {navPane}
      {resolved ? (
        <DetailPane
          resolved={resolved}
          onSelectTool={selectTool}
          focusRef={detailRef}
        />
      ) : (
        <div className="rounded-[var(--radius-md)] border border-dashed border-border/70 p-8 text-sm text-muted-foreground">
          {noMatches ? (
            <>
              {copy.mcpReference.noResultsDetail}
            </>
          ) : (
            <>
              {copy.mcpReference.selectDetailBeforeShortcut}{" "}
              <kbd className="rounded-[var(--radius-sm)] border border-border/70 px-1 font-mono">
                /
              </kbd>{" "}
              {copy.mcpReference.selectDetailAfterShortcut}
            </>
          )}
        </div>
      )}
    </div>
  );
}
