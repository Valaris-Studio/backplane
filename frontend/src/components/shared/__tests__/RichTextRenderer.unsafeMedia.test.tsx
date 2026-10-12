// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Sink-side defence for stored rich text that predates the backend allowlist
// (or was hand-built as ProseMirror JSON): an unsafe attachment src is never
// window.open()ed, and an unsafe image src never reaches the <img>.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test/test-utils";
import { RichTextRenderer } from "@/components/shared/RichTextRenderer";

const UNSAFE: Array<[string, string]> = [
  ["javascript", "javascript:alert(1)"],
  ["leading-space", " javascript:alert(1)"],
  ["tab-inside-scheme", "java\tscript:alert(1)"],
  ["entity-in-scheme-literal", "java&#x73;cript:alert(1)"],
  ["vbscript", "vbscript:msgbox(1)"],
  ["data-html", "data:text/html,<script>alert(1)</script>"],
  ["file", "file:///etc/passwd"],
  ["protocol-relative", "//evil.example/x"],
  ["slash-tab-slash", "/\t/evil.example/x"],
];

afterEach(() => {
  vi.restoreAllMocks();
});

function doc(...content: object[]) {
  return JSON.stringify({ type: "doc", content });
}

async function renderContent(content: string) {
  const utils = renderWithProviders(<RichTextRenderer content={content} />);
  await waitFor(() => expect(utils.container.querySelector(".tiptap-editor")).not.toBeNull());
  return utils;
}

describe("RichTextRenderer refuses unsafe media URLs", () => {
  it.each(UNSAFE)("never opens a %s attachment src", async (_name, src) => {
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    await renderContent(
      doc({ type: "fileAttachment", attrs: { src, filename: "evil.pdf", fileSize: 1, mimeType: "application/pdf" } }),
    );

    await userEvent.setup().click(await screen.findByRole("button", { name: /evil\.pdf/ }));

    expect(opened).not.toHaveBeenCalled();
  });

  it.each(UNSAFE)("never puts a %s src on an image", async (_name, src) => {
    const { container } = await renderContent(doc({ type: "image", attrs: { src, alt: "x" } }));
    await waitFor(() => expect(container.querySelector(".tiptap-editor")).not.toBeNull());
    const rendered = Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("src"));
    expect(rendered.filter((value) => value !== null && value !== "")).toEqual([]);
  });
});
