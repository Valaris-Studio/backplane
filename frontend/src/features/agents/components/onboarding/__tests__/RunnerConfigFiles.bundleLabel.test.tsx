// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { RunnerConfigFiles } from "../RunnerConfigFiles";
import type { RunnerConfig } from "@/features/git/api/use-runner-config";

const DATA: RunnerConfig = {
  runner_yaml: "valaris:\n  workspace_slug: x\n",
  mcp_config_json: "{}",
  prerequisites: ["Go 1.22 on PATH"],
};

describe("RunnerConfigFiles — agent-scoped bundle label", () => {
  it("labels the agent-scoped download as a .zip bundle, not 'runner.yaml'", () => {
    renderWithProviders(
      <RunnerConfigFiles
        data={DATA}
        isLoading={false}
        isError={false}
        onDownloadAgentConfig={vi.fn()}
      />,
    );

    const bundleBtn = screen.getByTestId("download-agent-config");
    // Honest label: the button streams a ZIP bundle, not a bare runner.yaml.
    expect(bundleBtn).toHaveTextContent(/\.zip/i);
    expect(bundleBtn).not.toHaveTextContent(/runner\.yaml/i);
  });

  it("keeps the raw board-yaml button labeled runner.yaml when no agent scope is given", () => {
    renderWithProviders(
      <RunnerConfigFiles data={DATA} isLoading={false} isError={false} />,
    );

    expect(screen.getByTestId("download-board-yaml")).toHaveTextContent(
      /runner\.yaml/i,
    );
  });
});
