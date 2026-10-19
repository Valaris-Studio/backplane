// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { PageErrorBoundary } from "@/components/shared/PageErrorBoundary";
import i18n from "@/i18n/config";

const state = vi.hoisted(() => ({ roots: [] as Root[], reload: vi.fn() }));
vi.mock("react-dom/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-dom/client")>();
  return { ...original, createRoot: (...args: Parameters<typeof original.createRoot>) => {
    const root = original.createRoot(...args);
    state.roots.push(root);
    return root;
  } };
});
vi.mock("@/App", () => ({ App: RouteFailureProbe }));
vi.mock("@/providers/WebSocketProvider", () => ({ WebSocketProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/ThemedToaster", () => ({ ThemedToaster: () => null }));
vi.mock("@/components/shared/InitialCatalog", () => ({ InitialCatalog: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/lib/reload-page", () => ({ reloadPage: state.reload }));

function StaleChunk(): never {
  throw new TypeError("Failed to fetch dynamically imported module: https://example.test/assets/Page-aaaaaaaa.js?token=synthetic-private-marker#private-fragment");
}

function RouteFailureProbe() {
  const [failed, setFailed] = useState(false);
  return failed ? <StaleChunk /> : <main>
    <h1>Healthy application route</h1>
    <button onClick={() => setFailed(true)}>Load stale route chunk</button>
  </main>;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  state.reload.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await act(async () => { state.roots.splice(0).forEach((root) => root.unmount()); });
  document.getElementById("root")?.remove();
  await act(async () => { await i18n.changeLanguage("en"); });
  vi.restoreAllMocks();
});

describe("main data-router page recovery", () => {
  it("keeps localized recovery, a deliberate reload and a redacted report at the actual root route seam", async () => {
    const container = document.createElement("div");
    container.id = "root";
    document.body.append(container);
    window.history.replaceState({ idx: 0, key: "origin", usr: null }, "", "/?token=synthetic-private-marker#private-fragment");
    await act(async () => { await import("../main"); });
    expect(screen.getByRole("heading", { name: "Healthy application route" })).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Load stale route chunk" }));

    expect.soft(document.body.textContent).not.toContain("Unexpected Application Error!");
    expect.soft(document.body.textContent).not.toContain("synthetic-private-marker");
    expect.soft(document.body.textContent).not.toContain("private-fragment");
    expect.soft(document.querySelector("h1")?.textContent).toBe("This page could not load");
    expect(state.reload).not.toHaveBeenCalled();
    const reload = screen.getByRole("button", { name: "Reload page" });
    expect(screen.getByText(/unsaved changes/i)).toBeVisible();
    const report = screen.getByRole("textbox", { name: "Error details", hidden: true }) as HTMLTextAreaElement;
    expect(JSON.parse(report.value)).toMatchObject({ kind: "module-load", asset: "/assets/Page-aaaaaaaa.js", path: "/" });
    expect(report.value).not.toContain("synthetic-private-marker");
    expect(report.value).not.toContain("private-fragment");
    await user.click(reload);
    expect(state.reload).toHaveBeenCalledTimes(1);
  });

  it.each(["en", "es", "pt-BR"])("positive control: the existing page boundary supplies localized safe recovery in %s", async (language) => {
    await i18n.changeLanguage(language);
    renderWithProviders(<PageErrorBoundary><StaleChunk /></PageErrorBoundary>);
    expect(screen.getByRole("heading", { name: i18n.t("pageRecovery.title") })).toBeVisible();
    expect(screen.getByRole("button", { name: i18n.t("pageRecovery.reload") })).toBeVisible();
    expect(screen.getByText(i18n.t("pageRecovery.unsavedWarning"))).toBeVisible();
    expect(document.body.textContent).not.toContain("Unexpected Application Error!");
    expect(document.body.textContent).not.toContain("synthetic-private-marker");
    expect(state.reload).not.toHaveBeenCalled();
  });
});
