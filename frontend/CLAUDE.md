# Frontend — Quick Reference

```bash
pnpm dev        # dev server at localhost:5173
pnpm build      # typecheck + production build
pnpm lint       # eslint
pnpm test       # vitest
pnpm test:e2e   # Playwright console-clean acceptance gate (needs `make dev` stack up)
```

## E2E acceptance gate

`pnpm test:e2e` runs the browser-level "console must be clean" gate in `e2e/`.
It assumes a **running** stack (`make dev` — frontend 5173, backend 8000) and
starts no server of its own; point it elsewhere with `BACKPLANE_E2E_BASE_URL`.
It walks the workspace/board lifecycle (create workspace → welcome modal →
create board → freeze/unfreeze → delete board → delete workspace) and fails on
any console error outside the by-design allowlist in `e2e/console-collector.ts`.
Each allowlist entry names the finding it pins — adding one is a product
decision, not a test fix. `console-clean.selftest.spec.ts` is the positive
control proving the detector can still go red.

## Key Conventions

- **Tailwind v4**: CSS-first config. No `tailwind.config` file.
- **shadcn/ui**: Components in `src/components/ui/` (manually written).
- **React Query**: ALL server state. Query keys in `src/lib/query-keys.ts`.
- **i18n**: `useTranslation()` for all user-facing strings. The locale registry is `src/i18n/supported-languages.ts`; catalogs are `src/i18n/locales/{en,es,pt-BR}.json`. Add equivalent keys to every supported locale and preserve technical identifiers exactly. The selected locale persists under the localStorage key **`i18n-lang`** — *not* i18next's default `i18nextLng`, which nothing reads or writes. Written by `src/components/LanguageSwitcher.tsx`, read at boot by `src/i18n/config.ts`. Anyone automating the UI or debugging a stuck locale should set that key; do not rename it (it is stored user state on live browsers).
- **Feature modules**: `src/features/{name}/` with api/, components/, hooks/, utils/.
- **pnpm lockfile**: Committed standalone here (`frontend/pnpm-lock.yaml`), used frozen by both Docker builds; the monorepo root has its own separate lockfile for native/root-workspace installs. Refresh this one with `pnpm install --lockfile-only` when deps change.
