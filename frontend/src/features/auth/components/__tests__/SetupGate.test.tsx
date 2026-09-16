// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { useEffect } from "react";
import { renderWithProviders, screen } from "@/test/test-utils";
import { SetupGate } from "../SetupGate";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/api-error";

// Records mounting: if this runs while setup status is unsettled on an
// authenticated path, the gate leaked its children (and their queries).
function Probe({ onMount }: { onMount: () => void }) {
  useEffect(() => {
    onMount();
  }, [onMount]);
  return <div>probe-child</div>;
}

function mockSetupStatusPending() {
  vi.spyOn(api, "get").mockReturnValue(new Promise(() => {}) as never);
}

function renderGate(path: string, onMount: () => void = () => {}) {
  return renderWithProviders(
    <SetupGate>
      <Probe onMount={onMount} />
    </SetupGate>,
    { routerProps: { initialEntries: [path] } },
  );
}

describe("SetupGate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("holds authenticated paths on the fallback while setup status is unsettled", async () => {
    mockSetupStatusPending();
    const onMount = vi.fn();
    renderGate("/", onMount);

    expect(await screen.findByRole("status")).toBeInTheDocument();
    // Give a wrongly-mounted child a chance to fire its effect before asserting.
    await new Promise((r) => setTimeout(r, 100));
    expect(onMount).not.toHaveBeenCalled();
    expect(screen.queryByText("probe-child")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it.each(["/login", "/setup", "/documentation", "/documentation/quickstart"])(
    "renders children immediately on public path %s while unsettled",
    async (path) => {
      mockSetupStatusPending();
      const onMount = vi.fn();
      renderGate(path, onMount);

      expect(await screen.findByText("probe-child")).toBeInTheDocument();
      expect(onMount).toHaveBeenCalled();
    },
  );

  it("renders children once the query settles, leaving the redirect to FirstRunRedirect", async () => {
    vi.spyOn(api, "get").mockResolvedValue({
      data: { needs_setup: true },
    } as never);
    renderGate("/");

    expect(await screen.findByText("probe-child")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("fails open and renders children when the query settles with an error", async () => {
    vi.spyOn(api, "get").mockRejectedValue(
      new ApiError("Internal Server Error", 500, "boom"),
    );
    renderGate("/");

    expect(await screen.findByText("probe-child")).toBeInTheDocument();
  });
});
