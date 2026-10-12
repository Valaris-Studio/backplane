// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { api } from "@/lib/api";

// Stored rich text references media by the backend's RELATIVE stable path
// (`/api/workspaces/{slug}/media/{id}/{name}`, `…/resources/{id}/content`).
// These two helpers translate between that stored form and what the browser
// must request — identity unless the API lives on another origin
// (VITE_API_URL). Anything else (legacy signed URLs, foreign images) passes
// through untouched: the backend canonicaliser owns those, never the client.

const API_PATH_PREFIX = "/api/";

// The URL parser trims leading/trailing C0 controls and spaces and deletes
// every tab/CR/LF anywhere (`java\tscript:` runs as `javascript:`, `/\t/evil`
// as `//evil`), so mirror that before checking the prefix.
// eslint-disable-next-line no-control-regex
const EDGE_CONTROL_OR_SPACE_RE = /^[\u0000- ]|[\u0000- ]$/;
const TAB_OR_NEWLINE_RE = /[\t\n\r]/g;
const HTTP_URL_RE = /^https?:\/\/[^/\\]/i;

/**
 * Allowlist for an image/attachment `src`: a root-relative app path or an
 * http(s) URL — twin of backend `media_markdown.is_safe_media_url`. Stored
 * content is untrusted (hand-built ProseMirror JSON can carry anything), and an
 * attachment src is handed to `window.open`, so `javascript:`, `data:`,
 * `file:`, `blob:` and protocol-relative `//host` are all refused.
 */
export function isSafeMediaUrl(url: unknown): url is string {
  if (typeof url !== "string" || !url || EDGE_CONTROL_OR_SPACE_RE.test(url)) return false;
  const parsedAs = url.replace(TAB_OR_NEWLINE_RE, "");
  if (parsedAs.startsWith("/")) return !parsedAs.startsWith("//") && !parsedAs.startsWith("/\\");
  return HTTP_URL_RE.test(parsedAs);
}

function splitOriginApiBase(): string | null {
  const baseURL = api.defaults.baseURL ?? "";
  if (!/^https?:\/\//i.test(baseURL)) return null;
  return baseURL.replace(/\/+$/, "");
}

export function resolveMediaSrc<T extends string | null | undefined>(src: T): T {
  if (!src || !src.startsWith(API_PATH_PREFIX)) return src;
  const apiBase = splitOriginApiBase();
  if (!apiBase) return src;
  return `${apiBase}${src.slice(API_PATH_PREFIX.length - 1)}` as T;
}

export function toStoredMediaSrc<T extends string | null | undefined>(src: T): T {
  const apiBase = splitOriginApiBase();
  if (!src || !apiBase || !src.startsWith(`${apiBase}/`)) return src;
  return `/api${src.slice(apiBase.length)}` as T;
}
