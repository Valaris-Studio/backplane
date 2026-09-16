# Frontend & User-Facing Surface — Valaris Internal Platform

**Scope.** Everything under `frontend/src/`. Stack: React 19, TypeScript, Vite 6, Tailwind v4 (CSS-first), shadcn/ui (hand-written), React Query v5, React Router v7, dnd-kit, react-i18next, Sonner, Recharts, Tiptap, GSAP.

All paths below are absolute. Line references are accurate as of the working tree at time of write; a few call-outs flagged by older audit notes (`memory/audits/audit_frontend.md`, 2026-04-17) have since been fixed — those are noted inline.

---

## 1. Page Inventory

Routes are declared in one place: `frontend/src/App.tsx`. Everything except the root workspace picker renders inside `AppShell` (sidebar + topbar + main).

### 1.1 Top-level (no shell)

| Route | Page component | What the user does |
|-------|----------------|--------------------|
| `/` | `WorkspacesPage` (`src/pages/WorkspacesPage.tsx`) | Picks a workspace. Full-bleed hero, workspace grid, "Create workspace" dialog. Hosts the `LanguageSwitcher` and `ThemeSwitcher` at the page level because the shell is not mounted yet. |

### 1.2 Workspace shell (`/:slug/*`, renders `AppShell`)

`AppShell` (`src/components/layout/AppShell.tsx`) mounts `Sidebar` + `TopBar` + `<Outlet/>` and a floating `ObserverPanel` (see §1.5). Sidebar nav is defined as a flat array in `Sidebar.tsx:40-50`.

| Route | Page | Purpose |
|-------|------|---------|
| `/:slug` | `Dashboard` (`src/pages/Dashboard.tsx`) | Workspace overview: per-board stats, recent activity feed with per-action icons, quick-create buttons (board / note / channel), agent KPIs. `FirstRunPanel` walks a brand-new workspace through setup. |
| `/:slug/boards` | `BoardsPage` → `BoardList` (`features/kanban/components/BoardList.tsx`) | Board directory. Grid/list of boards with tags, health score badge, "Create board" dialog. |
| `/:slug/boards/:boardId` | `BoardLayout` (`src/pages/kanban/BoardLayout.tsx`) | Shared chrome for board tabs: header with name, health badge, active-runners badge, tag chips, settings dialog. Renders `TabNav` + `<Outlet/>`. Index route redirects to `kanban`. |
| `/:slug/boards/:boardId/kanban` | `BoardKanbanPage` → `BoardView` | Kanban view (see §3). |
| `/:slug/boards/:boardId/definitions` | `BoardDefinitionsPage` | Rich-text spec doc for the project (`features/definitions/`). Uses the shared Tiptap editor (`components/shared/RichTextEditor.tsx`). |
| `/:slug/boards/:boardId/resources` | `BoardResourcesPage` | File and link library scoped to the board. Upload, tag, preview (PDFs + images). |
| `/:slug/boards/:boardId/notes` | `BoardNotesPage` | Board-scoped notes (runner + human). Supports card-linked notes. |
| `/:slug/boards/:boardId/history` | `BoardHistoryPage` | Filtered activity feed for this board. |
| `/:slug/boards/:boardId/git` | `BoardGitPage` | Git repos attached to the board. |
| `/:slug/boards/:boardId/alerts` | `BoardAlertsPage` | Cost / velocity / quality thresholds and their recent breaches. |
| `/:slug/resources` | `WorkspaceResourcesPage` | Workspace-wide resource library (same component family, workspace scope). |
| `/:slug/channels` | `WorkspaceChannelsPage` | Communication channels (Slack/Discord-ish outbound hooks). |
| `/:slug/notes` | `WorkspaceNotesPage` | Workspace-level notes. |
| `/:slug/members` | `WorkspaceMembersPage` | Member directory, role management (admin-only actions gated). |
| `/:slug/approvals` | `WorkspaceApprovalsPage` | Pending runner approvals queue. Sidebar shows unread badge via `ApprovalBadge`. |
| `/:slug/history` | `WorkspaceHistoryPage` | Workspace-wide activity feed. |
| `/:slug/settings` | `PlatformSettingsPage` (`src/pages/PlatformSettingsPage.tsx`) | **MCP install surface.** Shows API keys, the MCP server config JSON to paste into a client, the `git+https://…` install URL, and Terminal / Code snippets. This is where an operator wires a coding agent to the platform. |

### 1.3 Agents / Runner surface (`/:slug/agents/*`)

| Route | Page | Purpose |
|-------|------|---------|
| `/:slug/agents` | `WorkspaceAgentsPage` → `AgentOverview` | Landing page for the runner operator. KPI cards (agents, success rate, avg duration, tokens), runner table, execution timeline, velocity/quality/cost/improvement panels, pending approvals, team panel, analytics dashboard (pies / stacks). Mounts `useConfigSync(slug)` to broadcast pipeline/prompt config changes workspace-wide. |
| `/:slug/agents/pipeline` | `PipelineBuilderPage` | Authoritative **pipeline editor** for the workspace (see §4). Admin-only. |
| `/:slug/agents/prompts` | `PromptConfigPage` | Per-stage prompt authoring. Two dimensions: role filter + stage. Loads `usePromptDefaults` (platform-provided) and `usePromptConfigs` (per-workspace overrides). Deep-linkable: `?role=…&stage=…` prefills the create dialog. |
| `/:slug/agents/roles` | `RolesGlossaryPage` | Read-only documentation page — six default roles (orchestrator, implementer, reviewer, documentator, planner, researcher) with `writesCode/writesNotes/mutatesBacklog` flags + any custom roles found in the pipeline. Used by the RichTooltip "Role glossary" deep-links. |
| `/:slug/agents/:agentId` | `AgentDetailPage` → `AgentDetail` | One runner: config, prompt, budget, execution history, tools used. |
| `/:slug/agents/executions/:executionId` | `ExecutionDetailPage` | One execution: status icon, duration, token/cost breakdown, tool invocation list, insights panel. Tabbed: overview / prompt. |
| `/:slug/teams/:teamId` | `TeamDetailPageView` → `TeamDetailPage` | Runner team composition — member runners, role assignments, pipeline diagram, export button. |

### 1.4 Hidden / admin routes

