// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId, useLayoutEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { ContextLink } from "@/components/shared/ContextLink";
import { useReturnNavigation } from "@/providers/ReturnNavigationProvider";
import { renderBrowserNavigationRouter } from "@/test/navigation-router";
import { act, screen, userEvent, waitFor } from "@/test/test-utils";

function Origin() {
  const panelId = useId();
  return <main>
    <h1>Origin</h1>
    <aside id={panelId} data-testid="origin-panel">
      <ContextLink to="/target">Follow related note</ContextLink>
    </aside>
    <button type="button">Another control</button>
  </main>;
}

function mount() {
  return renderBrowserNavigationRouter([
    { path: "/origin", element: <Origin /> },
    { path: "/target", element: <h1>Related note</h1> },
  ], "/origin#content-retained");
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("return after actual route remount", () => {
  it("uses the exact link's top when its generated ancestor ID has changed", async () => {
    let returning = false;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const top = this.tagName === "A" ? (returning ? 760 : 450) : (returning ? 700 : 400);
      return { x: 0, y: top, top, bottom: top + 20, left: 0, right: 100, width: 100, height: 20, toJSON: () => ({}) };
    });
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    const { router } = mount();
    const initialPanel = screen.getByTestId("origin-panel").id;
    await userEvent.click(screen.getByRole("link", { name: "Follow related note" }));
    returning = true;
    scrollBy.mockClear();
    await act(async () => { await router.navigate(-1); });
    const link = screen.getByRole("link", { name: "Follow related note" });
    expect(screen.getByTestId("origin-panel").id).not.toBe(initialPanel);
    await waitFor(() => expect(link).toHaveFocus());
    expect(scrollBy).toHaveBeenCalledWith({ top: 310, behavior: "instant" });
    expect(scrollBy).not.toHaveBeenCalledWith({ top: 360, behavior: "instant" });
  });

  it.each(["pointer", "keyboard", "wheel"] as const)("allows late automatic focus to settle but yields to subsequent %s intent", async (intent) => {
    const { router } = mount();
    await userEvent.click(screen.getByRole("link", { name: "Follow related note" }));
    await act(async () => { await router.navigate(-1); });
    const link = screen.getByRole("link", { name: "Follow related note" });
    const other = screen.getByRole("button", { name: "Another control" });
    await waitFor(() => expect(link).toHaveFocus());
    act(() => { other.focus(); });
    await waitFor(() => expect(link).toHaveFocus());

    if (intent === "pointer") fireEvent.pointerDown(other);
    else if (intent === "keyboard") fireEvent.keyDown(document, { key: "Tab" });
    else fireEvent.wheel(document, { deltaY: 50 });
    act(() => {
      other.focus();
      screen.getByTestId("origin-panel").setAttribute("aria-hidden", "false");
    });
    await act(async () => { await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())); });
    expect(other).toHaveFocus();
  });

  it("does not treat a new entry's view metadata as a return origin that overrides a direct hash", async () => {
    vi.useFakeTimers();
    function DirectHash() {
      useReturnNavigation()?.readView("reader-tab");
      useLayoutEffect(() => { document.getElementById("content-direct")?.focus(); }, []);
      return <main><h1>Fresh direct link</h1><div id="content-direct" tabIndex={-1}>Direct content</div></main>;
    }
    renderBrowserNavigationRouter([{ path: "/direct", element: <DirectHash /> }], "/direct#content-direct");
    expect(screen.getByText("Direct content")).toHaveFocus();
    await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
    expect(screen.getByText("Direct content")).toHaveFocus();
  });
});
