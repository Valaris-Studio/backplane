// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// WP2 durable media, end to end through the REAL upload hooks: what the editor
// saves is the backend's relative stable path (no origin, no signature), a
// failed upload says what happened and offers a retry, and a split-origin
// self-host renders via the API base without that base leaking into the doc.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { renderWithProviders, waitFor } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { api } from "@/lib/api";
import RichTextEditor from "@/components/shared/RichTextEditorImpl";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Wildcard origin: the split-origin case posts to the absolute API base.
const UPLOAD_URL_ENDPOINT = "*/api/workspaces/ws/media/upload-url";
const IMAGE_PATH = "/api/workspaces/ws/media/3f1c9a52-7d2e-4c1b-9a0e-2b7f5d6c8e91/shot.png";
const FILE_PATH = "/api/workspaces/ws/media/8a6d1e0b-52f4-4d3c-b7a1-0c9e2f4d6b13/spec.pdf";
const SIGNED_PUT = "https://storage.googleapis.com/bucket/media/ws/obj/blob?X-Goog-Signature=up";
const SPLIT_API_BASE = "https://api.example.test/api";

const originalBaseURL = api.defaults.baseURL;

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

afterEach(() => {
  api.defaults.baseURL = originalBaseURL;
});

function serveUploads(publicPath: string) {
  server.use(
    http.post(UPLOAD_URL_ENDPOINT, () =>
      HttpResponse.json({ upload_url: SIGNED_PUT, public_url: publicPath }),
    ),
    http.put(SIGNED_PUT, () => new HttpResponse(null, { status: 200 })),
  );
}

function serveStorageUnavailable() {
  server.use(
    http.post(UPLOAD_URL_ENDPOINT, () =>
      HttpResponse.json(
        { detail: "Object storage is temporarily unavailable", error_code: "storage_backend_unavailable" },
        { status: 503 },
      ),
    ),
  );
}

function pasteFile(target: HTMLElement, file: File) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      types: ["Files"],
      items: [{ kind: "file", type: file.type, getAsFile: () => file }],
      files: [file],
      getData: () => "",
    },
  });
  target.dispatchEvent(event);
}

async function mountEditor() {
  const onChange = vi.fn();
  const utils = renderWithProviders(
    <RichTextEditor content="" onChange={onChange} editable workspaceSlug="ws" />,
  );
  const editorEl = await waitFor(() => {
    const el = utils.container.querySelector(".tiptap-editor");
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  return { ...utils, editorEl, onChange };
}

function lastSavedDoc(onChange: ReturnType<typeof vi.fn>): string {
  const calls = onChange.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![0] as string;
}

interface ToastOptions {
  description?: string;
  action?: { label: string; onClick: () => void };
}

function lastErrorToast(): { title: string; options: ToastOptions } {
  const calls = vi.mocked(toast.error).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const [title, options] = calls[calls.length - 1]!;
  return { title: title as string, options: (options ?? {}) as ToastOptions };
}

const png = () => new File(["png-bytes"], "shot.png", { type: "image/png" });
const pdf = () => new File(["pdf-bytes"], "spec.pdf", { type: "application/pdf" });

describe("saved document carries the relative stable path", () => {
  it("stores a pasted image as /api/workspaces/... with no origin", async () => {
    serveUploads(IMAGE_PATH);
    const { editorEl, onChange } = await mountEditor();

    pasteFile(editorEl, png());

    await waitFor(() => expect(editorEl.querySelector("img")).not.toBeNull());
    const saved = lastSavedDoc(onChange);
    expect(JSON.parse(saved).content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "image", attrs: expect.objectContaining({ src: IMAGE_PATH }) }),
      ]),
    );
    expect(saved).not.toMatch(/https?:\/\//);
    expect(saved).not.toContain(window.location.origin);
    expect(saved).not.toContain("X-Goog");
  });

  it("stores a pasted attachment as /api/workspaces/... with no origin", async () => {
    serveUploads(FILE_PATH);
    const { editorEl, onChange } = await mountEditor();

    pasteFile(editorEl, pdf());

    await waitFor(() => {
      const saved = JSON.parse(lastSavedDoc(onChange));
      expect(saved.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "fileAttachment",
            attrs: expect.objectContaining({ src: FILE_PATH }),
          }),
        ]),
      );
    });
    expect(lastSavedDoc(onChange)).not.toMatch(/https?:\/\//);
  });

  it("renders through a split-origin API base but saves the relative path", async () => {
    api.defaults.baseURL = SPLIT_API_BASE;
    serveUploads(IMAGE_PATH);
    const { editorEl, onChange } = await mountEditor();

    pasteFile(editorEl, png());

    const img = await waitFor(() => {
      const el = editorEl.querySelector("img");
      expect(el).not.toBeNull();
      return el as HTMLImageElement;
    });
    expect(img.getAttribute("src")).toBe(`https://api.example.test${IMAGE_PATH}`);
    const saved = lastSavedDoc(onChange);
    expect(saved).toContain(`"src":"${IMAGE_PATH}"`);
    expect(saved).not.toContain("api.example.test");
  });
});

