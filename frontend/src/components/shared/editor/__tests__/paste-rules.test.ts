// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pins editor P0-2's pure paste rules (module does not exist yet — RED by design):
// text/html must win over Word's PNG rendition unless the HTML is just a lone <img>,
// and pasted HTML must be scrubbed of GDocs guid wrappers and Word mso-* cruft.
import { describe, it, expect } from "vitest";
import { htmlWinsClipboard, cleanPastedHtml } from "../paste-rules";

type ClipboardLike = Pick<DataTransfer, "types" | "getData">;

function clipboard(types: string[], html = ""): ClipboardLike {
  return {
    types,
    getData: (format: string) => (format === "text/html" ? html : ""),
  } as ClipboardLike;
}

// Trimmed from a real Word paste: mso-* style noise, <o:p> tags, and a
// downlevel-hidden conditional comment block.
const WORD_HTML = [
  '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">',
  "<head>",
  "<!--[if gte mso 9]><xml><w:WordDocument><w:View>Normal</w:View></w:WordDocument></xml><![endif]-->",
  "</head>",
  "<body>",
  '<p class="MsoNormal" style="mso-bidi-font-weight:normal; color:red">Quarterly report<o:p></o:p></p>',
  "</body>",
  "</html>",
].join("\n");

const GDOCS_HTML =
  '<b style="font-weight:normal;" id="docs-internal-guid-abc123">' +
  '<p dir="ltr"><span style="font-size:11pt;">Hello from Docs</span></p>' +
  '<p dir="ltr"><span style="font-size:11pt;">Second paragraph</span></p>' +
  "</b>";

describe("htmlWinsClipboard", () => {
  it("wins when Word puts text/html alongside its PNG rendition", () => {
    expect(
      htmlWinsClipboard(clipboard(["text/html", "text/plain", "Files"], WORD_HTML)),
    ).toBe(true);
  });

  it("wins for a plain html clipboard with meaningful text", () => {
    expect(
      htmlWinsClipboard(clipboard(["text/html", "text/plain"], "<p>hello from word</p>")),
    ).toBe(true);
  });

  it("does not win when the clipboard has no text/html (screenshot paste)", () => {
    expect(htmlWinsClipboard(clipboard(["Files"]))).toBe(false);
  });

  it("does not win when the html is a bare lone <img>", () => {
    expect(
      htmlWinsClipboard(clipboard(["text/html", "Files"], '<img src="blob:screenshot">')),
    ).toBe(false);
  });

  it("does not win when wrapper-only markup surrounds a lone <img>", () => {
    expect(
      htmlWinsClipboard(
        clipboard(["text/html", "Files"], '<html><body><img src="https://x.test/a.png"></body></html>'),
      ),
    ).toBe(false);
    expect(
      htmlWinsClipboard(clipboard(["text/html", "Files"], '<p><img src="https://x.test/a.png"></p>')),
    ).toBe(false);
  });

  it("wins when the html carries an <img> plus real text", () => {
    expect(
      htmlWinsClipboard(
        clipboard(["text/html", "Files"], '<p><img src="https://x.test/a.png">caption text</p>'),
      ),
    ).toBe(true);
  });
});

describe("cleanPastedHtml", () => {
  it("unwraps the GDocs guid <b font-weight:normal> wrapper but keeps its children", () => {
    const out = cleanPastedHtml(GDOCS_HTML);
    expect(out).not.toContain("docs-internal-guid");
    expect(out).not.toMatch(/<b[\s>]/);
    expect(out).toContain("Hello from Docs");
    expect(out).toContain("Second paragraph");
    // children survive as markup, not flattened to text
    expect(out).toContain("<p");
  });

  it("unwraps the same guid wrapper written as <span font-weight:normal>", () => {
    const out = cleanPastedHtml(
      '<span style="font-weight:normal" id="docs-internal-guid-xyz789">' +
        "<p><span>Span-wrapped doc</span></p></span>",
    );
    expect(out).not.toContain("docs-internal-guid");
    expect(out).toContain("Span-wrapped doc");
    expect(out).toContain("<p");
  });

  it("leaves a real <b> (no font-weight:normal) untouched", () => {
    expect(cleanPastedHtml("<p>keep <b>bold</b> here</p>")).toContain("<b>bold</b>");
  });

  it("strips mso-* declarations from style attributes but keeps the rest", () => {
    const out = cleanPastedHtml('<p style="mso-bidi-font-weight:normal; color:red">x</p>');
    expect(out).not.toMatch(/mso-/i);
    expect(out).toMatch(/color:\s*red/);
    expect(out).toContain(">x<");
  });

  it("removes <o:p> tags but keeps their content", () => {
    const out = cleanPastedHtml("<p>Hi<o:p> there</o:p></p>");
    expect(out).not.toMatch(/<\/?o:p>/i);
    expect(out).toContain("there");
  });

  it("removes downlevel-hidden mso conditional comment blocks entirely", () => {
    const out = cleanPastedHtml(WORD_HTML);
    expect(out).not.toContain("WordDocument");
    expect(out).not.toMatch(/\[if\s/i);
    expect(out).not.toContain("<xml");
    expect(out).toContain("Quarterly report");
    expect(out).not.toMatch(/mso-/i);
    expect(out).toMatch(/color:\s*red/);
  });

  it("removes downlevel-revealed conditional blocks (Word fake list markers) with their content", () => {
    const out = cleanPastedHtml(
      '<p class="MsoListParagraph"><!--[if !supportLists]-->' +
        '<span style="mso-list:Ignore">1.<span>&nbsp;</span></span>' +
        "<!--[endif]-->First item</p>",
    );
    expect(out).toContain("First item");
    expect(out).not.toContain("1.");
    expect(out).not.toContain("supportLists");
  });

  it("is a no-op on clean html", () => {
    const clean = "<p>hello <strong>world</strong></p>";
    expect(cleanPastedHtml(clean)).toBe(clean);
  });
});
