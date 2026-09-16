// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pins editor P0-2 wiring in RichTextEditorImpl: handlePaste short-circuits on
// Word's PNG rendition (discarding the good text/html), handleDrop does the same
// for html-carrying drops, and no transformPastedHTML scrubs Word cruft.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { renderWithProviders, waitFor } from "@/test/test-utils";
import RichTextEditor from "@/components/shared/RichTextEditorImpl";

const { uploadImageSpy, uploadFileSpy } = vi.hoisted(() => ({
  uploadImageSpy: vi.fn(async () => "https://cdn.test/img.png"),
  uploadFileSpy: vi.fn(async () => ({
    url: "https://cdn.test/file.pdf",
    filename: "file.pdf",
    fileSize: 10,
    mimeType: "application/pdf",
  })),
}));

vi.mock("@/hooks/useImageUpload", () => ({
  useImageUpload: () => ({ uploadImage: uploadImageSpy, isUploading: false }),
}));
vi.mock("@/hooks/useFileUpload", () => ({
  useFileUpload: () => ({ uploadFile: uploadFileSpy, isUploading: false }),
}));

// prosemirror-view probes DOM geometry APIs jsdom doesn't implement.
beforeAll(() => {
  const rect = {
    top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect;
  Range.prototype.getBoundingClientRect = () => rect;
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  document.elementFromPoint = () => null;
});

beforeEach(() => {
  uploadImageSpy.mockClear();
  uploadFileSpy.mockClear();
});

interface TransferStub {
  types: string[];
  items?: Array<{ kind: string; type: string; getAsFile: () => File | null }>;
  files?: File[];
  getDataMap?: Record<string, string>;
}

function makeTransfer(stub: TransferStub) {
  return {
    types: stub.types,
    items: stub.items ?? [],
    files: stub.files ?? [],
    getData: (format: string) => stub.getDataMap?.[format] ?? "",
  };
}

function makePasteEvent(stub: TransferStub): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: makeTransfer(stub) });
  return event;
}

function makeDropEvent(stub: TransferStub): Event {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: makeTransfer(stub) });
  Object.defineProperty(event, "clientX", { value: 1 });
  Object.defineProperty(event, "clientY", { value: 1 });
  return event;
}

