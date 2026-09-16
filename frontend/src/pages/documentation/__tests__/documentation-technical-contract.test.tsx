// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  collectDocumentationTechnicalContract,
  compareDocumentationTechnicalContracts,
} from "../technical-contract";

function fixture(markup: string) {
  const container = document.createElement("div");
  container.innerHTML = markup;
  return container;
}

describe("documentation technical content contract", () => {
  it("captures code blocks, inline identifiers, commands, routes and URLs byte-for-byte", () => {
    const contract = collectDocumentationTechnicalContract(
      fixture(`
        <h2 id="start-runner">Start the runner</h2>
        <p>Run <code>docker compose up</code> against <code>/api/cards</code>.</p>
        <pre><code data-language="yaml">kind: llm\nnext: review\n</code></pre>
        <span data-doc-technical>mcp__valaris__get_card</span>
        <a href="https://docs.example.com/api">API docs</a>
      `),
    );

    expect(contract).toEqual({
      anchors: ["start-runner"],
      codeBlocks: ["kind: llm\nnext: review\n"],
      inlineCode: ["docker compose up", "/api/cards"],
      links: ["https://docs.example.com/api"],
      technicalTokens: ["mcp__valaris__get_card"],
    });
  });

  it("detects a translated technical token even when surrounding prose changes", () => {
    const source = collectDocumentationTechnicalContract(
      fixture("<p>Use <code>review</code>.</p>"),
    );
    const invalidTranslation = collectDocumentationTechnicalContract(
      fixture("<p>Usa <code>revisión</code>.</p>"),
    );

    expect(
      compareDocumentationTechnicalContracts(source, invalidTranslation),
    ).toEqual(["inlineCode[0]: expected \"review\", received \"revisión\""]);
  });

  it("detects a changed heading anchor used by a deep link", () => {
    const source = collectDocumentationTechnicalContract(
      fixture('<h2 id="runner-config">Runner configuration</h2>'),
    );
    const invalidTranslation = collectDocumentationTechnicalContract(
      fixture('<h2 id="configuracao-runner">Configuração do Runner</h2>'),
    );

    expect(
      compareDocumentationTechnicalContracts(source, invalidTranslation),
    ).toEqual([
      'anchors[0]: expected "runner-config", received "configuracao-runner"',
    ]);
  });

  it("detects a changed tool name rendered outside a code element", () => {
    const source = collectDocumentationTechnicalContract(
      fixture('<span data-doc-technical>claim_card</span>'),
    );
    const invalidTranslation = collectDocumentationTechnicalContract(
      fixture('<span data-doc-technical>tomar_tarjeta</span>'),
    );

    expect(
      compareDocumentationTechnicalContracts(source, invalidTranslation),
    ).toEqual([
      'technicalTokens[0]: expected "claim_card", received "tomar_tarjeta"',
    ]);
  });

  it("allows narrative translation when all technical bytes stay unchanged", () => {
    const source = collectDocumentationTechnicalContract(
      fixture(
        '<p>Run <code>backplane-runner</code>.</p><a href="/documentation/runners">Runners</a>',
      ),
    );
    const translation = collectDocumentationTechnicalContract(
      fixture(
        '<p>Execute <code>backplane-runner</code>.</p><a href="/documentation/runners">Executores</a>',
      ),
    );

    expect(compareDocumentationTechnicalContracts(source, translation)).toEqual(
      [],
    );
  });
});
