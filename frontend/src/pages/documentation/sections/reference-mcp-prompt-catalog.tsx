// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Rows render from mcp-reference/data PROMPT_DOCS — never hardcode counts.

import { SectionPage } from "../shell/SectionPage";
import { HonestRemark } from "../callouts";
import { PROMPT_ROLE_LABELS } from "../mcp-reference";
import { PROMPT_DOCS } from "../mcp-reference/data";
import type { PromptDoc } from "../mcp-reference/data";

export const MCP_PROMPT_CATALOG_EMPTY_SUMMARY =
  "Prompts are organized by agent role. ";

interface ReferenceMcpPromptCatalogProps {
  prompts?: PromptDoc[];
}

export function ReferenceMcpPromptCatalog({
  prompts = PROMPT_DOCS,
}: ReferenceMcpPromptCatalogProps = {}) {
  return (
    <SectionPage title="MCP Prompt Catalog" eyebrow="Reference">
      <p>
        Prompts are server-authored multi-phase workflow templates. An MCP
        host (Claude Code, Claude Desktop, a runner) expands a prompt by
        name and gets back a long instruction block that the LLM then
        executes as a sequenced plan. The templates do not share one universal
        phase cadence or confirmation rule: <code>triage</code> explicitly
        waits for confirmation before applying fixes, while{" "}
        <code>decompose_card</code> asks before deleting a parent card. Other
        prompts can present a plan and then proceed without a second
        confirmation gate.
      </p>
      <p>
        {prompts.length > 0 ? (
          <>
            {prompts.length}
            {" prompts total, organized by agent role. "}
          </>
        ) : (
          MCP_PROMPT_CATALOG_EMPTY_SUMMARY
        )}
        Parameters are interpolated into the prompt body at expansion time.
        The LLM sees the rendered string; parameter names are not visible
        to it. Invoking a prompt is not a transaction boundary: the host sends
        rendered prose to the model, and any resulting tool calls still run
        through normal authentication, authorization, and MCP allowlist checks.
      </p>

      <h2 id="the-prompts">The prompts</h2>
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Prompt
              </th>
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Role
              </th>
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Parameters
              </th>
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Purpose
              </th>
            </tr>
          </thead>
          <tbody>
            {prompts.map((prompt) => (
              <tr key={prompt.name} className="border-b border-border align-top">
                <td className="py-3 pr-4">
                  <code>{prompt.name}</code>
                </td>
                <td className="py-3 pr-4">{PROMPT_ROLE_LABELS[prompt.role]}</td>
                <td className="py-3 pr-4">
                  <code>
                    {prompt.params
                      .map(
                        (param) =>
                          `${param.name}${param.required ? "" : "?"}`,
                      )
                      .join(", ")}
                  </code>
                </td>
                <td className="py-3 pr-4">{prompt.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 id="how-to-invoke">How a host invokes them</h2>
      <p>
        In Claude Code and Claude Desktop, prompts appear in the slash-
        command palette. The host fetches the prompt template, interpolates
        any parameters the user typed, and sends the resulting prose to the
        model as a user turn. The model then executes it as a plan — no
        different from the user typing a long, careful instruction by hand.
      </p>
      <p>
        The Go runner does not expand this MCP prompt catalog during stage
        assembly. It fetches workspace prompt configurations and pipeline
        assignments through REST, then gives the spawned coding-agent session
        its allowed MCP tools. MCP prompts are host-facing templates, separate
        from the platform's pipeline prompt configurations.
      </p>

      <HonestRemark title="The slash-command name and the MCP handle disagree">
        The MCP install guide's workflow overview shows prompts with dashed
        names —{" "}
        <code>/init-project</code>, <code>/plan-work</code>,{" "}
        <code>/decompose</code>. The MCP server registers them with
        underscores — <code>init_project</code>, <code>plan_work</code>,{" "}
        <code>decompose_card</code>. A user typing the dashed form into a
        host that strictly matches registered MCP names will come up empty.
        Use the underscore handles shown in this catalog; dashed aliases are
        not registered by the server.
      </HonestRemark>
    </SectionPage>
  );
}
