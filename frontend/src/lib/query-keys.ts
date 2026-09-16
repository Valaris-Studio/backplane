// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export const workspaceKeys = {
  all: ["workspaces"] as const,
  bySlug: (slug: string) => ["workspaces", slug] as const,
};

export const boardKeys = {
  byWorkspace: (slug: string) => ["boards", slug] as const,
  detail: (slug: string, id: string) => ["boards", slug, id] as const,
  dependencies: (slug: string, id: string) =>
    ["boards", slug, id, "dependencies"] as const,
  dependencyValidation: (slug: string, id: string) =>
    ["boards", slug, id, "dependencies", "validation"] as const,
};

export const columnKeys = {
  byBoard: (slug: string, boardId: string) =>
    ["columns", slug, boardId] as const,
};

export const cardKeys = {
  byColumn: (slug: string, boardId: string, columnId: string) =>
    ["cards", slug, boardId, columnId] as const,
  detail: (slug: string, boardId: string, cardId: string) =>
    ["cards", slug, boardId, cardId] as const,
  dependencies: (slug: string, boardId: string, cardId: string) =>
    ["cards", slug, boardId, cardId, "dependencies"] as const,
};

export const noteKeys = {
  byBoard: (slug: string, boardId: string) =>
    ["notes", slug, boardId] as const,
  byWorkspace: (slug: string) => ["notes", slug] as const,
  // The paginated browse list. `listRoot` is the invalidation prefix: every
  // filter combination the user has visited lives under it, so a WS note event
  // refreshes the list they'll come back to, not just the one on screen.
  listRoot: (slug: string, boardId?: string) =>
    ["notes", slug, boardId ?? null, "list"] as const,
  list: (slug: string, boardId: string | undefined, params: object) =>
    ["notes", slug, boardId ?? null, "list", params] as const,
  byCard: (slug: string, boardId: string, cardId: string) =>
    ["notes", slug, boardId, "card", cardId] as const,
  // Deliberately NOT a subtree of the list keys: the note editor must never be
  // served a body that a (possibly trimmed) list response put in the cache.
  detail: (slug: string, noteId: string) =>
    ["note-detail", slug, noteId] as const,
};

export const activityKeys = {
  byBoard: (slug: string, boardId: string, filters?: object) =>
    ["activity", slug, boardId, filters ?? {}] as const,
  byWorkspace: (slug: string, filters?: object) =>
    ["activity", slug, filters ?? {}] as const,
};

export const timelineKeys = {
  byBoard: (slug: string, boardId: string) =>
    ["timeline", slug, boardId] as const,
};

export const resourceKeys = {
  downloadUrl: (slug: string, boardId: string | undefined, resourceId: string) =>
    ["resource-download-url", slug, boardId ?? "workspace", resourceId] as const,
  previewText: (resourceId: string, url: string) => ["file-preview", resourceId, url] as const,
  previewBinary: (resourceId: string, url: string) => ["file-preview-binary", resourceId, url] as const,
  byBoard: (slug: string, boardId: string) =>
    ["resources", slug, boardId] as const,
  byWorkspace: (slug: string) => ["resources", slug] as const,
  tags: (slug: string, boardId?: string) =>
    ["resources", "tags", slug, boardId ?? "workspace"] as const,
};

export const definitionKeys = {
  byBoard: (slug: string, boardId: string) =>
    ["definitions", slug, boardId] as const,
  // `configured` (the board's `has_definition` flag) appended UNDER the
  // byBoard prefix so a false→true flip is a distinct cache entry (real
  // refetch, not a pinned cached null) while prefix-based invalidation and
  // domain sync on byBoard still hit every variant.
  withConfigured: (slug: string, boardId: string, configured?: boolean) =>
    [...definitionKeys.byBoard(slug, boardId), { configured }] as const,
};

export const channelKeys = {
  byWorkspace: (slug: string) => ["channels", slug] as const,
};

export const gitRepoKeys = {
  byBoard: (slug: string, boardId: string) =>
    ["git-repos", slug, boardId] as const,
};

