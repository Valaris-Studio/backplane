// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface DocumentationTechnicalContract {
  anchors: string[];
  codeBlocks: string[];
  inlineCode: string[];
  links: string[];
  technicalTokens: string[];
}

export function collectDocumentationTechnicalContract(
  container: ParentNode,
): DocumentationTechnicalContract {
  const codeElements = Array.from(container.querySelectorAll("code"));

  return {
    anchors: Array.from(container.querySelectorAll("[id]")).map(
      (element) => element.id,
    ),
    codeBlocks: codeElements
      .filter((element) => element.closest("pre") !== null)
      .map((element) => element.textContent ?? ""),
    inlineCode: codeElements
      .filter((element) => element.closest("pre") === null)
      .map((element) => element.textContent ?? ""),
    links: Array.from(container.querySelectorAll("a[href]")).map(
      (element) => element.getAttribute("href") ?? "",
    ),
    technicalTokens: Array.from(
      container.querySelectorAll("[data-doc-technical]"),
    ).map((element) => element.textContent ?? ""),
  };
}

export function compareDocumentationTechnicalContracts(
  source: DocumentationTechnicalContract,
  localized: DocumentationTechnicalContract,
): string[] {
  const mismatches: string[] = [];

  compareValues("anchors", source.anchors, localized.anchors, mismatches);
  compareValues("codeBlocks", source.codeBlocks, localized.codeBlocks, mismatches);
  compareValues("inlineCode", source.inlineCode, localized.inlineCode, mismatches);
  compareValues("links", source.links, localized.links, mismatches);
  compareValues(
    "technicalTokens",
    source.technicalTokens,
    localized.technicalTokens,
    mismatches,
  );

  return mismatches;
}

function compareValues(
  field: keyof DocumentationTechnicalContract,
  expected: string[],
  actual: string[],
  mismatches: string[],
) {
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index += 1) {
    if (expected[index] === actual[index]) continue;
    mismatches.push(
      `${field}[${index}]: expected ${JSON.stringify(expected[index])}, received ${JSON.stringify(actual[index])}`,
    );
  }
}
