// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { Tabs, type TabItem } from "../../components/Tabs";
import type { DiscoveredProject } from "../../ipc/bindings";
import { ViewSwap } from "../../motion/ViewSwap";
import type { ViewSwapKind } from "../../motion/variants";
import { showToast } from "../../shell/layers";
import { overviewResource, useBoardsCatalog, useDiscovered, useIgnored, useMappings, type ProjectMapping } from "../../stores/projects";
import { useStoreSelector } from "../../stores/external-store";
import { addProjectFolder } from "../shared/add-project-folder";
import { bindTargetFor } from "./bind-flow";
import { openBindSheet } from "./open-bind-sheet";
import { BoundPanel } from "./BoundPanel";
import { FoundPanel } from "./FoundPanel";
import { IgnoredPanel } from "./IgnoredPanel";
import { safeRepo } from "./repo";
import { useCatalogRefreshOnReturn } from "../shared/catalog-refresh";
import { RulesPanel } from "./RulesPanel";
import "./projects.css";

const SUB_TABS = ["bound", "found", "ignored", "rules"] as const;
type SubTab = (typeof SUB_TABS)[number];

const TAB_ID_PREFIX = "projects-tab";
const PANEL_ID = "projects-panel";

const folders = (count: number) => (count === 1 ? "1 folder" : `${count} folders`);

function coveredByMapping(project: DiscoveredProject, mappings: readonly ProjectMapping[]): boolean {
  const repo = safeRepo(project.repo_url);
  return mappings.some((mapping) => mapping.root_path === project.root || (!mapping.root_path && repo !== null && mapping.repo_url_normalized === repo));
}

/**
 * Rows taken out on success, before the daemon's next list confirms it. Each
 * is forgotten once a list arrives that no longer shows it.
 */
function useLeftRows(stillListed: (key: string) => boolean, listVersion: unknown) {
  const [left, setLeft] = useState<ReadonlySet<string>>(() => new Set());
  const [seenVersion, setSeenVersion] = useState(listVersion);
  // Adjusted while rendering when a new list arrives (React's "derive from props" pattern).
  if (seenVersion !== listVersion) {
    setSeenVersion(listVersion);
    const kept = [...left].filter(stillListed);
    if (kept.length !== left.size) setLeft(new Set(kept));
  }
  const leave = (key: string) => setLeft((current) => new Set(current).add(key));
  return [left, leave] as const;
}

export function ProjectsScreen() {
  const [tab, setTab] = useState<SubTab>("bound");
  const [swap, setSwap] = useState<ViewSwapKind>("none");
  const focusTabAfterSwitch = useRef(false);
  const mappings = useMappings();
  const discovered = useDiscovered();
  const ignored = useIgnored();
  const catalog = useBoardsCatalog();
  useCatalogRefreshOnReturn();
  const overview = useStoreSelector(overviewResource.store, (value) => value);

  const [leftFound, leaveFound] = useLeftRows(
    (root) => discovered.some((project) => project.root === root && !coveredByMapping(project, mappings)),
    overview,
  );
  const [leftIgnored, leaveIgnored] = useLeftRows((path) => ignored.includes(path), overview);

  const found = useMemo(
    () => discovered.filter((project) => !leftFound.has(project.root) && !coveredByMapping(project, mappings)),
    [discovered, mappings, leftFound],
  );
  const stillIgnored = useMemo(() => ignored.filter((path) => !leftIgnored.has(path)), [ignored, leftIgnored]);

  const selectTab = (next: SubTab, { focusTab = false } = {}) => {
    if (next === tab) return;
    setSwap(SUB_TABS.indexOf(next) > SUB_TABS.indexOf(tab) ? "right" : "left");
    focusTabAfterSwitch.current = focusTab;
    setTab(next);
  };

  // "Edit rules" leaves with its row's view: focus follows to the Rules tab.
  useLayoutEffect(() => {
    if (!focusTabAfterSwitch.current) return;
    focusTabAfterSwitch.current = false;
    document.getElementById(`${TAB_ID_PREFIX}-${tab}`)?.focus({ preventScroll: true });
  }, [tab]);

  // From Bound the picked folder is bound straight away; it stays under Found if the sheet is cancelled.
  const addFolderToBind = async (opener: HTMLElement) => {
    const outcome = await addProjectFolder();
    if (outcome.status === "failed") showToast(outcome.message, { tone: "error" });
    if (outcome.status !== "added") return;
    overviewResource.invalidate();
    const { project } = outcome;
    openBindSheet(bindTargetFor(project, catalog), opener, () => leaveFound(project.root));
  };

  const items: TabItem<SubTab>[] = [
    { id: "bound", label: "Bound", count: mappings.length, countLabel: folders(mappings.length) },
    { id: "found", label: "Found", count: found.length, countLabel: `${found.length} not captured yet` },
    { id: "ignored", label: "Ignored", count: stillIgnored.length, countLabel: folders(stillIgnored.length) },
    { id: "rules", label: "Rules" },
  ];

  return (
    <div className="projects-screen" data-testid="screen-projects">
      <Tabs label="Project lists" variant="sub" idPrefix={TAB_ID_PREFIX} panelId={PANEL_ID} items={items} value={tab} onValueChange={(next) => selectTab(next)} />
      <ViewSwap viewKey={tab} kind={swap} id={PANEL_ID} role="tabpanel" aria-labelledby={`${TAB_ID_PREFIX}-${tab}`} viewClassName="projects-view">
        {tab === "bound" ? (
          <BoundPanel mappings={mappings} discovered={discovered} onAddFolder={(opener) => void addFolderToBind(opener)} />
        ) : tab === "found" ? (
          <FoundPanel
            projects={found}
            mappings={mappings}
            catalog={catalog}
            onEditRules={() => selectTab("rules", { focusTab: true })}
            onLeave={leaveFound}
          />
        ) : tab === "ignored" ? (
          <IgnoredPanel paths={stillIgnored} onLeave={leaveIgnored} />
        ) : (
          <RulesPanel />
        )}
      </ViewSwap>
    </div>
  );
}