- **No explicit "admin" route segment.** Admin gating is per-page via `useWorkspaceAdmin(slug)` (`src/hooks/useWorkspaceAdmin.ts`). `PipelineBuilderPage` renders a 403-style message when not admin (`pipeline-builder/PipelineBuilderPage.tsx:266-278`).
- `/:slug/settings` is publicly routed but API-key creation requires admin on the backend.

### 1.5 Floating / non-route UI surfaces

- **`ObserverPanel`** (`src/features/observer/components/ObserverPanel.tsx`). Draggable floating panel, always mounted when `slug` is present (`AppShell.tsx:78`). Streams WS events in four namespaces — `card`, `agent`, `execution`, `approval` (`useObserverEvents.ts:6-11`) — with pause/resume, clear, namespace filters, and a persisted on-screen position (`localStorage` key `observer.position`). Admin-only UI inside the panel via `useWorkspaceAdmin`.
- **`AgentStatusBar`** (`features/kanban/components/AgentStatusBar.tsx`). Thin banner above the kanban view listing in-flight executions on the current board.
- **`CardDetailSheet`** (`features/kanban/components/CardDetailSheet.tsx`). Right-side sheet, opens when a kanban card is clicked.
- **`BoardSettingsDialog`** modal from the board header cog icon.
- **Toasts** via `sonner` (imported ad-hoc; no global `<Toaster/>` shown in this scan — verify if absent).

---

## 2. Feature Module Structure

Every domain lives in `src/features/{name}/` with the canonical split:

```
features/{name}/
├── api/           React Query hooks (queries + mutations)
├── components/    Presentational + container components
├── hooks/         Local feature hooks (UI state, derived selectors)
└── utils/         Pure helpers (formatters, validators)
```

Not every module uses every subdir; `api/` + `components/` is the minimum. Inventory:

| Module | api | components | hooks | utils | Scope |
|--------|-----|-----------|-------|-------|-------|
| `activity` | ✓ | ✓ |  |  | Activity feeds + filters |
| `agents` | ✓ | ✓ | ✓ | ✓ (+`lib/`) | Runners, teams, pipeline builder, prompts, analytics |
| `alerts` | ✓ | ✓ | ✓ |  | Cost / velocity / quality thresholds |
| `approvals` | ✓ | ✓ | ✓ |  | Approval queue + sidebar badge |
| `channels` | ✓ | ✓ |  |  | Workspace channels |
| `dashboard` | ✓ | ✓ |  |  | Summary widgets + FirstRunPanel |
| `definitions` | ✓ | ✓ |  | ✓ | Board definition (rich text) |
| `git` | ✓ | ✓ |  |  | Board git repo wiring |
| `kanban` | ✓ | ✓ | ✓ | ✓ | Board / column / card UI, DnD |
| `members` | ✓ | ✓ |  |  | Workspace membership |
| `notes` | ✓ | ✓ |  |  | Notes (workspace + board + card) |
| `observer` |  | ✓ | ✓ | ✓ | Floating WS event viewer |
| `resources` | ✓ | ✓ | ✓ | ✓ | File/link library + tag filters |
| `settings` | ✓ | ✓ |  |  | API keys + MCP install |
| `workspaces` | ✓ | ✓ |  |  | Workspace picker + create |

Notable extras inside `features/agents/`:

- `agents/api/pipelineConfig.ts`, `agents/api/prompts.ts` — raw axios + Zod-ish validation. Schemas are mirrored from backend Pydantic models; any drift is a known risk.
- `agents/lib/pipelineValidation.ts` — client-side validator mirroring `backend/app/schemas/pipeline_config.py`.
- `agents/utils/stageTemplates.ts` — starter templates for new pipeline stages.
- `agents/components/pipeline-builder/` — 10 files, the most complex surface in the app.

---

## 3. Board Experience (Kanban)

Entry: `features/kanban/components/BoardView.tsx`. Everything hangs off `useBoard(slug, boardId)` which returns the full board — columns and cards — in one request via eager loading on the backend.

### 3.1 Layout & composition

```
BoardLayout (header, health badge, active-runners badge, tabs)
 └── BoardKanbanPage
      └── BoardView
           ├── AgentStatusBar  (active executions)
           ├── DndContext
           │    ├── KanbanColumn[] (ColumnHeader + ScrollArea of KanbanCard + "Add card")
           │    └── "Add column" dashed button
           ├── DragOverlay (portalled clone of the dragged card)
           ├── CardDetailSheet
           └── CreateColumnDialog
```

Columns are rendered sorted by `position` (fractional float). Each column registers as a dnd-kit droppable (`KanbanColumn.tsx:58-61`). Each card is a sortable. The board-level `DndContext` uses a custom collision detection (see §3.3).

### 3.2 Fractional indexing on the client

`features/kanban/utils/position.ts` is the entire position algorithm:

```ts
export function calculatePosition(before?: number, after?: number): number {
  if (before != null && after != null) return (before + after) / 2;
  if (after != null) return after / 2;
  if (before != null) return before + 1024;
  return 1024;
}
```

Clients compute the next position locally and send it in the move payload; backend just persists. Same pattern for columns. See the comment blocks in `hooks/use-kanban-dnd.ts:105-180` for the drag-down versus drag-up midpoint logic and for the same-column no-op short-circuit.

### 3.3 Collision detection (multi-column sortable)

`use-kanban-dnd.ts:37-63` builds a three-stage collision detector that works around dnd-kit's default `closestCorners` mis-targeting:

1. `pointerWithin` first — authoritative user intent, excluding the active card from candidates.
2. Fall back to `rectIntersection` when the pointer briefly clears all droppables.
3. Final fallback: `closestCenter` **restricted to columns only**, to avoid a card in column Y winning a drop aimed at column X.

This fixes the "moved from Done to Done" bug noted in the inline comment.

### 3.4 Optimistic card moves

`features/kanban/hooks/use-optimistic-card-move.ts` — classic React Query optimistic pattern:

- `onMutate` snapshots the board query, removes the card from its old column, inserts at the new `(column_id, position)` and re-sorts.
- `onError` restores the snapshot.
- `onSettled` invalidates the board key.

Single source of truth for the query key: `boardKeys.detail(slug, boardId)` from `lib/query-keys.ts`.

There is also a dedupe seatbelt in `KanbanColumn.tsx:68-73` — if an optimistic write and a WS-triggered refetch race and briefly deliver the same card twice, the component dedupes by id so dnd-kit's `SortableContext` doesn't see duplicate keys.

### 3.5 Card interactions

