// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ToolDoc } from "./types";

export const DOCUMENTATION_TOOL_DOCS: ToolDoc[] = [
  {
    name: "list_documentation",
    category: "context",
    kind: "read",
    description: "List product documentation from the connected platform, including version and translation status.",
    params: [
      {
        name: "locale",
        required: false,
        description: "Registered documentation locale: en, es or pt-BR."
      },
      {
        name: "offset",
        required: false,
        description: "Section offset, starting at zero."
      },
      {
        name: "limit",
        required: false,
        description: "Maximum sections to return (1–100)."
      }
    ],
    gotchas: [
      "Product documentation contains no workspace data. Normal authentication and MCP allowlists still apply."
    ],
    examplePrompt: "List the documentation available on this platform in <locale>.",
    related: [
      "read_documentation"
    ]
  },
  {
    name: "read_documentation",
    category: "context",
    kind: "read",
    description: "Read a bounded Markdown section from the connected platform.",
    params: [
      {
        name: "slug",
        required: true,
        description: "Section slug returned by list_documentation."
      },
      {
        name: "locale",
        required: false,
        description: "Registered documentation locale: en, es or pt-BR."
      },
      {
        name: "version",
        required: false,
        description: "Version returned by list_documentation; a mismatch fails explicitly."
      },
      {
        name: "offset",
        required: false,
        description: "Character offset for continuing a section."
      },
      {
        name: "limit",
        required: false,
        description: "Maximum characters to return (1–30000)."
      }
    ],
    gotchas: [
      "Follow next_offset with the same locale and version. No bundled documentation fallback is used.",
      "Product documentation contains no workspace data. Normal authentication and MCP allowlists still apply."
    ],
    examplePrompt: "Read <slug> using the version from list_documentation, continuing until next_offset is null.",
    related: [
      "list_documentation"
    ]
  }
];
