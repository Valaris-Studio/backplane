// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Paste/drop decision + scrub rules for the shared rich text editor.
// Word and Google Docs put a PNG rendition on the clipboard alongside the real
// text/html; these rules make the html win unless it is genuinely just an image.

// Structural elements that may surround a pasted screenshot's <img> without
// making the html "real content" (browsers wrap lone images in html/body/p).
const LONE_IMG_WRAPPERS = new Set(["HTML", "BODY", "P", "DIV"]);

function isLoneImgHtml(html: string): boolean {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  if (body.querySelectorAll("img").length !== 1) return false;
  if ((body.textContent ?? "").trim() !== "") return false;
  for (const el of Array.from(body.querySelectorAll("*"))) {
    if (el.tagName !== "IMG" && !LONE_IMG_WRAPPERS.has(el.tagName)) return false;
  }
  return true;
}

export function htmlWinsClipboard(data: Pick<DataTransfer, "types" | "getData">): boolean {
  if (!data.types.includes("text/html")) return false;
  // A lone <img> rendition still falls through to the image-upload path.
  return !isLoneImgHtml(data.getData("text/html"));
}

// Conditional-comment blocks are stripped with regex BEFORE any DOM work:
// comments are invisible to querySelector, and the downlevel-hidden payload
// lives entirely inside one comment node.
const DOWNLEVEL_HIDDEN_BLOCK = /<!--\[if[\s\S]*?<!\[endif\]-->/gi;
// Downlevel-revealed markers come as a comment PAIR with live content between
// them (Word's fake list numbers) — the content between the pair goes too.
const DOWNLEVEL_REVEALED_PAIR = /<!--\[if[^\]]*\]-->[\s\S]*?<!--\[endif\]-->/gi;
const OFFICE_NAMESPACE_TAG = /<\/?o:p[^>]*>/gi;
const STYLE_ATTR = /style=(["'])(.*?)\1/gi;

const GUID_WRAPPER_SELECTOR =
  'b[id^="docs-internal-guid"], span[id^="docs-internal-guid"]';

function unwrapDocsGuidWrappers(html: string): string {
  // Gated on the guid marker so clean input never takes a parse/serialize
  // round-trip — cleanPastedHtml must be byte-identical on clean html.
  if (!html.includes("docs-internal-guid")) return html;
  const body = new DOMParser().parseFromString(html, "text/html").body;
  for (const wrapper of Array.from(body.querySelectorAll(GUID_WRAPPER_SELECTOR))) {
    if (/font-weight:\s*normal/i.test(wrapper.getAttribute("style") ?? "")) {
      wrapper.replaceWith(...wrapper.childNodes);
    }
  }
  return body.innerHTML;
}

function stripMsoDeclarations(html: string): string {
  return html.replace(STYLE_ATTR, (attr, quote: string, css: string) => {
    if (!/mso-/i.test(css)) return attr;
    const kept = css
      .split(";")
      .map((decl) => decl.trim())
      .filter((decl) => decl && !/^mso-/i.test(decl));
    return kept.length ? `style=${quote}${kept.join("; ")}${quote}` : "";
  });
}

export function cleanPastedHtml(html: string): string {
  const uncommented = html
    .replace(DOWNLEVEL_HIDDEN_BLOCK, "")
    .replace(DOWNLEVEL_REVEALED_PAIR, "")
    .replace(OFFICE_NAMESPACE_TAG, "");
  return stripMsoDeclarations(unwrapDocsGuidWrappers(uncommented));
}
