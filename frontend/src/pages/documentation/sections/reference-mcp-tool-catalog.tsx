// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// The 'mcp-tool-catalog' slot renders the searchable two-pane explorer.
// Content lives in mcp-reference/data — never hardcode tool counts here.

import { McpToolReference } from "../mcp-reference";
import { CATEGORIES, TOOL_DOCS } from "../mcp-reference/data";
import { SectionPage } from "../shell/SectionPage";

export const MCP_TOOL_CATALOG_EMPTY_SUMMARY =
  "Searchable, filterable, copy-ready. ";

export function ReferenceMcpToolCatalog() {
  const populatedCategoryCount = new Set(TOOL_DOCS.map((doc) => doc.category))
    .size;
  const categoryCount = Math.min(populatedCategoryCount, CATEGORIES.length);
  return (
    <SectionPage
      title="MCP Tool Catalog"
      eyebrow="MCP Reference"
      bodyClassName="max-w-none"
    >
      <p className="max-w-prose text-muted-foreground">
        {TOOL_DOCS.length > 0 ? (
          <>
            {TOOL_DOCS.length}
            {" tools across "}
            {categoryCount}
            {" categories — searchable, filterable, and copy-ready. "}
          </>
        ) : (
          MCP_TOOL_CATALOG_EMPTY_SUMMARY
        )}
        Every tool id follows the <code>mcp__valaris__&lt;name&gt;</code>{" "}
        convention your MCP host uses to invoke it.
      </p>
      <McpToolReference />
    </SectionPage>
  );
}
