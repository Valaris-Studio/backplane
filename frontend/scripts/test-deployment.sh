#!/usr/bin/env bash
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
frontend_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
gate_image="backplane-deployment-gate:$$"
trap 'docker image rm "$gate_image" >/dev/null 2>&1 || true' EXIT
docker build -t "$gate_image" "$frontend_root"
node "$frontend_root/tests/deployment-browser.mjs" "$gate_image"
