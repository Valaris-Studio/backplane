// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Read-only checklists (notes, card descriptions, definitions, approvals all
// render through RichTextRenderer). The box shows the stored state as a real,
// labelled checkbox, but a viewer cannot change it: ticking would be an
// unsaved, unauthored edit to content they are only reading.
import { describe, expect, it } from "vitest";
import { act } from "@testing-library/react";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test/test-utils";
import { RichTextRenderer } from "@/components/shared/RichTextRenderer";
import i18n from "@/i18n/config";

const CHECKLIST = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "taskList",
      content: [
        { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "write tests" }] }] },
        {
          type: "taskItem",
          attrs: { checked: false },
          content: [
            { type: "paragraph", content: [{ type: "text", text: "ship it" }] },
            {
              type: "taskList",
              content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph" }] }],
            },
          ],
        },
      ],
    },
  ],
});

async function renderContent(content: string) {
  const utils = renderWithProviders(<RichTextRenderer content={content} />);
  await waitFor(() => expect(utils.container.querySelector(".tiptap-editor")).not.toBeNull());
  return utils;
}

describe("RichTextRenderer — checklists", () => {
  it("renders each task item as a native checkbox labelled by its text", async () => {
    await renderContent(CHECKLIST);

    const done = await screen.findByRole("checkbox", { name: "Checklist item: write tests" });
    const open = screen.getByRole("checkbox", { name: "Checklist item: ship it" });
    expect(done).toBeChecked();
    expect(open).not.toBeChecked();
  });

  it("renders the DOM shape the checklist CSS selects on", async () => {
    // The node view only carries data-checked on the <li> (no data-type), so
    // index.css must select through the list: `ul[data-type=taskList] > li`.
    const { container } = await renderContent(CHECKLIST);
    await screen.findAllByRole("checkbox");
    expect(container.querySelectorAll('ul[data-type="taskList"] > li > label > input[type="checkbox"]')).toHaveLength(3);
    expect(container.querySelector('ul[data-type="taskList"] > li[data-checked="true"] > div > p')).toHaveTextContent(
      "write tests",
    );
  });

  it("names an empty nested item instead of announcing nothing", async () => {
    await renderContent(CHECKLIST);
    expect(await screen.findByRole("checkbox", { name: "Checklist item: empty item" })).toBeInTheDocument();
  });

  it("relabels the boxes when the language changes", async () => {
    await renderContent(CHECKLIST);
    await screen.findByRole("checkbox", { name: "Checklist item: write tests" });
    try {
      await act(() => i18n.changeLanguage("es"));
      expect(await screen.findByRole("checkbox", { name: "Tarea: write tests" })).toBeInTheDocument();
    } finally {
      await act(() => i18n.changeLanguage("en"));
    }
  });

  it("does not let a viewer tick a box", async () => {
    await renderContent(CHECKLIST);
    const open = await screen.findByRole("checkbox", { name: "Checklist item: ship it" });

    expect(open).toBeDisabled();
    await userEvent.setup().click(open);
    expect(open).not.toBeChecked();
  });

  it("parses a raw markdown description into checkboxes", async () => {
    await renderContent("- [x] spec\n- [ ] build");
    expect(await screen.findAllByRole("checkbox")).toHaveLength(2);
  });

  it("never renders an unsafe image src nested in a task item", async () => {
    const { container } = await renderContent(
      JSON.stringify({
        type: "doc",
        content: [{
          type: "taskList",
          content: [{
            type: "taskItem",
            attrs: { checked: false },
            content: [
              { type: "paragraph", content: [{ type: "text", text: "see" }] },
              { type: "image", attrs: { src: "javascript:alert(1)", alt: "x" } },
            ],
          }],
        }],
      }),
    );
    await screen.findByRole("checkbox");
    const sources = Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("src"));
    expect(sources.filter((src) => src !== null && src !== "")).toEqual([]);
  });
});
