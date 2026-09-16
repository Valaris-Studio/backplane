# The documentation corpus

55 sections of product documentation, rendered inside the app at `/documentation`
(slug-independent — readable before any workspace exists) and at
`/:slug/documentation` once you're in one.

## Why it lives here, and not on a website yet

**Decision (2026-07-26):** the corpus stays in this repo, as part of the app, for
now. When the Backplane website lands it becomes the source for the public docs
site — but it is *not* worth splitting into a separate repo or a static-site
generator before that site exists. Docs that ship with the code they describe
stay honest; a separate pipeline is one more thing to keep in sync, and the
in-app reader is already good.

What that costs today: the docs are not indexable by search engines and not
readable without running the app. That is the accepted trade until the website
exists.

## Structure — keep it uniform, that is the point

```
routes.ts       DOC_GROUPS (10 groups) + DOC_SECTIONS (slug, title, group, order)
sections/       one .tsx per section, named <group>-<slug>.tsx
content/        versioned shell, route, MCP chrome and section copy for en, es and pt-BR
callouts/       the closed set of content primitives (see below)
shell/          SectionPage, TocSidebar — chrome, not content
mcp-reference/  the generated MCP tool/prompt catalog (two-pane reference)
```

Every section is a component that returns a single `<SectionPage>` and composes
only these callouts:

`CodeExample` · `HonestRemark` · `Screenshot` · `ProTip` · `ImportantNote` ·
`DangerZone` · `FutureState` · `WhatThisIsNot`

**This uniformity is load-bearing.** All 55 sections use `SectionPage`, which is
what makes the corpus mechanically extractable to another renderer later. Adding
a one-off layout or a bespoke callout to a single section trades a small local win
for that extractability — don't.

## Extracting to the website, when the time comes

The shape is deliberately friendly to it:

- `routes.ts` is already the sitemap — groups, slugs, titles, ordering.
- The 53 narrative section bodies are static JSX with no data fetching, router
  dependency or workspace context. The MCP tool catalog mounts the one
  interactive, hash-addressable explorer and must be mapped separately by a
  static extractor.
- The callout set is small and closed, so each one needs exactly one mapping to
  whatever the website uses (MDX component, template partial, …).
- `Screenshot` placeholders carry their intended shot description in `props` —
  they double as a written shot list.

The likely path is a build step that walks `DOC_SECTIONS`, renders each section to
static HTML with the callouts mapped to site components, and emits a page per
slug. Nothing here needs to change first.

## Localization architecture

The English section components remain the canonical layout and technical
contract. Localized narrative lives in versioned dictionaries under
`content/sections/<locale>/<group>.ts`, keyed by the exact English source
fragment and scoped by section slug. `SectionPage` applies those dictionaries
while rendering the canonical component.

This boundary is deliberate:

- prose, headings, callout titles, screenshot descriptions and captions are
  localizable;
- `<code>`, `<pre>`, commands, tool names, parameter names, JSON, YAML, routes,
  URLs, enums and heading anchor IDs remain byte-stable;
- the MCP reference keeps one shared catalog for tool ids, parameter names,
  enum values and example prompt code blocks. Its Backplane-authored
  descriptions, gotchas and other narrative are translated by the owning
  section dictionary, including content rendered only after a selection;
- locale packs are committed and bundled with the frontend. There is no runtime
  translation service or external availability dependency.

`technical-contract.ts` defines the executable invariant across all 55 routes:
heading anchor ids, code blocks, inline code, links and explicitly marked
technical tokens must compare byte-for-byte. The locale contract requires the
same 10 groups and 55 slugs in every supported language, an explicit dictionary
registration per slug and no missing narrative. Runtime fallback to the English
source is explicit and visible for compatibility, but the release gate requires
55 of 55 translated sections and zero fallbacks in both `es` and `pt-BR`.

## Safe translation matrix

Each row and locale is a separate file ownership boundary. Agents can work in
parallel as long as no two agents edit the same file.

