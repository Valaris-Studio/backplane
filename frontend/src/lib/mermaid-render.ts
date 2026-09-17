// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Mermaid render seam. Kept out of the NodeView component so the security
// boundary is unit-testable without mounting an editor.
//
// SECURITY POSTURE — all four clauses matter, do not "simplify" any of them:
//   1. `mermaid` is pinned EXACT (>= 11.15.0) in package.json: CVE-2026-41149
//      (HTML injection via classDef) and CVE-2026-41148 (CSS injection) are
//      fixed in 11.15.0. A caret range would silently allow a downgrade.
//   2. securityLevel: "strict" — mermaid runs its own DOMPurify over the SVG
//      and disables click bindings. Keep SVG sanitization inside Mermaid;
//      the HTML-only sanitizer for DOCX previews is a separate boundary.
//   3. `%%{init ...}%%` directives are stripped from stored content before
//      rendering. Without this, note content could set securityLevel:"loose"
//      itself and re-enable raw HTML — the directive outranks initialize().
//      Verified in a real browser, not assumed: rendering
//      `%%{init: {"theme":"forest"}}%%` under initialize({theme:"default"})
//      came back with forest-green node fills, i.e. the embedded directive
//      won. Stored content CAN override initialize(); this strip is the only
//      thing standing between a note author and securityLevel:"loose".
//   4. mermaid.render's `bindFunctions` callback is never invoked, so no
//      diagram-authored handler is ever attached to the DOM.

type ResolvedTheme = "light" | "dark";

interface RenderArgs {
  id: string;
  source: string;
  theme: ResolvedTheme;
}

// `%%{init: {...}}%%` (also `%%{ init : ... }%%`) anywhere in the source, not
// just line 1 — mermaid honours a directive on any line. Non-greedy up to the
// closing `}%%` so a diagram with later braces is not swallowed whole.
const INIT_DIRECTIVE_RE = /^[ \t]*%%\{\s*init\s*:[\s\S]*?\}%%[ \t]*\r?\n?/gim;

export function stripInitDirectives(source: string): string {
  return source.replace(INIT_DIRECTIVE_RE, "");
}

// React 19's useId() returns ids containing «» and : — both illegal in the
// `select('#' + id)` mermaid performs internally.
export function sanitizeRenderId(id: string): string {
  return `mermaid-${id.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

// Module-level singleton: the dynamic import resolves once per session, so the
// ~150-250 KB gz mermaid chunk is fetched only when a diagram is actually
// rendered and never lands in the entry bundle.
let mermaidModule: Promise<typeof import("mermaid")> | null = null;

function loadMermaid() {
  if (!mermaidModule) mermaidModule = import("mermaid");
  return mermaidModule;
}

export async function renderMermaid({ id, source, theme }: RenderArgs): Promise<string> {
  const mermaid = (await loadMermaid()).default;

  // initialize() is idempotent and cheap; calling it per render is what makes a
  // light/dark theme flip apply to already-mounted diagrams.
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: theme === "dark" ? "dark" : "default",
  });

  const { svg } = await mermaid.render(sanitizeRenderId(id), stripInitDirectives(source));
  return svg;
}
