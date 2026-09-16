// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Single source of truth for the public repository identity. A repo rename or
// move should touch ONLY this file — everything user-facing (install commands,
// docs snippets, settings page) derives from it.

export const GITHUB_ORG = "Valaris-Studio";
export const GITHUB_REPO = "backplane";
export const REPO_URL = `https://github.com/${GITHUB_ORG}/${GITHUB_REPO}`;

// `uvx --from "<this>" valaris-mcp` installs the MCP server straight from the
// monorepo subdirectory. Switch to the PyPI name once the package is published.
export const MCP_GIT_INSTALL_URL = `git+${REPO_URL}.git#subdirectory=mcp-server`;

export const MCP_INSTALL_COMMAND = `uvx --from "${MCP_GIT_INSTALL_URL}" valaris-mcp`;
