# Engineering & Collaboration Principles

Distilled from accumulated working memory. Grouped so the **portable** principles
(reusable on any project) come first, then the **agentic-platform** principles
(specific to building autonomous runner systems), then the **operational
habits** that are Valaris-specific but worth carrying as patterns.

---

## 1. Code & Craft (portable)

- **The code is the documentation.** Self-documenting names carry intent
  (`retryable_count`, not `n`). Comment only the non-obvious — regex, domain
  gotchas, concurrency traps, magic thresholds. Never comment the obvious. No
  redundant docstrings that restate the function name.
- **No unnecessary docs.** Spec & architecture live in README/design docs;
  day-to-day understanding comes from reading the code. Don't generate prose
  that the code already states.
- **Improve clarity by renaming, not restructuring.** Rename variables, extract
  named constants, add a one-line comment on a tricky section — never refactor
  working code for cosmetics.
- **Detail-oriented, correctness-first.** Cover edge cases. Errors propagate
  with useful context, never swallowed. Don't ship half-finished work or leave
  TODO markers for things achievable this pass.
- **Stay focused on the main goal.** No feature creep, no speculative
  abstractions, no refactors beyond the task's scope. Three similar lines beat a
  premature abstraction.

## 2. Testing Discipline (portable)

- **TDD, always.** Failing test first → minimum code to pass → refactor with
  tests green. No exceptions for features or bug fixes.
- **Scope test runs to what changed.** During edit cycles run only the
  affected files/packages. The full suite runs once before commit and once
  before deploy — never as an inner-loop default.
- **Per-test timeouts prevent silent hangs.** A hung test should fail fast, not
  consume the whole budget. Mark legitimately slow tests explicitly rather than
  raising the global cap.
- **Watch for shared-fixture mutation in tests.** Copying a struct by value
  still shares its inner maps/slices by reference — mutating one can poison
  other tests in the same run. Deep-copy before mutating; run the full package
  (not the single test) before declaring green.
- **Test the real seam, not just the unit.** In-process/mocked tests miss
  cross-boundary contracts (cross-origin calls, env drift, migrations on the
  real dialect, config composition). Add a deployment-smoke check whose
  definition of done is "fresh clone → follow the README → working system."

## 3. Integration Seams (portable)

- **Someone must own the composition.** When many changes each touch the same
  shared file (env, compose, settings, migrations) and each only adds "what it
  needs," nobody owns the whole — and it silently rots. Name a composition owner
  or a smoke gate that exercises it end-to-end.
- **Every recurring break lives in a seam no single unit owns.** When auditing a
  plan, look for the absent owner of the integration surface, not just per-unit
  correctness.

## 4. APIs & Mutations (portable)

- **Idempotent create/add operations.** An operation that can be safely retried
  should return the existing entity (200/201) on duplicate, not error (409).
  "Already exists" is a success, not a conflict — critical anywhere a caller
  retries on failure.
- **Layered architecture, no skipped layers.** Router/controller → service →
  repository → model. Entry points are thin (parse, call service, return);
  services own business logic + authorization; repositories are pure data
  access.
- **Migration safety under rolling deploys.** Both old and new code may run
  against the new schema briefly. Add columns nullable/with defaults; remove in
  two steps (stop reading, then drop); never rename in place (add new, migrate,
  drop old); adding tables is always safe.

## 5. Communication & Transport (portable)

- **Prefer the existing event bus over new point-to-point channels.** If two
  components can already reach each other over a shared bus (WebSocket/event
  stream), use it instead of HTTP proxies or polling loops. It consolidates
  transport, dodges topology bugs (container-bridge/localhost), and keeps traffic
  observable. Polling fallbacks are acceptable only while the live channel is
  down.

## 6. Delegation & Parallelism (portable)

- **Run independent work in parallel.** Disjoint subtasks dispatch concurrently;
  go sequential only when there's a real data dependency.
- **Every delegated brief must transmit the principles explicitly.** A
  subagent/contractor starts with zero context and treats the brief as literal
  spec. Leaving principles implicit yields work that matches the letter and
  misses the spirit. Restate the load-bearing principles in the brief itself —
  don't just link to them.
- **Cap delegated test scope in the brief.** Name the exact files/packages to
  test; forbid full-suite runs inside a delegated task. Broad regression
  verification is the orchestrator's job, after the delegated work returns.
