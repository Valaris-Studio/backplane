// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content adapted from docs/platform-source-of-truth.md §10.5 and §8,
// docs/research/runner-pipeline-internals.md §5, and
// memory/feedback_llm_abstraction_north_star.md (referenced from source-of-truth).

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, FutureState } from "../callouts";

export function UnderTheHoodModelAgnosticRoles() {
  return (
    <SectionPage title="Model-Agnostic Roles" eyebrow="Under the Hood">
      <p>
        The north star is per-role <code>llm.provider</code> and{" "}
        <code>llm.model</code>. Implementer on Sonnet for speed and cost.
        Reviewer on GPT-5 because a different model is a different
        reviewer. Documentator on Gemini because its context window fits
        a whole codebase. All three roles driven by the same runner,
        against the same card, from the same pipeline config. This is
        the declared target and it is on the backlog, not on trunk.
      </p>
      <p>
        This page documents what is wired today, what the target shape
        looks like, and what it will take to get there. It is one of the
        few pages in this documentation where a future state is load
        bearing enough to deserve its own section — everything on the
        platform flows through the LLM runner, and the runner being
        model-locked today bounds what the platform can ship tomorrow.
      </p>

      <h2 id="why-this-matters">Why role independence implies model independence</h2>
      <p>
        Role extensibility without model extensibility is a half-answer.
        An operator can declare a <code>security-auditor</code> role and
        the platform will dispatch cards to it — the runtime hot path
        and the prompt synthesis both handle arbitrary roles. What the
        operator cannot do today is say "the security auditor runs on a
        different model than the implementer." The auditor inherits the
        runner's single LLM config. Every role routes through the same
        Claude CLI subprocess against the same model string, and{" "}
        <code>model_overrides</code> is keyed by pipeline{" "}
        <em>phase</em>, not <em>role</em> — the runner can vary which
        model it uses for <code>research</code> versus{" "}
        <code>implement</code>, but not which model a custom{" "}
        <em>analyst</em> uses at the same phase.
      </p>
      <p>
        The practical consequences are immediate. You cannot run a
        mixed-provider quorum reviewer. You cannot send the
        cost-sensitive drafting role to a cheap model and the
        precision-sensitive review role to an expensive one. You
        cannot experiment with "does GPT-5 review Sonnet's output
        better than Opus reviews Sonnet's output" without standing up
        two runners. The data model supports the distinction in
        principle; the runtime does not implement it yet.
      </p>

      <h2 id="what-is-wired-today">What is wired today</h2>
      <p>
        A single <code>LLMConfig</code> lives on the runner's YAML at{" "}
        <code>runner/internal/config/config.go</code>. It carries a
        provider string, a default model, optional per-phase overrides,
        and credentials. All routes flow through{" "}
        <code>runner/internal/llm/claude_cli.go</code>, which spawns{" "}
        <code>claude -p</code> as a subprocess. The{" "}
        <code>ANTHROPIC_API_KEY</code> environment variable is
        deliberately stripped from the subprocess so Claude Code Max
        (OAuth/subscription) wins unless the operator sets an explicit
        key in config.
      </p>
      <p>
        The pipeline config DSL has <code>llm</code> blocks per stage
        already — they declare the stage name, the tools allowlist, the
        post-process kind, and the directives. What they do <em>not</em>{" "}
        declare today is a provider or a model. The fields are not in
        the schema. Adding them is a schema change; making them take
        effect is the rest of the work.
      </p>

      <h2 id="target-shape">The target shape</h2>
      <p>
        Per-role, per-stage <code>llm</code> configuration on the pipeline
        config itself. Credentials stored at the workspace level and
        resolved by the runner at stage dispatch time. A provider
        abstraction in Go that dispatches to Anthropic, OpenAI, or
        Google from the same call site without the runner caring which
        it lands on. Prompt caching normalized across providers. Tool-call
        normalization so an MCP tool behaves the same whether the model
        underneath speaks Anthropic's tool-use format or OpenAI's
        function-call format.
      </p>

      <CodeExample
        language="json"
        title="The target pipeline_config llm block (not yet wired)"
      >
        {`{
  "role": "reviewer",
  "discover": { "strategy": "column_scan", "column_type": "review" },
  "claim":    { "participant_role": "helper", "execution_action": "review" },
  "git":      { "action": "checkout_pr_branch", "branch_prefix": "impl/" },
  "llm": {
    "enabled": true,
    "stage": "review",
    "tools":  ["mcp"],
    "post_process_kind": "produces_decision",
    "provider": "openai",
    "model":    "gpt-5",
    "temperature": 0.2,
    "credential_ref": "workspace:openai-key"
  },
  "on_success": {
    "branches": {
      "approve":          { "move_to_column_type": "done",    "wake_roles": ["documentator"] },
      "request_changes":  { "move_to_column_type": "active",  "wake_roles": ["orchestrator"] }
    }
  }
}`}
      </CodeExample>

      <h2 id="what-it-will-take">What it will take</h2>
      <p>
        The work breaks into five threads. None are individually hard.
        Together they are the LLM abstraction milestone.
      </p>
      <ul>
        <li>
          <strong>Credential storage at the workspace level.</strong> A
          workspace can hold references to Anthropic, OpenAI, and
          Google credentials, encrypted at rest. The runner resolves
          the <code>credential_ref</code> on stage dispatch. Per-role
          credentials compose with workspace budgets for per-provider
          spend tracking.
        </li>
        <li>
          <strong>Provider interface in Go.</strong> A{" "}
          <code>LLMProvider</code> interface with implementations for
          Anthropic CLI, Anthropic SDK, OpenAI, and Google Generative
          AI. The runner dispatches to the right one based on the
          stage's <code>llm.provider</code>. The existing Claude CLI
          path becomes one provider among several.
        </li>
        <li>
          <strong>Prompt caching normalization.</strong> Anthropic's
          ephemeral-cache-control blocks and OpenAI's prompt-caching
          semantics do not map one-to-one. The runner needs a cache
          abstraction that accepts the platform's prompt parts and
          emits provider-appropriate cache controls.
        </li>
        <li>
          <strong>Tool-call format normalization.</strong> The MCP
          server speaks the tool-call protocol every major host
          supports, but the subprocess-level formats differ. Whatever
          wrapper the Go runner uses has to translate the provider's
          tool-use frames into MCP calls transparently.
        </li>
        <li>
          <strong>Self-review guard removal.</strong> The hardcoded{" "}
          <code>p.Role == "reviewer"</code> check in the runner that
          prevents a runner from reviewing its own work is a
          pre-abstraction heuristic. Once models can differ per role,
          "this runner reviewed its own work" is no longer a concern —
          the reviewer is a different model with a different persona,
          and the same physical process being involved stops
          mattering.
        </li>
      </ul>

      <h2 id="why-not-already">Why this isn't already done</h2>
      <p>
        Two reasons. The first is that single-provider operation has
        been the short path to proving everything else. Role
        extensibility, prompt synthesis, platform authority, pipeline
        DSL, post-process imperatives — all of these had to land and
        stabilize before the multi-provider story was worth the churn.
        The second is that prompt caching is a meaningful part of what
        keeps runner costs tractable, and building the caching layer
        for one provider well is easier than building it for three
        provisionally.
      </p>
      <p>
        Neither reason survives indefinitely. The single-provider
        scaffolding has stabilized — the runtime hot path is clean, the
        extensibility story is proven in production with custom roles,
        the audit findings cluster at the boundaries rather than the
        core. Prompt caching is well enough understood across providers
        that the normalization layer is a week of work, not a quarter.
        The LLM abstraction milestone is the next major unit of work
        rather than the year-out horizon it was when the platform first
        started.
      </p>

      <FutureState title="The declared north star, explicitly not yet shipped">
        <p>
          Per-role model selection is the single largest declared-but-
          unshipped item on the platform roadmap. The scoping document
          lives at{" "}
          <code>docs/scoping/role-separation-and-llm-abstraction.md</code>
          . The feedback memo at{" "}
          <code>memory/feedback_llm_abstraction_north_star.md</code>{" "}
          captures the principle: role extensibility without model
          extensibility is a half-answer. We are taking that seriously
          rather than quietly. If you are reading this page because you
          wanted to send your reviewer role to GPT-5 and your
          implementer to Sonnet — that is the feature we know we owe
          you. It is not here yet.
        </p>
      </FutureState>

      <p>
        Every other page in this group documents something that works.
        This one documents something that should. The distinction is
        worth the page. When someone asks "can Backplane run a mixed-model
        pipeline?" the honest answer today is no, and the principled
        answer tomorrow is yes, and the work between here and there is
        the explicit subject of a scheduled milestone rather than
        something you have to guess at. That is the kind of honesty
        documentation is for.
      </p>
    </SectionPage>
  );
}
