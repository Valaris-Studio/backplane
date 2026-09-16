#!/usr/bin/env bash
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

set -euo pipefail

# First-run setup for valaris-runner.
# Validates dependencies, generates config files from templates.
# Safe to re-run — only creates files that don't already exist.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNNER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$RUNNER_DIR/.." && pwd)"
CONFIGS_DIR="$RUNNER_DIR/configs"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { printf "${GREEN}[ok]${NC}    %s\n" "$1"; }
warn() { printf "${YELLOW}[warn]${NC}  %s\n" "$1"; }
fail() { printf "${RED}[fail]${NC}  %s\n" "$1"; }

errors=0

# --- Dependency checks ---

printf "\n=== Checking dependencies ===\n\n"

if command -v go &>/dev/null; then
    ok "go $(go version | awk '{print $3}')"
else
    fail "go not found — install from https://go.dev/dl/"
    errors=$((errors + 1))
fi

if command -v claude &>/dev/null; then
    ok "claude CLI found"
else
    fail "claude CLI not found — install: npm install -g @anthropic-ai/claude-code"
    errors=$((errors + 1))
fi

if command -v uv &>/dev/null; then
    ok "uv $(uv --version 2>/dev/null || echo '(version unknown)')"
else
    fail "uv not found — install: curl -LsSf https://astral.sh/uv/install.sh | sh"
    errors=$((errors + 1))
fi

if command -v git &>/dev/null; then
    ok "git $(git --version | awk '{print $3}')"
else
    fail "git not found"
    errors=$((errors + 1))
fi

if command -v ssh &>/dev/null; then
    ok "ssh available"
else
    warn "ssh not found — needed for git clone over SSH"
fi

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    ok "ANTHROPIC_API_KEY is set (will use API credits)"
else
    ok "ANTHROPIC_API_KEY not set — will use Claude Code Max subscription (OAuth)"
fi

if [ -n "${VALARIS_API_KEY:-}" ]; then
    ok "VALARIS_API_KEY is set"
else
    warn "VALARIS_API_KEY not set — create an agent via POST /api/agents and set this"
fi

# --- Config generation ---

printf "\n=== Generating config files ===\n\n"

# MCP config
MCP_CONFIG="$CONFIGS_DIR/mcp-config.json"
if [ -f "$MCP_CONFIG" ]; then
    ok "mcp-config.json already exists"
else
    MCP_SERVER_DIR="$PROJECT_ROOT/mcp-server"
    API_URL="${VALARIS_API_URL:-http://localhost:8000}"
    API_KEY="${VALARIS_API_KEY:-vlr_your_agent_key_here}"
    AGENT_EMAIL="${VALARIS_AGENT_EMAIL:-runner@valaris.dev}"

    cat > "$MCP_CONFIG" <<MCPEOF
{
  "mcpServers": {
    "valaris": {
      "command": "bash",
      "args": ["$MCP_SERVER_DIR/run.sh"],
      "env": {
        "VALARIS_API_URL": "$API_URL",
        "VALARIS_API_KEY": "$API_KEY",
        "VALARIS_AGENT_EMAIL": "$AGENT_EMAIL"
      }
    }
  }
}
MCPEOF
    ok "created mcp-config.json (edit API_KEY before running)"
fi

# Intern config
RUNNER_CONFIG="$CONFIGS_DIR/runner.yaml"
if [ -f "$RUNNER_CONFIG" ]; then
    ok "runner.yaml already exists"
else
    cp "$CONFIGS_DIR/runner.example.yaml" "$RUNNER_CONFIG"
    ok "created runner.yaml from example (review and edit before running)"
fi

# --- Build check ---

printf "\n=== Build verification ===\n\n"

cd "$RUNNER_DIR"
if go build -o /dev/null ./cmd/runner/ 2>/dev/null; then
    ok "go build succeeds"
else
    fail "go build failed — run 'cd runner && go build ./cmd/runner/' to see errors"
    errors=$((errors + 1))
fi

# --- Summary ---

printf "\n=== Summary ===\n\n"

if [ "$errors" -gt 0 ]; then
    fail "$errors issue(s) found — fix them before running the runner"
    exit 1
else
    ok "all checks passed"
    printf "\nNext steps:\n"
    printf "  1. Edit %s/runner.yaml (workspace_slug, board_ids)\n" "$CONFIGS_DIR"
    printf "  2. Edit %s/mcp-config.json (API key)\n" "$CONFIGS_DIR"
    printf "  3. Set VALARIS_API_KEY env var (ANTHROPIC_API_KEY only if not using Max subscription)\n"
    printf "  4. Run: cd runner && make build && ./bin/valaris-runner -config configs/runner.yaml\n"
    printf "  5. Or discovery mode: cd runner && make discover\n\n"
fi
