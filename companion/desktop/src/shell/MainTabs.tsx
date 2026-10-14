// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { Tabs, type TabItem } from "../components/Tabs";
import { attentionStore, statusStore } from "../stores/daemon-stream";
import { useStoreSelector } from "../stores/external-store";
import { selectTab, type MainTab } from "./navigation";
import { AGENT_PROBLEM_STATES } from "./status-model";

export const SHELL_PANEL_ID = "shell-panel";
export const MAIN_TAB_ID_PREFIX = "tab";

export function MainTabs({ tab }: { tab: MainTab }) {
  const discovered = useStoreSelector(statusStore, (status) => status?.pending_projects.length ?? 0);
  const agentInProblemState = useStoreSelector(statusStore, (status) => status?.agents.some((agent) => AGENT_PROBLEM_STATES.has(agent.state)) ?? false);
  const attentionNamesAgent = useStoreSelector(attentionStore, (items) => items.some((item) => item.agent !== null));
  const agentsNeedYou = agentInProblemState || attentionNamesAgent;
  const items: TabItem<MainTab>[] = [
    { id: "home", label: "Home" },
    discovered > 0 ? { id: "projects", label: "Projects", count: discovered, countLabel: `${discovered} not captured yet` } : { id: "projects", label: "Projects" },
    { id: "agents", label: "Agents", dot: agentsNeedYou, dotLabel: "needs attention" },
  ];
  return <Tabs label="Sections" idPrefix={MAIN_TAB_ID_PREFIX} panelId={SHELL_PANEL_ID} items={items} value={tab} onValueChange={selectTab} />;
}
