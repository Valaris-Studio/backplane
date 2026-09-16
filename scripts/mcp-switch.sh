#!/usr/bin/env bash
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

# Switch the project's .mcp.json between environment profiles.
#
# Usage: scripts/mcp-switch.sh <profile>
#   profile: name of a file in mcp-server/envs/<profile>.env
#
# After switching, restart Claude Code so the MCP client reloads.
set -euo pipefail

cd "$(dirname "$0")/.."

PROFILE="${1:-}"
if [[ -z "$PROFILE" ]]; then
  available=$(ls mcp-server/envs/*.env 2>/dev/null | xargs -n1 basename | sed 's/\.env$//' | tr '\n' ' ')
  echo "usage: $0 <profile>"
  echo "available: ${available:-<none>}"
  exit 1
fi

ENV_FILE="mcp-server/envs/${PROFILE}.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found"
  exit 1
fi

declare -a jq_args=()
while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
  jq_args+=(--arg "$key" "$value")
done < "$ENV_FILE"

env_json=$(jq -n "${jq_args[@]}" '$ARGS.named')

tmp=$(mktemp)
jq --argjson env "$env_json" '.mcpServers.valaris.env = $env' .mcp.json > "$tmp"
mv "$tmp" .mcp.json

echo "✓ switched .mcp.json → $PROFILE"
echo "  VALARIS_API_URL=$(jq -r '.mcpServers.valaris.env.VALARIS_API_URL' .mcp.json)"
echo ""
echo "Restart Claude Code to reload the MCP client."
