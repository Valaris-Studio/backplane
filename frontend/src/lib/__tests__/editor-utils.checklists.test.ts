// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Obstacle #10 on the client parse path: `- [ ] task` typed into a card
// description, pasted as markdown, or stored raw by an older writer must become
// a real checklist — the same tree the backend normalizer builds, which is why
// the shared corpus's checklist entries are parsed back here and compared.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseContent } from "../editor-utils";

type PMNode = { type?: string; attrs?: Record<string, unknown>; content?: PMNode[]; text?: string };

interface CorpusEntry {
  name: string;
  doc: PMNode;
  expected_markdown: string;
}

const corpus = JSON.parse(
  readFileSync(
    path.resolve(process.cwd(), "../backend/tests/services/notes/fixtures/pm_markdown_corpus.json"),
    "utf-8",
  ),
) as CorpusEntry[];

const para = (text?: string): PMNode =>
  text === undefined ? { type: "paragraph" } : { type: "paragraph", content: [{ type: "text", text }] };
const task = (text: string | undefined, checked = false, ...children: PMNode[]): PMNode => ({
  type: "taskItem",
  attrs: { checked },
  content: [para(text), ...children],
});
const taskList = (...items: PMNode[]): PMNode => ({ type: "taskList", content: items });
const bullets = (...texts: string[]): PMNode => ({
  type: "bulletList",
  content: texts.map((text) => ({ type: "listItem", content: [para(text)] })),
});

function blocks(value: object): PMNode[] {
  return (value as PMNode).content ?? [];
}

describe("parseContent — markdown checklists", () => {
  it("turns `- [ ]` / `- [x]` items into a taskList", () => {
    expect(blocks(parseContent("- [ ] write tests\n- [x] ship it"))).toEqual([
      taskList(task("write tests"), task("ship it", true)),
    ]);
  });

  it("keeps a nested checklist as a tree", () => {
    expect(blocks(parseContent("- [ ] parent\n  - [X] child\n- [ ] next"))).toEqual([
      taskList(task("parent", false, taskList(task("child", true))), task("next")),
    ]);
  });

  it("leaves a mixed list as a bullet list with the brackets as text", () => {
    expect(blocks(parseContent("- [ ] todo\n- plain"))).toEqual([bullets("[ ] todo", "plain")]);
  });

  it("treats an escaped bracket as literal text", () => {
    expect(blocks(parseContent("- \\[ ] literal"))).toEqual([bullets("[ ] literal")]);
  });

  it("does not make an ordered list into a checklist", () => {
    expect(blocks(parseContent("1. [ ] first"))[0]?.type).toBe("orderedList");
  });

  const checklistEntries = corpus.filter((entry) => entry.name.startsWith("task-"));

  it("has checklist entries in the shared corpus", () => {
    expect(checklistEntries.length).toBeGreaterThan(0);
  });

  for (const entry of checklistEntries) {
    it(`parses the ${entry.name} corpus markdown back to its doc`, () => {
      expect(parseContent(entry.expected_markdown)).toEqual(entry.doc);
    });
  }
});

describe("parseContent — HTML checklists", () => {
  it("imports TipTap's own task list HTML", () => {
    const html =
      '<ul data-type="taskList">' +
      '<li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked><span></span></label><div><p>done</p></div></li>' +
      '<li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>open</p></div></li>' +
      "</ul>";
    expect(blocks(parseContent(html))).toEqual([taskList(task("done", true), task("open"))]);
  });

  it("imports a standard checkbox list (GitHub-rendered markdown)", () => {
    const html =
      '<ul class="contains-task-list">' +
      '<li class="task-list-item"><input type="checkbox" disabled checked> shipped</li>' +
      '<li class="task-list-item"><input type="checkbox" disabled> pending</li>' +
      "</ul>";
    expect(blocks(parseContent(html))).toEqual([taskList(task("shipped", true), task("pending"))]);
  });

  it("keeps a list where only some items carry a checkbox as a bullet list", () => {
    const html = '<ul><li><input type="checkbox" checked> one</li><li>two</li></ul>';
    expect(blocks(parseContent(html))[0]?.type).toBe("bulletList");
  });
});
