// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { mergeAttributes } from "@tiptap/core";
import { DOMSerializer } from "@tiptap/pm/model";

describe("editor attribute merging", () => {
  it("does not turn JSON prototype keys into executable DOM attributes", () => {
    const imported = JSON.parse('{"__proto__":{"onerror":"alert(1)","src":"invalid:"},"alt":"Document image"}');
    const attributes = mergeAttributes({}, imported);
    const { dom } = DOMSerializer.renderSpec(document, ["img", attributes]);
    expect((dom as Element).hasAttribute("onerror")).toBe(false);
    expect((dom as Element).hasAttribute("src")).toBe(false);
    expect((dom as Element).getAttribute("alt")).toBe("Document image");
  });
});
