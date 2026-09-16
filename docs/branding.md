# Branding & naming policy

Adopted 2026-07-23. This is the living reference for what things are called;
follow it in code, docs, UI copy, and release material.

## The three names

| Name | What it is | Usage |
| --- | --- | --- |
| **Backplane** | The platform: backend, frontend, MCP server, docs — the product as a whole | Display name `Backplane`, slug `backplane`. All user-facing branding, package/app titles, product descriptions. |
| **runner** | The autonomous runner — the Go program under `runner/` that works kanban cards | Renamed from "intern" 2026-07-25 (open-source prep): binary `backplane-runner`, module `github.com/Valaris-Studio/backplane/runner`, `cmd/backplane-runner`, `RUNNER_*` env vars, `runner.yaml` configs, generated `runner-<name>.yaml` bundles, git branch prefix `runner/`. Refer to it as "the runner" or "the Backplane runner". |
| **Valaris** | The company/studio | Domains (`valaris.studio`), workspace names, the MCP server key `valaris`, cloud resources. Not a product name. |

Rules of thumb:

- Naming the product? → Backplane. Naming the process that executes cards? →
  the runner. Attributing ownership? → Valaris.
- Plain-English "internal" (internal server error, Go `runner/internal/`
  package layout) is not a brand mention — leave it alone.
- Historical documents (`docs/archive/`, `docs/runbooks/`, `docs/reports/`,
  `docs/research/`, dated filenames, per-run configs under `runner/configs/`)
  are records — they keep whatever name was current when written.
- Persisted data, migrations, and API wire formats never change for branding.

## Logo & assets

Source artwork lives in `brand/source/` (green origami plane, light/dark
variants). All derived assets are generated, not hand-made:

```
pnpm brand:assets   # regenerates frontend/public/brand/* from brand/source/*
```

Outputs: `favicon-{16,32,48}.png`, `favicon.ico`, `apple-touch-icon.png`,
`icon-{192,512}.png`, `icon-maskable-{192,512}.png`, `logo-{light,dark}.{png,webp}`,
`og-image.png`, `brand.json` (dominant color → PWA `theme_color`).

Frontend usage: `frontend/src/components/brand/BrandLogo.tsx` renders the
logo — the light variant on both themes (decided 2026-07-23: the dark
variant's heavy shadow reads worse; dark assets are still generated and kept
as sources). `frontend/index.html` + `frontend/public/manifest.webmanifest`
carry favicon/PWA wiring. Never reference `brand/source/` from app code.

## Infra cutover checklist (deliberately NOT done locally)

The rebrand ships in code first; live infrastructure still answers to the old
names. When we decide to cut over (separate, coordinated change):

- [ ] Domain: legacy internal domain → new Backplane domain (DNS + IAP +
      OAuth consent screen display name + `VITE_API_URL` in `cloudbuild.yaml`)
- [ ] Cloud Run service names (`valaris-frontend`, `valaris-frontend-backend`,
      …) — renaming creates *new* services; plan traffic + IAP bindings
- [ ] `cloudbuild.yaml` substitutions / image names / triggers
- [ ] `infra/setup.sh` provisioning values
- [ ] GCS buckets and `gcs_path` values (persisted — likely never rename)
- [ ] Runner deploy scripts and `runner/configs/mcp-config-prod.json` URLs
- [ ] GitHub repos → consolidate on `Valaris-Studio/backplane`
      (referenced by the uvx install command in `PlatformSettingsPage.tsx`,
      the getting-started docs section, `docs/platform-source-of-truth.md`,
      and the `--repo-name` values in `infra/setup.sh` trigger commands)
- [x] The live "Valaris Intern" board in `internal-projects` — DONE
      2026-07-23: board renamed to "Backplane" (board slug
      unchanged), doc references updated
- [x] MCP package name — DONE 2026-07-30 (pre-PyPI-publish, card fc69c832):
      distribution + primary console script renamed to `backplane-mcp`;
      `valaris-mcp` kept as an alias entry point so dev flows and existing
      configs keep working. The FastMCP server name "Valaris", the
      `valaris_mcp` module, and the `valaris` server key are unchanged
      (permanent namespace, below).
- [ ] External references: board definitions, workspace notes, webhook URLs

Deliberately permanent — **decided 2026-07-24 (open-source prep)**: `valaris`
is the stable *technical namespace* of the platform (like `chromium` inside
Chrome); Backplane is the product name. This covers `mcp__valaris__*` tool
ids, `valaris://` resource URIs, `VALARIS_*` env vars, the `valaris-mcp`
console-script alias (the PyPI distribution itself is product-branded
`backplane-mcp` since 2026-07-30), and persisted client values
(`valaris-browser-notifications-enabled` localStorage key, DB names, the
`internal-projects` workspace slug). These are wire/persisted identifiers
load-bearing in stored pipeline allowlists, workspace configs, and runner
`--allowedTools` — public docs present the namespace as stable, and any
future rename is its own coordinated migration with compat aliases, never a
sweep.

Until then, live-infra values in the repo intentionally keep the old names.