- **Click** → opens `CardDetailSheet`.
- **Drag** → pointer-sensor with 5-px activation distance (`use-kanban-dnd.ts:74-78`). Drag overlay portalled to `document.body`, slightly rotated.
- **Rich tooltip** on runner badges: "agent active / eligible / touched / awaiting prompt" — uses `ui.tooltips.kanbanCardAgent*` i18n keys.
- **Visual priority / type styling**: `KanbanCard.tsx:21-40` maps card type and priority to Tailwind design-token classes (no hex strings).
- **Skipped-execution indicator** via `useCardHasSkippedExecution` — surfaces "runner tried but no prompt authored" state directly on the card.

### 3.6 Board tabs

The seven-tab `TabNav` in `BoardLayout.tsx:27-35`: kanban, definitions, resources, notes, history, git, alerts. Labels are i18n keys (`boardTabs.*`). Icons from `lucide-react`. All tabs share the same board query; each tab fetches its own feature data on mount.

---

## 4. Runner / Pipeline UX

The runner surface is the densest part of the app. Three distinct pages plus the overview.

### 4.1 `AgentOverview` (`/:slug/agents`)

`features/agents/components/AgentOverview.tsx`. Panels:

- **MetricCard** strip: total agents, success rate, avg duration, total tokens.
- **AgentTable**: list of runners, inline toggle `showInactive`.
- **ExecutionTimeline**: chronological list of recent executions.
- **VelocityPanel / QualityPanel / CostPanel / ImprovementPanel**: derived metrics with charts (`recharts`).
- **PendingApprovalsPanel**: links into `/:slug/approvals`.
- **TeamPanel**: team roster.
- **AnalyticsDashboard**: pies + stacked bars split by role.
- **CreateAgentDialog**: admin-gated runner creation.

`useConfigSync(slug)` is mounted here and acts as a workspace-wide broadcaster: when `config.*` WS events arrive, it invalidates pipeline, team, and prompt caches so anyone viewing this page picks up changes. Other pages (e.g. `TeamDetailPage`) do not currently mount this — the older audit flagged that as a gap.

### 4.2 Pipeline builder (`/:slug/agents/pipeline`)

`features/agents/components/pipeline-builder/PipelineBuilderPage.tsx`. This is the **most complex page in the app** and the one the user has repeatedly flagged as rough. Mechanics:

- Admin gate: `useWorkspaceAdmin(slug)` → friendly fallback message if not admin.
- Remote data: `useWorkspaceConfig(slug)` → `{ pipeline_config, version, ... }`; sensor catalog: `useSensorCatalog(slug)`.
- Local draft: `DraftPipelineConfig` — deep-cloned remote with a synthesized `_dndId` on each stage so role renames don't break dnd-kit keys (`PipelineBuilderPage.tsx:55-82`).
- DnD: `DndContext` with `SortableContext` on `stages.map(s => s._dndId)` using `verticalListSortingStrategy`. Each stage is a `SortableStageCard` with its own expand/collapse state.
- Validation: `validatePipelineConfig(draft, knownSensorSet)` runs client-side every keystroke (`lib/pipelineValidation.ts`); server returns structured `PipelineValidationError[]` on save which overrides client errors until the draft next changes.
- Optimistic concurrency: `expected_version` is sent with every save; a 409 with `{code: "stale_version", current_version, expected_version}` opens `PipelineDriftDialog` offering **Reload** (discard local) or **Override** (force-save).
- Export button (`ExportButton`) downloads the canonical JSON from `/workspaces/{slug}/config/pipeline/export` — the file an operator ships to another workspace.
- Post-save: the server response re-seeds the draft because the backend canonicalises (e.g. auto-extends `scheduling.priority_order` with any stage roles the operator omitted). Comment in `PipelineBuilderPage.tsx:199-204`.

Per stage (`SortableStageCard.tsx`), the operator sees a collapsed summary and an expanded editor with:

- Role name (free text — the pipeline contract supports arbitrary roles; defaults like `orchestrator`, `implementer`, `reviewer`, `documentator`, `planner`, `researcher` are starting points).
- **Strategy section** — `discover.strategy` + `column_type` + filters. Hosts the RichTooltip **showcase** (`pipelineDiscoverStrategy` key — rows + callouts + code block + examples + sections). See §5 for its API.
- LLM / tool / action / sensor / post-process config.
- DnD grip, delete button, per-field validation errors (`FieldError`).

Hardcoded enum duplication that still exists (`SortableStageCard.tsx:31-41`) — `DISCOVER_STRATEGIES`, `COLUMN_TYPES`, `CLAIM_ROLES`, `GIT_ACTIONS`, `POST_PROCESS_KINDS` — is a backend contract in `backend/app/schemas/pipeline_config.py`. Drift risk called out as Major in the frontend audit.

### 4.3 Prompt authoring (`/:slug/agents/prompts`)

`features/agents/components/PromptConfigPage.tsx`. UX flow:

- Role tabs driven by the live pipeline (`ROLES = ["all", ...pipelineRoles]`) — custom roles the operator added to their pipeline appear automatically.
- For each role, default platform prompts (`usePromptDefaults`) are listed and can be **overridden** by creating a `PromptConfig` row.
- Deep-link from other pages: `?role=reviewer&stage=implement` auto-opens the create dialog pre-filled, then clears the query string.
- Textarea editor (no syntax highlight) + title row + "Save / Reset" actions. Server returns structured errors on conflicts.

### 4.4 Runner launch walkthrough (end-to-end)

The user journey an operator takes to launch a runner, stitched across routes:

1. `/` → pick workspace.
2. `/:slug/settings` → grab API key, paste MCP config into the agent client, install the MCP server via `uvx backplane-mcp` (published on PyPI).
3. `/:slug/agents` → create runner (`CreateAgentDialog`), assign to a team (`TeamPanel`).
4. `/:slug/agents/pipeline` → verify / edit pipeline stages. Export the pipeline JSON for reuse.
5. `/:slug/agents/prompts` → author/override prompts for each stage + role combo.
6. `/:slug/boards/:boardId/kanban` → create cards, watch `AgentStatusBar` + `ObserverPanel` for live events.
7. `/:slug/approvals` → tick through runner approval asks.

Rough spots the user has flagged (from `memory/audits/`, `feedback_*`, and inline comments):

