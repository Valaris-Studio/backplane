#!/bin/bash
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

set -e

# Create a non-root user with the same UID as the host user (from mounted volumes).
# Claude CLI refuses --dangerously-skip-permissions as root.
RUNNER_UID="${RUNNER_UID:-1000}"
groupadd -g "$RUNNER_UID" runner 2>/dev/null || true
useradd -u "$RUNNER_UID" -g "$RUNNER_UID" -m -s /bin/bash runner 2>/dev/null || true

# Ensure writable directories
chown -R runner:runner /app/bin 2>/dev/null || mkdir -p /app/bin && chown runner:runner /app/bin
chown -R runner:runner /repos 2>/dev/null || true
chown -R runner:runner /etc/backplane 2>/dev/null || true

# Copy host .claude.json to runner's home (don't bind-mount — concurrent writes corrupt it).
if [ -f /host-claude-json ]; then
    cp /host-claude-json /home/runner/.claude.json
    chown runner:runner /home/runner/.claude.json
fi

# Ensure all caches/data dirs are writable: Go, uv (Python), npm, local
export GOPATH="/home/runner/go"
export GOCACHE="/home/runner/.cache/go-build"
mkdir -p "$GOPATH" "$GOCACHE" \
    /home/runner/.cache/uv \
    /home/runner/.local/share/uv \
    /home/runner/.npm
chown -R runner:runner /home/runner/.cache /home/runner/.local /home/runner/.npm "$GOPATH"

# Git identity and GitHub auth for commits/push
chown runner:runner /home/runner
gosu runner git config --global user.email "runner@valaris.studio"
gosu runner git config --global user.name "Backplane"
if [ -n "${GH_TOKEN:-}" ]; then
    gosu runner git config --global credential.helper "!f() { echo username=x-access-token; echo password=${GH_TOKEN}; }; f"
fi

# Execute as non-root user
exec gosu runner "$@"
