// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export function pageErrorReport(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const asset = message.match(/\/assets\/[A-Za-z0-9_.-]+/)?.[0] ?? null;
  const entry = Array.from(document.scripts).map((script) => script.src)
    .find((src) => /\/assets\/index-[\w-]+\.js/.test(src));
  return {
    kind: /dynamically imported module|Importing a module script failed|Loading chunk|preload.*CSS/i.test(message) ? "module-load" : "render",
    name: error instanceof Error ? error.name : "Error",
    message: message.replace(/https?:\/\/[^\s)]+/g, (url) => {
      try { const parsed = new URL(url); return parsed.origin + parsed.pathname; }
      catch { return "[invalid URL]"; }
    }).slice(0, 1000),
    asset,
    entry: entry ? new URL(entry).pathname : null,
    path: window.location.pathname,
    online: navigator.onLine,
    occurredAt: new Date().toISOString(),
  };
}

export type PageErrorReport = ReturnType<typeof pageErrorReport>;
