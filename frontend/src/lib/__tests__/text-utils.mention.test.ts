// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { extractPlainText } from "@/lib/text-utils";

// A mention is a ProseMirror inline atom node carrying { id, label }. Previews
// and client-side search read the plain-text projection, so a mention MUST
// surface as "@Label" — otherwise the name silently disappears from previews
// and a "search by name" never matches.
const docWithMention = (label: string) =>
  JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "hey " },
          { type: "mention", attrs: { id: "u-1", label } },
          { type: "text", text: " ping" },
        ],
      },
    ],
  });

describe("extractPlainText — mention nodes", () => {
  it("emits @Label for a mention node", () => {
    expect(extractPlainText(docWithMention("Alice Adams"))).toBe(
      "hey @Alice Adams ping",
    );
  });

  it("emits the mention even when it is the only content", () => {
    const doc = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "mention", attrs: { id: "u-9", label: "Bob" } }],
        },
      ],
    });
    expect(extractPlainText(doc)).toBe("@Bob");
  });

  it("tolerates a mention node missing its label (no crash, drops it)", () => {
    const doc = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "x" },
            { type: "mention", attrs: { id: "u-2" } },
          ],
        },
      ],
    });
    expect(extractPlainText(doc)).toBe("x");
  });
});