export const runnerConfigKeys = {
  // agentId scopes the prerequisites to an existing runner (drops the
  // create/bind steps); null = board-generic config.
  byBoard: (slug: string, boardId: string, agentId: string | null = null) =>
    ["runner-config", slug, boardId, agentId] as const,
};

export const boardLoopKeys = {
  // Deliberately a TOP-LEVEL key, NOT under boardKeys.detail's ["boards", ...]
  // prefix: useBoard prefix-invalidates that key from five domain
  // subscriptions (card/column/activity/execution), which would churn the
  // loop-config query on every board event for no reason. Loop config has its
  // own WS event (board.loop_updated) driving its own invalidation.
  detail: (slug: string, boardId: string) =>
    ["board-loop", slug, boardId] as const,
  // `configured` (the board's `loop_configured` flag) appended UNDER the
  // detail prefix so a false→true flip is a distinct cache entry (real
  // refetch, not a pinned cached null) while prefix-based invalidation and
  // useBoardLoopSync on detail still hit every variant.
  withConfigured: (slug: string, boardId: string, configured?: boolean) =>
    [...boardLoopKeys.detail(slug, boardId), { configured }] as const,
  // Sibling of `detail`, NOT under it: the two have different invalidation
  // triggers (config changes on board.loop_updated, runtime status on
  // execution.*), and nesting status under detail would make every config
  // save refetch the status feed and vice versa.
  status: (slug: string, boardId: string) =>
    ["board-loop-status", slug, boardId] as const,
  // Sibling again, for the same reason: the stop timeline only changes on a
  // state flip (board.loop_updated), never on the execution churn that drives
  // status.
  transitions: (slug: string, boardId: string) =>
    ["board-loop-transitions", slug, boardId] as const,
  // Sibling of `detail` again: the binding carries slot values and the drift
  // verdict, which a system-template publish changes WITHOUT any board save —
  // so it invalidates on config.changed {entity: loop_template}, a trigger
  // `detail` does not share.
  binding: (slug: string, boardId: string) =>
    ["board-loop-binding", slug, boardId] as const,
  // Its own entry rather than a `binding` child: the diff is fetched only when
  // the operator opens the review panel, and nesting it would make every
  // binding refetch drag the (expensive, two-version) diff along with it.
  bindingDiff: (slug: string, boardId: string) =>
    ["board-loop-binding-diff", slug, boardId] as const,
};

export const loopTemplateKeys = {
  proposedFit: (slug: string, boardId: string, ref: string, proposal: object, revision: number) => ["loop-template-proposed-fit", slug, boardId, ref, proposal, revision] as const,
  // Workspace-scoped and DB-backed since P1: templates are authored in the
  // manager and published, so `config.changed {entity: "loop_template"}`
  // invalidates this space live (see useLoopTemplateSync).
  //
  // `all` is the invalidation root — every list variant and every detail nests
  // under it, so one publish refreshes the library and any open detail at once.
  all: (slug: string) => ["loop-templates", slug] as const,
  // Search/sort live IN the key: the server does the filtering, so two
  // different queries are two different results and must not share a cache
  // entry.
  list: (slug: string, params: { q?: string; sort?: string } = {}) =>
    [
      "loop-templates",
      slug,
      "list",
      params.q ?? "",
      params.sort ?? "",
    ] as const,
  detail: (slug: string, ref: string, draft = false) =>
    ["loop-templates", slug, "detail", ref, draft] as const,
  versions: (slug: string, ref: string) =>
    ["loop-templates", slug, "versions", ref] as const,
  // Its OWN entry rather than `detail(slug, ref, false)`: the draft store
  // publishes saved DRAFT content into the `detail` entry via setQueryData, so
  // the published half needs a key no draft write can reach.
  published: (slug: string, ref: string) =>
    ["loop-templates", slug, "published", ref] as const,
  profile: (slug: string, ref: string) =>
    ["loop-templates", slug, "profile", ref] as const,
  // Board-scoped: the same template fits two boards differently, so the board
  // is part of the identity rather than a filter over one cached report.
  fit: (slug: string, boardId: string, ref: string) =>
    ["loop-templates", slug, "fit", boardId, ref] as const,
};