- **Don't stop a long-running process without permission.** Budget and
  "is this enough data?" decisions belong to the owner. If you think something
  should be killed (loop, runaway cost), flag it and let them decide — unless
  pre-authorized for that specific context.
- **Isolated work environments can start stale.** A parallel worktree may branch
  off an older commit and lack pre-landed scaffolding. Either verify
  prerequisites at the top of the brief ("STOP if missing"), or drop isolation
  when lanes share assumptions about recent parent state.

## 7. Agentic-Platform Principles (for autonomous runner systems)

- **Backend-authoritative config.** The runner/client is thin: it fetches the
  pipeline shape (roles, stages, filters, models) from the backend and executes
  whatever comes back. A hardcoded runtime fallback is a red flag — it masks
  misconfiguration and turns the declared pipeline into a lie. (Hardcoded
  *defaults for bootstrapping* and *test fixtures* are fine; hardcoded *ceilings*
  are bugs.)
- **Extensibility with no ceilings.** Any role, with any rules and any prompts,
  must be expressible end-to-end through config + UI without code changes.
  Defaults must never be the ceiling. Any "no hardcoded entry for this role/stage
  → fail/degrade" path caps extensibility and is a bug.
- **Role-agnostic execution.** The runner executes whatever role the backend
  assigns; it does not maintain its own allowlist of roles. Per-role behavior is
  a backend/config concern.
- **Model-agnostic, model-per-role.** A platform that lets you invent roles but
  routes them all through one model gives only prompt-deep separation. Per-role
  provider/model is part of the north star — especially for review-type roles,
  where a model critiquing its own output rubber-stamps (self-review bias is
  real). Self-participation guards are heuristics, not correctness invariants.
- **Context is code-controlled, never LLM-fetched.** Mandatory context is
  fetched by code, formatted as a labeled block, and injected into the prompt —
  not left to the LLM to retrieve via tool calls. LLMs treat tool results as
  optional reference and format structured output inconsistently. The LLM's job
  is reasoning + output, not mandatory data retrieval.
- **Directives need structural emphasis, not prose.** Models comply unevenly
  with requirements buried in prose; weaker models ignore them. Force-inject
  directives into the prompt as a mandatory block. Pass cross-agent feedback
  (e.g. review findings) as a numbered checklist with file:line references, not a
  wall of text.
- **Sequential gating for dependent work.** When later work depends on earlier
  work's committed output, enforce ordering structurally (dependency edges, a
  one-in-flight gate) — don't rely on a planner/scheduler heuristic. Front-loaded
  planning across a backlog produces stale plans referencing code that doesn't
  exist yet. The planner must see the *current* state after each preceding unit
  lands.
- **Own your quality gate; don't depend on vendor plan tiers.** Don't build the
  pipeline on features locked behind a paid tier (auto-merge, branch protection).
  The platform owns its own CI-gating so it works on any plan.
- **UI copy describes primitives generically.** Tooltips/help text explain what
  a mechanism *does*; specific roles appear only as "e.g." examples, never as
  definitional ("the reviewer does X"). Every role is generic.

## 8. Operational Habits (patterns worth carrying)

- **Know what production actually runs.** If deploys ship the working tree
  (not a committed ref), prod can run uncommitted local code while the remote is
  behind. When a prod bug looks impossible from the git log, check for
  working-tree drift before assuming it's new. Reconcile across all layers in one
  logical commit.
- **Closed-set invariants span every layer.** A "kind"/enum registry duplicated
  across backend + runner + frontend (+ i18n + drift tests) must be updated in
  all layers together, or the layer that's behind crashes.
- **Confirm the deploy target before deploying.** Verify the active
  project/account; sibling projects with similar names are a wrong-deploy trap.
- **Direct cloud deploys can wipe IAM/invoker bindings.** Out-of-band deploys
  (bypassing CI) may reset service IAM and break auth forwarding. Re-grant the
  invoker binding and re-route traffic to the new revision after such a deploy.
- **Burst mutations hit rate limits.** Bulk API mutations fail past ~12 parallel
  calls. Batch in modest groups, then verify and retry stragglers sequentially —
  the successful subset isn't predictable from input order.
- **Browser-only bugs need browser testing.** WebSocket/UI timing bugs
  (StrictMode double-mount races, provider/child effect ordering, missing
  server-side subscribe) don't show up in unit tests. Test in a real browser.
- **i18n plurals use the library's current suffix scheme.** Dead legacy plural
  suffixes fail silently (the singular renders for every count). Define the
  count forms the current version expects, in every locale.
