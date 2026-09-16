// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen } from "@/test/test-utils";
import { useRunnerBasePath } from "../useRunnerBasePath";

function Probe() {
  const { base, overview, runnerDetail, executionDetail, runnersList, activity, pipeline, prompts } =
    useRunnerBasePath();
  return (
    <div>
      <span data-testid="base">{base}</span>
      <span data-testid="overview">{overview}</span>
      <span data-testid="runnerDetail">{runnerDetail("ag1")}</span>
      <span data-testid="executionDetail">{executionDetail("ex1")}</span>
      <span data-testid="runnersList">{runnersList}</span>
      <span data-testid="activity">{activity}</span>
      <span data-testid="pipeline">{pipeline}</span>
      <span data-testid="prompts">{prompts}</span>
    </div>
  );
}

function renderAt(path: string, routePattern: string) {
  return renderWithProviders(
    <Routes>
      <Route path={routePattern} element={<Probe />} />
    </Routes>,
    { routerProps: { initialEntries: [path] } },
  );
}

// The legacy /:slug/agents surface is retired — every link resolves to the
// /:slug/runner console regardless of where it's rendered.
describe("useRunnerBasePath", () => {
  it("returns the console base + overview target", () => {
    renderAt("/acme/runner/overview", "/:slug/runner/overview");
    expect(screen.getByTestId("base").textContent).toBe("/acme/runner");
    expect(screen.getByTestId("overview").textContent).toBe("/acme/runner/overview");
  });

  it("builds in-shell detail + tab targets on the console surface", () => {
    renderAt("/acme/runner/runners", "/:slug/runner/runners");
    expect(screen.getByTestId("runnerDetail").textContent).toBe("/acme/runner/runners/ag1");
    expect(screen.getByTestId("executionDetail").textContent).toBe("/acme/runner/executions/ex1");
    expect(screen.getByTestId("runnersList").textContent).toBe("/acme/runner/runners");
    expect(screen.getByTestId("activity").textContent).toBe("/acme/runner/activity");
  });

  it("folds roles into the Pipeline tab but keeps prompts on their standalone page", () => {
    // Prompts must stay deep-linkable (?role[&stage]) — pointing them at the
    // pipeline tab silently ate the "Edit prompt" links from LLM steps.
    renderAt("/acme/runner/pipeline", "/:slug/runner/pipeline");
    expect(screen.getByTestId("pipeline").textContent).toBe("/acme/runner/pipeline");
    expect(screen.getByTestId("prompts").textContent).toBe("/acme/runner/prompts");
  });

  it("resolves to the console even when rendered under a retired /:slug/agents path", () => {
    // Such a path only ever renders a redirect now, but the builder is surface-agnostic.
    renderAt("/acme/agents", "/:slug/agents");
    expect(screen.getByTestId("base").textContent).toBe("/acme/runner");
    expect(screen.getByTestId("overview").textContent).toBe("/acme/runner/overview");
  });
});
