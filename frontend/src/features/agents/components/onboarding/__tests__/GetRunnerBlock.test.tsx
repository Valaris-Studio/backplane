// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { renderWithProviders, screen, within } from "@/test/test-utils";
import { GetRunnerBlock } from "../GetRunnerBlock";
import { RUNNER_RELEASE, runnerArtifactUrl } from "@/lib/runner-release";

describe("GetRunnerBlock", () => {
  it("links every published artifact, the checksums file, and the walkthrough docs", () => {
    renderWithProviders(<GetRunnerBlock />);

    const block = screen.getByTestId("get-runner-block");
    for (const artifact of RUNNER_RELEASE.artifacts) {
      expect(
        within(block).getByTestId(`get-runner-link-${artifact.filename}`),
      ).toHaveAttribute("href", runnerArtifactUrl(artifact));
    }
    expect(RUNNER_RELEASE.artifacts).toHaveLength(6);
    expect(within(block).getByTestId("get-runner-checksums").getAttribute("href")).toMatch(
      /\/SHA256SUMS$/,
    );
    // Rendered outside a workspace route the docs base falls back to the
    // standalone /documentation tree — the section slug is what's pinned here.
    expect(within(block).getByTestId("get-runner-docs-link")).toHaveAttribute(
      "href",
      "/documentation/your-first-pipeline-run",
    );
  });
});
