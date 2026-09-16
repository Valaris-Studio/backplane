# Frontend Agent Instructions

## Project Overview
Internal tooling platform for Valaris software factory. React 19 + TypeScript + Vite 6 + Tailwind v4 (CSS-first).

## Critical Technical Context

### Tailwind v4 — CSS-First Config
This project uses Tailwind v4 with NO `tailwind.config.js`. All theme tokens live in `src/index.css` inside a `@theme { }` block using oklch colors. When adding theme values, add them to the `@theme` block — never create a tailwind config file.

### shadcn/ui — Hand-Written
Components in `src/components/ui/` are manually written (not installed via shadcn CLI). They do NOT use Radix UI or any headless library. They use plain React + Tailwind + the `cn()` utility from `@/lib/utils`. Do not introduce Radix dependencies.

### Path Alias
`@/` maps to `src/`. Use this alias in all imports.

### i18n
All user-facing strings use `react-i18next`. The supported locales are defined once in `src/i18n/supported-languages.ts`; their catalogs live in `src/i18n/locales/en.json`, `es.json`, and `pt-BR.json`. Do not hardcode user-facing strings in JSX; use `t("key")`. If you add new product copy, add equivalent keys to every supported locale and preserve technical identifiers exactly.

## Commands
- Build check: `npx tsc --noEmit && npx vite build`
- Dev server: `pnpm dev`
- Lint: `pnpm lint`
- Install deps: `pnpm add <package>` (run from `frontend/` directory)

## Code Style
- The code IS the documentation. No docstrings, no obvious comments.
- Only comment non-obvious patterns (GSAP timelines, CSS hacks, regex).
- Use semantic variable/function names that convey intent.
- Use `cn()` for conditional Tailwind classes.
- Prefer Tailwind utilities over custom CSS.

## File Organization
- UI primitives: `src/components/ui/`
- Layout shells: `src/components/layout/`
- Feature modules: `src/features/{name}/components/`
- Pages: `src/pages/`
- Shared hooks: `src/hooks/`
- Shared utilities: `src/lib/`
