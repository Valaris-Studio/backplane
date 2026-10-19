// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { ContextLink } from "@/components/shared/ContextLink";
import { renderBrowserNavigationRouter } from "@/test/navigation-router";
import { act, screen, userEvent, waitFor } from "@/test/test-utils";

describe("independent focus snapshots across browser Back and Forward", () => {
  it("keeps the destination's focused control when Back restores the origin link", async () => {
    const { router } = renderBrowserNavigationRouter([
      {
        path: "/source",
        element: <main><h1>Source investigation</h1><ContextLink id="source-related-note" to="/note">Related note</ContextLink></main>,
      },
      {
        path: "/note",
        element: <main><h1>Shared note</h1><button id="note-edit" type="button">Edit note</button></main>,
      },
    ], "/source?filter=active#selected-source");
    const sourceEntry = router.state.location;
    await userEvent.click(screen.getByRole("link", { name: "Related note" }));
    const noteEntry = router.state.location;
    await userEvent.click(screen.getByRole("button", { name: "Edit note" }));
    expect(screen.getByRole("button", { name: "Edit note" })).toHaveFocus();

    await act(async () => { await router.navigate(-1); });
    await waitFor(() => expect(router.state.location.key).toBe(sourceEntry.key));
    await waitFor(() => expect(screen.getByRole("link", { name: "Related note" })).toHaveFocus());

    await act(async () => { await router.navigate(1); });
    await waitFor(() => expect(router.state.location.key).toBe(noteEntry.key));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit note" })).toHaveFocus());
  });
});
