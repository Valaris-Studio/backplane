// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { noteToMarkdown } from "../noteToMarkdown";
import type { Note } from "@/types/note";

// One PM→markdown truth: the frontend exporter vs the shared parity corpus.
//
// The corpus lives with the backend suite and is read by BOTH serializers —
// backend twin: backend/tests/services/notes/test_serializer_corpus_parity.py.
// Each entry pins the CONTRACT emission for one node of the closed vocabulary,
// so whichever engine lags goes red on exactly those entries while the
// agreeing entries act as regression guards.
//
// The frontend side runs @tiptap/markdown over MARKDOWN_EXPORT_EXTENSIONS;
// entries that upstream would emit differently (heading clamp, compact tables,
// the code-fence trailing newline, mention/fileAttachment atoms) are held to
// the contract by the renderMarkdown overrides in that list.
const corpusPath = path.resolve(
  process.cwd(),
  "../backend/tests/services/notes/fixtures/pm_markdown_corpus.json",
);

interface CorpusEntry {
  name: string;
  doc: unknown;
  expected_markdown: string;
}

const corpus = JSON.parse(readFileSync(corpusPath, "utf-8")) as CorpusEntry[];

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: "n1",
    workspace_id: "w1",
    board_id: null,
    card_id: null,
    title: "My Note",
    content: "",
    pinned: false,
    kind: "user_note",
    failure_class: null,
    findings: null,
    source_execution_id: null,
    created_by: "u1",
    created_at: "2026-07-20T10:00:00Z",
    updated_at: "2026-07-20T10:00:00Z",
    ...overrides,
  };
}

// noteToMarkdown is title-wrapped: `# {title}\n\n{body}\n`, or just the
// heading when the body is empty. Strip the wrapper to compare body-only
// against the corpus (an empty body — e.g. a dropped table — becomes "").
const TITLE = "Corpus";
const PREFIX = `# ${TITLE}\n\n`;

function serializeBody(doc: unknown): string {
  const md = noteToMarkdown(
    note({ title: TITLE, content: JSON.stringify(doc) }),
  );
  if (!md.startsWith(PREFIX)) return "";
  return md.slice(PREFIX.length, -1);
}

describe("noteToMarkdown corpus parity", () => {
  it("loads a non-empty corpus", () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  for (const entry of corpus) {
    it(`serializes ${entry.name} to the contract markdown`, () => {
      expect(serializeBody(entry.doc)).toBe(entry.expected_markdown);
    });
  }
});
