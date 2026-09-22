import { lazy, Suspense } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { PageErrorBoundary, RouteErrorBoundary } from "../PageErrorBoundary";

const reload = vi.fn();
vi.mock("@/lib/reload-page", () => ({ reloadPage: () => reload() }));

function Broken(): never { throw new Error("Render failed"); }

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); reload.mockClear(); });

describe("page recovery", () => {
  it("catches a rejected route import and never reloads automatically", async () => {
    const Page = lazy(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module: https://example.test/assets/Page-aaaaaaaa.js")));
    renderWithProviders(<PageErrorBoundary><Suspense fallback="Loading"><Page /></Suspense></PageErrorBoundary>);
    expect(await screen.findByRole("heading", { name: "This page could not load" })).toBeInTheDocument();
    expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("Backplane page error", expect.objectContaining({ kind: "module-load", asset: "/assets/Page-aaaaaaaa.js" }));
    await userEvent.click(screen.getByRole("button", { name: "Reload page" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("catches other render errors and provides a report without URL secrets", async () => {
    renderWithProviders(<PageErrorBoundary><Broken /></PageErrorBoundary>, { routerProps: { initialEntries: ["/workspace/history?token=secret#private"] } });
    expect(screen.getByRole("heading", { name: "This page could not load" })).toBeInTheDocument();
    await userEvent.click(screen.getByText("Error details"));
    const report = screen.getByRole("textbox", { name: "Error details" });
    expect((report as HTMLTextAreaElement).value).toContain('"kind": "render"');
    expect((report as HTMLTextAreaElement).value).not.toContain("secret");
    expect(reload).not.toHaveBeenCalled();
  });

  it("keeps surrounding draft state and recovers on another route", async () => {
    renderWithProviders(<><input aria-label="Draft" defaultValue="Unsaved draft" /><Link to="/healthy">Other page</Link><RouteErrorBoundary><Routes><Route path="/broken" element={<Broken />} /><Route path="/healthy" element={<p>Healthy page</p>} /></Routes></RouteErrorBoundary></>, { routerProps: { initialEntries: ["/broken"] } });
    expect(screen.getByRole("heading")).toHaveTextContent("This page could not load");
    expect(screen.getByLabelText("Draft")).toHaveValue("Unsaved draft");
    await userEvent.click(screen.getByText("Other page"));
    expect(screen.getByText("Healthy page")).toBeInTheDocument();
    expect(screen.getByLabelText("Draft")).toHaveValue("Unsaved draft");
    expect(reload).not.toHaveBeenCalled();
  });
});

it("does not remount healthy route layouts when the URL changes", async () => {
  renderWithProviders(<><Link to="/next">Next</Link><RouteErrorBoundary><input aria-label="Persistent draft" defaultValue="" /></RouteErrorBoundary></>);
  await userEvent.type(screen.getByLabelText("Persistent draft"), "Work in progress");
  await userEvent.click(screen.getByText("Next"));
  expect(screen.getByLabelText("Persistent draft")).toHaveValue("Work in progress");
});
