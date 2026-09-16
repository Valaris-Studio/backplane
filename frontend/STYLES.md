# Backplane Frontend Styles

All tokens live in the `@theme` block of `src/index.css` — that file is the source of truth; this page describes the scale. The palette is an oklch green ramp centered on hue ~145 (the pre-rebrand `#00B1B9` teal is gone).

## Color Palette

### Brand scale
| Token | Oklch | Use |
| --- | --- | --- |
| `brand-50` | `oklch(0.98 0.02 145)` | washed backgrounds, soft tints |
| `brand-100` | `oklch(0.95 0.04 145)` | hover fills, soft highlights |
| `brand-200` | `oklch(0.88 0.08 145)` | hero gradients, info surfaces |
| `brand-300` | `oklch(0.80 0.13 144)` | elevated accents |
| `brand-400` | `oklch(0.72 0.17 143)` | active decoration |
| `brand-500` | `oklch(0.85 0.29 142)` | signature luminous green — accents, sidebar highlights |
| `brand-600` | `oklch(0.52 0.16 145)` | primary actions (light-mode `primary`/`ring`) |
| `brand-700` | `oklch(0.35 0.09 147)` | active nav, focused states |
| `brand-800` | `oklch(0.28 0.06 148)` | deep accents |
| `brand-900` | `oklch(0.22 0.01 145)` | dark text on brand surfaces, shadow tint |
| `brand-950` | `oklch(0.15 0.005 145)` | darkest anchors |

Note the ramp is not monotonic in lightness: `brand-500` is the vivid high-chroma accent (brighter than 400/600); `brand-600` carries the "primary action" role that 500 holds in a conventional scale.

### Semantic colors
Each status color pairs with a `-foreground` token; dark mode lifts the foregrounds to luminous values (see the `[data-theme="dark"]` block).

| Token | Oklch | Use |
| --- | --- | --- |
| `success` | `oklch(0.7 0.149 154.9)` | success badges, positive status |
| `warning` | `oklch(0.812 0.149 82.6)` | medium priority, caution UI |
| `error` | `oklch(0.638 0.218 27.7)` | destructive actions, urgent priority (aliased as `destructive`) |
| `info` | `oklch(0.707 0.136 232.1)` | info badges, external-link context |

### Light surfaces
| Token | Oklch | Use |
| --- | --- | --- |
| `background` | `oklch(0.985 0.008 145)` | app canvas |
| `surface-1` | `oklch(0.978 0.007 145)` | headers, floating panels |
| `surface-2` | `oklch(0.965 0.009 145)` | section fills |
| `surface-3` | `oklch(0.943 0.013 145)` | nested controls |
| `foreground` | `oklch(0.236 0.026 145)` | primary text |

### Dark surfaces
| Token | Oklch | Use |
| --- | --- | --- |
| `background` | `oklch(0.166 0.018 148)` | app canvas |
| `surface-1` | `oklch(0.192 0.019 148)` | headers, floating panels |
| `surface-2` | `oklch(0.216 0.019 148)` | section fills |
| `surface-3` | `oklch(0.252 0.023 148)` | nested controls |
| `foreground` | `oklch(0.94 0.011 145)` | primary text |

The sidebar has its own token family (`sidebar-background`, `sidebar-primary`, …) — dark-tinted in both modes, with `brand-500` as its highlight.

### Chart/data colors
| Token | Oklch |
| --- | --- |
| `data-1` | `oklch(0.686 0.148 145)` |
| `data-2` | `oklch(0.748 0.156 161.2)` |
| `data-3` | `oklch(0.79 0.17 86.8)` |
| `data-4` | `oklch(0.652 0.19 19.8)` |
| `data-5` | `oklch(0.694 0.173 300.4)` |
| `data-6` | `oklch(0.726 0.153 255.6)` |
| `data-7` | `oklch(0.77 0.128 38.8)` |
| `data-8` | `oklch(0.62 0.124 134.6)` |

Guidelines:
- Use `primary`/brand for intent, not decoration.
- Prefer `surface-1` to `card` for layout containers and `card` for interactive modules.
- Keep status meaning semantic: never swap `success`, `warning`, `error`, `info`.

## Typography
- Headings: `Space Grotesk` (`--font-display`), weight `700`, tracking tightened in base styles.
- Body/UI: `Manrope` (`--font-sans`), weights `400-800`.
- Code/mono: `--font-mono` — the system mono stack (`ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`). No mono webfont is loaded; use `font-mono` or `var(--font-mono)` instead of hardcoding a stack.
- Scale: use Tailwind utilities directly. Typical pairings are `text-4xl`/`text-5xl` for hero titles, `text-3xl` for page titles, `text-xl` for card titles, `text-sm` or `text-base` for body copy, `text-xs` for meta labels.

## Spacing
- Global gutters live in CSS variables inside `src/index.css`.
- `--page-gutter`: outer shell padding.
- `--page-shell-max`: max readable width for routed content.
- `--page-section-gap`: vertical rhythm between page sections.
- `--card-padding`: default internal card/dialog padding.

Guidelines:
- Use `gap-[var(--page-section-gap)]` between major sections.
- Use `p-[var(--card-padding)]` inside cards and editors.
- Keep dense list rows at `py-4`; most action areas should stay at least `44px` tall.

## Animation
- Library: `gsap`.
- Motion gate: `src/hooks/use-reduced-motion.ts`.
- Presets live in `src/lib/animations.ts`.

Presets:
- `fadeInUp(targets, options)`: general route and list entrance.
- `slideIn(targets, options)`: horizontal or vertical entrance for shell pieces and kanban columns.
- `scaleIn(targets, options)`: cards, stats, dialogs, quick actions.
- `staggerChildren(container, selector, effect, options)`: batch reveal helper for grids and timelines.

Usage:
```ts
const tween = staggerChildren(ref.current, "[data-stagger-item]", scaleIn, {
  stagger: 0.05,
  duration: 0.2,
});
return () => tween?.kill();
```

## Component Patterns
- Page headers: use `PageHeader` for title, subtitle, and primary actions. Set `compact` inside nested board tabs.
- Empty states: use `EmptyState` with one icon, one title, one clear CTA.
- Cards: default to bordered, elevated surfaces with subtle motion on hover.
- List rows: use group hover, keep secondary actions hidden until hover/focus, keep metadata in uppercase microcopy.
- Forms: label-above pattern, section spacing `space-y-5`, footer actions separated by a top border.

## Dark Mode
- Theme state is managed by `ThemeProvider` in `src/hooks/use-theme.tsx`.
- Default mode is `system`; explicit `light`/`dark` values are stored in `localStorage` under `valaris-theme`.
- The active theme sets `data-theme` on `document.documentElement`; `src/index.css` overrides semantic tokens for `[data-theme="dark"]` and `@media (prefers-color-scheme: dark)`.
- Theme switching UI lives in `src/components/ThemeSwitcher.tsx`.

## Adding New Components
- Pull colors from semantic tokens first: `background`, `card`, `surface-*`, `primary`, `muted`, `border`.
- Use `buttonVariants`, `Card`, `Badge`, and `PageHeader` instead of restyling from scratch.
- Apply one motion preset on mount unless the component is always-visible chrome.
- Respect reduced motion by checking `useReducedMotion()` or relying on helpers in `src/lib/animations.ts`.
- Keep focus-visible rings on every interactive element.

## Asset Replacement
- Full logo: `src/assets/logo.svg`
- Icon mark: `src/assets/logo-icon.svg`
- Favicon: `public/favicon.svg`

Replace the SVG files directly. Search for `BRAND: Replace logo` to find the live usage points.
