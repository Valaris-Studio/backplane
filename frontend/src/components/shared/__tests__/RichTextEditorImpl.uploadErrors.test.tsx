// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pins editor P0-5: a rejected image upload is swallowed by a bare `catch` in
// RichTextEditorImpl.handleImageFile (no user feedback), and the editor's
// `allowBase64: true` lets pasted data-URI images into stored content that
// RichTextRenderer/editor-utils (allowBase64 default false) silently drop.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { toast } from "sonner";
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
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
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
  vi.clearAllMocks();
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

async function mountEditor() {
  const utils = renderWithProviders(
    <RichTextEditor content="" onChange={vi.fn()} editable workspaceSlug="ws" />,
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

const IMAGE_ONLY_PASTE = (file: File): TransferStub => ({
  types: ["Files"],
  items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
});

describe("RichTextEditor upload failure — the user must be told", () => {
  it("surfaces a rejected image upload as an error toast and inserts nothing", async () => {
    uploadImageSpy.mockRejectedValueOnce(new Error("network"));
    const { editorEl } = await mountEditor();
    const screenshot = new File(["png-bytes"], "shot.png", { type: "image/png" });

    editorEl.dispatchEvent(makePasteEvent(IMAGE_ONLY_PASTE(screenshot)));
    await flushMicrotasks();

    expect(uploadImageSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const message = vi.mocked(toast.error).mock.calls[0]![0] as string;
    // Translated human copy, not a raw i18n key leaking through.
    expect(message).toMatch(/image|upload/i);
    expect(message).not.toMatch(/^[a-z0-9]+(\.[a-zA-Z0-9]+)+$/);
    // The failed upload must leave the doc clean — no broken/phantom image.
    expect(editorEl.querySelector("img")).toBeNull();
  });

  it("inserts the image and stays quiet when the upload succeeds (guard)", async () => {
    const { editorEl } = await mountEditor();
    const screenshot = new File(["png-bytes"], "shot.png", { type: "image/png" });

    editorEl.dispatchEvent(makePasteEvent(IMAGE_ONLY_PASTE(screenshot)));
    await flushMicrotasks();

    await waitFor(() =>
      expect(editorEl.querySelector('img[src="https://cdn.test/img.png"]')).not.toBeNull(),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("RichTextEditor base64 gap — data URIs never enter stored content", () => {
  it("drops a pasted data-URI img while keeping the surrounding text", async () => {
    const { editorEl } = await mountEditor();
    // html+text so htmlWinsClipboard routes the paste to ProseMirror (the
    // P0-2 contract) — this is exactly how a real mixed html paste arrives.
    const event = makePasteEvent({
      types: ["text/html", "text/plain"],
      getDataMap: {
        "text/html": '<p>caption</p><img src="data:image/png;base64,AAAA">',
        "text/plain": "caption",
      },
    });

    editorEl.dispatchEvent(event);
    await flushMicrotasks();

    // Anti-vacuous: the paste itself must have landed.
    expect(editorEl.textContent).toContain("caption");
    // The data URI must not be stored — uploads are the storage contract.
    expect(editorEl.querySelector('img[src^="data:"]')).toBeNull();
    expect(uploadImageSpy).not.toHaveBeenCalled();
    expect(uploadFileSpy).not.toHaveBeenCalled();
  });
});

describe("Image extension config parity — no surface accepts base64", () => {
  // The renderer and editor-utils already reject data URIs (allowBase64
  // defaults false); the editable editor must match, or content written on
  // one side is silently destroyed on the other.
  const IMAGE_CONFIGURING_FILES = [
    "src/components/shared/RichTextEditorImpl.tsx",
    "src/components/shared/RichTextRenderer.tsx",
    "src/lib/editor-utils.ts",
  ];

  it.each(IMAGE_CONFIGURING_FILES)("%s configures Image without allowBase64: true", (relPath) => {
    const source = readFileSync(path.resolve(process.cwd(), relPath), "utf8");
    // Loud failure on rename/refactor instead of a vacuous pass.
    expect(source).toContain("Image.configure(");
    expect(source).not.toMatch(/allowBase64:\s*true/);
  });
});
