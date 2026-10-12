// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Read-only surfaces render stable relative media paths (mapped through the API
// base on a split-origin self-host), keep legacy signed URLs as stored, and an
// attachment opens its resolved link — the client never re-signs anything.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, waitFor, userEvent, screen } from "@/test/test-utils";
import { api } from "@/lib/api";
import { RichTextRenderer } from "@/components/shared/RichTextRenderer";
import { noteToMarkdown } from "@/features/notes/utils/noteToMarkdown";
import type { Note } from "@/types/note";

const IMAGE_PATH = "/api/workspaces/ws/media/3f1c9a52-7d2e-4c1b-9a0e-2b7f5d6c8e91/shot.png";
const FILE_PATH = "/api/workspaces/ws/media/8a6d1e0b-52f4-4d3c-b7a1-0c9e2f4d6b13/spec%20v2.pdf";
const LEGACY_SIGNED =
  "https://storage.googleapis.com/bucket/media/ws/obj/old.png?X-Goog-Signature=abc";
const SPLIT_API_BASE = "https://api.example.test/api";

const originalBaseURL = api.defaults.baseURL;
afterEach(() => {
  api.defaults.baseURL = originalBaseURL;
  vi.restoreAllMocks();
});

function doc(...content: object[]) {
  return JSON.stringify({ type: "doc", content });
}
const image = (src: string) => ({ type: "image", attrs: { src, alt: "shot" } });
const attachment = (src: string) => ({
  type: "fileAttachment",
  attrs: { src, filename: "spec v2.pdf", fileSize: 2048, mimeType: "application/pdf" },
});

async function renderContent(content: string) {
  const utils = renderWithProviders(<RichTextRenderer content={content} />);
  await waitFor(() => expect(utils.container.querySelector(".tiptap-editor")).not.toBeNull());
  return utils;
}

describe("RichTextRenderer media", () => {
  it("renders a relative stable image path as-is on a shared origin", async () => {
    const { container } = await renderContent(doc(image(IMAGE_PATH)));
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe(IMAGE_PATH),
    );
  });

  it("maps the stable path through the API base on a split-origin self-host", async () => {
    api.defaults.baseURL = SPLIT_API_BASE;
    const { container } = await renderContent(doc(image(IMAGE_PATH)));
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        `https://api.example.test${IMAGE_PATH}`,
      ),
    );
  });

  it("still renders a legacy signed URL untouched", async () => {
    api.defaults.baseURL = SPLIT_API_BASE;
    const { container } = await renderContent(doc(image(LEGACY_SIGNED)));
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe(LEGACY_SIGNED),
    );
  });

  it("opens an attachment through its resolved stable path", async () => {
    api.defaults.baseURL = SPLIT_API_BASE;
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    await renderContent(doc(attachment(FILE_PATH)));

    await userEvent.setup().click(await screen.findByRole("button", { name: /spec v2\.pdf/ }));

    expect(opened).toHaveBeenCalledWith(`https://api.example.test${FILE_PATH}`, "_blank", "noopener");
  });

  it("parses HTML carrying a split-origin media URL back to the relative stable path", async () => {
    api.defaults.baseURL = SPLIT_API_BASE;
    const { parseContent } = await import("@/lib/editor-utils");
    const parsed = parseContent(`<p>x</p><img src="https://api.example.test${IMAGE_PATH}">`) as {
      content: Array<{ type: string; attrs?: { src?: string } }>;
    };
    expect(parsed.content.find((node) => node.type === "image")?.attrs?.src).toBe(IMAGE_PATH);
  });
});

describe("markdown export round-trip matches the backend serializer", () => {
  it("emits stored relative stable paths verbatim for images and attachments", () => {
    const markdown = noteToMarkdown({
      title: "Spec",
      content: doc(image(IMAGE_PATH), attachment(FILE_PATH)),
    } as Note);
    expect(markdown).toContain(`![shot](${IMAGE_PATH})`);
    expect(markdown).toContain(
      `[spec v2.pdf](${FILE_PATH} "attachment; size=2048; type=application/pdf")`,
    );
    expect(markdown).not.toMatch(/https?:\/\//);
  });
});
