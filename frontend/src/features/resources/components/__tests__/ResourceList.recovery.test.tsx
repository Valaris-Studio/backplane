// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderWithProviders, screen, userEvent, waitFor, stubReducedMotion } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { toast } from "sonner";
import { ResourceList } from "../ResourceList";
import type { Resource } from "@/types/resource";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
const resource = { id: "res-1", name: "notes.txt", resource_type: "file", gcs_path: "acme/notes.txt", metadata: { tags: [] }, updated_at: "2026-09-10T00:00:00Z" } as unknown as Resource;
let missingStorage = false;
vi.mock("../../api/use-resources", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useResources: () => ({ data: [{ ...resource, gcs_path: missingStorage ? null : resource.gcs_path }], isLoading: false }),
  useTags: () => ({ data: [] }),
}));

beforeEach(() => {
  stubReducedMotion(true);
  missingStorage = false;
  vi.mocked(toast.error).mockClear();
});

async function openPreview() {
  renderWithProviders(<ResourceList slug="acme" boardId="board-1" />);
  await userEvent.setup().click(screen.getByText("notes.txt"));
}

const endpoint = "/api/workspaces/acme/boards/board-1/resources/res-1/download-url";

describe("resource recovery", () => {
  it.each([403, 404, 500])("recovers preview signing failure %s", async (status) => {
    let failed = true;
    server.use(http.get(endpoint, () => failed
      ? HttpResponse.json({ detail: "request failed" }, { status })
      : HttpResponse.json({ download_url: "/resource-body" })),
    http.get("/resource-body", () => HttpResponse.text("Recovered preview")));
    await openPreview();
    expect(await screen.findByRole("alert")).toHaveTextContent(/preview.*notes.txt/i);
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    failed = false;
    await userEvent.setup().click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText("Recovered preview")).toBeInTheDocument();
  });

  it("does not wait forever for a file without a storage path", async () => {
    missingStorage = true;
    await openPreview();
    expect(await screen.findByRole("alert")).toHaveTextContent(/file.*unavailable/i);
  });

  it.each([403, 404, 500])("reports download failure %s with a working retry", async (status) => {
    let failed = false;
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    server.use(http.get(endpoint, () => failed
      ? HttpResponse.json({ detail: "request failed" }, { status })
      : HttpResponse.json({ download_url: "/resource-body" })),
    http.get("/resource-body", () => HttpResponse.text("Preview")));
    await openPreview();
    await screen.findByText("Preview");
    failed = true;
    await userEvent.setup().click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const [title, options] = vi.mocked(toast.error).mock.calls.at(-1)!;
    expect(title).toMatch(/download.*notes.txt/i);
    expect(opened).not.toHaveBeenCalled();
    failed = false;
    await act(async () => {
      const action = options?.action;
      if (action && typeof action === "object" && "onClick" in action) action.onClick({} as never);
    });
    await waitFor(() => expect(opened).toHaveBeenCalledWith("/resource-body", "_blank"));
    opened.mockRestore();
  });
});


it.each(["/renewed-body", "/expired-body"])("renews an expired preview URL before retrying content (%s)", async (renewedUrl) => {
  let signCalls = 0;
  server.use(http.get(endpoint, () => {
    signCalls++;
    return HttpResponse.json({ download_url: signCalls === 1 ? "/expired-body" : renewedUrl });
  }), http.get("/expired-body", () => signCalls === 1
    ? HttpResponse.text("Expired signature", { status: 403 })
    : HttpResponse.text("Renewed content")),
  http.get("/renewed-body", () => HttpResponse.text("Renewed content")));
  await openPreview();
  expect(await screen.findByRole("alert")).toHaveTextContent(/preview/i);
  await userEvent.setup().click(screen.getByRole("button", { name: /retry/i }));
  expect(await screen.findByText("Renewed content")).toBeInTheDocument();
  expect(signCalls).toBe(2);
});


it.each([false, true])("keeps every concurrent download callback (first fails: %s)", async (firstFails) => {
  let downloading = false;
  const pending: Array<(response: Response) => void> = [];
  const opened = vi.spyOn(window, "open").mockImplementation(() => null);
  server.use(http.get(endpoint, () => downloading
    ? new Promise<Response>((resolve) => pending.push(resolve))
    : HttpResponse.json({ download_url: "/resource-body" })),
  http.get("/resource-body", () => HttpResponse.text("Preview")));
  await openPreview(); await screen.findByText("Preview"); downloading = true;
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Download" }));
  await user.click(screen.getByRole("button", { name: "Download" }));
  await waitFor(() => expect(pending).toHaveLength(2));
  const [firstDownload, secondDownload] = pending;
  if (!firstDownload || !secondDownload) throw new Error("Expected two pending downloads");
  firstDownload(firstFails ? new HttpResponse(null, { status: 403 }) : HttpResponse.json({ download_url: "/first-download" }));
  secondDownload(HttpResponse.json({ download_url: "/second-download" }));
  if (firstFails) await waitFor(() => expect(toast.error).toHaveBeenCalled());
  await waitFor(() => expect(opened).toHaveBeenCalledTimes(firstFails ? 1 : 2));
  opened.mockRestore();
});
