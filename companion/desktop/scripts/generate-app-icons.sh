#!/usr/bin/env bash
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

# Derives the Companion's bundle icons from src-tauri/icons/app-icon-source.png,
# which `pnpm brand:assets` (scripts/brand/generate-assets.mjs) renders from
# brand/source/. `tauri icon` also emits Android/iOS/Windows-Store logos the
# desktop bundle never references, so it runs into a scratch directory and only
# the files tauri.conf.json lists (plus icon.png) are copied back.
set -euo pipefail

desktop_dir="$(cd "$(dirname "$0")/.." && pwd)"
icons_dir="$desktop_dir/src-tauri/icons"
bundle_icons=(32x32.png 128x128.png 128x128@2x.png icon.png icon.icns icon.ico)

scratch="$(mktemp -d)"
trap 'find "$scratch" -delete' EXIT

(cd "$desktop_dir" && pnpm tauri icon "$icons_dir/app-icon-source.png" -o "$scratch" >/dev/null)
for icon in "${bundle_icons[@]}"; do
  cp "$scratch/$icon" "$icons_dir/$icon"
done
echo "wrote ${#bundle_icons[@]} bundle icons to $icons_dir"
