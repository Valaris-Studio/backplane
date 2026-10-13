// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { noteToMarkdown } from "../noteToMarkdown";
import type { Note } from "@/types/note";

function noteWithCode(code: string): Note {
  return {
    id: "n1",
    workspace_id: "w1",
    board_id: null,
    card_id: null,
    title: "Capture",
    content: JSON.stringify({
      type: "doc",
      content: [{ type: "codeBlock", content: [{ type: "text", text: code }] }],
    }),
    pinned: false,
    kind: "user_note",
    failure_class: null,
    findings: null,
    source_execution_id: null,
    created_by: "u1",
    created_at: "2026-07-20T10:00:00Z",
    updated_at: "2026-07-20T10:00:00Z",
  };
}

describe("noteToMarkdown code fence sizing", () => {
  // Spreading one argument per backtick run into Math.max overflows the call
  // stack; bodyToMarkdown's catch then exports the raw stored JSON instead.
  it("sizes the fence for a body with hundreds of thousands of backtick runs", () => {
    const code = "` ".repeat(200_000);
    expect(noteToMarkdown(noteWithCode(code))).toBe(
      `# Capture\n\n\`\`\`\n${code}\n\`\`\`\n`,
    );
  });
});
