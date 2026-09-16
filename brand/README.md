# Backplane brand sources

Canonical logo artwork. Everything logo-derived in the repo (favicons, PWA
icons, apple-touch icon, OG card, UI logos) is generated from these four
files — never hand-edit the generated copies in `frontend/public/brand/`.

| File | Use |
| --- | --- |
| `source/light_transparent.webp` | Light UIs, alpha background |
| `source/light_whitebg.webp` | Light social/solid surfaces |
| `source/dark_transparent.webp` | Dark UIs, alpha background |
| `source/dark_blackbg.webp` | Dark social/solid surfaces |

Requirements: 1:1 square, ≥1024px, matching filenames. Shadows may be baked
in — the generator trims the halo aggressively for small icons.

## Rebranding / updating the logo

1. Replace the four files in `source/` (same names).
2. From the repo root: `pnpm install && pnpm brand:assets`
3. Commit `brand/source/` and `frontend/public/brand/` together.

The generator (`scripts/brand/generate-assets.mjs`) also refreshes
`frontend/public/brand/brand.json` with the dominant brand color used as the
PWA `theme_color` — update `frontend/public/manifest.webmanifest` if it
changes materially.

See `docs/branding.md` for the naming policy (platform vs runner vs company).
