// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
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

  it("removes executable links and active markup while preserving document formatting", async () => {
    convertToHtmlMock.mockResolvedValue({
      value: '<h2>Review</h2><p><a href="javascript:alert(1)">Unsafe link</a> '
        + '<a href="https://example.com/report">Safe link</a></p>'
        + '<img src="data:image/png;base64,AA==" onerror="alert(1)">'
        + '<iframe src="https://example.com"></iframe><script>alert(1)</script>'
        + '<table><tbody><tr><td>Revenue</td></tr></tbody></table>',
      messages: [],
    });

    const { container } = renderWithProviders(<DocumentPreview data={new ArrayBuffer(8)} />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Review" })).toBeInTheDocument());
    expect(screen.getByText("Unsafe link")).not.toHaveAttribute("href");
    expect(screen.getByRole("link", { name: "Safe link" })).toHaveAttribute("href", "https://example.com/report");
    expect(screen.getByRole("cell", { name: "Revenue" })).toBeInTheDocument();
    expect(container.querySelector("img")).not.toHaveAttribute("onerror");
    expect(container.querySelector("iframe, script")).toBeNull();
  });

  it("sanitizes a javascript hyperlink produced by the real DOCX converter", async () => {
    const mammoth = await vi.importActual<typeof import("mammoth")>("mammoth");
    const buffer = readFileSync("src/features/resources/components/preview/__tests__/fixtures/javascript-link.docx");
    // Node's converter accepts Buffer; the browser adapter uses the same XML/HTML pipeline.
    const result = await mammoth.convertToHtml({ buffer });
    expect(result.value).toContain('href="javascript:alert(1)"');
    convertToHtmlMock.mockResolvedValue(result);

    renderWithProviders(<DocumentPreview data={new ArrayBuffer(8)} />);

    await waitFor(() => expect(screen.getByText("Ordinary paragraph")).toBeInTheDocument());
    expect(screen.getByText("DOCX unsafe link")).not.toHaveAttribute("href");
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