export const skillKeys = {
  // `all` is the invalidation root for the workspace library — detail and
  // version entries nest under it, so one catalog activation refreshes the
  // list and any open detail at once.
  all: (slug: string) => ["skills", slug] as const,
  // The include-archived list variant. Nested under `all` so every existing
  // library invalidation refetches it too; the object discriminant keeps it
  // from ever colliding with the detail key of a skill slugged "archived".
  archivedList: (slug: string) =>
    ["skills", slug, { includeArchived: true }] as const,
  detail: (slug: string, skillSlug: string) =>
    ["skills", slug, skillSlug] as const,
  version: (slug: string, skillSlug: string, version: number) =>
    ["skills", slug, skillSlug, "versions", version] as const,
  // Top-level sibling of `all`: the catalog listing only changes on
  // activation, so library invalidations must not churn it.
  catalog: (slug: string) => ["skill-catalog", slug] as const,
  // Top-level sibling: board bindings change on bind/unbind, not on library
  // edits, so library invalidation must not refetch every open board dialog.
  byBoard: (slug: string, boardId: string) =>
    ["board-skills", slug, boardId] as const,
  // The RAW binding rows behind `byBoard`'s effective set — a settings UI
  // needs disabled and unresolvable bindings that the effective set drops.
  bindingsByBoard: (slug: string, boardId: string) =>
    ["board-skill-bindings", slug, boardId] as const,
};

export const gitConnectionKeys = {
  list: (slug: string) => ["git-connections", slug] as const,
  repositories: (slug: string, connectionId: string) =>
    ["git-connections", slug, connectionId, "repositories"] as const,
};

export const integrationsKeys = {
  configStatus: ["integrations", "config-status"] as const,
};

export const memberKeys = {
  all: ["members"] as const,
  list: (slug: string) => ["members", slug] as const,
  // Workspace + query scoped key for the @mention autocomplete (debounced
  // ?q= search). Distinct from `list` so the full-member cache is untouched.
  search: (slug: string, query: string) =>
    ["members", slug, "search", query] as const,
};

export const dashboardKeys = {
  summary: (slug: string) => ["dashboard", slug, "summary"] as const,
};

export const approvalKeys = {
  // Bare prefix matching every status-filtered list variant AND details.
  // Note list(slug) would NOT work for that: `{ status: undefined }` is a
  // trailing object segment, not a prefix.
  all: (slug: string) => ["workspaces", slug, "approvals"] as const,
  list: (slug: string, status?: string) =>
    ["workspaces", slug, "approvals", { status }] as const,
  detail: (slug: string, id: string) =>
    ["workspaces", slug, "approvals", id] as const,
};

export const agentKeys = {
  metrics: (slug: string, includeInactive?: boolean) =>
    ["agents", slug, "metrics", includeInactive ? "all" : "active"] as const,
  velocity: (slug: string) => ["agents", slug, "velocity"] as const,
  quality: (slug: string) => ["agents", slug, "quality"] as const,
  cost: (slug: string) => ["agents", slug, "cost"] as const,
  list: () => ["agents"] as const,
  improvement: (slug: string) => ["agents", slug, "improvement"] as const,
  executions: (
    slug: string,
    filters?: { status?: string; agent_id?: string; card_id?: string },
  ) => ["agents", slug, "executions", filters ?? {}] as const,
  executionDetail: (slug: string, executionId: string) =>
    ["agents", slug, "execution", executionId] as const,
  // Board-scoped loop-iteration feed (card ea43b848). Deliberately its OWN
  // key, not a variant of `executions(slug, filters)` — boardLoopKeys.detail's
  // precedent: keeping it out from under a shared prefix means invalidating
  // the workspace-wide executions cache never churns a board's loop dialog,
  // and vice versa.
  boardLoopIterations: (slug: string, boardId: string) =>
    ["agents", slug, boardId, "loop-iterations"] as const,
  // The full paginated/filtered log (card 6c036f0b). Filters live IN the key
  // (withConfigured's precedent) so each page + filter combination is its own
  // cache entry rather than one entry thrashing between result sets, while
  // the shared `boardLoopIterations` prefix still prefix-invalidates them all
  // from the same WS subscription.
  boardLoopIterationsPage: (
    slug: string,
    boardId: string,
    params: Record<string, string | number | undefined>,
  ) =>
    [...agentKeys.boardLoopIterations(slug, boardId), "page", params] as const,
  skippedCardIds: (slug: string) =>
    ["agents", slug, "executions", "skipped-card-ids"] as const,
  budgetStatus: (agentId: string) =>
    ["agents", agentId, "budget-status"] as const,
  detail: (agentId: string) => ["agents", agentId] as const,
  analytics: (slug: string, agentId?: string) =>
    ["agents", slug, "analytics", agentId ?? "all"] as const,
};

