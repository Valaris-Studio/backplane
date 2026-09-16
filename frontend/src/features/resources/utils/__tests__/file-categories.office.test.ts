// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { categorizeFile } from "../file-categories";

describe("categorizeFile — office formats", () => {
  it("maps .xlsx to the spreadsheet category", () => {
    expect(categorizeFile("budget.xlsx")).toBe("spreadsheet");
  });

  it("maps .xlsm and .xls to the spreadsheet category", () => {
    expect(categorizeFile("macros.xlsm")).toBe("spreadsheet");
    expect(categorizeFile("legacy.xls")).toBe("spreadsheet");
  });

  it("maps .docx to the document category", () => {
    expect(categorizeFile("proposal.docx")).toBe("document");
  });

  it("is case-insensitive on the extension", () => {
    expect(categorizeFile("REPORT.XLSX")).toBe("spreadsheet");
    expect(categorizeFile("REPORT.DOCX")).toBe("document");
  });

  // .doc is the pre-2007 binary format — mammoth only reads OOXML, so it must
  // stay on the download-only path rather than rendering an empty document.
  it("leaves legacy .doc non-previewable", () => {
    expect(categorizeFile("legacy.doc")).toBe("unknown");
  });

  it("leaves .pptx non-previewable", () => {
    expect(categorizeFile("deck.pptx")).toBe("unknown");
  });

  it("does not disturb existing categories", () => {
    expect(categorizeFile("data.csv")).toBe("csv");
    expect(categorizeFile("notes.md")).toBe("markdown");
    expect(categorizeFile("main.ts")).toBe("code");
  });
});
