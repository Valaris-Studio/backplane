// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content derived from docs/research/mcp-server.md §9 and the mcp-server CLAUDE.md.

import { SectionPage } from "../shell/SectionPage";
import {
  CodeExample,
  HonestRemark,
  ImportantNote,
  ProTip,
} from "../callouts";

export function ExtendingAddingANewMcpTool() {
  return (
    <SectionPage
      title="Adding a New MCP Tool"
      eyebrow="Extending Backplane"
    >
      <p>
        MCP tools are the programmatic surface runners and operator LLMs use to
        touch Backplane. Adding one is a small, six-step loop: pick a module,
        write a decorated function, include a next-step hint, register by
        import, test it, and update the frontend catalog so the drift guard
        stays happy. This page walks each step with a concrete example — a{" "}
        <code>archive_card</code> tool that moves a card to the archived
        column.
      </p>

      <h2 id="pick-a-module">Pick a module</h2>
      <p>
        Tools group by entity in <code>mcp-server/src/valaris_mcp/tools/</code>.
        A card operation goes in <code>cards.py</code>; a workspace operation
        in <code>workspaces.py</code>. Create a new file only if no existing
        module fits — the MCP host shows tools in a flat list, so file
        boundaries are for contributors, not callers.
      </p>

      <h2 id="write-the-function">Write the function</h2>
      <p>
        Every tool follows the same shape:{" "}
        <code>async def fn(..., ctx: Context = None) -&gt; str</code>, decorated
        with <code>@mcp.tool()</code> over <code>@handle_api_errors</code>,
        returning a JSON-serialized dict. The backend HTTP call goes through
        the lifespan-scoped <code>ValarisClient</code> on the request context.
      </p>

      <CodeExample
        language="python"
        title="archive_card — a minimal mutation tool"
      >
        {`from mcp.server.fastmcp import Context

from valaris_mcp.app_context import AppContext
from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import mcp

import json


@mcp.tool()
@handle_api_errors
async def archive_card(
    workspace_slug: str,
    card_id: str,
    reason: str | None = None,
    ctx: Context = None,
) -> str:
    """Archive a card by moving it to the workspace's archive column.

    Call this when a card is no longer actionable and should be removed
    from the active board without deleting its history. The archived
    column is created on demand if it doesn't exist.

    Args:
        workspace_slug: The URL slug identifying the workspace.
        card_id: The card to archive.
        reason: Optional note explaining why the card was archived.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.post(
        f"{client.ws(workspace_slug)}/cards/{card_id}/archive",
        {"reason": reason},
    )
    result["_hint"] = (
        "Call list_cards with column_type='archive' to confirm the "
        "card landed, or get_card to re-fetch its state."
    )
    return json.dumps(result, indent=2, default=str)`}
      </CodeExample>

      <ImportantNote title="Parameter order is load-bearing">
        <p>
          <code>ctx: Context = None</code> is always the last parameter. FastMCP
          injects the context positionally in some call paths; putting another
          keyword-only argument after <code>ctx</code> makes the tool invisible
          in the MCP handshake on certain hosts. Required positional args first,
          then optional keyword args, then <code>ctx</code>. No exceptions.
        </p>
      </ImportantNote>

      <h2 id="the-hint-field">The <code>_hint</code> field</h2>
      <p>
        Every response dict should carry an <code>_hint</code> key with a short
        action-oriented instruction. The LLM reads the response verbatim; a
        good hint shaves an entire round-trip off the next step because the
        model already knows which tool to call. Bad hints describe what just
        happened ("Card archived successfully"). Good hints point to the next
        tool.
      </p>

      <ProTip title="Write hints in the imperative">
        <p>
          "Call <code>list_cards</code> with <code>column_type=&apos;archive&apos;</code>{" "}
          to confirm." is a useful hint — it names a tool, names an argument,
          and gives a reason. "The card has been archived." is not — it tells
          the LLM nothing it couldn't already infer from the status field. When
          in doubt, imagine the LLM has exactly one more tool call to make:
          what would help it pick?
        </p>
      </ProTip>

      <h2 id="register-and-test">Register, test, and declare</h2>
      <p>
        MCP registration happens at import time via the <code>@mcp.tool()</code>
        {" "}decorator. Add an import line to <code>server.py</code> so the
        module loads when the server boots.
      </p>

      <CodeExample
        language="python"
        title="server.py — side-effect imports"
      >
        {`# In src/valaris_mcp/server.py, alongside the other tool imports:
import valaris_mcp.tools.cards       # noqa: F401, E402
import valaris_mcp.tools.my_module   # noqa: F401, E402`}
      </CodeExample>

      <p>
        Write a unit test in <code>tests/test_tools.py</code> that mocks{" "}
        <code>ValarisClient</code> to record the HTTP call and asserts the
        verb, path, and body. Naming follows{" "}
        <code>test_&lt;tool_name&gt;_success</code> and{" "}
        <code>test_&lt;tool_name&gt;_&lt;failure_mode&gt;</code>.
      </p>

      <CodeExample
        language="python"
        title="test_archive_card_success"
      >
        {`async def test_archive_card_success(mock_client, fake_context):
    mock_client.post.return_value = {
        "id": "card-123", "column_id": "archive-col", "status": "archived"
    }
    raw = await archive_card(
        workspace_slug="demo",
        card_id="card-123",
        reason="superseded by card-456",
        ctx=fake_context,
    )
    result = json.loads(raw)
    mock_client.post.assert_awaited_once_with(
        "/api/workspaces/demo/cards/card-123/archive",
        {"reason": "superseded by card-456"},
    )
    assert result["status"] == "archived"
    assert "_hint" in result`}
      </CodeExample>

      <p>
        Finally, add the tool name to the frontend catalog at{" "}
        <code>frontend/src/features/agents/lib/toolCatalog.ts</code> in the
        {" "}<code>VALARIS_MCP_NAMES</code> array (sorted alphabetically). The
        drift guard at <code>backend/tests/test_mcp_catalog_drift.py</code>{" "}
        will fail CI if the catalogs disagree — it exists because half-added
        tools that the UI can't show are worse than no tool at all.
      </p>

      <HonestRemark title="The drift guard catches us about twice a month">
        <p>
          The drift guard started as a paranoia test. It's fired often enough —
          someone adds a tool, skips the frontend catalog update, CI reminds
          them — that we now treat it as part of the definition of "done." If
          you ship a tool and the operator UI can't show it in the agent tool
          picker, the tool effectively doesn't exist for the humans configuring
          the pipeline. The guard exists because we learned this the expensive
          way.
        </p>
      </HonestRemark>

      <h2 id="mutation-tracking">If the tool mutates cards</h2>
      <p>
        Add the tool name to <code>CARD_MUTATING_TOOLS</code> in{" "}
        <code>mcp-server/src/valaris_mcp/tracking.py</code>. This populates the
        {" "}<code>cards_affected</code> field on execution records so the UI
        can show which cards a stage touched. Skipping this step means the
        execution row looks like the stage did nothing, which makes debugging
        a confused pipeline harder than it needs to be.
      </p>
    </SectionPage>
  );
}
