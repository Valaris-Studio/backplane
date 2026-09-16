# Valaris Internal Platform — History and Lessons Learned

A narrative overview of where the platform came from, the principles that now guide its evolution, the rough edges we are still filing down, and the things that clearly work. Written for a reader who wants to understand the project without reading the code — with enough technical precision that an engineer can act on it.

Sources: git log (319 commits as of `2026-04-19`), `memory/plan.md` (north star + backlog), `memory/feedback_*.md` (durable principles), `memory/audits/*` (four parallel read-only audits + live walkthrough), `memory/archive/*` (completed milestone narratives), and the project's `CLAUDE.md` conventions.

Document status: point-in-time snapshot `2026-04-19`. Claims about specific file:line anchors may drift — the platform is actively evolving, and commits after this date supersede these claims where they conflict. The principles, themes, and architectural narrative are stable; the specific commit SHAs and audit findings are accurate as of the date stamp.

Intended audience: product stakeholders who need the shape of the platform without reading code, engineers onboarding to the project who want the "why" context before diving into specific files, and operators evaluating whether Valaris fits their use case. Each audience should find the relevant depth in one of the nine sections below; reading linearly is not required.

---

## 1. Platform Story

### Origin — an internal productivity tool

Valaris Internal began as a custom internal tool for the Valaris software factory: a Kanban board plus workspace tenancy, definitions, resources, notes, channels, and activity history. The first commits (`4706b9e` through roughly the first ~15 changes) stood up the skeleton a small team needs to coordinate work — Postgres, FastAPI, React, Docker Compose, IAP auth on Cloud Run, fractional card indexing, rich-text notes, file attachments.

For its first few weeks this was a conventional project-management app. The distinguishing choice from day one was the **monorepo + layered backend** discipline (Router → Service → Repository → Model), which later proved critical once autonomous agents started hammering the same endpoints that humans used. The second distinguishing choice was idempotent-mutation patterns from the first `BoardService.create_board` — returning the existing entity on slug collision rather than raising 409. At the time it was a nicety; in retrospect it was the first correctness invariant that made multi-agent operation possible without custom retry logic.

### Pivot — from "internal tool" to "agentic software factory"

The pivot happened when the MCP server landed (`9c124b5` — "Add Valaris MCP server with 32 tools for AI agent integration"). Adding programmatic, LLM-driven access forced a different question: what does the product look like if the primary operators are agents rather than humans? That re-framing reshaped everything downstream.

Concretely: if the caller is an LLM, every endpoint must tolerate retry (idempotency becomes a correctness invariant, not a nicety), every response must be shaped for token economics (composite endpoints over round-trip chatter), every field must be documented in-band (MCP tool docstrings are part of the contract), and every mutation must broadcast so that other agents and humans watching the same workspace stay coherent. The properties of the platform shift from "correct for the UI" to "correct for a distributed multi-writer system where half the writers are probabilistic."

The agentic story then unfolded in a series of named milestones:

- **Harness engineering plan** (`92f12c1`, `ef8f322`) — defined the agent-facing surface as an explicit engineering milestone, not a side feature. Established the vocabulary (runners, roles, stages, sensors, approvals) that the rest of the work inherits.
- **Phase 1–7** of harness work — introduced agent identity rows, execution logs, scoped API-key auth, human-in-the-loop approval, agent teams and prompt configs, cost metrics, and the "intern" Go client (`11ca7c0` onward). Each phase was an independently-shippable slice; by Phase 7 the platform had a working multi-role scheduler, team-based prompt resolution, and a headless Go runtime.
- **Tiers 1–5** of platform hardening — resilience, headless operation, WebSocket event layer (Tier 4.0, the single most impactful addition in this range), execution lineage, tool invocation tracking, cost alerts and budget enforcement. The WS event layer is what made everything subsequent possible: without it, every cross-surface sync would have been HTTP polling.
- **Milestone 7 (Snake Team PoC)** — the first validated multi-agent run end-to-end, $9.32 of LLM spend, proved the architecture worked. Three runners collaborated on a Snake game card through claim, implement, review, and ship without human intervention between stages.
- **Milestone Alpha** — the flag-plant milestone. Three pillars (Platform Completeness, Runner Client Maturity, Agentic UX Clarity) with validation criteria V1–V7. Closed `2026-04-19` with merge commit `c5f7e87`, tag `milestone-alpha-complete`, PR #1. 282 commits on the feat/harness-engineering-plan epic branch. The operator-in-the-loop validation model (continuous TDD + live smoke) carried the epic-branch review load; post-Alpha adopts tighter branch discipline.
- **M-Observability** (wrapped `2026-04-19` as part of Alpha) — every mutation on every entity publishes an `activity.{entity}.{action}` bus event; a single `useDomainSync` hook wires React Query to those events in one line; slug-identity migrations (Board, AgentTeam, GitRepo, AgentPromptConfig) laid groundwork for config portability. The milestone fanned out 28 `(entity, action)` pairs as observable events, brought `useDomainSync` from 5 callsites to 18, and closed `column.updated` + `column.deleted` events that were previously declared but not emitted.

### What the platform is today

Valaris Internal is now an **agentic software factory**: runners (credentialed Go processes named "intern") pick up cards, execute pipeline stages (implement, review, document, or any custom role the operator defines), and report cost and outcome back to a human operator watching an observatory UI. Humans shape pipelines, curate prompts, set budgets, and review approvals. The runners do the implementation work inside sandboxed branches, and the platform arbitrates.

A representative pipeline tick looks like this:

1. A runner polls the backend (via WebSocket event, not HTTP interval) for work matching its team membership. The trigger can be `card.created`, `card.updated`, `card.moved`, a manual `agent.poll_requested`, or an idle-timer safety net.
2. The backend tells it: "claim card X for stage Y." The claim is atomic — the card's hero participant field is updated in a single transaction with a unique constraint that prevents double-claim. Two runners racing for the same card lose one cleanly; the loser backs off.
3. The runner fetches context — board definition, pinned notes, card description, relevant prior executions — via REST, formats it into a mandatory-labelled prompt block. Context augmentation is code-controlled; the LLM never fetches its own mandatory context.
4. The runner invokes Claude CLI via subprocess with the assembled prompt, streams stdout as NDJSON, accumulates cost from the `result` event. Session persistence lets long-running claude sessions be resumed with the `-r <session_id>` flag.
5. Tool calls the LLM makes during the run go through MCP — which the runner exposes as a local server configured via a sibling JSON file. Every tool call records a `tool_invocation` row with cost, duration, and arguments.
6. On completion, the runner reports status (blocked / success / rework-requested), moves the card to the stage's configured success or failure column, fires an approval request if the stage requires one, and emits an `execution.completed` event. Cost is reported back to the `AgentExecution` row; budget enforcement runs pre-tick.
7. The frontend's Observer panel shows the event live; the operator never refreshes. The next runner in the pipeline (if any) sees the card in its new column and begins its own discover phase. The whole cycle is observable: every card position change, every execution, every approval, every cost threshold crossing has an activity row plus a bus event.

The architecture has four collaborating surfaces:

- **Backend** (FastAPI, async SQLAlchemy, Postgres 16) — the authoritative source of truth for pipeline configuration, prompts, team composition, budgets, column semantics, and permissions. All business logic lives in services, all data access in repositories, all auth at the router boundary via dependencies. The `get_workspace` dependency resolves a slug to a workspace object and verifies membership in one step; `get_workspace_admin` does the same plus role check.
- **Frontend** (React 19 + Vite 6 + Tailwind v4 + shadcn/ui, written by hand not CLI-installed) — the operator's observatory, configuration editor, and kanban workspace. Feature modules live in `features/{name}/` with `api/`, `components/`, `hooks/`, `utils/` subdirectories. React Query handles all server state; optimistic updates for drag-and-drop. A single WebSocket connection per tab carries all live events; `useDomainSync(domain, queryKey)` is the one-line bridge from event to cache invalidation.
- **MCP server** (Python, 67 tools) — the HTTP surface LLMs call into, with composite tools like `get_project_context` and `get_board_health` designed to reduce round-trips. Four agent-role prompts (Project Initializer, Secretary/Manager, Architect/Orchestrator, Coding Agent) wrap common workflows. Tool error handling is centralized; agent-id tracking is automatic via API-key prefix.
- **Intern Go client** — the credentialed runner. Fetches pipeline config from the backend, picks up cards via WebSocket events, drives Claude CLI subprocesses to generate code, and reports executions, costs, and status back. Built to run headless on an operator's laptop, a CI box, or a dedicated server. One binary per runner identity; a runner with multiple roles runs all of them in one process.

Production runs on Cloud Run + Cloud SQL in the production GCP project, with IAP on the frontend service restricted to the `@valaris.studio` domain. The backend sits behind the frontend proxy (no separate IAP) because the Go runner authenticates with API keys, not Google Workspace identities.

### Milestone tag summary

| Milestone | State | Signal |
|---|---|---|
| Initial internal tool (kanban, notes, resources, IAP auth) | Done | ~commit 30 |
| MCP server (32 → 42 → 67 tools) | Done | `9c124b5` → `ec43cfe` |
| Harness Phases 1–7 (agent identity, approvals, teams, prompts) | Done | `a7bd0ae` → `3faac27` |
| Tiers 1–5 (resilience, WS, lineage, cost alerts) | Done | `f7399da` → `af9da69` |
| Milestone 7 PoC (Snake Team multi-agent run) | Validated | `f4a0ea3` |
| Milestone Alpha (agentic software factory) | Closed `2026-04-19` | `c5f7e87`, tag `milestone-alpha-complete` |
| M-Observability (platform-wide live state + slug identity) | Closed `2026-04-19` | `0638042`, `cc806b9`, `3cdb4f4` |