// workspaceSlug is read off an options object, NOT a defaulted positional:
// passing `undefined` to a parameter with a default silently restores the
// default, which made the "no workspaceSlug" case vacuously green.
async function mountEditor(content = "", options: { workspaceSlug?: string } = { workspaceSlug: "ws" }) {
  const utils = renderWithProviders(
    <RichTextEditor
      content={content}
      onChange={vi.fn()}
      editable
      workspaceSlug={options.workspaceSlug}
    />,
  );
  // immediatelyRender: false — the editor mounts in an effect.
  const editorEl = await waitFor(() => {
    const el = utils.container.querySelector(".tiptap-editor");
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  return { ...utils, editorEl };
}

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("RichTextEditor paste pipeline — text/html wins over Word's image rendition", () => {
  it("keeps Word's text/html and never uploads the PNG rendition riding alongside it", async () => {
    const { editorEl } = await mountEditor();
    const rendition = new File(["png-bytes"], "rendition.png", { type: "image/png" });
    const event = makePasteEvent({
      types: ["text/html", "text/plain", "Files"],
      items: [
        { kind: "string", type: "text/html", getAsFile: () => null },
        { kind: "string", type: "text/plain", getAsFile: () => null },
        { kind: "file", type: "image/png", getAsFile: () => rendition },
      ],
      getDataMap: {
        "text/html": "<p>hello from word</p>",
        "text/plain": "hello from word",
      },
    });

    editorEl.dispatchEvent(event);
    await flushMicrotasks();

    expect(uploadImageSpy).not.toHaveBeenCalled();
    expect(editorEl.textContent).toContain("hello from word");
  });

  it("still uploads when the clipboard is image-only (screenshot paste)", async () => {
    const { editorEl } = await mountEditor();
    const screenshot = new File(["png-bytes"], "shot.png", { type: "image/png" });
    const event = makePasteEvent({
      types: ["Files"],
      items: [{ kind: "file", type: "image/png", getAsFile: () => screenshot }],
    });

    editorEl.dispatchEvent(event);
    await flushMicrotasks();

    expect(uploadImageSpy).toHaveBeenCalledTimes(1);
    expect(uploadImageSpy).toHaveBeenCalledWith(screenshot);
  });

  it("still attaches non-image file items pasted from the file manager", async () => {
    const { editorEl } = await mountEditor();
    const pdf = new File(["pdf-bytes"], "report.pdf", { type: "application/pdf" });
    const event = makePasteEvent({
      types: ["Files"],
      items: [{ kind: "file", type: "application/pdf", getAsFile: () => pdf }],
    });

    editorEl.dispatchEvent(event);
    await flushMicrotasks();

    expect(uploadFileSpy).toHaveBeenCalledTimes(1);
    expect(uploadImageSpy).not.toHaveBeenCalled();
  });
});

describe("RichTextEditor drop pipeline — html-carrying drops go to ProseMirror", () => {
  it("does not upload dropped content when the dataTransfer carries text/html", async () => {
    const { editorEl } = await mountEditor();
    const rendition = new File(["png-bytes"], "dragged.png", { type: "image/png" });
    const event = makeDropEvent({
      types: ["text/html", "Files"],
      files: [rendition],
    });

    editorEl.dispatchEvent(event);
    await flushMicrotasks();

    expect(uploadImageSpy).not.toHaveBeenCalled();
    expect(uploadFileSpy).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("still uploads a files-only image drop", async () => {
    const { editorEl } = await mountEditor();
    const image = new File(["png-bytes"], "photo.png", { type: "image/png" });
    const event = makeDropEvent({ types: ["Files"], files: [image] });

    editorEl.dispatchEvent(event);
    await flushMicrotasks();

    expect(uploadImageSpy).toHaveBeenCalledTimes(1);
    expect(uploadImageSpy).toHaveBeenCalledWith(image);
  });
});

// Pins editor P1-4: a text/plain clipboard that looks like markdown is parsed
// into structure instead of landing as literal source text. jsdom renders no
// layout, so these assert the DOM the editor produced (tag names + text),
// which is the ProseMirror doc shape one-for-one for these node types.
describe("RichTextEditor paste pipeline — text/plain markdown lands structured", () => {
  function makeMarkdownPaste(text: string, html?: string): Event {
    return makePasteEvent({
      types: html ? ["text/html", "text/plain"] : ["text/plain"],
      items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
      getDataMap: html ? { "text/html": html, "text/plain": text } : { "text/plain": text },
    });
  }

  it("parses a markdown heading + bullet list from text/plain into real nodes", async () => {
    const { editorEl } = await mountEditor();

    editorEl.dispatchEvent(makeMarkdownPaste("## Result\n\n- a\n- b"));
    await flushMicrotasks();

    expect(editorEl.querySelector("h2")?.textContent).toBe("Result");
    const items = Array.from(editorEl.querySelectorAll("ul li")).map((li) => li.textContent);
    expect(items).toEqual(["a", "b"]);
    // The literal markdown source must NOT survive anywhere in the doc.
    expect(editorEl.textContent).not.toContain("## Result");
    expect(editorEl.textContent).not.toContain("- a");
  });

  it("leaves plain prose exactly as typed — one paragraph, no markdown parsing", async () => {
    const { editorEl } = await mountEditor();

    editorEl.dispatchEvent(makeMarkdownPaste("just a sentence"));
    await flushMicrotasks();

    expect(editorEl.textContent).toBe("just a sentence");
    expect(editorEl.querySelector("h1, h2, h3, ul, ol")).toBeNull();
  });

  it("never breaks out of a code block — markdown pasted inside a fence stays literal", async () => {
    // Mounting with a codeBlock-only doc puts Selection.atStart inside the block.
    const codeDoc = JSON.stringify({
      type: "doc",
      content: [{ type: "codeBlock", attrs: { language: null }, content: [{ type: "text", text: "x" }] }],
    });
    const { editorEl } = await mountEditor(codeDoc);
    expect(editorEl.querySelectorAll("pre")).toHaveLength(1);

    editorEl.dispatchEvent(makeMarkdownPaste("## Result\n\n- a\n- b"));
    await flushMicrotasks();

    expect(editorEl.querySelectorAll("pre")).toHaveLength(1);
    expect(editorEl.querySelector("h2")).toBeNull();
    expect(editorEl.querySelector("ul")).toBeNull();
    // Declining means ProseMirror's own literal insert runs, so the markdown
    // source text survives verbatim INSIDE the fence. (defaultPrevented is not
    // a usable signal here: ProseMirror calls preventDefault itself when it
    // handles the paste, so it reads true either way.)
    expect(editorEl.querySelector("pre")?.textContent).toContain("## Result");
  });

  it("yields to the P0-2 html path when the clipboard also carries text/html", async () => {
    const { editorEl } = await mountEditor();

    // The html says "from html"; the markdown text says "## Result" — deliberately
    // unlike each other, so a green assertion cannot come from the wrong branch.
    editorEl.dispatchEvent(makeMarkdownPaste("## Result\n\n- a", "<p>from html</p>"));
    await flushMicrotasks();

    expect(editorEl.textContent).toContain("from html");
    expect(editorEl.querySelector("h2")).toBeNull();
    expect(editorEl.querySelector("ul")).toBeNull();
  });

  // The one path where the markdown branch actually sees text/html on the
  // clipboard: htmlWinsClipboard deliberately declines a LONE <img> rendition
  // so the screenshot can upload. Without the branch's own html guard, markdown
  // would hijack that paste and the image would never reach handleImageFile.
  it("lets a lone-<img> screenshot rendition upload even when markdown text rides along", async () => {
    const { editorEl } = await mountEditor();
    const shot = new File(["png-bytes"], "shot.png", { type: "image/png" });
    const event = makePasteEvent({
      types: ["text/html", "text/plain", "Files"],
      items: [
        { kind: "string", type: "text/html", getAsFile: () => null },
        { kind: "file", type: "image/png", getAsFile: () => shot },
      ],
      getDataMap: {
        "text/html": "<p><img src='shot.png'></p>",
        "text/plain": "## Result\n\n- a",
      },
    });

    editorEl.dispatchEvent(event);
    await flushMicrotasks();

    expect(uploadImageSpy).toHaveBeenCalledWith(shot);
    expect(editorEl.querySelector("h2")).toBeNull();
    expect(editorEl.querySelector("ul")).toBeNull();
  });

  it("still routes an image item to upload even when text/plain markdown rides along", async () => {
    const { editorEl } = await mountEditor();
    const shot = new File(["png-bytes"], "shot.png", { type: "image/png" });
    const event = makePasteEvent({
      types: ["text/plain", "Files"],
      items: [
        { kind: "string", type: "text/plain", getAsFile: () => null },
        { kind: "file", type: "image/png", getAsFile: () => shot },
      ],
      getDataMap: { "text/plain": "screenshot.png" },
    });

    editorEl.dispatchEvent(event);
    await flushMicrotasks();

    expect(uploadImageSpy).toHaveBeenCalledTimes(1);
    expect(uploadImageSpy).toHaveBeenCalledWith(shot);
  });

  it("parses markdown even with no workspaceSlug — image upload is gated, paste is not", async () => {
    const { editorEl } = await mountEditor("", {});

    editorEl.dispatchEvent(makeMarkdownPaste("## Result\n\n- a"));
    await flushMicrotasks();

    expect(editorEl.querySelector("h2")?.textContent).toBe("Result");
  });
});

describe("RichTextEditor transformPastedHTML — Word cruft is scrubbed before parsing", () => {
  it("drops Word's fake list-marker cruft (downlevel-revealed conditional block) from pasted html", async () => {
    const { editorEl } = await mountEditor();
    const wordListHtml =
      '<p class="MsoListParagraph"><!--[if !supportLists]-->' +
      '<span style="mso-list:Ignore">1.<span>&nbsp;</span></span>' +
      "<!--[endif]-->First item</p>";
    const event = makePasteEvent({
      types: ["text/html", "text/plain"],
      getDataMap: { "text/html": wordListHtml, "text/plain": "1. First item" },
    });

    editorEl.dispatchEvent(event);
    await flushMicrotasks();

    expect(editorEl.textContent).not.toMatch(/1\./);
    expect(editorEl.textContent).toContain("First item");
  });
});
