// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import type { Resource } from "@/types/resource";

vi.mock("../SpreadsheetPreview", () => ({
  SpreadsheetPreview: ({ data }: { data: ArrayBuffer }) => (
    <div data-testid="spreadsheet-preview">{data.byteLength}</div>
  ),
}));

vi.mock("../DocumentPreview", () => ({
  DocumentPreview: ({ data }: { data: ArrayBuffer }) => (
    <div data-testid="document-preview">{data.byteLength}</div>
  ),
}));

import { FilePreview } from "../FilePreview";

function makeResource(name: string): Resource {
  return {
    id: "res-1",
    name,
    resource_type: "file",
    parent_id: null,
    board_id: "board-1",
    size_bytes: 4096,
    tags: [],
  } as unknown as Resource;
}

const textSpy = vi.fn();
const arrayBufferSpy = vi.fn();

beforeEach(() => {
  textSpy.mockReset().mockResolvedValue("a,b\n1,2\n");
  arrayBufferSpy.mockReset().mockResolvedValue(new ArrayBuffer(32));
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      text: textSpy,
      arrayBuffer: arrayBufferSpy,
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FilePreview — office routing", () => {
  it("fetches xlsx as an ArrayBuffer and routes to the spreadsheet preview", async () => {
    renderWithProviders(
      <FilePreview resource={makeResource("budget.xlsx")} downloadUrl="/dl/budget" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("spreadsheet-preview")).toBeInTheDocument();
    });
    expect(arrayBufferSpy).toHaveBeenCalled();
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("fetches docx as an ArrayBuffer and routes to the document preview", async () => {
    renderWithProviders(
      <FilePreview resource={makeResource("plan.docx")} downloadUrl="/dl/plan" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("document-preview")).toBeInTheDocument();
    });
    expect(arrayBufferSpy).toHaveBeenCalled();
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("keeps the text path on .text() for csv", async () => {
    renderWithProviders(
      <FilePreview resource={makeResource("rows.csv")} downloadUrl="/dl/rows" />,
    );

    await waitFor(() => expect(textSpy).toHaveBeenCalled());
    expect(arrayBufferSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("spreadsheet-preview")).not.toBeInTheDocument();
  });

  it("leaves pptx on the download-only path without fetching bytes", async () => {
    renderWithProviders(
      <FilePreview resource={makeResource("deck.pptx")} downloadUrl="/dl/deck" />,
    );

    await waitFor(() => {
      expect(screen.getByText("deck.pptx")).toBeInTheDocument();
    });
    expect(arrayBufferSpy).not.toHaveBeenCalled();
    expect(textSpy).not.toHaveBeenCalled();
  });
});
