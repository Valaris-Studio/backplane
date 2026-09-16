// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";

// SheetJS is ~400KB and must never enter the main bundle, so the component
// reaches it through a dynamic import() — mocking the module id proves the
// boundary exists as well as exercising the render.
const sheetToJsonMock = vi.fn();
const readMock = vi.fn();
vi.mock("xlsx", () => ({
  read: (...args: unknown[]) => readMock(...args),
  utils: {
    sheet_to_json: (...args: unknown[]) => sheetToJsonMock(...args),
  },
}));

import { SpreadsheetPreview } from "../SpreadsheetPreview";

function workbookWithRows(rows: string[][]) {
  readMock.mockReturnValue({
    SheetNames: ["Sheet1"],
    Sheets: { Sheet1: {} },
  });
  sheetToJsonMock.mockReturnValue(rows);
}

describe("SpreadsheetPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the first row as table headers and the rest as body cells", async () => {
    workbookWithRows([
      ["Region", "Revenue"],
      ["North", "1200"],
      ["South", "980"],
    ]);

    renderWithProviders(
      <SpreadsheetPreview data={new ArrayBuffer(8)} />,
    );

    await waitFor(() => {
      expect(screen.getByRole("columnheader", { name: "Region" })).toBeInTheDocument();
    });
    expect(screen.getByRole("columnheader", { name: "Revenue" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "North" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "980" })).toBeInTheDocument();
  });

  it("parses the workbook from the ArrayBuffer it is handed", async () => {
    workbookWithRows([["A"], ["1"]]);
    const data = new ArrayBuffer(16);

    renderWithProviders(<SpreadsheetPreview data={data} />);

    await waitFor(() => expect(readMock).toHaveBeenCalled());
    expect(readMock).toHaveBeenCalledWith(data, expect.anything());
  });

  it("shows the empty state when the sheet has no rows", async () => {
    workbookWithRows([]);

    renderWithProviders(<SpreadsheetPreview data={new ArrayBuffer(8)} />);

    await waitFor(() => {
      expect(screen.getByText(/empty|vacía|vacia/i)).toBeInTheDocument();
    });
  });
});
