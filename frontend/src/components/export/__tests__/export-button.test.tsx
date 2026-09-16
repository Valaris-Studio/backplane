// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === "export.success" && opts?.entity) {
        return `${opts.entity} exported`;
      }
      const en: Record<string, string> = {
        "export.button": "Export",
        "export.inProgress": "Exporting…",
        "export.failure": "Export failed",
      };
      return en[key] ?? key;
    },
  }),
}));

const successMock = vi.fn();
const errorMock = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (msg: string) => successMock(msg),
    error: (msg: string) => errorMock(msg),
  },
}));

const fetchExportBlobMock = vi.fn();
vi.mock("@/lib/api-export", () => ({
  fetchExportBlob: (path: string, fallback: string) =>
    fetchExportBlobMock(path, fallback),
}));

const downloadBlobAsMock = vi.fn();
vi.mock("@/lib/download", () => ({
  downloadBlobAs: (name: string, blob: Blob) => downloadBlobAsMock(name, blob),
}));

import { ExportButton } from "../export-button";

describe("ExportButton", () => {
  beforeEach(() => {
    successMock.mockReset();
    errorMock.mockReset();
    fetchExportBlobMock.mockReset();
    downloadBlobAsMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the localized label and download icon", () => {
    render(
      <ExportButton
        endpoint="/foo/export"
        defaultFilename="foo.json"
        entityLabel="Pipeline"
      />,
    );
    expect(screen.getByRole("button", { name: /Export/i })).toBeInTheDocument();
  });

  it("downloads the blob and shows a success toast on click", async () => {
    const blob = new Blob(["{}"]);
    fetchExportBlobMock.mockResolvedValueOnce({ blob, filename: "real.json" });

    render(
      <ExportButton
        endpoint="/api/workspaces/acme/config/pipeline/export"
        defaultFilename="acme.valaris.pipeline.json"
        entityLabel="Pipeline"
      />,
    );
    await userEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(downloadBlobAsMock).toHaveBeenCalled());
    expect(fetchExportBlobMock).toHaveBeenCalledWith(
      "/api/workspaces/acme/config/pipeline/export",
      "acme.valaris.pipeline.json",
    );
    expect(downloadBlobAsMock).toHaveBeenCalledWith("real.json", blob);
    expect(successMock).toHaveBeenCalledWith("Pipeline exported");
    expect(errorMock).not.toHaveBeenCalled();
  });

  it("shows an error toast and re-enables when the fetch fails", async () => {
    fetchExportBlobMock.mockRejectedValueOnce(new Error("boom"));

    render(
      <ExportButton
        endpoint="/foo/export"
        defaultFilename="foo.json"
        entityLabel="Team"
      />,
    );
    const button = screen.getByRole("button");
    await userEvent.click(button);

    await waitFor(() => expect(errorMock).toHaveBeenCalledWith("Export failed"));
    expect(downloadBlobAsMock).not.toHaveBeenCalled();
    expect(successMock).not.toHaveBeenCalled();
    expect(button).not.toBeDisabled();
  });

  it("disables the button while a request is pending", async () => {
    let resolve: (v: { blob: Blob; filename: string }) => void = () => {};
    fetchExportBlobMock.mockImplementationOnce(
      () => new Promise((r) => (resolve = r)),
    );

    render(
      <ExportButton
        endpoint="/foo/export"
        defaultFilename="foo.json"
        entityLabel="Notes"
      />,
    );
    const button = screen.getByRole("button");
    await userEvent.click(button);
    expect(button).toBeDisabled();
    expect(screen.getByText("Exporting…")).toBeInTheDocument();

    resolve({ blob: new Blob(["{}"]), filename: "x.json" });
    await waitFor(() => expect(button).not.toBeDisabled());
  });
});