describe("upload failures surface with a retry — never a broken image", () => {
  it("names the storage outage on a 503 and the retry inserts the image once storage is back", async () => {
    serveStorageUnavailable();
    const { editorEl, onChange } = await mountEditor();

    pasteFile(editorEl, png());

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const { title, options } = lastErrorToast();
    expect(title).toContain("shot.png");
    expect(options.description).toMatch(/storage.*temporarily unavailable/i);
    expect(options.action?.label).toMatch(/retry/i);
    expect(editorEl.querySelector("img")).toBeNull();

    serveUploads(IMAGE_PATH);
    options.action!.onClick();

    await waitFor(() =>
      expect(editorEl.querySelector(`img[src="${IMAGE_PATH}"]`)).not.toBeNull(),
    );
    expect(lastSavedDoc(onChange)).toContain(IMAGE_PATH);
  });

  it("explains a failed transfer generically and offers retry", async () => {
    server.use(
      http.post(UPLOAD_URL_ENDPOINT, () =>
        HttpResponse.json({ upload_url: SIGNED_PUT, public_url: IMAGE_PATH }),
      ),
      http.put(SIGNED_PUT, () => new HttpResponse(null, { status: 403 })),
    );
    const { editorEl } = await mountEditor();

    pasteFile(editorEl, png());

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const { title, options } = lastErrorToast();
    expect(title).toContain("shot.png");
    expect(options.description).not.toMatch(/storage.*temporarily/i);
    expect(options.description).toBeTruthy();
    expect(options.action?.label).toMatch(/retry/i);
    expect(editorEl.querySelector("img")).toBeNull();
  });

  it("removes the attachment placeholder on failure and retries into a real attachment", async () => {
    serveStorageUnavailable();
    const { editorEl, onChange } = await mountEditor();

    pasteFile(editorEl, pdf());

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const { title, options } = lastErrorToast();
    expect(title).toContain("spec.pdf");
    expect(options.description).toMatch(/storage.*temporarily unavailable/i);
    await waitFor(() => expect(editorEl.textContent).not.toMatch(/uploading/i));
    expect(editorEl.querySelector("[data-file-attachment]")).toBeNull();

    serveUploads(FILE_PATH);
    options.action!.onClick();

    await waitFor(() => expect(lastSavedDoc(onChange)).toContain(FILE_PATH));
  });

  it("reports an oversized attachment in a toast without a pointless retry", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const { editorEl } = await mountEditor();
    const huge = pdf();
    Object.defineProperty(huge, "size", { value: 51 * 1024 * 1024 });

    pasteFile(editorEl, huge);

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const { title, options } = lastErrorToast();
    expect(title).toContain("spec.pdf");
    expect(options.description).toMatch(/50 MB/);
    expect(options.action).toBeUndefined();
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });
});