### What was proven at each milestone

- **Milestone 7 (Snake Team PoC)** proved that multiple runners with different roles could collaborate on a real card through the full lifecycle — discover, claim, implement, review, ship — without human intervention between stages, for an end-to-end cost of $9.32. The card was a Snake game implementation. The milestone answered: "can three agents pass work to each other without stepping on each other?" Yes, with care: idempotent mutations on participant-add, explicit column-type semantics rather than column-name magic, and WebSocket-driven poll triggers rather than fixed-interval polling.
- **Smoke tests #3–#13** each exposed a different failure mode and produced a feedback rule. ST#3 produced the idempotency rule. ST#5 produced the AgentStatusBar-requires-WS rule. ST#8 produced the backend-authoritative rule. ST#11 produced the subagent-briefing-principles rule. The smoke tests are the platform's production tests — synthetic scenarios that run the full stack against a real operator end-to-end, and every one of them has surfaced at least one structural bug.
- **Milestone Alpha** proved the "operator can reach go without secret knowledge" bar is close but not yet met. The runner-launch walkthrough ran end-to-end but took three manual interventions. Most of those interventions are now fixed. The final live validation — an unassisted operator creating a runner, exporting config, launching, and observing successful work — is the next smoke test.
- **M-Observability** proved that the activity system could become a bus and a persistence layer at the same time. Every mutation on every entity now both records to the DB and publishes on the WebSocket bus; every frontend query hook that wants live sync gets it in one line. The milestone also closed the epic-branch experiment: post-Alpha, branches stay small and thematic.

---

## 2. Development Principles

These are the durable rules the project enforces. Each one came out of a concrete incident; each one now governs design review. The path from incident to principle is worth tracing: a symptom is observed in a smoke test or a live run, the post-mortem identifies the structural cause (not the surface behavior), and a single-purpose feedback document captures the rule in language terse enough that a sub-agent briefed in 50 words can apply it. The principles are load-bearing — every design review starts by asking which of them the proposal engages.

### Backend owns pipeline, role, and prompt configuration

The Go runner is a thin client. It fetches pipeline shape — roles, stages, sensors, filters, priority order — from the backend via `GET /api/agents/me/config`. It does not carry a hardcoded default pipeline at runtime. When the platform config is missing, the runner refuses to start instead of falling back. This rule exists because `ST#8` silently shipped a 3-role hardcoded pipeline over a 5-role platform pipeline — the backend was configured correctly, the runner ignored it. Defaults and fallbacks are fine at the *platform* level (a new workspace boots with useful scaffolding); they are a bug at the *client* level. The practical test: if the operator adds a role named `security-auditor` via the UI, the runner should see it next poll without a single Go file changing.

### WebSocket-first communication

If two components on the platform (backend, runner, frontend, MCP) can reach each other through the existing workspace WebSocket bus, they use it. HTTP is reserved for REST RPCs (claim card, move card, PATCH execution), external webhooks (GitHub callbacks), and the MCP tool-call server. The rule came out of Docker networking pain — the agent was on the host, the backend in a container, HTTP couldn't traverse the bridge, but the WS bus already connected them. The broader win: every HTTP-poll path is a source of latency floors (the frontend polls at 15–120s windows), topology fragility (container-bridge / NAT / VPN failures), and observability blind spots (HTTP traffic doesn't flow through the same event bus everything else does). HTTP polling fallbacks in the frontend are allowed only when `enabled: !wsConnected`; any `refetchInterval` that fires while WS is up is a bug.

### Idempotent mutations

Create and add operations return the existing entity on duplicate instead of raising a 409. An LLM retrying a failed `add_card_participant` call, or a multi-role runner hitting the same endpoint from two pipeline stages, must not be punished for the second attempt. "Already exists" is a success, not an error. This rule came from Smoke Test #3: a reviewer role tried to add itself as a participant, got a 409, failed the card, ticked again, eventually adapted — one wasted tick per failure, multiplied across every smoke run.

### Code-controlled context augmentation

Every piece of context a prompt needs — board directives, definition content, pinned notes, card history, review findings — is fetched by code (Go or Python), formatted into a text block, and injected into the prompt under a clearly-labelled mandatory section. The LLM never fetches its own context via tool calls for anything the pipeline depends on. Two smoke tests showed that LLMs treat tool-call results as optional reference, not mandatory instructions; a reviewer's findings ignored once costs another full rework cycle (~$0.70). LLM attention is for reasoning and output, not data retrieval. The pattern for adding new context: Go code fetches via REST, formats as `=== SECTION NAME (MANDATORY) ===`, exposes via `PromptContext` as `{{.FieldName}}`, non-fatal on fetch failure (log warn, proceed without), never a tool call.

### Directive compliance — Opus or structured injection

Sonnet reliably ignores subtle directives in prompts. Concrete observation: a planted `# Valaris Alpha` comment directive in a board note was ignored by the implementer (Sonnet) but correctly obeyed by the reviewer (also Sonnet, but the directive reached it via commit-prefix convention). Two fixes both work: (a) inject the directive as **"Step N: Do X"** imperatives in the prompt template rather than leaving it as generic "follow project conventions"; (b) run implement on Opus and discover/claim on Sonnet for cost optimization. Current practice combines both: the pipeline's `post_process_kind` now auto-injects imperatives, and model selection is operator-configurable.

### Extensibility without hardcoded ceilings

The platform's north star is a **fully customizable agentic pipeline**. Operators define any role (not just `orchestrator/reviewer/documentator`), any rules (filters, claim semantics, git actions, sensors, branch logic), and any prompts. Defaults are legitimate; they must never be the ceiling. The test for a proposed change: does it silently break if the operator invents a new role tomorrow? If yes, restructure it data-driven (table lookup on `pipeline_config.stages[]`) rather than as a Python enum or Go switch. This principle forced the T1.1 work — dropping `TeamRole` enum from the backend model, replacing `UNIQUE_ROLES` with pipeline-driven `stages[*].unique`, and making the frontend `AddTeamMemberDialog` a free-form combobox.

### Model-agnostic per-role LLM provider

Role extensibility without model extensibility is a half-answer. The north-star architecture: one runner binary, multiple roles concurrently, each role declares its own LLM provider + model via `pipeline_config.stages[*].llm.{provider, model}`. Implementer on Claude Sonnet, reviewer on GPT-5, documentator on Gemini — all from the same runner. Research on LLM self-critique shows measurable bias when a model reviews its own output; the failure mode for review-type roles is silent rubber-stamping. Model-per-role resolves that at the layer that matters. The work is scoped; the implementation is tracked under the LLM abstraction milestone.

### Review context quality requirements

Rework prompts need reviewer findings as structured action items, not raw prose. A reviewer's wall of text produced a cosmetic rework that didn't address any of the blocking issues; the second rework wasted another $0.70. The fix is format: numbered action items, explicit file:line references, checkbox-shaped rather than paragraph-shaped. Reviewer output is the authority on what's wrong; prompts must treat it as a checklist not a suggestion.

### TDD mandatory for new features

Every new feature and bug fix is test-first: write the failing integration test, write the minimum code to make it pass, refactor while green. Integration tests use `httpx.AsyncClient` against the real FastAPI app with an in-process aiosqlite DB — no Docker needed. Auth is faked via an `X-User-Email` header. Each test is function-scoped and rolls back. A 5-second per-test timeout catches hung tests fast instead of starving parallel sub-agents. The discipline is enforced in CLAUDE.md and carried through all multi-agent dispatches: test-writing sub-agents run before implementation sub-agents, and green tests are a merge precondition even when the implementation is obvious.

### Additional operating rules (meta)

These are project-management rules rather than code rules, but they shape everything the engineering surface touches.

- **Branch hygiene (post-Alpha):** one theme per branch, ~20-commit soft ceiling, PR-before-drift. The 282-commit Alpha epic was tolerable because review was continuous TDD + live smoke with the operator acting as sole reviewer; post-Alpha PRs must stay scannable end-to-end, which means they must stay small enough to scan. Crossing the soft ceiling means either the theme was too broad or drift has set in — pause and cut.
- **Subagent briefings transmit principles explicitly.** Every sub-agent starts with zero context. Leaving principles implicit produces work that matches the letter of the request but misses the spirit. Every brief carries, in words not links, the five core principles (code-is-documentation, detail-oriented, focused-on-main-goal, TDD always, parallel when possible) plus whatever project-specific rules the task touches. Briefs also specify scoped test runs, not full-platform suites — a backend cleanup sub-agent doesn't need to run the frontend test suite.
- **Worktree isolation is not always safe.** Parallel Agent calls with `isolation: "worktree"` have landed on stale commits missing pre-landed scaffolding. When a fanout depends on pre-landed state, either drop isolation or put a mandatory prerequisite-check block at the top of every brief. When a sub-agent reports "I wrote via absolute paths because my cwd was stale," treat that as a smell and audit the main-tree diff before committing.
- **Never stop running agents or tests without explicit operator permission.** Hung sub-agents get diagnosed, not killed reflexively.
- **No gold-plating, no half-finishing.** Complete the task; don't leave dangling imports or commented-out code. But don't redesign working code just because it could be cleaner. Three similar lines are better than a premature abstraction.