export const healthKeys = {
  byBoard: (slug: string, boardId: string) =>
    ["health", slug, boardId] as const,
};

export const alertKeys = {
  byBoard: (slug: string, boardId: string) =>
    ["alerts", slug, boardId] as const,
  byWorkspace: (slug: string) => ["alerts", slug] as const,
};

export const teamKeys = {
  all: ["teams"] as const,
  list: (slug: string) => ["teams", slug] as const,
  detail: (slug: string, teamId: string) => ["teams", slug, teamId] as const,
};

export const promptKeys = {
  all: ["prompts"] as const,
  defaults: (slug: string, role?: string) =>
    ["prompts", slug, "defaults", role ?? "all"] as const,
  list: (slug: string, teamRole?: string) =>
    ["prompts", slug, "list", teamRole ?? "all"] as const,
};

export const workspaceConfigKeys = {
  byWorkspace: (slug: string) => ["workspace-config", slug] as const,
};

// Notifications are cross-workspace user-owned: `slug` undefined = all-workspaces
// rollup (the inbox "All" tab + the global unread-count). Keep the key shape
// stable across slug/undefined so the inbox and rollup never collide.
export const notificationKeys = {
  // Prefixes matching every slug variant (including the "all" rollup) without
  // touching the sibling preferences/channels caches.
  allInboxes: () => ["notifications", "inbox"] as const,
  allUnreadCounts: () => ["notifications", "unread-count"] as const,
  inbox: (slug?: string) => ["notifications", "inbox", slug ?? "all"] as const,
  unreadCount: (slug?: string) =>
    ["notifications", "unread-count", slug ?? "all"] as const,
  preferences: (slug: string) =>
    ["notifications", "preferences", slug] as const,
  channels: () => ["notifications", "channels"] as const,
};

export const mergeQueueKeys = {
  // Bare prefix matching every merged-window variant — invalidating this
  // refreshes the default view and the widened one together.
  list: (slug: string) => ["merge-queue", slug, "list"] as const,
  listWindowed: (slug: string, mergedWithinHours?: number) =>
    ["merge-queue", slug, "list", mergedWithinHours ?? "active-only"] as const,
};

export const platformConfigKeys = {
  lifecycleKinds: () => ["config", "lifecycle-kinds"] as const,
};

export const apiKeyKeys = {
  all: ["api-keys"] as const,
};

export const meKeys = {
  me: () => ["me"] as const,
};

export const authKeys = {
  modes: () => ["auth", "modes"] as const,
  setupStatus: () => ["auth", "setup-status"] as const,
};

export const completionKeys = {
  contextImpact: (slug: string, kind: string, id?: string) => ["completion-context-impact", slug, kind, id ?? null] as const,
  board: (slug: string, boardId: string) => ["completion", slug, boardId] as const,
  policy: (slug: string, boardId: string) => ["completion", slug, boardId, "policy"] as const,
  preview: (slug: string, boardId: string, policy: unknown, loopConfig?: object, template?: object) => ["completion", slug, boardId, "preview", policy, loopConfig ?? null, template ?? null] as const,
  card: (slug: string, boardId: string, cardId: string) => ["completion", slug, boardId, "card", cardId] as const,
};