- **AgentStatusBar stale until reload** — `feedback_agent_status_bar_no_ws.md`. Currently uses React Query polling on `useExecutions(slug, { status: "started" })`. No direct WS subscription — it only refreshes when `useAgentMetrics` invalidates on `execution.*`. Verify this is still the case on the current main; the audit was 4-6 days old at time of write.
- **Allowlist visibility wall** — bug B2 from the 2026-04-18 runner-launch walkthrough (`memory/audits/runner-launch-walkthrough-2026-04-18.md`). The team-role allowlist is not surfaced in the team UI.
- **Scaffold tooltips leaked to prod** — `examples.simple` / `examples.withExamples` / `examples.withLinks` keys still ship in `en.json` (`src/i18n/locales/en.json:1025-1053`). Called out in the audit as "BudgetPanel points at a scaffold"; BudgetPanel has since migrated to real `budgetStatus` / `budgetPeriodReset` keys (`en.json:1095-1109`), but the scaffold keys are still in the bundle as unused ballast.
- **Hardcoded pipeline enums** — see §4.2 above.
- **Prompt authoring UX** — single textarea, no preview, no variable lint. Called out in bug list B4-B6.

### 4.5 Teams

`TeamDetailPage` — members, role assignments, composition templates (`TeamCompositions`), pipeline diagram (read-only visualisation of the workspace pipeline), export button. Missing `useConfigSync` subscription — stale under concurrent edits (flagged in audit).

---

## 5. Shared UI System

### 5.1 shadcn components in use

All in `src/components/ui/` (hand-written, not CLI-installed):

- `avatar`, `badge`, `button`, `card`, `dialog`, `dropdown-menu`, `input`, `progress`, `scroll-area`, `select`, `separator`, `sheet`, `skeleton`, `textarea`, `toggle`, `tooltip`, **`rich-tooltip`**.

Only one Radix primitive is pulled in (`@radix-ui/react-toggle`); every other component is built directly on native elements + class variants with `class-variance-authority`.

### 5.2 Shared / agentic primitives

- `components/shared/`
  - `RichTextEditor` — Tiptap wrapper, used across notes, definitions, card descriptions. Pinned at `@tiptap/*@3.20.2` (see `package.json` pnpm overrides block).
  - `RichTextRenderer` — read-only render for Tiptap JSON.
  - `EditableList`, `KeyValueList`, `TagInput`, `InfoTooltip` (thin legacy info icon; superseded by RichTooltip for new work).
- `components/agentic/`
  - `agent-info-section.tsx` (`AgentInfoSubtab`) — only used by `CardDetailSheet.tsx:10`.
  - `auto-fill-button.tsx`, `config-analysis-panel.tsx` — scaffolds, only their own tests import them. The audit recommended wiring or deleting them. *(Deleted 2026-08-29, card 7ade62a2 — the copy promised LLM suggestions, contradicting the no-intelligence contract.)*
- `components/export/export-button.tsx` — generic "download a JSON export" button, reused for pipeline, team, prompt exports.
- `components/layout/`
  - `AppShell`, `Sidebar`, `TopBar`, `TabNav`, `PageHeader`, `EmptyState`, `ConnectionStatusIndicator`.

### 5.3 RichTooltip — the rich-content tooltip

`frontend/src/components/ui/rich-tooltip.tsx`. This is the **showcase component** other agents will replicate. Showcased in the pipeline builder's Strategy field (`SortableStageCard.tsx` → `i18nKey="pipelineDiscoverStrategy"`) and on BudgetPanel, ColumnHeader, KanbanCard runner badges, and the CreateCardDialog.

#### Architecture

Two UIs in one component:

1. **Hover tooltip** — small, anchored, summary-only. Fires on `mouseenter`/`focus`. Positioned via `getBoundingClientRect()` + CSS transforms per `side` (top/bottom/left/right).
2. **Expanded modal** — click or `Enter`/`Space`. Centred over a blurred backdrop, full panel content. Dismisses on Escape, backdrop click, or outside click. Portalled to `document.body`.

#### Public API

```ts
type RichTooltipLink = { label: string; href: string };
type RichTooltipRow = { label: string; value: string };
type RichTooltipCalloutVariant = "info" | "warn" | "success" | "note";
type RichTooltipCallout = { variant?: RichTooltipCalloutVariant; text: string };

// One-level-deep sub-group; no recursion by design.
type RichTooltipSection = {
  title: string;
  summary?: string;
  examples?: string[];
  rows?: RichTooltipRow[];
  callouts?: RichTooltipCallout[];
  code?: string;
  links?: RichTooltipLink[];
};

type RichTooltipPanel = {
  examples?: string[];
  rows?: RichTooltipRow[];
  callouts?: RichTooltipCallout[];
  code?: string;
  links?: RichTooltipLink[];
  sections?: RichTooltipSection[];
};

type RichTooltipProps = {
  summary?: string;                  // one-liner for hover tooltip + modal heading
  panel?: RichTooltipPanel;          // declarative rich content
  customPanel?: React.ReactNode;     // escape hatch for bespoke layouts
  i18nKey?: string;                  // reads ui.tooltips.<i18nKey> (preferred)
  children: React.ReactNode;         // the trigger (icon, label, etc.)
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
};
```

#### Content-authoring pattern (i18n-first)

Authors rarely pass `panel` directly. They set `i18nKey` and put the content in `src/i18n/locales/{en,es}.json` under `ui.tooltips.<key>`. Example from `en.json:1121-1140`:

```json
"pipelineDiscoverStrategy": {
  "summary": "How this stage finds its next card: …",
  "rows": [
    { "label": "Trigger", "value": "unassigned_or_rework: … // column_scan: …" },
    { "label": "Column scope", "value": "…" }
  ],
  "callouts": [
    { "variant": "info", "text": "Default for most hero-style stages …" },
    { "variant": "warn", "text": "column_scan with an empty column_type never finds work …" },
    { "variant": "note", "text": "Both strategies apply the stage's filters …" }
  ],
  "code": "\"discover\": {\n  \"strategy\": \"column_scan\",\n  …\n}",
  "examples": [
    "A reviewer-style stage scanning the review column …",
    "A documentator-style stage walking the done column …"
  ],
  "sections": [ /* one-level-deep sub-panels */ ],
  "links": [ { "label": "Role glossary", "href": "agents/roles" } ]
}
```

Rendering order inside the modal is fixed in `PanelBody` (`rich-tooltip.tsx:391-402`): rows → callouts → code → examples → sections → links.

#### Callout variants and data-attrs

