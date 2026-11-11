#!/bin/sh
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

set -eu

if [ "$(id -u)" -eq 0 ]; then
    echo "Runner container smoke must execute as its nonroot runtime user" >&2
    exit 1
fi

if [ "$#" -eq 0 ]; then
    set -- claude
fi
for agent in "$@"; do
    case "$agent" in
        claude|codex) ;;
        *) echo "Unsupported coding agent for this container smoke: $agent" >&2; exit 1 ;;
    esac
done

echo "Node runtime:"
timeout 15s node --version
echo "npm runtime:"
timeout 15s npm --version

for agent in "$@"; do
    printf '%s runtime:\n' "$agent"
    timeout 30s "$agent" --version
done
