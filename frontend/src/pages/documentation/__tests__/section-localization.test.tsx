// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CodeExample } from "../callouts";
import {
  DocumentationSectionTranslationProvider,
  collectDocumentationTranslatableStrings,
  localizeDocumentationNode,
} from "../section-localization";

const source = (
  <div>
    <h2>Start the runner</h2>
    <p>
      Run <code>backplane-runner --config runner.yaml</code> from the repository.
    </p>
    <a href="/documentation/runners">Read the runner guide</a>
    <CodeExample language="yaml" title="Runner configuration">
      {"kind: llm\nnext: review\n"}
    </CodeExample>
  </div>
);

describe("documentation section localization boundary", () => {
  it("collects narrative strings but excludes technical children and link targets", () => {
    expect(collectDocumentationTranslatableStrings(source)).toEqual([
      "Start the runner",
      "Run ",
      " from the repository.",
      "Read the runner guide",
      "Runner configuration",
    ]);
  });

  it("translates narrative while keeping code, commands, routes and YAML byte-stable", () => {
    const translated = localizeDocumentationNode(source, {
      "Start the runner": "Inicie o Runner",
      "Run ": "Execute ",
      " from the repository.": " a partir do repositório.",
      "Read the runner guide": "Leia o guia do Runner",
      "Runner configuration": "Configuração do Runner",
    });

    const { container } = render(
      <DocumentationSectionTranslationProvider translations={{}}>
        {translated}
      </DocumentationSectionTranslationProvider>,
    );

    expect(screen.getByRole("heading", { name: "Inicie o Runner" })).toBeInTheDocument();
    expect(screen.getByText("backplane-runner --config runner.yaml")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Leia o guia do Runner" })).toHaveAttribute(
      "href",
      "/documentation/runners",
    );
    expect(container.querySelector("pre code")?.textContent).toBe(
      "kind: llm\nnext: review\n",
    );
  });
});