`data-variant="info|warn|success|note"` on each callout `<li>` (`rich-tooltip.tsx:481`) — used by tests and by any downstream styling override. Icons: `Info`, `AlertTriangle`, `CheckCircle2`, `Lightbulb`.

#### Link resolution

`rich-tooltip.tsx:192-197` — `href` strings in i18n can be:

- absolute (`https://…`) → opens in new tab with `rel="noreferrer"`.
- leading-slash (`/…`) → absolute within the app.
- workspace-relative (`agents/roles`) → resolved to `/${slug}/agents/roles` using `useParams()`. This is why tooltip authors write `"agents/roles"` and not `"/agents/roles"`.

#### Test hooks

`data-testid` landmarks: `rt-backdrop`, `rt-examples`, `rt-rows`, `rt-callouts`, `rt-code`, `rt-links`, `rt-sections`. See `components/ui/__tests__/rich-tooltip.test.tsx`.

#### Replication checklist for other agents

When adding a RichTooltip somewhere new:

1. Wrap the trigger: `<RichTooltip i18nKey="myKey"><span>…</span></RichTooltip>`.
2. Add `ui.tooltips.myKey` to **both** `en.json` and `es.json` (locale keys are kept symmetric by project policy — see audit).
3. Prefer the declarative schema over `customPanel`. Sections are one level deep by design.
4. Trigger must have content — pass an icon, label, or both; accessibility (`role="button"`, `tabIndex=0`, focus ring, Enter/Space handling) is already wired.
5. If linking to another workspace-scoped page, use workspace-relative hrefs (no leading slash).

### 5.4 Design tokens and Tailwind

- **Tailwind v4, CSS-first.** No `tailwind.config.js`. Tokens live in `src/index.css` and are referenced via CSS custom properties (`--color-info`, `--radius-xl`, `--page-gutter`, `--page-section-gap`, `--topbar-height`, `--sidebar-width`, `--sidebar-collapsed-width`, etc.).
- `@tailwindcss/vite` plugin is wired in `vite.config.ts`.
- Component styling pattern: `cn(...)` from `src/lib/utils.ts` (the canonical `clsx` + `tailwind-merge` wrapper).
- Semantic tokens for colors: `bg-primary`, `text-destructive`, `border-border`, `bg-muted`. Raw hex only appears where `recharts` needs a prop it can't derive from classes (`usePipelineConfig.ts:29-37`).
- Dark mode: class-based, driven by `ThemeSwitcher` + `use-theme.tsx` (system/light/dark).
- Radii token family: `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl` consumed through the `rounded-[var(--radius-…)]` pattern.

### 5.5 Icons

`lucide-react` everywhere. No sprite sheet, no custom icon system. `ValarisLogo` is an inline SVG in `Sidebar.tsx:20-38`.

### 5.6 Animations

`src/lib/animations.ts` wraps `gsap`. Respecting user settings: `hooks/use-reduced-motion.ts` short-circuits every animation call — `BoardView`, `AppShell`, `WorkspacesPage`, and `KanbanColumn` all read this flag before firing tweens.

### 5.7 Rich text

Tiptap, pinned version-across-the-board via pnpm overrides (see `package.json:62-90`). Used by notes, definitions, card descriptions. `extractPlainText()` in `src/lib/editor-utils.ts` is the one-way projection used for card card-previews and search.

---

## 6. Real-time / WebSocket Integration

### 6.1 Transport

`src/lib/websocket.ts` — single hand-rolled `WebSocketService`. Connects to `{wsBase}/ws/workspaces/{slug}/events`. Features:

- Exponential backoff reconnect (1s → 30s cap, `RECONNECT_BASE`/`RECONNECT_MAX`).
- Server-side subscribe protocol: client sends `{subscribe: ["card.*", ...]}` on connect **and whenever a new pattern is registered** (`websocket.ts:97-114`). Client-side pattern filtering alone is not enough — the server drops anything the client didn't subscribe to.
- **Stale-connection guard.** Every `onopen`/`onmessage`/`onclose` callback checks `this.ws !== ws` against the captured local ref. This is the defence against React StrictMode's double-mount race (effect → cleanup → effect) where a stale socket's `onclose` would otherwise flip state belonging to the newer connection.
- `intentionalClose` flag + `e.code === 1000` check to tell "we disconnected on purpose" from "network died".

### 6.2 Provider

`src/providers/WebSocketProvider.tsx`. One service instance per workspace slug; recreated when the route's first segment changes (`WebSocketProvider.tsx:27-59`). The provider exposes `{ status, subscribe }` via React context.

**Critical detail** — `serviceEpoch` state counter (`WebSocketProvider.tsx:41-49,68-69`):

```ts
const [serviceEpoch, setServiceEpoch] = useState(0);
// inside the effect when creating a new service:
setServiceEpoch((e) => e + 1);
// subscribe is memoised with serviceEpoch as its only dep
```

The epoch exists because child `useEffect`s in `useWebSocketEvent` consumers run **before** the provider's effect that creates the service. Without the epoch bump, children subscribe against a stale closure holding `serviceRef.current === null`. Incrementing the epoch on service creation invalidates that closure and triggers re-subscribe. The eslint-disable on the deps array is documented in the file.

### 6.3 Consumption patterns

Three patterns, in order of preference:

1. **`useDomainSync(domain, queryKey, debounceMs?)`** — the standard. Subscribes to `${domain}.*`, debounces (default 250ms), invalidates the React Query key. Live on: boards, notes, activity, dashboard, resources, members, channels, git-repos, definitions, approvals, agent metrics, workspaces. 14 callsites across `features/*/api/`.
2. **`useWebSocketEvent(pattern, handler)`** — when the handler needs to do more than invalidate a key. Used by `useObserverEvents.ts` (buffers events for the observer panel), `useCostAlerts.ts`, `useConfigSync.ts`, `useAgentMetrics.ts`.
3. **Polling fallback** — a few hooks still poll (`useExecutions`, `useBudgetStatus@60s`). `useBudgetStatus` comments that `cost.*` events aren't published yet; should be migrated when the backend emits them.

### 6.4 UI surfaces

- **`ConnectionStatusIndicator`** (`components/layout/ConnectionStatusIndicator.tsx`). Coloured dot in the TopBar — green/amber(pulsing)/red. Tooltip shows translated status + "stale data" hint when disconnected. Note: the older audit (2026-04-17) said *"No visible WebSocket connection status indicator anywhere"* — that has since been fixed and shipped.
- **`ObserverPanel`**. Live WS event buffer (see §1.5).
- **`AgentStatusBar`**. Driven by polled executions query; WS-native refresh is the outstanding UX gap noted by the user.

