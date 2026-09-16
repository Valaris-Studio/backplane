// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeAll, describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { RunnerPipelineTab } from "../RunnerPipelineTab";

// Same canvas-hosting stubs as the sibling rocket test — the tab mounts xyflow
// (ResizeObserver) and the prompt-config hooks once the draft loads.
vi.mock("@/features/agents/hooks/usePromptConfigs", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    usePromptDefaults: () => ({ data: [], isLoading: false }),
    usePromptConfigs: () => ({ data: [], isLoading: false }),
    useCreatePromptConfig: () => ({ mutate: () => {}, isPending: false }),
    useUpdatePromptConfig: () => ({ mutate: () => {}, isPending: false }),
    useDeletePromptConfig: () => ({ mutate: () => {}, isPending: false }),
  };
});

beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

const SLUG = "prompts-link-ws";

describe("RunnerPipelineTab — prompts are reachable from the pipeline surface", () => {
  it("renders a persistent Manage-prompts link to the standalone prompts page", () => {
    // The prompts page has no console tab of its own; the pipeline header link
    // is the discoverable path in. It must not depend on the draft having
    // loaded (it renders alongside the view toggle, above the canvas).
    server.use(
      http.get(`/api/workspaces/${SLUG}/config`, () => HttpResponse.json({})),
      http.get(`/api/workspaces/${SLUG}/teams`, () => HttpResponse.json([])),
      http.get(`/api/workspaces/${SLUG}/metrics/agents`, () =>
        HttpResponse.json({ agents: [] }),
      ),
    );
    renderWithProviders(<RunnerPipelineTab slug={SLUG} />, {
      routerProps: { initialEntries: [`/${SLUG}/runner/pipeline`] },
    });

    const link = screen.getByRole("link", { name: /manage prompts/i });
    expect(link).toHaveAttribute("href", `/${SLUG}/runner/prompts`);
  });
});
