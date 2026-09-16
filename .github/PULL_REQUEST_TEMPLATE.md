<!--
⚠️ NOT ACCEPTING OUTSIDE CONTRIBUTIONS

Backplane is maintained solely by the Valaris team, and pull requests from
outside the team are closed unreviewed. This is not a judgement on your work —
we have no contributor agreement in place yet. Please open an issue instead;
bug reports are genuinely more useful to us right now than patches.
See CONTRIBUTING.md for the full policy and when we expect it to change.

Maintainers: keep it focused on one concern. See CONTRIBUTING.md for the
layering rules and the test-first expectation.
-->

## What and why

<!-- What does this change, and what problem does it solve? Link the issue. -->

Closes #

## How it was tested

<!--
Which test would have failed before this change? Name it.
Behavior changes need a test that covers them — see CONTRIBUTING.md.
-->

## Checklist

- [ ] A test covers the new behavior (or this is a docs/refactor-only change)
- [ ] The full relevant suite passes locally (`make test`, `pnpm test`, `make mcp-test`, `make runner-test`)
- [ ] Linters pass (`ruff check app/`, `pnpm lint`, `go vet ./...`)
- [ ] No secrets, real credentials, or internal hostnames added (`scripts/scan-secrets.sh`)
- [ ] Backend changes respect Router → Service → Repository → Model layering
- [ ] Any new migration is rolling-deploy safe (nullable / `server_default`; no renames)
- [ ] User-facing strings go through i18n with equivalent entries in every locale registered by `frontend/src/i18n/supported-languages.ts` (currently `en`, `es`, and `pt-BR`)
