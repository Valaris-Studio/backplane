// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { fireEvent } from "@testing-library/react";
import { FilePreview } from "../FilePreview";
import type { Resource } from "@/types/resource";

describe("preview content recovery", () => {
  it.each([403, 404, 500])("rejects HTTP %s rather than rendering its body", async (status) => {
    let failed = true;
    server.use(http.get("/preview-body", () => failed ? HttpResponse.text("private storage error", { status }) : HttpResponse.text("Recovered content")));
    renderWithProviders(<FilePreview resource={{ id: "r", name: "readme.txt" } as Resource} downloadUrl="/preview-body" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/preview/i);
    expect(screen.queryByText("private storage error")).toBeNull();
    failed = false;
    await userEvent.setup().click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText("Recovered content")).toBeInTheDocument();
  });
  it("shows binary network failure with retry", async () => {
    server.use(http.get("/preview-bytes", () => HttpResponse.error()));
    renderWithProviders(<FilePreview resource={{ id: "b", name: "book.xlsx" } as Resource} downloadUrl="/preview-bytes" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/preview/i);
    expect(screen.getByRole("button", { name: /retry/i })).toBeEnabled();
  });
});


it.each([["image.png", "img"], ["clip.mp4", "source"], ["sound.mp3", "source"]])("recovers native media failure for %s", async (name, selector) => {
  const refresh = vi.fn().mockResolvedValue("/media");
  const { container } = renderWithProviders(<FilePreview resource={{ id: "m", name } as Resource} downloadUrl="/media" onRefreshUrl={refresh} />);
  const original = container.querySelector(selector)!;
  fireEvent.error(original);
  expect(await screen.findByRole("alert")).toHaveTextContent(/preview/i);
  await userEvent.setup().click(screen.getByRole("button", { name: /retry/i }));
  expect(refresh).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(container.querySelector(selector)).not.toBe(original);
});
