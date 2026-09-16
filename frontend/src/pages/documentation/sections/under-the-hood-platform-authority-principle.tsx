// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content adapted from docs/platform-source-of-truth.md §7.4 and §8, and
// docs/research/runner-pipeline-internals.md §10.

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, FutureState, HonestRemark } from "../callouts";

export function UnderTheHoodPlatformAuthorityPrinciple() {
  return (
    <SectionPage title="Platform Authority Principle" eyebrow="Under the Hood">
      <p>
        The backend is the single source of truth for pipeline shape and
        prompts. The runner fetches both at startup and refuses to start
        when the backend hasn't authored them. The runner does not carry a
        compiled-in default pipeline that runs when the platform is
        silent. The platform owns identity and behavior; the runner owns
        execution.
      </p>
      <p>
        This is the hardest principle to appreciate from outside the
        system, because it looks like an overreaction. "Why not just let
        the runner default to a sensible pipeline if the platform returns
        nothing?" That question has a specific answer grounded in a
        specific incident, and it is worth stating it plainly: defaults at
        the client level hide platform bugs. Defaults at the platform
        level are legitimate. The distinction is load-bearing.
      </p>

      <h2 id="what-this-means-in-practice">What this means in practice</h2>
      <p>
        On every boot, the Go runner calls{" "}
        <code>GET /api/agents/me/config</code>. The response is expected
        to carry a non-empty <code>pipeline_config</code> with a
        non-empty <code>stages</code> array. If either is missing, the
        runner logs a clear error and exits — it does not fall back to a
        built-in pipeline, it does not pick a reasonable default, it
        refuses to operate. On every tick, the runner re-fetches the
        config and re-applies platform authority: roles whose prompts
        have been removed are dropped from the live scheduler without a
        restart. Authoring a new prompt in the UI restores the role on
        the next refresh.
      </p>
      <p>
        Prompts follow the same rule. Every stage declares its prompt
        source from the platform's prompt registry, synthesis layer, or
        an operator-authored override. The runner prefers{" "}
        <code>resolved_content</code> (backend-assembled, with the
        post-process imperative spliced in) over raw{" "}
        <code>content</code> — so operator edits on synthesized
        placeholders retain the platform-owned imperative text. A stage
        with no prompt in the cache returns{" "}
        <code>status: skipped</code> rather than executing against a
        compiled-in template.
      </p>

      <h2 id="the-st8-anchor">The ST#8 anchor incident</h2>
      <p>
        The principle has an origin. ST#8 silently shipped a three-role
        hardcoded pipeline over a five-role platform pipeline. The
        backend was configured correctly. The runner ignored it, because
        the runner carried a compiled-in default that won the race when
        the authoritative fetch was slower than the first tick of the
        scheduler. Operators saw the three-role behavior and assumed the
        platform was misconfigured. The platform was not misconfigured.
        The runner was.
      </p>
      <p>
        The fix was not "add better defaults." The fix was "refuse to
        operate on stale authority." The runner now blocks startup on the
        platform config, and the scheduler re-applies platform authority
        every tick. The compiled-in defaults that won ST#8 are being
        removed one by one. The principle is what the fix crystallized:
        defaults and fallbacks are legitimate at the platform level;
        they are a bug at the client level.
      </p>

      <CodeExample
        language="go"
        title="The refuse-to-start check in Loop.New"
      >
        {`// runner/internal/workloop/loop.go — the boot-time platform authority check.
func New(cfg *Config, cli *valaris.Client) (*Loop, error) {
    platformCfg, err := cli.GetPlatformConfig(ctx)
    if err != nil {
        return nil, fmt.Errorf("platform config fetch failed: %w", err)
    }
    if platformCfg.PipelineConfig == nil || len(platformCfg.PipelineConfig.Stages) == 0 {
        // Deliberately not falling back to a compiled-in default.
        // The platform is the source of truth; a silent backend means
        // "do not start" until an operator authors a pipeline.
        return nil, errors.New(
            "platform pipeline config is empty — refusing to start. " +
            "Configure pipeline stages in the UI and retry.",
        )
    }
    return &Loop{ /* ... */ }, nil
}`}
      </CodeExample>

      <h2 id="what-extensibility-buys">What the principle buys for extensibility</h2>
      <p>
        Because the runner does not have a compiled-in picture of what
        roles exist, an operator can author a role named{" "}
        <code>security-auditor</code> in the UI and the runner picks it
        up on the next poll without a single Go file changing. If the
        operator removes a role, the scheduler drops it without a
        restart. The 2026-04-18 runner-launch walkthrough confirmed this
        end-to-end: a custom <code>Secretario</code> role ran through
        the full pipeline lifecycle, never having existed in the runner
        binary's type system.
      </p>
      <p>
        The corollary is that extensibility is not a separate feature.
        It is a consequence of the runner being thin. Every time the
        runner gains a hardcoded notion of what a role means — what
        column type to target, what git action to take, what post-process
        kind to run — that is a regression against extensibility, and
        it's a regression against platform authority, and they are the
        same thing.
      </p>

      <h2 id="whats-left-to-clean">What is still left to clean up</h2>
      <p>
        The principle is articulated and the runtime hot path is clean.
        A handful of residual hardcoded fallbacks survive in the Go
        runner and violate the principle in spirit, even though they do
        not fire on the critical path:
      </p>
      <ul>
        <li>
          <strong>Column-type string fallbacks</strong> —{" "}
          <code>loop.go</code> and <code>strategy_generic.go</code> each
          carry a handful of hardcoded column-type strings (
          <code>"review"</code>, <code>"done"</code>,{" "}
          <code>"backlog"</code>, <code>"blocked"</code>) used when the
          corresponding <code>ActionDef</code> field is empty. Operator
          mistakes that omit the field land on a legacy default instead
          of surfacing the omission.
        </li>
        <li>
          <strong><code>DefaultPipelineConfig</code> in validation paths</strong>{" "}
          —{" "}
          <code>runner/internal/workloop/pipeline_config.go</code>{" "}
          still carries a full hardcoded three-role default. It is dead
          on the runtime hot path (the boot check refuses to start
          without a platform config), but{" "}
          <code>config_validate.go</code> still references it for
          validation — so validation output can disagree with
          refusal-to-start behavior. This is the cleanup that would
          close the principle loop.
        </li>
        <li>
          <strong>Role literals in execution logging</strong> —{" "}
          <code>LogExecutionStart(..., role: "orchestrator")</code> is
          literally hardcoded at two call sites on the hero path, so
          every hero-driven execution records{" "}
          <code>role: "orchestrator"</code> even when a custom
          researcher or planner drove it. Purely a reporting bug — the
          execution ran correctly, the execution row misattributes.
        </li>
        <li>
          <strong>Scheduling and git defaults</strong> that historically
          leaked operator-set values the platform should own — backoff
          seconds, <code>MaxConsecutive</code>, commit-message templates,
          branch prefixes. Recent refactors tightened most of these by
          leaving the runner-side field empty and treating any non-zero
          platform value as authoritative; a couple of shadow defaults
          still exist and are tracked for removal.
        </li>
      </ul>

      <HonestRemark title="Residual fallbacks are maintenance liability, not runtime bugs">
        None of the residuals above fire on the runtime hot path. The
        runner will refuse to start without a platform pipeline. The
        scheduler will drop a role whose prompt has disappeared. The
        compiled-in three-role default is reachable only from validation
        paths that ultimately get overridden by the boot check. The
        concern is maintenance: every shadow default is a place where
        the code has two opinions about what should happen, and when the
        platform evolves, keeping them in sync is continuous work that
        should instead be zero work. The fix is to delete the shadows
        outright, which we are doing one batch at a time rather than all
        at once because each deletion reads against several tests.
      </HonestRemark>

      <FutureState title="The final cleanup is tied to the LLM abstraction milestone">
        The residual fallbacks cluster around two themes: role-specific
        behavior and model-specific behavior. Both of those themes are
        exactly what the LLM abstraction milestone dissolves. Once
        per-role provider and model are first-class platform config,
        the pre-abstraction heuristics that currently justify some of
        the Go hardcodes (the self-review guard, the hero-path role
        literal, the reviewer-specific branch logic) become unnecessary.
        The cleanup is scheduled to ride in with that milestone rather
        than land as its own sprint. Tracked in{" "}
        <code>docs/scoping/role-separation-and-llm-abstraction.md</code>.
      </FutureState>

      <p>
        The principle is short to state. The discipline is long to
        maintain. Every design review asks whether the proposed change
        adds a client-side fallback, and if so, why the platform is the
        wrong place for it. The answer is usually "the platform is the
        right place for it." The answer is never "defaults at both
        layers are fine."
      </p>
    </SectionPage>
  );
}
