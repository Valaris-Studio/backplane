// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Twin of backend tests/services/notes/test_media_url_safety.py: an image or
// attachment src is only ever a root-relative app path or an http(s) URL. The
// attachment view hands src to window.open for every viewer, so the client
// re-checks even though the backend already refuses anything else on save.
import { describe, expect, it } from "vitest";
import { isSafeMediaUrl } from "@/lib/media-src";

const UNSAFE_MEDIA_URLS: Array<[string, string]> = [
  ["javascript", "javascript:alert(1)"],
  ["javascript-mixed-case", "JavaScript:alert(1)"],
  ["leading-space", " javascript:alert(1)"],
  ["leading-tab", "\tjavascript:alert(1)"],
  ["tab-inside-scheme", "java\tscript:alert(1)"],
  ["newline-inside-scheme", "java\nscript:alert(1)"],
  ["leading-nul", "\u0000javascript:alert(1)"],
  ["entity-in-scheme-literal", "java&#x73;cript:alert(1)"],
  ["vbscript", "vbscript:msgbox(1)"],
  ["data-html", "data:text/html,<script>alert(1)</script>"],
  ["data-image", "data:image/svg+xml;base64,PHN2Zz4="],
  ["file", "file:///etc/passwd"],
  ["protocol-relative", "//evil.example/x.png"],
  ["slash-backslash", "/\\evil.example/x.png"],
  ["slash-tab-slash", "/\t/evil.example/x.png"],
  ["backslashes", "\\\\evil.example\\x.png"],
  ["https-without-slashes", "https:evil.example"],
  ["blob", "blob:https://app/1"],
  ["bare-relative", "shot.png"],
  ["empty", ""],
];

const SAFE_MEDIA_URLS: Array<[string, string]> = [
  ["stable-resource", "/api/workspaces/acme/resources/44444444-4444-4444-8444-444444444444/content"],
  ["stable-media", "/api/workspaces/acme/media/33333333-3333-4333-8333-333333333333/a%20b.png"],
  ["https", "https://example.com/cat.png"],
  ["http-upper", "HTTP://example.com/cat.png"],
  ["legacy-signed", "https://storage.googleapis.com/b/k.png?X-Goog-Signature=abc&X-Goog-Expires=3600"],
];

describe("isSafeMediaUrl", () => {
  it.each(UNSAFE_MEDIA_URLS)("refuses %s", (_name, url) => {
    expect(isSafeMediaUrl(url)).toBe(false);
  });

  it.each(SAFE_MEDIA_URLS)("accepts %s", (_name, url) => {
    expect(isSafeMediaUrl(url)).toBe(true);
  });

  it("refuses non-strings", () => {
    expect(isSafeMediaUrl(null)).toBe(false);
    expect(isSafeMediaUrl(undefined)).toBe(false);
  });
});
