// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import MarkdownIt from "markdown-it";
import i18n from "@/i18n/config";
import { makeContent, makeSession, SLUG } from "../../__tests__/fixtures";
import { formatExcerpt, utf8Bytes } from "../excerpt";

describe("excerpt captured-text fidelity", () => {
  it.each([
    { label: "empty body", text: "" },
    { label: "no trailing newline", text: "abc" },
    { label: "one trailing newline", text: "abc\n" },
    { label: "two trailing newlines", text: "abc\n\n" },
    { label: "Unicode and a fence in a newline-ending body", text: "🦊\n```\n" },
  ])("recovers $label after removing only the Markdown framing newline", ({ text }) => {
    const item = makeContent({ id: "literal-body", byte_count: utf8Bytes(text) });
    const excerpt = formatExcerpt(SLUG, makeSession(), [{ item, text }], i18n.t);
    const blocks = new MarkdownIt().parse(excerpt, {}).filter((token) => token.type === "fence");

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.content.endsWith("\n")).toBe(true);
    expect(blocks[0]!.content.slice(0, -1)).toBe(text);
  });
});