### Incident-to-principle traceability

Every rule above has a specific anchor:

| Principle | Anchor incident | Date |
|---|---|---|
| Backend authoritative config | ST#8 — 3-role hardcoded default beat 5-role platform pipeline | 2026-04-16 |
| WebSocket-first communication | T1.6 — Docker bridge blocked HTTP from backend-in-container to agent-on-host | 2026-04-17 |
| Idempotent mutations | ST#3 — reviewer role tried to re-add itself as participant, 409 wasted a tick | 2026-04-14 |
| Code-controlled context augmentation | Mediator 3/3 failure — LLM had to fetch AND format, dropped the formatting | 2026-04-14 |
| Directive compliance | Alpha smoke — `# Valaris Alpha` directive planted in note, Sonnet ignored | 2026-04-14 |
| Extensibility without ceilings | Alpha-validation workspace had 5 roles; PromptConfigPage rendered 3 raw i18n keys | 2026-04-17 |
| Model-agnostic per-role LLM | T1.1 surfaced Go self-review guard hardcoded on `p.Role == "reviewer"` | 2026-04-19 |
| Review context quality | Tier 5 validation — reviewer's 1260-char feedback ignored in rework | 2026-04-13 |
| Subagent briefs transmit principles | T2.1/ST#11 — sub-agent work drifted on style without explicit principle call-out | 2026-04-17 |
| Worktree isolation staleness | UX-B fanout — Lane B landed on commit predating pre-landed scaffolding | 2026-04-17 |

The traceability is the point. None of the principles are philosophical — every one has a date, a dollar cost (where applicable), and a fix in the archive.

---

## 3. Known Rough Edges

Four parallel read-only audits ran on `2026-04-17` (backend, intern/Go, frontend, MCP + cross-cut). A live runner-launch walkthrough followed on `2026-04-18`. The findings cluster into a few themes rather than a sprawling punch-list.

The audits themselves are a deliberate mechanism: four sub-agents, file-disjoint scopes, read-only access, consistent brief. The output is a set of Markdown files (`audits/audit_{backend,intern_go,frontend,mcp_and_crosscut}.md`) plus a consolidated `summary.md` that clusters findings by blast radius. The pattern ran cleanly — no finding was raised in more than one audit, no audit contradicted another. Where the four audits agreed on a theme (platform-authority violations, WS coverage), that became the top of the cleanup queue. Where they disagreed in emphasis (e.g., backend audit flagged `ACTIVITY_EVENT_MAP` as a Major, MCP audit flagged its downstream effects as Minor), the operator resolved the priority.

### Audit scale at a glance

- **Backend:** 4 Critical (authz/idempotency), 7 Major (principle violations, wrong abstractions, exception-handler inconsistency), 12 Minor (dead code, test gaps, polish). Zero TODO/FIXME in the tree.
- **Intern/Go:** 2 Critical (platform-authority defaults), 11 Major (hardcoded fallbacks, gh-ism outside git/, legacy code), 20+ Minor (error-handling polish, goroutine patterns, stream-parse robustness). ~20 code refs + 5 docs + 2 configs still carry "orchestrator" literal as shopping list for T1.1. Zero TODO/FIXME.
- **Frontend:** 3 Critical (WS-sub gaps, no connection-status indicator, scaffold tooltip in production), 9 Major (duplicated column-type enums, hardcoded role palette, pipeline-builder enum drift, dialog state hygiene), many Minor (a11y, inline query keys, KanbanCard keyboard activation). Zero production `any` / `ts-ignore` / `as any`.
- **MCP + cross-cut:** 2 Critical (list_teams params bug, create_agent docstring lies about enum), 6 Major (init_project definition-key mismatch, webhook-event list drift, log_execution_update missing duration_seconds, test-loads-all-tools covers 35 of 67). Zero TODO/FIXME.

Total: roughly 50 distinct findings across four surfaces. None structural. All localizable.

### Critical themes

**Platform authority violations.** The biggest single cluster. The Go runner shipped with a hardcoded `priority_order: ["reviewer", "orchestrator", "documentator"]` default that silently overrode any platform-configured scheduling — directly violating the backend-authoritative principle. Concretely: the runner's `loop.go` checked "is YAML priority_order non-empty? if yes, use it as an override" — but because the defaults pre-populated the field, the check was always true, even when the YAML had no `scheduling` block. Custom roles like `Secretario` were loaded into strategies but never selected by `scheduler.Next()`. Silent.

The same runner carried a full `DefaultPipelineConfig` (a 3-role hardcoded pipeline with stages, tools, columns, scheduling) reachable from validation paths. Plus hardcoded column-type fallbacks (`"review"`, `"backlog"`, `"blocked"`, `"done"`) sprinkled across the ship/rework/failure paths. Plus `LogExecutionStart(..., role="orchestrator")` hardcoded on legacy paths, so the backend saw "orchestrator" for every claim regardless of the stage's actual role. Any of these firing meant the operator had configured something and the runner ignored them.

Thread A of the Runner Onboarding & Authority theme closed the most serious of these (commit `efc507e`); subsequent commits (`0569463`, `bd05f56`) removed the `DefaultPipelineConfig` runtime fallback and dropped the `TeamRole` enum in favor of pipeline-driven `stages[*].unique`. Residual work: a handful of Go files still carry hardcoded role literals (`capitalizeRole` switch mapping "orchestrator"→"Implementing card", self-participation guard on `"reviewer"`, the `docs(...)` commit prefix auto-triggered by `BranchPrefix != ""`) tracked for the LLM-abstraction milestone because the real fix is model-per-role independence, not patching the heuristic.