### 6.5 Known fragility

Captured in `memory/feedback_websocket_bugs.md` (6 days old at time of this report — verify against current code):

1. **StrictMode double-mount race** — mitigated by stale-connection guard (`websocket.ts:48,55,65`).
2. **Server-side subscribe** — mitigated by sending `{subscribe: […]}` on connect and on new pattern registration.
3. **Provider/child effect timing** — mitigated by `serviceEpoch`.

Open:

- Per-pattern subscribe is sent immediately on `subscribe()` if the socket is open, but unsubscribe is not sent to the server (only removed from the client map). The server continues delivering events the client now drops. Not a correctness bug; a bandwidth nit.
- `useDomainSync` is not gated on `wsStatus`; when disconnected, its debounced-invalidate is a no-op (no new events arrive), but the page has no polling fallback. Disconnected = stale forever, modulo any other hook that still polls.

---

## 7. Internationalisation

### 7.1 Setup

- Library: `react-i18next` + `i18next`. Bundled JSON, no lazy loading.
- Config: `src/i18n/config.ts`. Resources loaded at module init, imported as a side-effect from `src/main.tsx`.
- Locales: `src/i18n/locales/en.json`, `src/i18n/locales/es.json`. The older audit confirmed both files have symmetric keysets.
- Language persisted in `localStorage` under `i18n-lang`. Initial value: saved → browser → `en`. See `config.ts:6-8`.

### 7.2 Switcher

`src/components/LanguageSwitcher.tsx` — simple EN/ES toggle button with the `Globe` icon. Lives in `TopBar` (mounted when a workspace shell is active) and on `WorkspacesPage` (before the shell).

### 7.3 Key patterns

- **Feature-namespaced keys**: `boards.*`, `cards.*`, `agents.*`, `pipelineBuilder.*`, `boardTabs.*`.
- **Enum-to-key mapping** for dynamic values: `` t(`cards.types.${card.card_type}`) ``.
- **Interpolation**: `t("agents.agentsWorking", { count: uniqueAgents.length })` with `{{count}}` in JSON.
- **Rich-tooltip namespace**: `ui.tooltips.<key>.{summary, examples, rows, callouts, code, sections, links}` — consumed by `useTooltipContent()` which safely parses unknown shapes.
- **Aria labels** are translated (`a11y.topbar.toggleSidebar`, `a11y.sidebar.closeMobile`). The old audit flagged raw English `aria-label`s in Sidebar and TopBar; current code reads `t(…)`.

### 7.4 Adding a language

1. Create `src/i18n/locales/fr.json` (or similar).
2. Register in `config.ts` `resources` map.
3. Add to `LANGUAGES` in `LanguageSwitcher.tsx`.

---

## 8. Data Fetching

### 8.1 React Query conventions

- **All server state goes through React Query.** `@tanstack/react-query` v5.
- Provider mount — a single `QueryClientProvider` wrapping the router (see `main.tsx`).
- Every query hook returns the raw `UseQueryResult` — callers destructure `data`, `isLoading`, `isError`. No custom wrappers.

### 8.2 Query-key ownership

Single file, single export per domain: `src/lib/query-keys.ts`. Every hook imports the helper — no inline `["workspaces", slug, …]` literals. This is an enforced rule (see `.claude/rules/frontend.md`).

Shape convention:

```ts
export const boardKeys = {
  byWorkspace: (slug) => ["boards", slug] as const,
  detail: (slug, id) => ["boards", slug, id] as const,
};
```

Fourteen key namespaces, one per feature. The older audit flagged two drift spots (`approvalKeys` vs inline literal in `useApprovals`; composed spreads in `use-resources.ts`) — worth re-verifying.

### 8.3 Mutation patterns

Three canonical shapes, in increasing sophistication:

1. **Invalidate-on-success** (default): most create/update/delete hooks. `onSuccess: () => queryClient.invalidateQueries({ queryKey })`.
2. **Optimistic with rollback**: `useOptimisticCardMove`, `useCreateCard`. `onMutate` snapshots + mutates the cache; `onError` restores; `onSettled` invalidates.
3. **Optimistic + WS backstop**: `useDomainSync` on the same key means the WS stream will re-confirm (or correct) the optimistic state once the backend commits.

### 8.4 Axios + error flattening

`src/lib/api.ts` — single axios instance with a response interceptor that flattens `response.data.detail` into `Error.message`, JSON-encoding objects/arrays so callers can `JSON.parse(err.message)` to dispatch on shape. Used by the pipeline builder for structured validation errors and drift (`stale_version`) handling.

### 8.5 Polling and WS gating

Where both exist, WS is primary. Polling survives on:

- `useExecutions` (started status)
- `useBudgetStatus` (`cost.*` events not published yet)
- A few admin endpoints with no WS coverage.

---

## 9. Honest Limitations

Confirmed against current source. Some audit-era items already fixed.

### 9.1 Still open

