// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content derived from docs/research/runner-pipeline-internals.md §5 and
// docs/research/frontend-ux.md §4.3.

import { SectionPage } from "../shell/SectionPage";
import {
  CodeExample,
  HonestRemark,
  ImportantNote,
  ProTip,
} from "../callouts";

export function ConfigurationPromptAuthoringGuide() {
  return (
    <SectionPage title="Prompt Authoring Guide" eyebrow="Configuration">
      <p>
        A runner's LLM prompt is the contract between your pipeline intent and
        the model's output. The platform resolves a prompt in three layers,
        stamps a post-process imperative on it based on the stage's{" "}
        <code>post_process_kind</code>, and renders the Go template against
        the card context before the model sees a single token. Everything in
        this page describes that flow.
      </p>

      <h2 id="three-layers">Three layers</h2>
      <p>
        When a stage's LLM phase fires, the agent resolves the template for
        the <code>(role, stage)</code> pair through a three-layer lookup.
      </p>
      <ol>
        <li>
          <strong>Registry.</strong> The platform seeds a library of default
          prompts on first workspace access (see{" "}
          <code>backend/app/services/agents/prompt_defaults.py</code>). This
          covers the seeded personas — implementer, reviewer, documentator,
          researcher, planner.
        </li>
        <li>
          <strong>Synthesis.</strong> For a <code>(role, stage)</code> pair
          that isn't in the registry, the platform synthesizes a minimal
          template with the canonical variables and the post-process
          imperative. Custom roles start here.
        </li>
        <li>
          <strong>Override.</strong> An operator-authored row in{" "}
          <code>prompt_configs</code> scoped to{" "}
          <code>(workspace, team, role, stage, slug)</code> wins over both.
          This is where you shape behavior for a specific workspace.
        </li>
      </ol>
      <p>
        The Go agent also carries hardcoded fallbacks for the seeded personas
        so a fresh runner can tick before the platform's cache has warmed.
        This is a resilience net, not an escape hatch — platform authority
        means the override in <code>prompt_configs</code> is the source of
        truth in any case of disagreement.
      </p>

      <p>The editor shows the raw template; the preview shows what the runner will send after variable substitution and imperative splicing.</p>

      <h2 id="template-variables">Template variables</h2>
      <p>
        Templates are rendered with Go's <code>text/template</code> syntax
        against a context struct assembled by the agent. The canonical
        variables available in every template:
      </p>
      <ul>
        <li>
          <code>{`{{.CardID}}`}</code> — the UUID of the claimed card.
        </li>
        <li>
          <code>{`{{.Title}}`}</code> and <code>{`{{.Description}}`}</code> —
          the card's display fields.
        </li>
        <li>
          <code>{`{{.ProjectDirectives}}`}</code> — board definition coding
          standards plus pinned notes, injected when{" "}
          <code>llm.inject_directives: true</code>. Empty otherwise.
        </li>
        <li>
          <code>{`{{.ReviewHistory}}`}</code> — prior review notes on the
          card, newest-first. Usually empty on the first tick, populated on
          rework.
        </li>
        <li>
          <code>{`{{.ActionPlan}}`}</code> — a structured plan field,
          populated only when a planner stage ran upstream.
        </li>
      </ul>

      <CodeExample
        language="text"
        title="Minimal reviewer template using the standard variables"
      >
        {`You are reviewing card {{.CardID}} titled "{{.Title}}".

Card description:
{{.Description}}

Project directives:
{{.ProjectDirectives}}

Prior review notes:
{{.ReviewHistory}}

Evaluate the PR against the directives. Emit your decision.`}
      </CodeExample>

      <p>
        The template body stops there. The post-process imperative — the
        line that tells the model how to format its output — is not something
        you write into the template. The engine appends it.
      </p>

      <h2 id="post-process-imperatives">Post-process imperatives</h2>
      <p>
        This is the section that saves you from six weeks of prompt debugging.
      </p>
      <p>
        The stage's <code>llm.post_process_kind</code> picks which imperative
        gets spliced onto the end of the rendered template before it reaches
        the model. The four kinds map to four imperatives:
      </p>
      <ul>
        <li>
          <code>writes_code</code> — "Make the changes directly in the
          working tree. Do not return code in your response." The engine then
          commits and pushes.
        </li>
        <li>
          <code>produces_decision</code> — "Emit a single JSON object with a
          <code>decision</code> field. Do not write code. Do not create
          notes." The decision string indexes into{" "}
          <code>on_success.branches</code>.
        </li>
        <li>
          <code>produces_note</code> — "Emit structured markdown findings.
          The platform will attach them to the card as a review note." No
          git.
        </li>
        <li>
          <code>mutates_backlog</code> — "Use the available MCP tools to
          create or update cards. The platform records the summary only." No
          git, no note.
        </li>
      </ul>
      <p>
        Picking the kind is the single most important design choice in the
        stage. A reviewer with <code>writes_code</code> will try to edit code
        instead of producing a decision. An implementer with{" "}
        <code>produces_decision</code> will emit JSON and never commit. If
        your runs consistently drift from what you wanted, check the kind
        before you rewrite the template.
      </p>

      <ImportantNote title="Do not hand-write the imperative into your template">
        The engine always splices the imperative. If you also write it into
        the template body, the model gets two imperatives — one from you and
        one auto-appended — which fight each other in subtle ways. Keep the
        template to the task description and the variables. Let the kind
        switch do its job.
      </ImportantNote>

      <h2 id="override-scope">Override scope</h2>
      <p>
        An override in <code>prompt_configs</code> is keyed by a five-tuple:
        {" "}<code>(workspace, team, role, stage, slug)</code>. Workspace and
        role scope the "who"; stage scopes the "when" (which ticking phase);
        team scopes to an agent team when you want a subset of runners to use
        a variant. The <code>slug</code> is the friendly-ID for a specific
        prompt revision — you can keep multiple variants named{" "}
        <code>default</code>, <code>strict-review</code>,{" "}
        <code>experiment-2026-04</code> and switch between them without
        losing the others.
      </p>
      <p>
        Resolution walks most-specific to least-specific. A prompt authored
        for a specific team beats a workspace-wide one; a workspace-wide
        override beats the registry default; the registry default beats the
        synthesized placeholder.
      </p>

      <HonestRemark title="The editor is a plain textarea today">
        The prompt editor renders a plain <code>&lt;textarea&gt;</code> with
        no syntax highlighting, no template-variable autocomplete, no preview
        of the spliced imperative, and no diff-against-default. You can paste
        a five-paragraph prompt into it and it will accept. Whether the
        runner uses it correctly is between you and the model. A richer
        editor is on the roadmap; in the meantime, draft complex prompts in
        your editor of choice and paste the final.
      </HonestRemark>

      <ProTip title="MCP is the path of least resistance for authoring">
        The MCP server exposes <code>set_prompt_config</code> and{" "}
        <code>get_prompt_config</code> tools. When you're iterating on a
        prompt from an agent client (Claude Desktop, Cursor, your own MCP
        consumer), calling those tools is faster than the UI — no
        context-switch, no copy-paste, and the tool response shows you the
        resolved prompt after substitution. The UI exists for the case where
        you don't have an MCP client connected to the workspace.
      </ProTip>
    </SectionPage>
  );
}