**Backend authorization gaps.** Four critical items surfaced: an unauthenticated local-storage endpoint that let any HTTP caller read or write arbitrary payloads under `LOCAL_STORAGE_DIR`, executions endpoints that authenticated the caller but never verified `user.id == agent.created_by_id` (any authed user could spoof executions — including cost_usd, input_prompt — for any agent in any workspace, corrupting audit trails and budget metrics), cross-tenant UUID leaks on prompt-config read/write/delete (a member of workspace A could read/modify/delete a prompt config of workspace B by UUID), and a prompt-config create that 500s on unique-constraint collision instead of returning the existing row. All four have been dispatched through the Batch A/B/C authz and idempotency cleanups; the residue is test-coverage confirmation and a round of integration tests for cross-tenant refusal (expect 404, not 403 — don't leak existence).

**WebSocket subscription coverage + StrictMode races.** The frontend has 12+ query hooks that don't subscribe to WS events — notes, activity, dashboard counts, resources, git repos, channels, members, definitions, alerts, team detail, prompt configs, and the boards list. On multi-user mutations these silently go stale. Separately, the WS connection status had no UI surface: a dropped socket was invisible; a user sitting on a frozen page had no affordance to diagnose.

M-Observability addressed the structural half: every activity now publishes on the bus under `activity.{entity}.{action}`, and `useDomainSync(domain, queryKey)` replaced the 5-line `useQueryClient` + `useWebSocketEvent` + `invalidateQueries` block at every invalidation-only site. A TopBar WS-status badge shipped in `0780230`. Known residue: StrictMode double-invocation races during initial subscribe (effects fire → cleanup → re-fire; if `onclose` fires after a new `connect()` resets shared state, it causes phantom reconnect loops — the fix is to guard all callbacks with a stale-connection check); server-side subscribe-timing gaps (the WS server requires an explicit `{"subscribe": [...]}` message on connect and when new patterns register); and provider/child effect timing (child `useEffect` runs before parent, so `useWebSocketEvent` hooks get `null` on first call unless the provider bumps a `serviceEpoch` counter). These are tracked in `feedback_websocket_bugs.md` as fix-before-expanding-reliance items, because every additional WS consumer we add multiplies the blast radius of any of these three timing bugs.

### Major themes

**Schema drift across the four surfaces.** The platform has four type boundaries — Pydantic schemas (backend), TypeScript interfaces (frontend), Go structs (intern), and JSON payloads (MCP) — and three-way drift between them is the single largest source of papercuts. Concretely: intern's Go structs for `Board` and `GitRepo` lack a `slug` field, which blocked slug-based URL migration until `cc806b9` landed the backend dual-lookup and the intern structs are being fed through. `PlatformConfig` on intern exposes a single `TeamRole` rather than `team_roles[]`, so multi-role runners effectively see only their first role. The frontend `SchedulingDef` omits `min_failure_backoff_seconds` (intern supports it; users can only set via YAML). The frontend and intern `WorkspaceConfig` both omit `model_pricing` — if cost accounting starts being workspace-scoped, both clients will silently miss it. MCP's `init_project` prompt writes definition keys (`no_gos`, `timeline`, `team`) that don't match the frontend's `DefinitionContent` schema (`exclusions`, `milestones`, `stakeholders`) — the backend accepts them (dict column), but definitions created via MCP render as free-form blobs instead of the structured view. Most of these have 3-line fixes; they add up because each is a separate pair of eyes on a separate contract.

**Hardcoded enums duplicated across the frontend.** `COLUMN_TYPES` appears verbatim in three different files. `ROLE_COLORS` has a second hardcoded palette that misses custom roles (renders them as `"unknown"`). `ACTION_PRESETS`, `DISCOVER_STRATEGIES`, `CLAIM_ROLES`, `GIT_ACTIONS`, `POST_PROCESS_KINDS` all live as TypeScript literals in a pipeline-builder component. Fixing these needs a backend `/config/schema` endpoint so the frontend can pull enum options at runtime — tracked as the "config-driven enum purge" work.

**Authoring UX for custom roles.** The platform accepts custom roles end-to-end in the pipeline DSL, but the prompt-authoring surface depends on registry entries that only exist for canonical roles. A concrete 2026-04-17 incident: the alpha-validation workspace had 5 roles (researcher, planner, implementer, reviewer, documentator); PromptConfigPage rendered 3 as raw i18n keys (`teams.roles.researcher`, `teams.roles.planner`, `teams.roles.implementer`) because the i18n only covered the legacy 3-role set. Short-term patch (`219cd91`, `T1.1`) added a "Create new stage" bypass and `{defaultValue: role}` at 8 call sites; long-term fix is a synthesized default surface for any pipeline-declared role (so the UI always has *something* to edit) plus a generic executor + platform-default minimal-agentic-prompt template on the intern side.

**Runner onboarding friction.** The live walkthrough on `2026-04-18` surfaced 11 bugs (B1–B11) grouped into two threads. The pipeline *did* execute end-to-end — claim → MCP session → label applied → stage completed in 17 seconds, $0.26 — but only after three manual interventions that a real first-time operator would not know to perform. Each intervention marked a real wall. Thread A (platform authority — the B1/B6/B7 cluster above) closed. Thread B is the operator-facing layer:

- **Allowlist visibility wall:** a freshly-created runner has `allowed_workspaces: null`, and the metrics filter treated null as "no workspaces" rather than "all workspaces." The runner was invisible in the workspace where it was created. Fixed by making `AgentCreate.allowed_workspaces` required and non-empty, replacing the misleading "Unrestricted — all access" hint with a red "required" warning.
- **Misleading exported YAML:** `role:` was written at the top level even though the runner ignores it (roles come from team membership). Operators edited it expecting it to matter.
- **`git.base_dir` placeholder:** `/path/to/repos` — operator must hand-edit before launch. For runners whose roles all have `git.action: none` the field is irrelevant but still required-looking.
- **`mcp_config_path` raw filesystem path:** operators have no way to know what this is or how to fill it. Fixed by bundling a pre-filled `mcp-config-{name}.json` sibling file; operator drops both files in one directory, no path to type.
- **Prompt-authoring contract:** setting `post_process_kind: produces_note` doesn't auto-inject a "Step N: Call `create_note(...)`" imperative into the prompt. Sonnet reads the card, decides the work is done, returns status JSON, never calls the tool. Fixed by synthesis-time + resolve-time imperative injection on the backend so the operator never has to know the post-process contract; they pick a kind, the platform produces the instruction text.

Most of Thread B is done (`92b213c`, `3bd4cc4`, `6ae22b6`, `caafbd4`, `9b35a04`); the final live smoke test on `test-alpha-2` is operator-gated.

**Idempotency holes beyond the critical cluster.** `create_workspace` raises on slug collision; `add_member` raises on duplicate; a few other routers still throw 409 where they should return the existing entity. Batch C cleans them up mechanically. The MCP server side has a related shape: `create_workspace` in the MCP tools does a pre-GET + POST to work around the backend's non-idempotence, which is two round-trips per creation and leaks a made-up error shape to the LLM; the fix is on the backend.

**Polling where WebSocket events already exist.** On the intern side, `GetAgentConfig`, `GetPlatformConfig`, and `GetPromptConfigs` are HTTP-refreshed every poll cycle despite the backend emitting `config.*` and `agent.*` events that could trigger a one-off fetch. On the frontend, `useConfigSync.ts` subscribes to a `team.*` wildcard that the backend doesn't emit. Batch F (WS-3 event-driven config) will collapse the per-cycle HTTP refreshes into event callbacks with HTTP only as a safety-net fallback.

### Minor themes

**Dead/unemitted events.** A few event constants are declared in the `WebhookEvent` enum but never published by any service — `board.health_changed` is the clearest example. The frontend's `useConfigSync.ts` subscribes to a `team.*` wildcard that the backend doesn't emit (team changes emit `config.changed` instead). `agent.heartbeat_received` is emitted but has zero consumers. These are either deletions (remove from the enum) or wirings (emit them). M-Observability's `docs/events.md` catalogs them; the cleanup is mechanical.

**Dead code.** An unreferenced `CardRepository.list_by_column`, a non-routed `ComingSoonPage`, a superseded `useMoveCard` hook, and three UX-A scaffold components (`AgentInfoSubtab`, `AutoFillButton`, `ConfigAnalysisPanel`) whose only callers are their own test files. Keeping them costs a small amount of mental overhead every time a dev asks "is this scaffold or production?" — but removing them without confirming downstream UX milestones won't consume them would be premature.

**Accessibility.** 53 unassociated `<label>` elements across 16 form files; a dozen-plus icon-only buttons without `aria-label`; the sidebar-close button has an untranslated English aria-label. Mostly swept in `9ac439f`/`c77a699`; residual items are tracked.

**Test coverage pockets.** 11 of 13 frontend feature modules have zero component tests (only `agents` and `approvals` ship any). Several non-trivial backend modules — `pipeline_config_validation.py` (437 lines, business-critical), `metrics.py`, `sensor.py`, `board_context.py` — have no direct tests and rely on router-level coverage. `test_server_loads_all_tools` on the MCP side asserts only 35 of 67 registered tools.

**Claude CLI integration fragility.** On non-zero exit, partial stdout could still populate `StructuredOutput`. Stderr buffer was unbounded (capped at 64 KiB in `4d81eee`). Stream-JSON parse errors continue silently — fine in practice, but worth a debug log.

### What the audits did NOT find

No `TODO`/`FIXME`/`XXX`/`HACK` comments anywhere in the tree. Zero production `any` / `@ts-ignore` / `as any` in the frontend. No `panic()` outside `main` in the Go code. No missing `defer cancel()` on `WithTimeout` paths. No manual transaction commits in services or repositories. No async-lazy-load errors caught at response time (every nested Pydantic schema has a corresponding `selectinload` in the repository layer). Discipline at the craftsmanship layer is tight; the debt is in principle enforcement at the seams (authz, idempotency, config authority, WS coverage, schema drift), not in individual code quality.

The distinction matters because it tells you what kind of work the next session needs. Craftsmanship debt compounds with every new file — you either clean as you go or accept a rewrite. Principle-enforcement debt localizes — each finding has a fix that touches a few files, a few tests, and closes on its own merit. The audits surfaced ~50 findings. None of them are structural. All of them are addressable.

---

## 4. Active Scoping Decisions

Two decisions are active right now and will shape the next few sessions.

### Slug identity migration — UUID → slug for config-shaped entities

**Status: implementation complete for the data model.** Four migrations landed (`040_add_board_slug.py`, `041_add_prompt_config_unique_slug.py`, `042_add_team_slug.py`, `043_add_git_repo_slug.py`). The backend now accepts slug-or-UUID on Board, AgentTeam, GitRepo, and AgentPromptConfig via a dual-lookup service pattern. The remaining work is three-fold: intern YAML `board_ids:` accepts slugs, frontend routes prefer slug over UUID with UUID-alias redirects, and the `slug` column nullability drops once all producers have shipped.

**Why it matters:** UX-D — config import/export — depends on slug identity. A pipeline config exported from workspace A must round-trip into workspace B without rewriting identifiers; a URL a human shares must be durable across renames. UUIDs are portable (globally unique) but not readable and not human-editable. Slugs are the right identifier for config-shaped data (Board, Team, GitRepo, PromptConfig); UUIDs remain correct for ephemeral runtime rows (executions, activities, approvals, cards, members).

**Decided scoping:** workspace-scoped uniqueness (not global) — `(workspace_id, slug)` for Board and AgentTeam, `(board_id, slug)` for GitRepo, `(workspace_id, team_id, team_role, stage, slug)` for AgentPromptConfig. Cross-workspace team-template marketplaces stay out of scope until post-Alpha.

### "Agent" → "Runner" vocabulary migration

**Status: Phase 1 complete `2026-04-18`.** The word "agent" was overloaded onto three distinct concepts — (A) credentialed process identity (the Go intern binary), (B) pipeline role / persona (implementer, reviewer, custom), and (C) card-participant kind (hero, helper, stakeholder). Users couldn't tell them apart; the "Create Agent" form asked for an "Agent Type" upfront, which is design-wise wrong because the same runner can execute multiple pipeline stages across ticks.

**Phase 1 (done):** frontend i18n copy sweep — every user-facing string meaning concept A renamed to "Runner"; concept B stays "Role"; concept C stays "Participant role". `CreateAgentDialog` dropped the `Agent Type` select entirely.

**Phase 2 (pending, low risk):** docs + MCP tool descriptions. Pure prose, no runtime behavior change. Canonical definition lives at `docs/runner-runtime.md:40-43`.

**Phase 3 (pending, medium risk):** backend schema cleanup — make `agent_type` optional on create, stop reading it as an authorization axis, then two-deploy migration to drop the column. Phase 3 follows CLAUDE.md migration safety because Cloud Run rolling updates can have old and new code briefly coexist.

**Why it matters:** unambiguous vocabulary is a prerequisite to scaling the operator base. "Runner" matches GitHub/GitLab/CI's established meaning (a registered machine slot that executes jobs). Rejected alternatives: `client` (collides with HTTP clients), `worker` (collides with background job workers), `bot` (implies autonomy), `intern` (internal Go name, leaky).

**Non-goals:** the database table `agents`, the SQLAlchemy `Agent` model, API routes `/api/agents/...`, MCP tool names `create_agent`/`get_agent`/..., and Go struct `valaris.AgentConfig` all stay. Breaking them simultaneously for a cosmetic win isn't worth it.

---

### Why these migrations matter operationally

**Slug identity** unblocks the import/export milestone (UX-D). Without stable human-readable identifiers for config-shaped entities, every exported pipeline config is a bundle of opaque UUIDs that either break on import into another workspace or get silently remapped and drift. Slugs make pipelines shareable, templatable, and review-diffable. The migration is additive (both slug and UUID resolve during transition), so no producer is rushed; the UUID path is deprecated once every producer is known to have moved.

**Runner vocabulary migration** is a prerequisite to scaling the operator base beyond the internal team. The internal team absorbs the overload; a new operator reading "Create Agent" on a form that asks for "Agent Type" upfront is getting lied to — the same Go client can run multiple pipeline stages across ticks, so the role is emergent from pipeline configuration, not a property of the credential. Fixing this is cheap (it's copy), the hard part is discipline: changing only what users see, leaving the database table, SQLAlchemy model, API routes, MCP tool names, and Go struct alone so external callers don't break.

### Why the word "runner"

Decided deliberately after considering alternatives:

- `client` — collides with HTTP clients, library clients, MCP clients. Already overloaded.
- `worker` — collides with background job workers (Celery, RQ, etc.). Implies stateless task execution; Valaris runners are stateful across ticks.
- `bot` — implies autonomy. A Valaris runner is not autonomous; it's a configured slot the operator has registered with credentials.
- `intern` — the Go binary's internal name, already used in the codebase (`intern/` directory). Leaky abstraction if surfaced to users; keeps working as the binary filename.

"Runner" matches GitHub Actions runners, GitLab CI runners, Buildkite agents. It carries the correct intuition: a registered machine slot that executes jobs on the operator's behalf, has credentials, has capacity limits, is something you own rather than something you delegate to.

---

## 5. Deployment & Ops Quirks

Concrete production details worth knowing before shipping a change.

- **GCP project**: the production GCP project, region `us-central1`. Cloud Run services for backend and frontend; Cloud SQL Postgres 16; GCS for object storage.
- **IAP on frontend only.** `IAP_AUDIENCE` env var: `/projects/<project-number>/locations/us-central1/services/<frontend-service>`. Restricts access to the `@valaris.studio` Google Workspace domain. Backend sits behind the frontend proxy rather than behind its own IAP because of agent-key auth flows (the Go runner holds an API key; it's not a Google Workspace user).
- **Auth is three-tier.** Dev mode reads `X-User-Email` header, falls back to `dev@valaris.dev`. Prod with `IAP_AUDIENCE` set validates `X-Goog-IAP-JWT-Assertion` ES256 JWT via `google.oauth2.id_token.verify_token`. Prod with `IAP_AUDIENCE` empty trusts `X-Goog-Authenticated-User-Email`. Users auto-provisioned on first request — no registration flow.
- **Cloud Build has two Docker flavors.** Kaniko has no shell — when a step needs shell (env-var interpolation, conditional logic), use `gcr.io/cloud-builders/docker` instead. `$$` escapes bash variables inside `cloudbuild.yaml`. `SHORT_SHA` is only available in trigger builds, not manual ones.
- **Cloud SQL hosts three databases:** `valaris` (this app), a second unrelated tenant app, and `postgres` (system). Always double-check `DATABASE_URL` before running migrations — Alembic runs from `backend/` and reads the URL from `app.config.settings`, so a stray env var can point at the wrong DB.
- **Automated backups:** daily at 04:00 UTC, 7 retained. Point-in-time recovery enabled. The `2026-03-19` DB incident validated the PITR path.
- **Infra provisioning:** `bash infra/setup.sh` from the repo root. Idempotent; safe to re-run.
- **Migrations run on container startup.** Cloud Run rolling updates mean old and new code may briefly run against the new schema. Follow CLAUDE.md migration safety: new columns are `nullable=True` or `server_default`; removing a column is two deploys (stop reading, then drop); never rename — add new, migrate, drop old.
- **In-memory rate limiter caveat.** `backend/app/core/rate_limit.py` uses a per-instance dict. Cloud Run scales to N instances; effective cap is `N × limit`. Fine for dev, insufficient for real protection. A move to Cloud Armor or Redis is tracked; for now the limit is documented inline.
- **Session management quirks.** The backend's `get_db` dependency commits on success and rolls back on exception — services and repositories should never manually commit, just `flush()` to get generated IDs. `BaseRepository.update()` needs `refresh()` after `flush()` because `onupdate` columns (like `updated_at`) otherwise cause `MissingGreenlet` errors in async. Any repository method returning a model whose Pydantic schema includes nested relationships must use `selectinload` — otherwise nested serialization raises async-lazy-load errors at response time rather than at query time.
- **Docker frontend `node_modules` persistence.** Uses a named volume (`frontend-node-modules`) so a `docker compose down` doesn't blow away the install. The CMD runs `pnpm install --prefer-offline` at startup to populate it on first run. `ENV CI=true` prevents pnpm TTY prompts. First boot is slow; every subsequent boot is instant.
- **Alembic quirk.** Runs from the `backend/` directory, not the repo root. `cd backend && alembic upgrade head`. The `alembic.ini` URL is overridden at runtime by `env.py` reading from `app.config.settings`, so a stray `DATABASE_URL` env var determines which DB Alembic targets — always verify before running.
- **SQLAlchemy `metadata` reserved name.** The `Resource` model uses `meta` as the Python attribute with `"metadata"` column name alias to avoid clashing with SQLAlchemy's declarative `metadata`. Any new model that wants a `metadata`-style column should follow the same pattern.
- **SQLite test DB strips timezone.** Integration tests compare datetime components (year/month/day) rather than tz-aware objects, because aiosqlite doesn't preserve timezone info the way Postgres does.
- **Auto-merge loop.** Reviewer stage can arm branch protection + auto-merge on a repo. Required the runner to hold `repo` scope on the GitHub token, enable `allow_auto_merge` at repo level, and send branch-protection config via `gh api --input -` (because `-F` flags produce the wrong nested structure for status-checks). When arming fails, the warning used to be swallowed; `ship_warnings` (migration 047) now captures it as a JSON column on the execution, and the ExecutionTimeline surfaces an amber chip.
- **Rework squash.** Before force-pushing on rework, the runner squashes the branch onto its merge base. Refuses on `main`/`master` as a safety net. Non-fatal if squash fails — the runner warns and pushes multiple commits rather than stalling the card. The rationale: don't let a working-tree edge case block progress.
- **Claude CLI subprocess management.** The runner invokes `claude -p <prompt> --verbose` via `exec.CommandContext`. Ctx cancel sends SIGKILL (no graceful shutdown), which means the last seconds of LLM work and the `result` event carrying cost info are lost on timeout. Stderr is captured into a bounded buffer (64 KiB cap, committed in `4d81eee`). On non-zero exit, `StructuredOutput` is now discarded rather than populated from partial stdout (commit `c72b6f9`) — otherwise a crashed subprocess could look like a successful one to the caller.
- **`agents` table retains the name.** Despite the Runner vocab migration, the database table, SQLAlchemy model, API routes, and MCP tool names all stay as `agents`/`Agent`/`create_agent`. The rename is user-facing only; breaking schema-level contracts for a cosmetic win isn't worth it. Any new MCP tool that wraps the agent concept should name itself consistent with the existing tools.

---

## 5.5 Tech Stack Recap

Consolidated from the project's MEMORY and CLAUDE.md for quick reference:

- **Backend:** FastAPI, async SQLAlchemy 2.x, asyncpg, PostgreSQL 16, Alembic. Pydantic 2 for schemas. Async throughout — every request path is non-blocking. Single `get_db` dependency provides sessions; auto-commit on success, rollback on exception.
- **Frontend:** React 19, TypeScript, Vite 6, Tailwind v4 (CSS-first, no tailwind.config.js), shadcn/ui components (manually written, not installed via CLI — editable). React Query for server state. React Router for routing. dnd-kit for drag-and-drop. react-i18next for i18n. GSAP for dialog entrance animations. Per-feature modules with `api/components/hooks/utils/` subdirectories.
- **Monorepo:** pnpm workspaces. Lockfile at the root, not in `frontend/`. Packages are `backend/`, `frontend/`, `mcp-server/`, `intern/`, plus `infra/` for provisioning scripts.
- **Docker:** Compose with named volumes (`frontend-node-modules` for install persistence). `CI=true` prevents pnpm TTY prompts. Postgres + backend + frontend come up with `make dev`.
- **Production:** Cloud Run (backend + frontend) + Cloud SQL Postgres 16 + Cloud Build CI/CD + GCS for object storage. The production GCP project, region `us-central1`. IAP restricts frontend to `@valaris.studio` domain.
- **MCP server:** Python, httpx client against backend, FastMCP for the tool server. 67 registered tools across workspaces, boards, cards, columns, notes, resources, git repos, agents, teams, prompt configs, approvals, channels, webhooks, and executions.
- **Intern runner:** Go 1.22, stdlib-heavy (no large framework dependency), `slog` for structured logging, `gorilla/websocket` for WS client, `go-yaml` for config parsing. `exec.CommandContext` for Claude CLI subprocess management.

---

## 6. What's Working Well

The debt above is real, but none of it is at the craftsmanship layer. Several deliberate design choices have been paying off across the full run of the project. What follows is not an exhaustive list — it's the subset of choices where the compounding effect is visible today and the "what if we had done X differently" counterfactual is clearly worse.

**Monorepo + pnpm workspaces.** Four deployable surfaces (backend, frontend, MCP, intern) live in one repo with one lockfile at the root. Cross-surface refactors (renaming a tool, adding a schema field, updating event namespaces) happen in one PR with one CI run. The Go client sits alongside the Python backend and the React frontend so schema drift is a `git diff` away from being visible.

**Layered backend — Router → Service → Repository → Model.** Thin routers (parse, call service, return schema), services own business logic and authorization, repositories are pure data access. The discipline means every authz gap is localizable to a service method, every data-access pattern is reusable, and every test can stub at the right layer. When the four audits ran, every finding had an exact file:line — which is only possible when the layering is consistent enough that the audit agent can navigate it.

**Composite MCP tools.** `get_project_context` returns definition + board summary + notes + git repos + recent activity in one call. `get_board_health` returns health score + stale/overdue/unassigned cards + velocity in one call. `bulk_create_cards` takes up to 50 cards per request. These shapes are designed for LLM round-trip economics — a Claude agent that needs to start work gets everything in one tool call rather than five. The savings compound over a full pipeline run.

**Fractional indexing for columns and cards.** Positions are `FLOAT`, not integers. A new item gets `max_position + 1024`. Moves compute the midpoint between neighbors. The result: no O(N) reorder updates, no index rebuilds, no race conditions when two users drag simultaneously. The frontend computes positions; the backend just stores them.

**Board detail as a single eager-loaded query.** `GET /boards/{id}` returns the whole board — columns and cards — in one query via `selectinload`. The frontend fetches once, never waterfalls, and the observer UI can render an entire board state without tail latency.

**Denormalized `board_id` on cards.** Cards have both `column_id` and `board_id`. The `board_id` is redundant (derivable from column) but enables fast board-level queries without joining through columns. Small duplication, measurable query-plan win.

**Named volumes for Docker pnpm.** The frontend container uses a named volume (`frontend-node-modules`) to persist `node_modules` across restarts. The CMD runs `pnpm install --prefer-offline` at startup. `ENV CI=true` prevents pnpm TTY prompts. First boot is slow; every subsequent boot is instant. The pnpm lockfile lives at the monorepo root, not in `frontend/`, so the frontend Dockerfile builds without it (standalone `pnpm install`) — intentional trade-off to avoid needing the root context in the Docker build.

**Idempotent create patterns where applied.** `create_board`, `add_card_participant`, `create_team`, and the idempotent half of `agents POST` all return the existing entity on duplicate with the correct status code. The places that still raise 409 are catalogued and will be swept. When it works, it works beautifully — LLM retries, multi-role pipeline ticks, and frontend double-clicks all stop costing tick budget.

**Strict test discipline.** 319 commits, zero `TODO`/`FIXME` in the tree. TDD as a non-negotiable. Integration tests use an in-process aiosqlite DB with `httpx.AsyncClient` against the real FastAPI app — no Docker required, tests run in seconds, a sub-agent can spin up the full suite without depending on shared infra. Per-test 5s timeout catches hung tests fast instead of starving parallel sub-agents.

**Event taxonomy as documentation.** `docs/events.md` catalogs every live event, its publisher call sites, its subscribers on frontend and intern, payload conventions, and deprecated aliases. Adding a new event is a documented 3-step process. When `M-Observability` fanned out `activity.{entity}.{action}` events, the doc was the review artifact.

**Code IS the documentation.** Semantic naming over comments (`retryable_count`, not `n`); comments reserved for the non-obvious (regex patterns, async gotchas, magic thresholds); no docstrings that repeat the function name; README and CLAUDE.md carry spec and architecture, the day-to-day answer lives in the code. This rule makes the codebase readable by agents without the hand-holding that verbose comments require, and it keeps the signal-to-noise ratio of every file high.

**Live smoke tests with a real operator.** Milestone Alpha didn't close on green CI alone. It closed on a live walkthrough on `test-alpha-2`: create runner → export config → drop files → launch binary → observe pipeline → confirm note created. The walkthrough surfaced 11 bugs a unit-test suite would never have caught. The discipline of "done means the operator can reach go without secret knowledge" is the right bar for a platform aimed at operator adoption. A parallel `standup` skill is used to generate a daily standup report from live project data via MCP — the same tools the agents use, the same shape of data. The dogfooding is load-bearing: every time the operator uses an agent workflow, that workflow is also a test of the agent-facing contract.

**Activity bus as both persistence and live feed.** Post-M-Observability, every mutation on every entity publishes to the WebSocket bus under a consistent namespace (`activity.{entity}.{action}`). Webhook subscribers, frontend query hooks, and the admin-only Observer panel all drink from the same stream. Adding a new entity with a new action is a single-point change: it records to the activity table, and it fans out to every interested surface. This is the payoff for the idempotency and WS-first principles compounding over a year of work.

**Optimistic frontend updates for drag-and-drop.** Kanban column reordering, card moves, and card reorders all optimistically update local state and roll back on server error. Combined with fractional indexing and React Query's cache layer, the perceived latency of drag-and-drop is near zero; the network round-trip is fully hidden behind the animation. The cost: two layers of state management (local + server); the payoff: a kanban board that feels native on a cross-continental Cloud SQL connection.

**Three-tier auth that degrades sensibly.** Dev mode trusts `X-User-Email`; prod with IAP validates the ES256 JWT via Google's library; prod without IAP trusts the Google-signed header. Each tier has a clear failure mode and a clear test harness. Users auto-provision on first request — no registration flow, no onboarding wizard, no email verification. The trade-off is deliberate: for an internal platform, provisioning friction is a larger tax than casual-access risk; for an external-facing deployment, this approach would need revisiting.

**React Query for all server state, nothing else.** The frontend has exactly one pattern for remote data: `useQuery` / `useMutation` from React Query, with query keys defined in a per-feature `query-keys.ts` module, and invalidations triggered by either explicit `invalidateQueries` calls or `useDomainSync` (the one-line WS → invalidation bridge). No Redux, no Zustand for server state, no hand-rolled fetch wrappers. The uniformity means that every new feature drops in predictably, and every bug is reproducible against the same abstraction.

**i18n with interpolation from day one.** Every user-facing string lives in `src/i18n/locales/{en,es}.json`; every component uses `const { t } = useTranslation()`; enum values are localized via dynamic keys (`t(\`cards.types.${card.card_type}\`)`). The en and es key sets are diff-checked in CI — zero drift. Adding a new language is adding a new `locales/{code}.json` plus one entry in the config and switcher. The Runner vocabulary migration Phase 1 was almost entirely an i18n edit because of this discipline.

**Fixture-driven testing without Docker.** Integration tests spin up a fresh aiosqlite async DB per test, use `httpx.AsyncClient` to drive the real FastAPI app, set `X-User-Email` to simulate auth, roll back on teardown. No container, no network, no shared state. The full backend suite runs in seconds; `make test-fast` uses `pytest-xdist` for even more parallelism. A sub-agent briefed to "make this test pass" can run the full cycle without any external dependency. The convention is `test_{action}_{scenario}` naming, function-scoped fixtures, and helpers (`create_user`, `create_workspace`, `create_board`) in `conftest.py`. New tests drop into an obvious shape.

**Event taxonomy documented and versioned.** `docs/events.md` catalogs 13 live events, 2 dead constants (flagged for cleanup), actor-id conventions, publisher and subscriber call sites, and the `config.changed` payload divergence. Adding a new event is a documented 3-step process: define in the enum, emit from the service, subscribe in the consumer. When M-Observability fanned out `activity.{entity}.{action}`, the doc was the review artifact — the diff showed exactly which 28 `(entity, action)` pairs became observable.

**Deploy is one command.** `make deploy-backend`, `make deploy-frontend`, or `make deploy` for both. Cloud Build triggers on main; artifacts go to Artifact Registry; Cloud Run picks up new revisions. Migrations run on container startup (which is why the two-deploy pattern for column removal matters). Rollback is `gcloud run services update-traffic --to-revisions=<previous>=100`.

**Health and liveness separated from work.** The intern runner has a dedicated `healthz` HTTP server on a separate port from the main work loop. It reports WS connection state, last heartbeat, config-validation errors, and current pipeline role coverage. The Observer panel consumes it; the Cloud Run liveness probe would consume it if the runner lived in Cloud Run. The separation means a wedged work loop doesn't take down the health signal.

**Scoped test runs over full-platform suites.** The repo has `make test` (full backend), `make test-fast` (parallel via pytest-xdist), `make test-cov` (with coverage), `cd intern && go test ./...` (Go), `pnpm --filter frontend typecheck` + `pnpm --filter frontend lint` (frontend), and scoped variants for the MCP server. A sub-agent working on a backend service doesn't need to run the frontend build. The principle is practical: full-platform test runs starve parallel sub-agents; scoped runs let three agents work independently without stepping on each other. The CI pipeline runs everything on merge; the inner-loop tests run what's relevant.

**The `standup` skill as daily health signal.** A Claude skill generates a daily standup report directly from MCP tool calls against live workspace data. Active runners, open approvals, stuck cards, recent executions, cost burn — all in one paragraph. Using MCP to surface platform state is the same path agents use to consume it, so the standup is a passive end-to-end smoke test of the agent-facing surface. If a tool is broken, the standup fails obviously.

---

## 6.5 How Work Gets Done

Worth pulling out the operating rhythm because it's part of what the platform is. The current workflow is unusual in a few specific ways.

**Plan as single source of truth.** `memory/plan.md` is the living work queue — north star, next session's scope, open backlog, completed log. Every session begins by reading it and ends by updating it. Historical narratives archive under `archive/plan-history-*.md` once a theme closes. The practice keeps sessions stateful across the conversation boundary: a new session's first 10 seconds is orienting from the plan, not rebuilding context.

**Feedback rules as durable memory.** `memory/feedback_*.md` files are single-purpose rule documents, each capturing one principle with its anchor incident. Sub-agents are briefed with the relevant feedback files inline; the human doesn't need to re-explain idempotency every time a new agent needs to know it. When a new rule is learned from an incident, it becomes a new feedback file on the same day.

**Audits as structured review.** Every few milestones, four read-only audit sub-agents run in parallel against file-disjoint scopes (backend, intern/Go, frontend, MCP + cross-cut). The output is a set of Markdown files with findings categorized by blast radius and a consolidated summary. Audits are a read-only activity — they produce a plan, they don't make changes. The cleanup batches derived from an audit are separately dispatched.

**Parallel sub-agent dispatch.** When a cleanup or feature has file-disjoint lanes, they run in parallel. Each sub-agent gets a brief with scope, tests to run, principles, and prerequisite-verification. Worktree isolation is used for truly independent work; for fanouts that depend on pre-landed scaffolding, isolation is dropped in favor of main-tree edits. Parallel work is the default, sequential only when there's a data dependency.

**Live smoke tests as validation gate.** No milestone closes on CI alone. An operator walks through the full path — end-to-end, with real tokens, real Cloud SQL, real runners — before a milestone is declared complete. Milestone Alpha's closure depended on the runner-launch walkthrough; M-Observability's closure depended on the test-alpha-2 smoke pass for smoke probes A/B/C/D/E.

**Post-Alpha branch discipline.** One theme per branch, ~20-commit soft ceiling, PR-before-drift. The Alpha epic's 282-commit branch is the last branch of its shape. Going forward, a branch exists to land a single theme; crossing the ceiling means the theme was too broad or drift has set in.

**MEMORY.md as session index.** The top-level auto-memory file lists every active plan, every durable feedback rule, every active scoping decision, and every audit document with brief descriptions. A new session loads MEMORY.md first, follows links as needed. The index stays shallow; depth lives in the linked files.

---

## 7. Lessons Learned (distilled from the archive)

A handful of insights from smoke tests, PoCs, and post-mortems that don't fit neatly under any single principle but shape how the platform evolves.

**Agents are users with worse debugging.** When an LLM hits a 409 or a 422 it doesn't escalate — it adapts, badly, and you discover three days later that a critical pipeline stage has been silently retrying with slightly different arguments until it works. Every error response is a UX surface. Messages need to be actionable, shapes need to be stable, idempotency needs to be the default. The MCP server's error wrapper pattern (`handle_api_errors`) that returns `{"error": true, "message": "..."}` is a double-edged tool — it prevents the LLM from crashing, but it also hides bugs from the developer. The audit flagged this; the recommendation was to re-raise for non-HTTP exceptions in dev.

**Composite endpoints pay compounding returns.** `get_project_context` takes what would be five separate MCP calls and returns them in one payload. On a single pipeline tick that saves four round-trips. Over a full day of agent activity across a real workspace, that's thousands of round-trips, proportional token savings, and proportional time savings. The design principle: for every agent workflow, ask what the first three API calls would be, and make those calls into one composite tool. `get_board_health` and `bulk_create_cards` came from the same design pressure.

**Activity recording is a forcing function.** When every mutation records an activity row, and every activity row publishes a bus event, debugging multi-agent sequences becomes tractable. "What did agent X do at 14:03?" is a single SQL query. "Why did card Y end up in the blocked column?" is a sequence of activity rows with a clear causal chain. The Observer panel that consumes these events is a production tool — not a debug tool — and it dramatically shortens the feedback loop when something goes wrong.

**The `post_process_kind` contract was the single most operator-valuable addition.** Stages declare what kind of artifact they produce (`writes_code`, `produces_note`, `produces_decision`, `mutates_backlog`). The runner injects the corresponding imperative into the prompt. The operator picks a kind from a dropdown instead of hand-authoring "Step N: Call `create_note(...)`". The pattern scales — adding a new `post_process_kind` is a single switch-case in the backend's synthesis logic, and every operator-authored prompt in the system inherits the imperative automatically.

**Every smoke test has paid for itself.** ST#3 (idempotency), ST#5 (WS coverage), ST#8 (backend authority), ST#11 (subagent briefings), the `2026-04-18` runner-launch walkthrough (11 bugs, six principle clarifications). The cost of a smoke test is an operator's afternoon; the value is a structural fix that compounds. The discipline is resisting the urge to declare "smoke tests passed with manual interventions" as a success — every intervention is a bug.

**Dead code is dangerous, half-emitted events are dangerous, scaffolds-in-production are dangerous.** The three share a pattern: they appear to work. `BudgetPanel` shipped with a scaffold tooltip that read "A concise one-liner that explains this control" as real production text for weeks. `board.health_changed` is declared in the `WebhookEvent` enum but never emitted; if someone writes a subscriber for it, the subscriber silently never fires. `useMoveCard` was still exported after `useOptimisticCardMove` superseded it; a future dev grabbing the first hook from IntelliSense got an unrolled-back mutation. The discipline is to close loops — ship the real tooltip or remove the primitive, emit the event or drop it from the enum, delete the hook or consolidate it.

---

## 7.5 Notable Incidents from the Archive

A selection of incidents that shaped the platform, pulled from `archive/project_*.md`:

- **DB Incident, 2026-03-19.** A production migration caused a brief outage. The PITR backup path was validated during recovery. The post-mortem produced the rule that migrations run on container startup and must be Cloud Run-safe (nullable new columns, two-deploy removals, never rename).
- **Doc Failure Regression.** The documentator role was producing empty docs for several weeks before anyone noticed. Root cause: the Go prompt template for the documentator stage had gone out of sync with the backend-seeded prompt, and the runner was silently falling back to the Go template with an outdated schema. Fix: platform-authority rule — runner never falls back to compiled-in templates, refuses to schedule if the platform hasn't authored the prompt.
- **Review Description Pollution.** Reviewer stages were writing review markers into card descriptions, cluttering the description with review prose over multiple review cycles. Fix: dedicated review-notes storage, descriptions remain human-authored content only (`5166cc7`).
- **Merged-PR Recovery Gap.** If a PR merged before the card reached the Done column (e.g., a human merged manually while the runner was mid-rework), the orchestrator failed on re-implement because there was no branch to push. Post-Alpha fix planned: on discover, if the card's PR is merged, skip implement and ship directly.
- **Ship Ignores Move Target.** An early bug where the ship path hardcoded movement to the `"review"` column regardless of the stage's configured `move_to_column_type`. Fix landed under the platform-authority theme.
- **Poll-Now Docker Bridge.** The Poll-Now button on the agent detail page posted to `/api/agents/{id}/poll` from the backend to the runner via HTTP. Docker networking blocked the path. Fix: emit `agent.poll_requested` on the WS bus; runner subscribes; button works. This incident is the direct anchor for the WebSocket-first principle.
- **Tool Invocations Empty 2026-04-17.** A test environment briefly showed empty tool_invocations lists despite executions having completed. Resolved — the route correctly gated on agent-ownership, but the test data fixture wasn't stamping the correct ownership. Highlighted the cross-tenant-leak risk that Batch A authz work addressed.
- **Label Search Substring Match.** Card search against the `labels` array was doing substring matches, so searching for label `"alpha"` returned cards with label `"alpha-two"`. Fix: exact-match against array elements, not JSON string containment.

These incidents are not catastrophic — the platform has been stable for months. They're listed because each one produced a structural change that stuck, and each one contributes to the current shape of the codebase.

---

## 8. What's Next

Post-Alpha, the active work streams are:

- **Runner Onboarding & Authority Thread B closure** — final operator-facing polish; live smoke test on `test-alpha-2` with a fresh operator following only in-UI prompts, no secret knowledge, no docs-reading. The bar is a first-time operator reaching "runner is doing useful work" in under 60 seconds of clicks.
- **UX-D — config import/export UI** — now that slug identity has landed, the pipeline config, board definition, agent team, prompt config, and board-notes bundle all have dedicated export endpoints (commits `c345bde` through `2ae3ea5`). The import side is the missing half: file picker, schema validation, diff preview, atomic replace. Round-trip clean between workspaces is the exit criterion.
- **UX-E — explanatory content pass** — authored tooltip content for pipeline builder, card types, column types, team roles, budget, prompt vars. `RichTooltip` ships in the codebase; the editorial work is what remains. The first-run Dashboard panel already shipped.
- **Runner vocabulary Phase 2 + 3** — docs and MCP description pass (Phase 2, low risk, pure prose) followed by the two-deploy schema migration to drop `agent_type` (Phase 3).
- **LLM abstraction milestone** — per-role provider/model configuration, credential storage at workspace level, prompt caching across providers, tool-call normalization. The design lives in an internal scoping note (not exported). This is the milestone that makes Valaris genuinely model-agnostic.
- **T1.2 — structured card dependencies** — a DB relation table (`card_id`, `blocks_card_id`), scheduler filter `exclude_if_blocked`, frontend linking UI. Design calls still open: cross-board deps? interaction with in-progress cards? Design before coding.
- **T1.4 — git host provider abstraction** — `GitHostProvider` interface mirroring the LLM provider interface. Three implementations: GitHub (wraps `gh`), GitLab (`glab` or REST), GenericWebhook. All current `gh`-isms already live inside `intern/internal/git/` except one sensor (`sensor_pr_overlap.go`); moving that behind `git.Manager.ListOpenPRs` is the scaffolding step.
- **Audit-surfaced sweeps** — config-driven enum purge (needs `/config/schema` backend endpoint first), remaining WS-subscription hooks on namespaces that now emit, in-memory rate limiter to Redis or Cloud Armor, cross-tenant refusal test coverage.

Each of these is a contained milestone with a clear exit criterion. The post-Alpha branch discipline (one theme per branch, ~20-commit soft ceiling, PR-before-drift) is designed to keep them honestly scoped.

### Longer-horizon ambitions

Beyond the immediate backlog, the platform carries a few longer-horizon directions that aren't scheduled but are structurally anticipated:

- **Marketplace for pipelines and teams.** Slug identity lays the groundwork for signed, shareable pipeline bundles. A workspace could install a third-party pipeline — a security-audit pipeline, a docs-generation pipeline — with the same ergonomics as installing a npm package. This is explicitly out of scope for Alpha; it's the reason slug uniqueness is workspace-scoped rather than global.
- **Prompt caching across providers.** The LLM abstraction milestone will introduce a caching layer that survives across sessions and across providers (Claude's prompt-cache API, OpenAI's prompt caching, Gemini's context caching). Cost savings compound for reviewer and documentator stages where most of the input is stable.
- **Harness sensors as a plugin ecosystem.** Today's sensor catalog is compiled-in; the long-term direction is a declarative sensor DSL operators can author. Example: "refuse to claim if the card's author is offline" or "require a human on the card before starting implement." The Sensor/Guide interfaces are already planted in `intern/internal/harness/`.
- **OTel across the Go runner.** GenAI semantic conventions were planted in the Tier 8 design; implementation is on deck for post-Alpha. Every LLM call, tool invocation, and pipeline transition becomes a span. Export goes to whatever backend the operator configures.
- **Multi-region deployment.** Current deployment is single-region (`us-central1`). Cloud SQL read replicas in other regions, Cloud Run multi-region failover, and global load balancing are straightforward but not scheduled.

---

## 8.5 Glossary

Short definitions for terms used throughout this document:

- **Activity** — a row in the `activities` table recording a mutation. Entity + action + actor + timestamp + payload. Post-M-Observability, every activity also publishes on the WebSocket bus under `activity.{entity}.{action}`.
- **Approval** — a gate inserted by a pipeline stage. A human must decide before the stage completes. The runner blocks until the approval resolves; rejection is terminal (not retriable per `c3488c6`), acceptance lets the stage continue.
- **Card** — a work item on a kanban board. Has title, description, labels, type, priority, participants, due date, status, and a fractional-index `position`.
- **Column** — a kanban column. Has a `column_type` (`backlog`, `active`, `review`, `done`, etc.) that drives pipeline transitions. Column types are the semantic identity; column names are human-facing.
- **Execution** — a row capturing one LLM invocation by a runner. Has role, stage, model, cost, duration, status, input prompt, and ship warnings (if any).
- **Intern** — the Go runner binary. Named for the filesystem directory (`intern/`), not a user-facing term.
- **Participant** — a user or agent associated with a card. Kinds: hero (primary executor), helper, viewer, stakeholder. Distinct from "pipeline role."
- **Pipeline config** — per-workspace configuration describing stages, roles, scheduling priority, sensor catalog, and column semantics. Owned by the backend; consumed by runners and frontends.
- **Prompt config** — per-role/stage prompt template. Lives in the `agent_prompt_configs` table, indexed by `(workspace_id, team_id, team_role, stage, slug)`.
- **Role** — a pipeline persona (implementer, reviewer, documentator, or any custom). Drives prompt lookup and card filters. Not the same as agent_type (which is legacy) or participant kind.
- **Runner** — user-facing name for a credentialed Go process that executes pipeline stages. Formerly called "agent" in the UI; still called `agent` in the database schema.
- **Sensor** — a platform-side check that gates stage transitions. Example: `pr_overlap` refuses to claim a card if another PR already touches the same files.
- **Stage** — a step in the pipeline (implement, review, document, research, plan, or custom). Declared in `pipeline_config.stages[]`.
- **Team** — a grouping of agents by role. A runner joins a team to claim cards for that team's role. Teams are per-workspace; a runner can belong to multiple teams.
- **Workspace** — the top-level tenancy unit. Contains boards, members, channels, teams, pipeline config, budgets. Slug-identified globally.

---

## 9. Reader's Quick Reference

For the reader who wants to know "where do I look for X":

| Question | File |
|---|---|
| What's the current plan? | `memory/plan.md` |
| Why did we decide X? | `memory/feedback_*.md` (indexed in `MEMORY.md`) |
| What did the last audit find? | `memory/audits/summary.md` + per-surface files |
| What bugs did the live walkthrough surface? | `memory/audits/runner-launch-walkthrough-2026-04-18.md` |
| How do I migrate a config entity to slug? | `memory/scoping_slug_identity.md` |
| How do I run the dev stack? | `make dev` (see root `Makefile`) |
| How do I run tests? | `make test` (full) or `make test-fast` (parallel) |
| Where does Alembic live? | `cd backend && alembic ...` |
| How does auth work in dev? | `X-User-Email` header, defaults to `dev@valaris.dev` |
| What's the event taxonomy? | `docs/events.md` |
| How do runners launch? | `docs/runner-runtime.md` |
| How do I onboard to the product? | `docs/onboarding.md` |
| What's the MCP tool catalog? | 67 tools under `mcp-server/src/valaris_mcp/tools/` |
| What are the three concepts "agent" overloaded onto? | `memory/vocabulary_runner_migration.md` |
| What's the north star? | `memory/plan.md` §1 + `archive/project_milestone_alpha.md` |

---

## Closing

Valaris Internal started as a kanban board and became an agentic software factory in about four months of concentrated work. The jump was possible because the foundations — layered backend, monorepo, typed schemas across all four surfaces, WS event bus, TDD discipline — were solid before the agentic work started. The jump was also painful in places the foundations couldn't predict: a runner binary that quietly overrode platform config, an authoring UX that couldn't represent custom roles, WebSocket subscriptions that silently missed half the mutations in the system.

Milestone Alpha closed the first complete arc. The next arc is operator scale: better onboarding, cleaner config export/import, per-role LLM abstraction, and a continued grind on the principle-enforcement debt the audits surfaced. The platform's strengths — discipline at the craftsmanship layer, clarity of architectural intent, and an operator-in-the-loop validation ritual — are exactly the strengths a platform needs to scale from "works for one team" to "works for many."

The debt is real; no audit with the discipline of the `2026-04-17` sweep could produce a clean bill of health on a codebase this young. But the debt is in principle-enforcement at the seams, not in craftsmanship. Zero TODO/FIXME markers, zero `any` in production TypeScript, zero manually-committed database sessions, zero polling where an event bus exists. That kind of tidiness is the platform's real asset — it means every one of the known rough edges is a localizable fix, not a rewrite.

Valaris Internal is a platform under active construction, but it is not a platform in denial about its state. The audits exist. The feedback rules exist. The operator-in-the-loop validation is regular. The next session's plan.md is always current. That combination — visibility plus discipline — is what makes the forward motion possible.

The platform's north star is clear: operators shape pipelines, runners execute them, humans stay in the loop for approval and direction, and the model identity for each role is independently configurable. Getting there means finishing the vocabulary migration, landing import/export, building the LLM abstraction layer, and closing the remaining principle-enforcement gaps. None of that is speculative; it's all in the plan, with anchors back to specific incidents and specific commits.

The last thing to say is about tone. This document doesn't sanitize the rough edges, but it also doesn't catalog bug IDs. A reader should come away with three beliefs: (1) the platform is more mature than its commit age would suggest; (2) the known debt is real and addressable, not hidden or minimized; (3) the team's working rhythm — principles tied to incidents, audits dispatched as structured review, sub-agents briefed with transmitted principles, milestones closed with live smoke tests — is itself a competitive asset. The codebase is the artifact. The working rhythm is the factory.
