// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { HonestRemark } from "../callouts";
import { SectionPage } from "../shell/SectionPage";

export function HonestRemarksTheNorthStar() {
  return (
    <SectionPage title="The North Star" eyebrow="Honest Remarks">
      <p>
        Backplane's direction is portable, operator-defined execution with
        explicit evidence at every boundary. The platform defines the work,
        Runners execute it, and humans retain approval and direction. Provider
        names should select real implementations, not decorative configuration.
      </p>

      <h2 id="platform-authority">Configuration remains platform-authoritative</h2>
      <p>
        The backend owns <code>pipeline_config</code>, prompts, role scope, and
        the provider and model resolved for an assignment. The Runner consumes
        that contract and refuses invalid or unknown provider names. Adding a
        role or changing an execution stage should not require recompiling a
        hardcoded role table.
      </p>

      <h2 id="provider-choice-today">Provider choice executes today</h2>
      <p>
        <code>claude-cli</code> and <code>codex-cli</code> are concrete{" "}
        <code>llm.Provider</code> implementations, and the Runner can register
        both and dispatch a stage to the backend-resolved provider. This is a
        working CLI abstraction, not universal model support: direct Anthropic,
        OpenAI, Gemini, and local-model providers are not implemented by that
        registry.
      </p>

      <HonestRemark title="Portable does not mean identical">
        Provider capabilities differ. Structured output, native cost reporting,
        session resume, MCP wiring, and budget enforcement are declared as
        capabilities so the Runner can adapt. A new provider must implement the
        contract and prove its behavior instead of inheriting Claude-specific
        assumptions.
      </HonestRemark>

      <h2 id="forge-neutrality">Code-host operations use a neutral seam</h2>
      <p>
        <code>forge.Provider</code> gives the Runner neutral change, review,
        status, and merge operations. GitHub and Gitea/Forgejo implement that
        seam today. Plain git remains separate, and the absence of a native
        GitLab driver is stated as a limit rather than hidden behind generic
        vocabulary.
      </p>

      <h2 id="evidence-before-claims">Evidence advances the claim</h2>
      <p>
        A compile-time interface check proves shape. A focused test proves a
        behavior under its fixtures. A live smoke proves one integrated path in
        a named environment. The north star is not a spotless-code claim; it is
        a platform where each operational promise names the strongest evidence
        that currently supports it.
      </p>
    </SectionPage>
  );
}
