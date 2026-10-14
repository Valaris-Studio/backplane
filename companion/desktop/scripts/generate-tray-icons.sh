#!/usr/bin/env bash
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

# Rasterises the DK-0 tray glyphs into macOS template PNGs (black on
# transparent) at 1x (18 px) and 2x (36 px), then derives the opaque
# variants Windows and Linux need, since only macOS recolours a template
# glyph for the menu bar: <state>-light.png is drawn for a light panel
# (dark glyph), <state>-dark.png for a dark panel (light glyph).
# Re-run after the SVGs change; the PNGs are committed so builds never
# depend on this machine's tooling.
set -euo pipefail

source_dir="${1:?usage: generate-tray-icons.sh <dir with tray-*.svg>}"
output_dir="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/icons/tray"
states=(capturing paused attention offline disconnected)
# Near-black and near-white, like the popover's foreground in each theme.
glyph_on_light_panel="#1e2820"
glyph_on_dark_panel="#f2f6f2"

command -v sips >/dev/null || { echo "sips (macOS) is required" >&2; exit 1; }
python3 -c "import PIL" 2>/dev/null || { echo "python3 with Pillow is required for the light/dark variants" >&2; exit 1; }
mkdir -p "$output_dir"
for state in "${states[@]}"; do
  svg="$source_dir/tray-$state.svg"
  [[ -f "$svg" ]] || { echo "missing $svg" >&2; exit 1; }
  sips -s format png -z 18 18 "$svg" --out "$output_dir/$state.png" >/dev/null
  sips -s format png -z 36 36 "$svg" --out "$output_dir/$state@2x.png" >/dev/null
done

# Keeps each template's alpha (its antialiasing) and replaces the colour.
python3 - "$output_dir" "$glyph_on_light_panel" "$glyph_on_dark_panel" "${states[@]}" <<'PY'
import sys
from pathlib import Path
from PIL import Image

output_dir, on_light, on_dark, *states = sys.argv[1:]
for state in states:
    for scale in ("", "@2x"):
        template = Image.open(Path(output_dir, f"{state}{scale}.png")).convert("RGBA")
        alpha = template.getchannel("A")
        for panel, colour in (("light", on_light), ("dark", on_dark)):
            variant = Image.new("RGBA", template.size, colour)
            variant.putalpha(alpha)
            variant.save(Path(output_dir, f"{state}-{panel}{scale}.png"))
PY
echo "wrote ${#states[@]} states x 2 scales x 3 variants to $output_dir"
