// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// WP2 durable media: the upload hooks hand the editor the backend's RELATIVE
// stable path verbatim (never origin-prefixed — an absolute URL pins the doc to
// one origin and escapes the backend canonicaliser), and a failed PUT is an
// error, not a silent success that inserts a broken image.
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { server, http, HttpResponse } from "@/test/msw-server";
import { isApiError } from "@/lib/api-error";
import { useImageUpload } from "@/hooks/useImageUpload";
import { useFileUpload } from "@/hooks/useFileUpload";
import { UploadTransferError } from "@/lib/media-upload";

const UPLOAD_URL_ENDPOINT = "/api/workspaces/acme/media/upload-url";
const STABLE_PATH = "/api/workspaces/acme/media/3f1c9a52-7d2e-4c1b-9a0e-2b7f5d6c8e91/shot.png";
const SIGNED_PUT = "https://storage.googleapis.com/bucket/media/ws/obj/shot.png?X-Goog-Signature=up";
const LOCAL_PUT = "/api/local-storage/upload/media/ws/obj/shot.png";

function serveUploadUrl(uploadUrl: string) {
  server.use(
    http.post(UPLOAD_URL_ENDPOINT, () =>
      HttpResponse.json({ upload_url: uploadUrl, public_url: STABLE_PATH }),
    ),
  );
}

const png = () => new File(["png-bytes"], "shot.png", { type: "image/png" });
const pdf = () => new File(["pdf-bytes"], "spec.pdf", { type: "application/pdf" });

describe("useImageUpload", () => {
  it("returns the relative stable path exactly as the backend minted it (GCS mode)", async () => {
    serveUploadUrl(SIGNED_PUT);
    server.use(http.put(SIGNED_PUT, () => new HttpResponse(null, { status: 200 })));
    const { result } = renderHook(() => useImageUpload("acme"));

    const src = await result.current.uploadImage(png());

    expect(src).toBe(STABLE_PATH);
    expect(src).not.toMatch(/^https?:/);
  });

  it("returns the relative stable path in local-storage mode too", async () => {
    serveUploadUrl(LOCAL_PUT);
    server.use(http.put(LOCAL_PUT, () => new HttpResponse(null, { status: 200 })));
    const { result } = renderHook(() => useImageUpload("acme"));

    expect(await result.current.uploadImage(png())).toBe(STABLE_PATH);
  });

  it("throws when the PUT itself fails instead of handing back a dead link", async () => {
    serveUploadUrl(SIGNED_PUT);
    server.use(http.put(SIGNED_PUT, () => new HttpResponse(null, { status: 403 })));
    const { result } = renderHook(() => useImageUpload("acme"));

    const failure = await result.current.uploadImage(png()).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(UploadTransferError);
    expect((failure as UploadTransferError).status).toBe(403);
  });

  it("propagates the backend's 503 storage_backend_unavailable as an ApiError", async () => {
    server.use(
      http.post(UPLOAD_URL_ENDPOINT, () =>
        HttpResponse.json(
          { detail: "Object storage is temporarily unavailable", error_code: "storage_backend_unavailable" },
          { status: 503 },
        ),
      ),
    );
    const { result } = renderHook(() => useImageUpload("acme"));

    const failure = await result.current.uploadImage(png()).catch((err: unknown) => err);

    expect(isApiError(failure)).toBe(true);
    expect(failure).toMatchObject({ status: 503, errorCode: "storage_backend_unavailable" });
  });
});

describe("useFileUpload", () => {
  it("returns the relative stable path as the attachment url", async () => {
    serveUploadUrl(SIGNED_PUT);
    server.use(http.put(SIGNED_PUT, () => new HttpResponse(null, { status: 200 })));
    const { result } = renderHook(() => useFileUpload("acme"));

    const uploaded = await result.current.uploadFile(pdf());

    expect(uploaded).toMatchObject({
      url: STABLE_PATH,
      filename: "spec.pdf",
      mimeType: "application/pdf",
    });
  });

  it("throws when the PUT fails", async () => {
    serveUploadUrl(SIGNED_PUT);
    server.use(http.put(SIGNED_PUT, () => new HttpResponse(null, { status: 500 })));
    const { result } = renderHook(() => useFileUpload("acme"));

    await expect(result.current.uploadFile(pdf())).rejects.toBeInstanceOf(UploadTransferError);
  });
});