- **AgentStatusBar + ExecutionTimeline WS subscriptions.** These live on the kanban board and are a major UX touchpoint. They refresh via `useExecutions` polling / domain sync rather than `execution.started|completed|failed` direct subscriptions, so "runner just started working this card" can feel delayed. Tracked as E.4 in the plan (`feedback_agent_status_bar_no_ws.md`).
- **Hardcoded pipeline enums in `SortableStageCard.tsx:31-41`** duplicate backend Pydantic contracts (`backend/app/schemas/pipeline_config.py`). Any new `discover.strategy` added server-side silently fails to appear in the dropdown until the TS constants are updated. Audit Batch B.
- **Scaffold `ui.tooltips.examples.*` keys** remain in both locales (`en.json:1025-1053`). BudgetPanel migrated to real content, so the scaffold is unused ballast — remove when authoring Batch G.
- **Prompt authoring UX** — single plain `<Textarea>`, no variable autocomplete, no live preview, no template inheritance visualisation. Users have flagged this repeatedly; the MCP is the path of least resistance for authoring today, not the UI.
- **Allowlist visibility wall** — team-role allowlist invisible from the team UI. Bug B2 from the runner-launch walkthrough.
- **`useMoveCard` dead export** in `features/kanban/api/use-cards.ts` — should be deleted (`useOptimisticCardMove` is the only caller path).
- **Breadcrumb segments untranslated** (`TopBar.tsx:20-22`). Raw slug-to-title via dash-strip; route tokens like "agents", "prompts" stay English in the ES locale.
- **Dialog state hygiene** — many Create* dialogs reset form state only on success, not on close. Batch D in the audit.
- **Icon-only buttons missing `aria-label`** — partial sweep done in the audit; spot-check before an a11y push.
- **Agentic scaffolds orphaned**: `AgentInfoSubtab` now consumed (`CardDetailSheet.tsx:10`) but `AutoFillButton` and `ConfigAnalysisPanel` still only have test callers. *(The latter two deleted 2026-08-29, card 7ade62a2.)*
- **`alert()` / `window.confirm()` in five editors** (`RichTextEditor`, `ChannelEditor`, `GitRepoEditor`, `ResourceEditor`, `ResourceList`) — breaks IAP iframe styling, test determinism, and i18n. Should move to a shared `ConfirmDialog`. Batch F.
- **Component test coverage thin** — most feature modules have zero component tests. `kanban` 0/11, `resources` 0/7, `notes` 0/3, `git` 0/3, etc. Only `agents` (6/23) and `approvals` (1/3) have any (audit counts). Given the platform-wide TDD mandate in `CLAUDE.md`, this is a standing debt.
- **Pipeline drift conflict UX** — the dialog works, but "Reload" silently discards local edits with no diff view. For an operator mid-auth of a 30-minute draft, this is destructive. Adding a "copy changes to clipboard" affordance would soften it.

### 9.2 Recently fixed (audit was stale)

- `ConnectionStatusIndicator` now in the TopBar (`TopBar.tsx:159`). The audit claim "no visible WS connection status indicator anywhere" is outdated.
- `useDomainSync` broadly adopted across ~14 feature hooks; the audit's "most query hooks do not subscribe" is partially obsolete.
- `useCostAlerts` mounted on `AppShell`.
- Sidebar/TopBar `aria-label`s now translated.
- `ComingSoonPage.tsx` removed from `src/pages/`.

### 9.3 Structural limits

- No centralised "route registry" — `App.tsx` is the only source of truth; keyboard navigation, sitemap-style features would have to re-derive it.
- Forms don't use a form library (no `react-hook-form`, no Zod-backed form schema). `useId()` + per-dialog useState is the default; labels are not consistently `htmlFor`-associated.
- Error boundaries are not per-route. An uncaught render error in one route unmounts the whole shell.
- No global toast infrastructure shown in this scan — `sonner` is imported ad-hoc by callers. Worth confirming a top-level `<Toaster/>` is mounted somewhere (likely `main.tsx`).

---

## 10. Cross-Cutting File Map (quick reference)

| Concern | File |
|---------|------|
| Routes | `src/App.tsx` |
| Shell chrome | `src/components/layout/AppShell.tsx`, `Sidebar.tsx`, `TopBar.tsx`, `TabNav.tsx`, `PageHeader.tsx` |
| Auth detection | `src/hooks/useWorkspaceAdmin.ts` |
| WS transport | `src/lib/websocket.ts` |
| WS provider | `src/providers/WebSocketProvider.tsx` |
| WS consumer hooks | `src/hooks/use-websocket.ts`, `src/hooks/useDomainSync.ts` |
| Query keys | `src/lib/query-keys.ts` |
| HTTP client | `src/lib/api.ts` |
| Rich tooltip | `src/components/ui/rich-tooltip.tsx` |
| Rich text | `src/components/shared/RichTextEditor.tsx`, `RichTextRenderer.tsx` |
| Kanban DnD | `src/features/kanban/hooks/use-kanban-dnd.ts`, `use-optimistic-card-move.ts` |
| Position algorithm | `src/features/kanban/utils/position.ts` |
| Pipeline builder | `src/features/agents/components/pipeline-builder/` |
| Pipeline validation | `src/features/agents/lib/pipelineValidation.ts` |
| Observer panel | `src/features/observer/components/ObserverPanel.tsx`, `hooks/useObserverEvents.ts` |
| Tooltip content | `src/i18n/locales/en.json` `ui.tooltips.*` |
| i18n config | `src/i18n/config.ts` |
| Language switcher | `src/components/LanguageSwitcher.tsx` |
| Theme | `src/components/ThemeSwitcher.tsx`, `src/hooks/use-theme.tsx` |


---

## 11. Mount Tree

Top-level providers (`src/main.tsx`):

```tsx
<StrictMode>
  <QueryClientProvider client={queryClient}>        // staleTime 30s, retry 1
    <ThemeProvider>                                  // system/light/dark class toggle
      <BrowserRouter>
        <WebSocketProvider>                          // one WS per workspace slug
          <App />                                    // route table
          <Toaster richColors position="bottom-right" />  // global sonner sink
        </WebSocketProvider>
      </BrowserRouter>
    </ThemeProvider>
  </QueryClientProvider>
</StrictMode>
```

Notes:

- `QueryClient` defaults: `staleTime: 30_000`, `retry: 1`. This is conservative — optimistic updates remain the default pattern for snappy UX. Any per-hook override (e.g. `usePipelineConfig` uses `staleTime: 5 * 60 * 1000`) is intentional.
- Single `<Toaster/>` at the root. All callers import `toast` from `sonner` directly (`toast.success(...)`, `toast.error(...)`). No wrapper.
- `<StrictMode>` is on in dev — the WS transport's stale-connection guard and the provider's `serviceEpoch` exist specifically because StrictMode double-mounts effects.

---

## 12. Column & Card Model (for downstream agents)

The card and column types drive almost every UI decision. Brief summary so agents proposing new features know the shape:

- `ColumnType` is one of `"backlog" | "active" | "review" | "done" | "blocked"` or `null` (untyped). Types are a backend-level contract — renaming a column only changes its label, but changing its type reroutes pipeline behaviour. The tooltip for this field (`ui.tooltips.columnType`, `en.json:1054-1068`) is one of the most content-rich RichTooltips in the app.
- `CardType` is `"task" | "bug" | "feature" | "issue"`. `Priority` is `"low" | "medium" | "high" | "urgent"`. Each has its own Tailwind token mapping in `KanbanCard.tsx:21-40`.
- Cards carry `labels: string[]`, `status: string | null`, `due_date: string | null`, `participants: Participant[]`. Participants can be users or runners (`agent_id` field is set for runner participants).
- `BoardDetail` (what `useBoard` returns) includes fully-expanded columns with all their cards — there is no separate "columns" or "cards" list endpoint used by the UI. `features/kanban/api/use-columns.ts` and `use-cards.ts` exist for mutations only; reads go through `useBoard`.

