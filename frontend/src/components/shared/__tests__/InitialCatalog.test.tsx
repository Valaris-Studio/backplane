import { Suspense } from "react";
import { expect, it, vi } from "vitest";
import { renderWithProviders, screen, act } from "@/test/test-utils";
import { InitialCatalog } from "../InitialCatalog";
import { PageErrorBoundary } from "../PageErrorBoundary";

it("shows recovery when the initial locale chunk fails instead of leaving an empty root", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const ready = Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/es-aaaaaaaa.js"));
    await act(async () => { renderWithProviders(<PageErrorBoundary><Suspense fallback={null}><InitialCatalog ready={ready}><p>App</p></InitialCatalog></Suspense></PageErrorBoundary>); });
    expect(await screen.findByRole("heading", { name: "This page could not load" })).toBeInTheDocument();
    expect(screen.queryByText("App")).not.toBeInTheDocument();
  } finally { consoleError.mockRestore(); }
});
