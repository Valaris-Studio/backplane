// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";

const convertToHtmlMock = vi.fn();
vi.mock("mammoth", () => ({
  default: { convertToHtml: (...args: unknown[]) => convertToHtmlMock(...args) },
}));

import { DocumentPreview } from "../DocumentPreview";

describe("DocumentPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the HTML mammoth produces from the docx bytes", async () => {
    convertToHtmlMock.mockResolvedValue({
      value: "<h1>Quarterly Plan</h1><p>Ship the thing.</p>",
      messages: [],
    });

    renderWithProviders(<DocumentPreview data={new ArrayBuffer(8)} />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Quarterly Plan" })).toBeInTheDocument();
    });
    expect(screen.getByText("Ship the thing.")).toBeInTheDocument();
  });

  it("hands mammoth the ArrayBuffer it was given", async () => {
    convertToHtmlMock.mockResolvedValue({ value: "<p>x</p>", messages: [] });
    const data = new ArrayBuffer(16);

    renderWithProviders(<DocumentPreview data={data} />);

    await waitFor(() => expect(convertToHtmlMock).toHaveBeenCalled());
    expect(convertToHtmlMock).toHaveBeenCalledWith({ arrayBuffer: data });
  });

  // A corrupt or non-OOXML file makes mammoth throw; the preview must degrade
  // to a readable message rather than blanking the dialog.
  it("shows a failure message when conversion rejects", async () => {
    convertToHtmlMock.mockRejectedValue(new Error("not a zip"));

    renderWithProviders(<DocumentPreview data={new ArrayBuffer(8)} />);

    await waitFor(() => {
      expect(screen.getByText(/could not|no se pudo/i)).toBeInTheDocument();
    });
  });
});
