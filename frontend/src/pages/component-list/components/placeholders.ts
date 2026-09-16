// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Intentional English-only scope — this page is an internal dev sandbox.
// When a component lifts out of /component-list into production UI, that
// component's copy gets i18n keys. Until then, literal English is fine.
// See docs/plans/phase3-component-list-page.md §2 and §9.

export interface ShowcasePlaceholder {
  id: string;
  name: string;
  concept: string;
  interaction: string;
  technicalNotes: string;
  whyItMatters: string;
  caption: string;
}

export const PLACEHOLDER_COMPONENTS: readonly ShowcasePlaceholder[] = [
  {
    id: "pipeline-tick-simulator",
    name: "PipelineTickSimulator",
    concept:
      "A complete pipeline tick — runner polls, finds a card, claims it, spawns LLM subprocess, commits, pushes, ships, wakes the reviewer.",
    interaction:
      "A schematic view of a runner (left), a card in a \"Backlog\" column (center), a reviewer (right). User clicks \"Start tick.\" Runner's \"heartbeat\" indicator pulses. An arrow animates to the card; the card moves to \"In Progress\"; the runner shows a spinner labeled \"claude -p implement.\" After a few seconds, a commit + push animation triggers; card moves to \"Review\"; reviewer's avatar wakes up. Timeline controls: pause, step, reset. \"Speed\" slider 0.5x–3x.",
    technicalNotes:
      "GSAP timeline with labelled segments. State machine with 6 phases. No real backend; hardcoded 3-second-per-phase demo data.",
    whyItMatters:
      "The pipeline concept is the hardest thing to explain in words. Watching it once answers 80% of \"wait, what's a runner?\" questions.",
    caption:
      "This is what happens when everything works. In production, it occasionally does.",
  },
  {
    id: "fractional-indexing-visualizer",
    name: "FractionalIndexingVisualizer",
    concept:
      "How card positions work under fractional indexing, and why we don't renumber on every move.",
    interaction:
      "Three columns of cards, each with a visible position: 1024.0, position: 2048.0, etc. User drags a card between two others. The component shows the midpoint calculation ((2048 + 3072) / 2 = 2560) animating into the position label. A counter at the bottom shows \"Renumber operations avoided: N\" incrementing with each drop. A \"Worst-case\" button demonstrates the rare rebalance scenario.",
    technicalNotes:
      "dnd-kit Sortable. GSAP for the midpoint label animation. Numbers fade in, not typed character-by-character.",
    whyItMatters:
      "Operators who read the code will see position: 2.718281828... and wonder what we're doing. This visualization pre-empts the question.",
    caption:
      "We use floats instead of integers so reordering is O(1) instead of O(the angry DBA). In theory we'll run out of precision; we have not yet.",
  },
  {
    id: "ws-live-cascade",
    name: "WSLiveCascade",
    concept: "Every mutation fans out to every observer via the WebSocket bus.",
    interaction:
      "A central \"backend\" node. Three observer clients around it (frontend, runner, MCP subscriber). User clicks \"Create card.\" Event ripples outward — activity.card.created radiates as concentric waves; each observer lights up as the wave hits it. Timeline scrubber shows which events landed when. Toggle: \"Show payloads\" — dims the lines and reveals a tiny JSON preview on each edge.",
    technicalNotes:
      "SVG for the radiating waves, GSAP for the ripple timing. Pure visual — no real WS connection.",
    whyItMatters:
      "The WS-first principle is foundational; showing it visually makes the \"why HTTP polling is a bug\" argument without a paragraph.",
    caption:
      "One event, many observers. The alternative was 12 HTTP polls per minute, and that's why we don't do that anymore.",
  },
  {
    id: "role-chain-walkthrough",
    name: "RoleChainWalkthrough",
    concept:
      "How a card moves through implementer → reviewer → documentator, with branching based on reviewer decision.",
    interaction:
      "A card displayed at the top. Below, three \"role lanes\" labeled implementer / reviewer / documentator. User clicks \"Run full cycle.\" Card drops into the implementer lane; commit animation; moves to reviewer lane. Prompt dialog: \"Approve or request changes?\" — user picks. If approve: card moves to documentator lane; documented label appears; settles in \"Done.\" If request_changes: card bounces back to implementer lane with a \"feedback\" badge; full cycle repeats.",
    technicalNotes:
      "GSAP sequence with a branching timeline. User-driven; not auto-playing.",
    whyItMatters:
      "Shows rework semantics and branching actions without requiring a real board.",
    caption:
      "Request changes twice, get a conversation. Request changes four times, get a budget alert.",
  },
  {
    id: "post-process-imperative-injector",
    name: "PostProcessImperativeInjector",
    concept: "How post_process_kind selection auto-injects a prompt imperative.",
    interaction:
      "Left side: a dropdown with the four post_process_kinds (writes_code, produces_note, produces_decision, mutates_backlog). Right side: a prompt editor textarea with placeholder operator content (\"You are a reviewer agent...\"). Below the textarea: a grayed-out resolved_content preview that updates live as the user changes the dropdown. The imperative splices in as a highlighted diff: + Step N: Call create_note(...) with your findings. A copy button for the resolved content.",
    technicalNotes:
      "Controlled form state. GSAP tween on the diff highlight. Actual imperative text comes from the Phase 1 research (mirror _POST_PROCESS_IMPERATIVES content at the level of detail operators need).",
    whyItMatters:
      "This is the single most valuable design choice in the platform and nobody knows about it.",
    caption:
      "The platform writes the part of the prompt that everyone forgets to write.",
  },
  {
    id: "approval-risk-meter",
    name: "ApprovalRiskMeter",
    concept:
      "How risk scores are computed for approval categories and the auto-approve threshold.",
    interaction:
      "A form mimicking request_approval: category dropdown, payload size slider, \"affects production\" toggle, \"irreversible\" toggle. As inputs change, a risk meter animates — needle sweeps between 0–100, with the AUTO_APPROVE_THRESHOLD marked at 40. Below the meter: three possible outcomes (auto_approved / pending / rejected-by-policy) light up based on where the needle lands. A small table showing the actual weight of each input.",
    technicalNotes:
      "GSAP rotation on the needle. Colors interpolate from green→amber→red with the needle angle.",
    whyItMatters:
      "Risk scoring is currently a black box in the code. Exposing the formula builds operator trust.",
    caption:
      "Low score: auto-approved. High score: humans get to ruin their afternoon. Medium score: humans, but they get notified.",
  },
  {
    id: "idempotent-retry-explainer",
    name: "IdempotentRetryExplainer",
    concept:
      "Why create/add ops return the existing entity instead of 409, and what happens without it.",
    interaction:
      "Two side-by-side simulations. Left: \"Strict 409\" — a runner sends add_participant three times (LLM retry pattern). Request 1 succeeds (200), 2 fails (409), 3 fails (409). Runner backs off and retries the whole stage; costs tick up on a meter. Right: \"Idempotent\" — same three requests, all return 200 with the existing entity. Runner continues without interruption; cost meter stays flat. Play/pause controls. A counter at the bottom: \"Tick cycles wasted on left: N\" vs. \"on right: 0.\"",
    technicalNotes:
      "Two parallel timelines. Text callouts appear at the critical moments. Cost meters are GSAP-tweened numbers.",
    whyItMatters:
      "The idempotency principle sounds abstract until you see the cost tick.",
    caption:
      "409 Conflict is a feature request, not a response. We adopted the fix after counting the dollars.",
  },
  {
    id: "collision-detection-visualizer",
    name: "CollisionDetectionVisualizer",
    concept:
      "The three-stage drop detection in multi-column kanban (pointerWithin → rectIntersection → closestCenter restricted to columns).",
    interaction:
      "A 3-column layout with cards. A \"ghost\" card follows the cursor (simulating drag). Real-time overlays highlight which detection stage currently resolves: a blue box for pointerWithin, amber for rectIntersection fallback, green for closestCenter fallback. Deliberately dragging the cursor to an empty gap between columns demonstrates the amber fallback; dragging fast through multiple columns demonstrates the green fallback locking onto the right column. Toggle: \"Disable multi-stage detection\" — shows the original dnd-kit default, producing the \"card in column Y wins a drop aimed at column X\" bug.",
    technicalNotes:
      "dnd-kit with custom collisionDetection hook. Overlay is absolute-positioned, opacity-tweened.",
    whyItMatters:
      "A specific bug the code comments document but nobody sees unless they read use-kanban-dnd.ts.",
    caption:
      "The default collision detection was correct 90% of the time, which is exactly the wrong amount of correct.",
  },
  {
    id: "event-bus-scope-demo",
    name: "EventBusScopeDemo",
    concept:
      "Workspace-scoped vs global subscriptions on the in-process EventBus; fnmatch pattern routing.",
    interaction:
      "Four \"subscribers\" stacked vertically, each with a visible pattern string (activity.card.*, activity.*.deleted, *, activity.card.created workspace-scoped to \"alpha\"). A \"publisher\" above fires events via dropdown: event type (activity.card.created, activity.column.deleted, etc.) × workspace (alpha | bravo). When fired, arrows animate from the publisher to each matching subscriber; non-matching subscribers dim. Counter per subscriber shows how many events it has received.",
    technicalNotes:
      "Pure animation; no actual EventBus. Client-side fnmatch to decide routing. GSAP for arrow draw-in.",
    whyItMatters:
      "The scope+pattern model is surprisingly subtle; showing it visually helps anyone writing new event subscribers.",
    caption:
      "Subscribe to * at your peril. Your console will thank you, or it will not speak to you again.",
  },
  {
    id: "prompt-resolution-layers",
    name: "PromptResolutionLayers",
    concept:
      "The three-layer prompt model (registry → synthesis → override) and resolved_content assembly.",
    interaction:
      "Three stacked \"layers\" visualized as translucent panes: 1) Registry defaults — shows the platform-shipped prompt for orchestrator.implement. 2) Synthesis — if the operator adds a custom role security-auditor.scan, a synthesized minimal template appears here. 3) Override — operator edits the prompt; a new pane slides in on top. Below the stack: the resolved_content preview — live updates as layers change, with the post-process imperative visibly appended. A toggle: \"Runner consumes.\" Arrow animates from resolved_content into a stylized claude -p subprocess.",
    technicalNotes:
      "Accordion-style layer interaction. GSAP for pane slide-ins. Diff-style highlighting on the final resolved_content.",
    whyItMatters:
      "Operators read \"the platform splices an imperative\" and wonder where. This shows where.",
    caption:
      "Three layers, one assembled prompt, zero chances for the LLM to improvise the tool call.",
  },
  {
    id: "runner-fleet-monitor",
    name: "RunnerFleetMonitor",
    concept:
      "Runner health states — active / draining / offline / error — and what triggers each transition.",
    interaction:
      "A grid of 6 runner cards, each showing CPU sparkline, uptime, last heartbeat, current state (color-coded). A control panel: \"Kill runner 3\" / \"Network partition runner 5\" / \"SIGTERM runner 2\" / \"Budget exceeded on runner 6.\" User clicks a control; affected runner transitions through states with animated edges (amber pulsing for draining, red for error, gray for offline). A timeline at the bottom logs state transitions.",
    technicalNotes:
      "No real runners. Fake data with plausible health values. Sparkline is mini-SVG updated every 500ms.",
    whyItMatters:
      "Operators need to know what each health state means and which are recoverable.",
    caption:
      "'Draining' is runner-speak for 'finishing up before I go offline.' 'Error' is runner-speak for 'I need you to read the logs.'",
  },
  {
    id: "slug-identity-round-trip",
    name: "SlugIdentityRoundTrip",
    concept:
      "Why we moved config entities from UUID identity to slug identity, and how export/import round-trips work.",
    interaction:
      "Two \"workspaces\" side by side: Alpha (left), Bravo (right). User drags a pipeline config from Alpha toward Bravo. Mid-air, the config shows its JSON — UUIDs are highlighted in red, slugs in green. In UUID mode: the import fails visibly (UUIDs don't exist in Bravo); the component shows an error state. Toggle \"Slug mode\": re-try. Slugs resolve; the import succeeds; the pipeline renders in Bravo as a shareable card. Below: a side-by-side diff showing what changed field-by-field.",
    technicalNotes:
      "Simulated drag across two fixed-width panels. GSAP for the airborne JSON animation. Syntax-highlighted JSON diff library not needed — hand-roll a tiny highlighter that only needs to distinguish UUID shape vs slug shape.",
    whyItMatters:
      "The slug identity migration is on the backlog (UX-D) and the concept matters for future users. Showing the \"why\" makes the \"how\" easier to understand later.",
    caption:
      "UUIDs are portable. Slugs are portable AND readable. One of these things is meaningfully better if you'd like to share a pipeline with a human.",
  },
];
