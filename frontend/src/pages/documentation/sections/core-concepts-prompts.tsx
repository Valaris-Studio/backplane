// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content derived from docs/platform-source-of-truth.md §2.6 and
// docs/research/runner-pipeline-internals.md §5.

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, HonestRemark } from "../callouts";

export function CoreConceptsPrompts() {
  return (
    <SectionPage title="Prompts" eyebrow="Core Concepts">
      <p>
        A <strong>prompt</strong> is the LLM instruction for a specific{" "}
        <code>(role, stage)</code> pair, optionally scoped to a team. It's
        the text the runner renders and passes to <code>claude -p</code> each
        time it executes that stage. Prompts are where the platform's opinion
        about how each role should think actually lives.
      </p>

      <h2 id="three-layers">Three layers</h2>
      <p>
        Prompts resolve through three cooperating layers on the backend:
      </p>
      <ol>
        <li>
          <strong>Registry.</strong> Hand-written platform defaults for the 21
          known <code>(role, stage)</code> pairs covering the five shipped
          roles. These ship with the backend.
        </li>
        <li>
          <strong>Synthesis.</strong> For any <code>(role, stage)</code> that
          appears in the live pipeline but isn't in the registry, a minimal
          placeholder is generated from a shared template. Custom roles are
          never second-class — the UI always has something to author against.
        </li>
        <li>
          <strong>Overrides.</strong> Operator-authored{" "}
          <code>AgentPromptConfig</code> rows, scoped to{" "}
          <code>(workspace, team, role, stage, slug)</code>. An override
          replaces the body from layer 1 or 2 for that scope.
        </li>
      </ol>
      <p>
        Runners pull their prompt cache at startup and refresh it every tick.
        Edit a prompt in the UI and the change takes effect on the next
        refresh without a runner restart.
      </p>

      <h2 id="post-process-imperative">
        The post-process imperative (the load-bearing idea)
      </h2>
      <p>
        This is the single most operator-valuable design choice in the
        platform. Every stage declares a <code>post_process_kind</code> from a
        dropdown: <code>writes_code</code>, <code>produces_note</code>,{" "}
        <code>produces_decision</code>, or <code>mutates_backlog</code>. The
        backend splices the correct tool-call instruction into the prompt
        body automatically — the operator never has to remember to write
        "Step N: call <code>create_note(...)</code>" by hand.
      </p>
      <p>
        The runner prefers the backend-assembled <code>resolved_content</code>{" "}
        over the raw <code>content</code>, so edits on a synthesized prompt
        body retain the imperative. A custom <code>produces_note</code> role
        that the operator authored in the UI will call{" "}
        <code>create_note</code> correctly, because the imperative was
        spliced in, not typed.
      </p>

      <h2 id="template">Template variables</h2>
      <p>
        Prompt bodies are Go <code>text/template</code> source. The runner
        renders them with a context object carrying workspace and card
        identifiers plus stage-specific fields like review history and the
        project directives pulled from the board definition.
      </p>

      <CodeExample language="go-template" title="Minimal prompt template for a custom researcher role">
        {`You are the Researcher on board {{.WorkspaceSlug}}.

=== PROJECT DIRECTIVES (MANDATORY) ===
{{.ProjectDirectives}}

=== TASK ===
Investigate card {{.CardID}}. Read linked resources, check prior notes,
and produce a findings note on the board.

When you're done, move on. Do not edit code. Do not request approval.`}
      </CodeExample>

      <p>
        The <code>=== SECTION (MANDATORY) ===</code> framing is not
        decoration. Sonnet-class models treat tool-call results as optional
        reference and will skip directives they read as background prose.
        Code-fetched context fetched by the runner and injected into a
        clearly-labeled mandatory section has measurably better compliance
        than "please consider the following" framings.
      </p>

      <HonestRemark title="The prompt editor is a textarea today">
        No syntax highlighting, no variable lint, no live preview, no
        template-inheritance visualization. It's a text box and a Save button.
        Operators have flagged this often — the MCP server is the path of
        least resistance for authoring real prompts today, not the UI. An
        upgrade is on the backlog. Meanwhile, <code>{"{{.ProjectDirectives}}"}</code>{" "}
        typo'd as <code>{"{{.ProjectDirectiv}}"}</code> renders as empty
        string, not an error, so proofread.
      </HonestRemark>
    </SectionPage>
  );
}
