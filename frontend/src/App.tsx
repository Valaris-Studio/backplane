// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Suspense, lazy } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { SearchPreservingNavigate } from "@/components/shared/SearchPreservingNavigate";
import { ParamRedirect } from "@/components/shared/ParamRedirect";
import { RouteFallback } from "@/components/layout/RouteFallback";
import { WorkspaceLayout } from "@/pages/WorkspaceLayout";
import { AuthModesBootstrap } from "@/features/auth/components/AuthModesBootstrap";
import { BackendStartingGate } from "@/features/auth/components/BackendStartingGate";
import { LoginPage } from "@/features/auth/components/LoginPage";
import { SetupPage } from "@/features/auth/components/SetupPage";
import { SetupGate } from "@/features/auth/components/SetupGate";
import { useSetupStatus } from "@/features/auth/api/use-setup-status";

// Every page module is lazy so its (and its heavy deps') chunk only downloads
// when its route is visited. AppShell stays eager — it's the persistent chrome
// rendered on every authenticated route, and keeping it static avoids a
// full-shell flash on the first in-app navigation. Page modules use named
// exports, so each import is remapped to a default for React.lazy().
const lazyPage = <T extends Record<string, unknown>, K extends keyof T>(
  loader: () => Promise<T>,
  name: K,
) => lazy(() => loader().then((m) => ({ default: m[name] as React.ComponentType })));

const WorkspacesPage = lazyPage(() => import("@/pages/WorkspacesPage"), "WorkspacesPage");
const Dashboard = lazyPage(() => import("@/pages/Dashboard"), "Dashboard");
const BoardsPage = lazyPage(() => import("@/pages/kanban/BoardsPage"), "BoardsPage");
const BoardLayout = lazyPage(() => import("@/pages/kanban/BoardLayout"), "BoardLayout");
const BoardKanbanPage = lazyPage(() => import("@/pages/kanban/BoardKanbanPage"), "BoardKanbanPage");
const BoardDefinitionsPage = lazyPage(() => import("@/pages/kanban/BoardDefinitionsPage"), "BoardDefinitionsPage");
const BoardResourcesPage = lazyPage(() => import("@/pages/kanban/BoardResourcesPage"), "BoardResourcesPage");
const BoardNotesPage = lazyPage(() => import("@/pages/kanban/BoardNotesPage"), "BoardNotesPage");
const BoardHistoryPage = lazyPage(() => import("@/pages/kanban/BoardHistoryPage"), "BoardHistoryPage");
const BoardTimelinePage = lazyPage(() => import("@/pages/kanban/BoardTimelinePage"), "BoardTimelinePage");
const BoardGitPage = lazyPage(() => import("@/pages/kanban/BoardGitPage"), "BoardGitPage");
const BoardAlertsPage = lazyPage(() => import("@/pages/kanban/BoardAlertsPage"), "BoardAlertsPage");
const WorkspaceResourcesPage = lazyPage(() => import("@/pages/WorkspaceResourcesPage"), "WorkspaceResourcesPage");
const WorkspaceChannelsPage = lazyPage(() => import("@/pages/WorkspaceChannelsPage"), "WorkspaceChannelsPage");
const WorkspaceNotesPage = lazyPage(() => import("@/pages/WorkspaceNotesPage"), "WorkspaceNotesPage");
const WorkspaceMembersPage = lazyPage(() => import("@/pages/WorkspaceMembersPage"), "WorkspaceMembersPage");
const WorkspaceHistoryPage = lazyPage(() => import("@/pages/WorkspaceHistoryPage"), "WorkspaceHistoryPage");
const WorkspaceApprovalsPage = lazyPage(() => import("@/pages/WorkspaceApprovalsPage"), "WorkspaceApprovalsPage");
const WorkspaceMergeQueuePage = lazyPage(() => import("@/pages/WorkspaceMergeQueuePage"), "WorkspaceMergeQueuePage");
const WorkspaceSkillsPage = lazyPage(() => import("@/pages/WorkspaceSkillsPage"), "WorkspaceSkillsPage");
const AgentDetailPage = lazyPage(() => import("@/pages/AgentDetailPage"), "AgentDetailPage");
const ExecutionDetailPage = lazyPage(() => import("@/pages/ExecutionDetailPage"), "ExecutionDetailPage");
const WorkspaceSettingsPage = lazyPage(() => import("@/pages/WorkspaceSettingsPage"), "WorkspaceSettingsPage");
const PromptConfigPage = lazyPage(() => import("@/pages/PromptConfigPage"), "PromptConfigPage");
const TeamDetailPageView = lazyPage(() => import("@/pages/TeamDetailPageView"), "TeamDetailPageView");
const RunnerLayout = lazyPage(() => import("@/pages/runner/RunnerLayout"), "RunnerLayout");
const RunnerOverviewTab = lazyPage(() => import("@/pages/runner/RunnerOverviewTab"), "RunnerOverviewTab");
const RunnerRunnersTab = lazyPage(() => import("@/pages/runner/RunnerRunnersTab"), "RunnerRunnersTab");
const RunnerTeamsTab = lazyPage(() => import("@/pages/runner/RunnerTeamsTab"), "RunnerTeamsTab");
const RunnerActivityTab = lazyPage(() => import("@/pages/runner/RunnerActivityTab"), "RunnerActivityTab");
const RunnerPipelineTab = lazyPage(() => import("@/pages/runner/RunnerPipelineTab"), "RunnerPipelineTab");
const RunnerLoopsTab = lazyPage(() => import("@/pages/runner/RunnerLoopsTab"), "RunnerLoopsTab");
const LoopTemplateDetailPage = lazyPage(() => import("@/features/loop-templates/components/LoopTemplateDetailPage"), "LoopTemplateDetailPage");
const ComponentListPage = lazyPage(() => import("@/pages/ComponentListPage"), "ComponentListPage");
const DocumentationPage = lazyPage(() => import("@/pages/DocumentationPage"), "DocumentationPage");
const DocumentationLanding = lazyPage(() => import("@/pages/documentation"), "DocumentationLanding");
const DocumentationSection = lazyPage(() => import("@/pages/documentation"), "DocumentationSection");
const DocumentationStandalone = lazyPage(() => import("@/pages/documentation"), "DocumentationStandalone");