| Group file | Sections | Spanish path | Brazilian Portuguese path |
|---|---:|---|---|
| `introduction.ts` | 3 | `content/sections/es/introduction.ts` | `content/sections/pt-BR/introduction.ts` |
| `core-concepts.ts` | 8 | `content/sections/es/core-concepts.ts` | `content/sections/pt-BR/core-concepts.ts` |
| `installing.ts` | 4 | `content/sections/es/installing.ts` | `content/sections/pt-BR/installing.ts` |
| `getting-started.ts` | 6 | `content/sections/es/getting-started.ts` | `content/sections/pt-BR/getting-started.ts` |
| `configuration.ts` | 7 | `content/sections/es/configuration.ts` | `content/sections/pt-BR/configuration.ts` |
| `operating.ts` | 6 | `content/sections/es/operating.ts` | `content/sections/pt-BR/operating.ts` |
| `under-the-hood.ts` | 6 | `content/sections/es/under-the-hood.ts` | `content/sections/pt-BR/under-the-hood.ts` |
| `extending.ts` | 4 | `content/sections/es/extending.ts` | `content/sections/pt-BR/extending.ts` |
| `reference.ts` | 7 | `content/sections/es/reference.ts` | `content/sections/pt-BR/reference.ts` |
| `honest-remarks.ts` | 4 | `content/sections/es/honest-remarks.ts` | `content/sections/pt-BR/honest-remarks.ts` |

For every slug, translate every key returned by
`getMissingDocumentationStrings(locale, slug)`. Never add commands or technical
values to a locale dictionary. If a technical value needs to change, update the
single English source contract and its parity test first.

The `mcp-tool-catalog` slug intentionally returns the lazy explorer narrative as
well as the section header. It is a larger translation unit, but its technical
catalog is still shared and immutable. Static explorer controls such as search,
filter and copy labels live in the locale-level `mcpReference` copy object rather
than being repeated in section dictionaries.

Before merging a source-copy change:

1. Run the locale contract and use its per-slug missing counts as the work list.
2. Fill both locale dictionaries with exact English keys and translated values.
3. Run the 55-route technical parity test; do not update its expected technical
   bytes to accommodate a translation.
4. Run the localized UI and MCP boundary tests.
5. Merge only with `translated: 55` and `fallback: 0` for both translated
   locales, Spanish (`es`) and Brazilian Portuguese (`pt-BR`).

## Conventions

- **Claims must be true of the code as committed.** If a section describes a flag,
  endpoint, or header, verify it before writing. Documentation that describes an
  intended design rather than the shipped one is how the webhooks page ended up
  telling integrators to look for headers that never existed (fixed 2026-07-26).
- Deployment-neutral voice: the reader operates their own instance. Platform
  specifics (Cloud Run, GCP) belong in explicitly-labelled examples, never as the
  only path.

## Agent-readable artifact

Run `pnpm docs:export` in `frontend/` after changing the corpus. The exporter
renders every registered section and locale, then includes every MCP explorer
detail (tools, prompts and resources). It preserves technical content as Markdown,
including heading anchors, code, links, callout variants and tables. The committed
`backend/app/data/product-documentation.json` is copied by the backend Docker
build and retained by the public export. `pnpm docs:check`, run by the frontend local/CI verification gates, rejects a stale artifact. Regenerate the MCP catalog **before** this artifact when
the MCP surface changes.

Authenticated clients can list `/api/documentation?locale=en&offset=0&limit=20`
and read `/api/documentation/{slug}?locale=en&version={version}&offset=0&limit=12000`.
The index has at most 100 entries per response; reads have at most 30000 characters.
Follow `next_offset` until null. The SHA-256 content version identifies the entire
locale corpus. Pin it when continuing reads; a changed version returns 409 rather
than mixing revisions. Unknown locales return 422; each section exposes its
translation `status`, `source_locale` and `content_locale`, including explicit
English fallback where applicable.

`list_documentation` and `read_documentation` use these endpoints on the connected
platform. They obey MCP toolsets and allowlists and never use a bundled fallback.
The service grants authenticated identities access only to the immutable product
artifact; it queries no workspace data. The UI's standalone `/documentation`
routes remain readable before first-run setup.
