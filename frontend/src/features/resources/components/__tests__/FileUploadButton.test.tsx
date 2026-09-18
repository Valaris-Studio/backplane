// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n/config";
import { FileUploadButton } from "../FileUploadButton";

const { uploadUrl, createResource } = vi.hoisted(() => ({
  uploadUrl: vi.fn(),
  createResource: vi.fn(),
}));

vi.mock("../../api/use-resources", () => ({
  useUploadUrl: () => ({ mutateAsync: uploadUrl }),
  useCreateResource: () => ({ mutateAsync: createResource }),
}));

const put = vi.fn();
const file = new File(["stored bytes"], "example.txt", { type: "text/plain" });

function selectFile() {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [file] } });
  return input;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  uploadUrl.mockResolvedValue({ upload_url: "/upload", gcs_path: "workspace/file" });
  createResource.mockResolvedValue({ id: "resource" });
  vi.stubGlobal("fetch", put);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("FileUploadButton", () => {
  it.each([403, 413, 500])("does not create metadata after HTTP %s", async (status) => {
    put.mockResolvedValue(new Response("proxy or storage error", { status }));
    render(<FileUploadButton slug="example" />);
    selectFile();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      i18n.t(status === 413 ? "errors.upload_too_large" : "errors.upload_failed"),
    );
    expect(createResource).not.toHaveBeenCalled();
    expect(document.querySelector("button")).toBeEnabled();
  });

  it("does not create metadata after a network failure", async () => {
    put.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<FileUploadButton slug="example" />);
    selectFile();
    expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("errors.upload_failed"));
    expect(createResource).not.toHaveBeenCalled();
  });

  it("waits for a successful PUT before creating metadata exactly once", async () => {
    let finishUpload!: (response: Response) => void;
    put.mockReturnValue(new Promise<Response>((resolve) => { finishUpload = resolve; }));
    render(<FileUploadButton slug="example" boardId="board" parentId="folder" />);
    selectFile();
    await waitFor(() => expect(put).toHaveBeenCalledOnce());
    expect(createResource).not.toHaveBeenCalled();
    expect(document.querySelector("button")).toBeDisabled();

    finishUpload(new Response(null, { status: 204 }));
    await waitFor(() => expect(createResource).toHaveBeenCalledOnce());
    expect(createResource).toHaveBeenCalledWith({
      name: file.name, resource_type: "file", parent_id: "folder",
      mime_type: file.type, size_bytes: file.size, gcs_path: "workspace/file",
    });
    expect(put).toHaveBeenCalledWith("/upload", {
      method: "PUT", headers: { "Content-Type": file.type }, body: file,
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("allows retrying the same file after a rejected upload", async () => {
    put.mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    render(<FileUploadButton slug="example" />);
    const input = selectFile();
    await screen.findByRole("alert");
    expect(input.value).toBe("");
    selectFile();
    await waitFor(() => expect(createResource).toHaveBeenCalledOnce());
    expect(put).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["en", "es", "pt-BR"])("localizes oversized uploads in %s", async (language) => {
    await i18n.changeLanguage(language);
    put.mockResolvedValue(new Response(null, { status: 413 }));
    render(<FileUploadButton slug="example" />);
    selectFile();
    const alert = await screen.findByRole("alert");
    expect(i18n.exists("errors.upload_too_large", { lng: language, fallbackLng: false })).toBe(true);
    expect(alert).toHaveTextContent(i18n.t("errors.upload_too_large"));
    expect(createResource).not.toHaveBeenCalled();
  });
});