// A fresh instance (empty users table) routes to first-run setup regardless
// of the requested private path; standalone documentation stays public.
function FirstRunRedirect() {
  const { data } = useSetupStatus();
  const location = useLocation();
  const publicDocs = location.pathname === "/documentation" || location.pathname.startsWith("/documentation/");
  if (data?.needs_setup && location.pathname !== "/setup" && !publicDocs) {
    return <Navigate to="/setup" replace />;
  }
  return null;
}

export function App() {
  return (
    // Top-level boundary catches the first lazy page on a cold load (e.g. "/"
    // → WorkspacesPage) and the AppShell-nested layouts on their initial mount.
    // The layouts add their own inner boundaries (below) so tab switches don't
    // tear down the chrome.
    <Suspense fallback={<RouteFallback />}>
      <BackendStartingGate>
        <AuthModesBootstrap />
        <FirstRunRedirect />
        <SetupGate>
          <Routes>
            <Route path="/" element={<WorkspacesPage />} />
            {/* Sign-in surface for the OIDC session tier. Static, so it outranks
                /:slug — and reachable while signed out, unlike everything else. */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/setup" element={<SetupPage />} />
            {/* Slug-independent docs: readable before any workspace exists.
                The static segment outranks /:slug, so no route collision. */}
            <Route path="/documentation" element={<DocumentationStandalone />}>
              <Route index element={<DocumentationLanding />} />
              <Route path=":sectionSlug" element={<DocumentationSection />} />
            </Route>
            {/* Everything below is workspace-scoped. WorkspaceLayout resolves
                /:slug first and holds the page until it does, so a bad slug costs
                ONE request instead of the whole dashboard's fan-out. It owns the
                AppShell so the chrome survives the not-found screen while its
                workspace-scoped badges stay quiet on an unresolved slug. */}
            <Route element={<WorkspaceLayout />}>
              <Route path="/:slug" element={<Dashboard />} />
              <Route path="/:slug/boards" element={<BoardsPage />} />
              <Route path="/:slug/boards/:boardId" element={<BoardLayout />}>
                {/* Preserve the query string: ?card=<id> deep links arrive at the
                    bare board path and must survive the redirect to the kanban tab. */}
                <Route index element={<SearchPreservingNavigate to="kanban" />} />
                <Route path="kanban" element={<BoardKanbanPage />} />
                <Route path="definitions" element={<BoardDefinitionsPage />} />
                <Route path="resources" element={<BoardResourcesPage />} />
                <Route path="notes" element={<BoardNotesPage />} />
                <Route path="history" element={<BoardHistoryPage />} />
                <Route path="timeline" element={<BoardTimelinePage />} />
                <Route path="git" element={<BoardGitPage />} />
                <Route path="alerts" element={<BoardAlertsPage />} />
              </Route>
              <Route path="/:slug/resources" element={<WorkspaceResourcesPage />} />
              <Route path="/:slug/channels" element={<WorkspaceChannelsPage />} />
              <Route path="/:slug/notes" element={<WorkspaceNotesPage />} />
              <Route path="/:slug/members" element={<WorkspaceMembersPage />} />
              <Route path="/:slug/approvals" element={<WorkspaceApprovalsPage />} />
              <Route path="/:slug/skills" element={<WorkspaceSkillsPage />} />
              <Route path="/:slug/merge-queue" element={<WorkspaceMergeQueuePage />} />
              {/* Track-2 Runner Console (additive): the consolidated /:slug/runner
                  tree unifies the scattered /:slug/agents/* surface under one tabbed
                  shell. Redesign collapses 6 tabs → 4: Overview, Pipeline (graph-first,
                  with each role's lifecycle + prompts folded in), Runners (with the
                  per-runner role binding folded in from Teams), and Activity. Detail
                  pages (runner, execution) mount INSIDE the console so drill-in stays
                  in-shell. The legacy /:slug/agents/* routes below stay live as an
                  untouched fallback. */}
              <Route path="/:slug/runner" element={<RunnerLayout />}>
                <Route index element={<Navigate to="overview" replace />} />
                <Route path="overview" element={<RunnerOverviewTab />} />
                <Route path="pipeline" element={<RunnerPipelineTab />} />
                {/* Loop-template manager. The detail route is a sibling so the
                    Loops tab stays highlighted while drilled into a template. */}
                <Route path="loops" element={<RunnerLoopsTab />} />
                {/* Sub-tabs are ROUTES, not local state, so every section of a
                    template is deep-linkable; an unknown :tab renders profile. */}
                <Route path="loops/:templateRef/:tab?" element={<LoopTemplateDetailPage />} />
                <Route path="runners" element={<RunnerRunnersTab />} />
                <Route path="runners/:agentId" element={<AgentDetailPage />} />
                <Route path="activity" element={<RunnerActivityTab />} />
                <Route path="executions/:executionId" element={<ExecutionDetailPage />} />
                {/* M2 folded Roles + Prompts into the Pipeline tab (click a role node →
                    capabilities + prompts). The standalone prompt-config page stays
                    reachable in-shell for the "create new stage" + all-roles workflow
                    and is linked from the graph's Advanced editor. Teams stays
                    transitional until M3 folds the role-binding into Runners. */}
                <Route path="prompts" element={<PromptConfigPage />} />
                <Route path="teams" element={<RunnerTeamsTab />} />
              </Route>
              {/* The legacy /:slug/agents/* surface is fully retired: every route
                  redirects into the canonical /:slug/runner/* console. Roles folded
                  into the Pipeline tab; prompts keep their standalone page, whose
                  ?role[&stage]= deep link survives via ParamRedirect's query
                  preservation. Param routes (:agentId, :executionId) interpolate
                  through ParamRedirect. */}
              <Route path="/:slug/agents" element={<ParamRedirect to={(p) => `/${p.slug}/runner/overview`} />} />
              <Route path="/:slug/agents/prompts" element={<ParamRedirect to={(p) => `/${p.slug}/runner/prompts`} />} />
              <Route path="/:slug/agents/pipeline" element={<ParamRedirect to={(p) => `/${p.slug}/runner/pipeline`} />} />
              <Route path="/:slug/agents/roles" element={<ParamRedirect to={(p) => `/${p.slug}/runner/pipeline`} />} />
              <Route path="/:slug/teams/:teamId" element={<TeamDetailPageView />} />
              <Route
                path="/:slug/agents/executions/:executionId"
                element={<ParamRedirect to={(p) => `/${p.slug}/runner/executions/${p.executionId}`} />}
              />
              <Route
                path="/:slug/agents/:agentId"
                element={<ParamRedirect to={(p) => `/${p.slug}/runner/runners/${p.agentId}`} />}
              />
              <Route path="/:slug/history" element={<WorkspaceHistoryPage />} />
              <Route path="/:slug/settings" element={<WorkspaceSettingsPage />} />
              <Route path="/:slug/component-list" element={<ComponentListPage />} />
              <Route path="/:slug/documentation" element={<DocumentationPage />}>
                <Route index element={<DocumentationLanding />} />
                <Route path=":sectionSlug" element={<DocumentationSection />} />
              </Route>
            </Route>
          </Routes>
        </SetupGate>
      </BackendStartingGate>
    </Suspense>
  );
}