### 12.1 "Stuck card" detection

`features/kanban/utils/stuckReasons.ts` computes reasons a card is stuck (no participant, overdue, blocked, awaiting review > N days). Surfaced via `StuckReasonsPanel` in the CardDetailSheet.

### 12.2 Skipped-execution indicator

`useCardHasSkippedExecution(slug, cardId)` (`features/agents/hooks/useAgentMetrics.ts`) identifies cards where a runner attempted a stage but was skipped because no prompt was authored. The kanban card surfaces this as a yellow warning badge with a RichTooltip (`kanbanCardAwaitingPrompt`) deep-linking into prompt authoring.

---

## 13. Animation & Motion

`src/lib/animations.ts` centralises every GSAP animation primitive. Three patterns:

- `fadeInUp(node, options)` — used for page transitions (`AppShell` reruns on `location.pathname` change), PageHeader entrance.
- `scaleIn(node, options)` — used by `WorkspacesPage` grid stagger.
- `slideIn(node, options)` — used by `BoardView` column stagger on the x-axis.

Every callsite checks `useReducedMotion()` first. The hook reads `prefers-reduced-motion` via `matchMedia`. When reduced-motion is on, animations are skipped (not slowed) — this matches macOS/iOS behaviour expectations.

The `KanbanCard` also has a dedicated GSAP tween on drag-release to soften the snap-back (`KanbanCard.tsx:6,10`).

---

## 14. Theming

`src/components/ThemeSwitcher.tsx` + `src/hooks/use-theme.tsx`:

- Three modes: `system`, `light`, `dark`.
- Persisted in `localStorage`.
- `resolvedTheme` exposes the concrete theme after system-resolution — consumers needing dark-mode-aware assets (logos, chart colours) use it rather than raw `theme`.
- Applied by toggling a `.dark` class on `<html>`.
- Tailwind v4 uses `data-theme` / `class` selectors; tokens are defined for both light and dark in `index.css`.

---

## 15. Appendix — Important Conventions Other Agents Must Follow

Distilled from `.claude/rules/frontend.md`, `frontend/CLAUDE.md`, and `frontend/AGENTS.md` (not quoted verbatim — spirit + project norms):

1. **Server state always via React Query.** No `useState` for server data. No custom caching.
2. **Query keys always via `lib/query-keys.ts`.** Never inline `["workspaces", slug, …]`. Two audit-flagged violations still exist (see §9).
3. **All user-facing strings via `useTranslation()`.** Raw strings in JSX are a bug. New keys must be added to both `en.json` and `es.json` simultaneously.
4. **Feature modules follow the `api / components / hooks / utils` split.** Do not introduce sibling folders unless the domain genuinely needs one (e.g. `agents/lib/` for non-hook, non-API helpers is acceptable).
5. **WS subscriptions via `useDomainSync` by default.** Fall back to `useWebSocketEvent` only when the handler must do something other than invalidate a query.
6. **Optimistic updates are the default for mutations on user-visible state** (card move, card create, column reorder). Non-optimistic mutations should be justified.
7. **shadcn components are hand-written and live in `src/components/ui/`.** Do not install via the shadcn CLI.
8. **Tailwind v4 CSS-first.** No `tailwind.config.*` file. Add tokens to `index.css`; don't hardcode hex except where charts require it.
9. **Labels must be `htmlFor`-associated.** `useId()` + `fieldId(name)` helper is the established pattern (see `CardDetailSheet.tsx:53-54`, `SortableStageCard.tsx:78-79`, `BudgetPanel.tsx:131`).
10. **Confirm destructive actions with `Dialog`, not `window.confirm()`**. Batch F still open but the direction is clear.
11. **Respect `useReducedMotion()`** for any animation.
12. **Admin gates via `useWorkspaceAdmin(slug)`**, never by parsing user role manually.
13. **TDD is mandatory** for new components per project root CLAUDE.md. `vitest` + MSW + `@testing-library/react` is the stack.

---

## 16. Quick-Reference: Where Things Live

| Question | Answer |
|----------|--------|
| "Where's the route table?" | `src/App.tsx` |
| "Where's the Kanban drag logic?" | `src/features/kanban/hooks/use-kanban-dnd.ts` |
| "Where's the fractional indexing math?" | `src/features/kanban/utils/position.ts` |
| "Where's the WS transport?" | `src/lib/websocket.ts` |
| "How do I add a query key?" | `src/lib/query-keys.ts`, add a namespace, export functions returning `as const` tuples |
| "How do I author a rich tooltip?" | Add `ui.tooltips.<key>` to `src/i18n/locales/{en,es}.json`; wrap a trigger with `<RichTooltip i18nKey="myKey">…</RichTooltip>` |
| "How do I gate UI on admin role?" | `const { isAdmin, isLoading } = useWorkspaceAdmin(slug)` |
| "How do I fire a WS-aware invalidation?" | `useDomainSync("card", boardKeys.detail(slug, boardId))` inside a query hook |
| "How do I add a new pipeline stage field?" | Schema in `features/agents/api/pipelineConfig.ts` → validator in `lib/pipelineValidation.ts` → editor UI in `pipeline-builder/SortableStageCard.tsx` (or a subeditor) → i18n keys in `pipelineBuilder.*` and optionally `ui.tooltips.*` |
| "How do I add a board tab?" | Route in `App.tsx`, page component in `src/pages/kanban/`, entry in `BoardLayout.tsx:27-35` `boardTabs` array with i18n key + icon |
| "How do I add a workspace nav item?" | Entry in `Sidebar.tsx:40-50` `navItems` + route in `App.tsx` + i18n key |
| "Where do i18n namespaces live?" | Top-level keys of `src/i18n/locales/en.json` — feature-named (`agents.*`, `boards.*`, …) plus `ui.*` for cross-cutting, `a11y.*` for aria labels, `common.*` for shared verbs |
| "Where's the one-off floating UI?" | `ObserverPanel` mounts in `AppShell.tsx:78` when `slug` is set |
| "Where's the settings / MCP install?" | `/:slug/settings` → `src/pages/PlatformSettingsPage.tsx` |

