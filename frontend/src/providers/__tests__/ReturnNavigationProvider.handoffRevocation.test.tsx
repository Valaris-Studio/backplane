// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { cleanup, render } from "@testing-library/react";
import { createBrowserRouter, Outlet, RouterProvider, useBlocker, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { ContextLink } from "@/components/shared/ContextLink";
import { ReturnNavigationProvider, useReturnNavigation } from "@/providers/ReturnNavigationProvider";
import { screen, userEvent } from "@/test/test-utils";

const origin = "/authorized-origin";
const destination = "/authorized-destination";
const identity = {
  workspace_id: "private-origin-workspace",
  entity_type: "note",
  entity_id: "private-origin-note",
  relation: "changed",
};
const routers: Array<ReturnType<typeof createBrowserRouter>> = [];

// Keep the real router's departure blocked while exercising the provider's
// public invalidation API. This isolates the handoff lifecycle: an actual
// editor's unmount may independently cancel its NavigationGuardProvider prompt.
function HeldDeparture({ changeOwner }: { changeOwner: () => void }) {
  const location = useLocation();
  const navigation = useReturnNavigation();
  const blocker = useBlocker(({ currentLocation, nextLocation }) => currentLocation.pathname !== nextLocation.pathname);
  return <>
    {blocker.state === "blocked" ? <section aria-label="Held departure">
      <p>Navigation is held at the origin.</p>
      <button onClick={() => navigation!.forget()}>Forget current reading entry</button>
      <button onClick={() => navigation!.forget(location.pathname)}>Revoke origin pathname</button>
      <button onClick={changeOwner}>Change authorized owner</button>
      <button onClick={() => blocker.proceed()}>Continue held navigation</button>
    </section> : null}
    <Outlet />
  </>;
}

function Layout() {
  const [owner, setOwner] = useState("owner-a");
  return <ReturnNavigationProvider ownerId={owner}>
    <HeldDeparture changeOwner={() => setOwner("owner-b")} />
  </ReturnNavigationProvider>;
}

function Destination() {
  const navigation = useReturnNavigation();
  const handoff = navigation?.readHandoff();
  return <main><h1>Destination committed</h1>
    <output aria-label="Destination handoff">{handoff === undefined ? "No handoff" : JSON.stringify(handoff)}</output>
  </main>;
}

function mount() {
  window.history.replaceState({ idx: 0, key: "origin-entry", usr: null }, "", origin);
  const router = createBrowserRouter([{ element: <Layout />, children: [
    { path: origin, element: <main><h1>Authorized origin</h1>
      <ContextLink to={destination} handoff={identity}>Inspect related work</ContextLink>
    </main> },
    { path: destination, element: <Destination /> },
  ] }]);
  routers.push(router);
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => {
  cleanup();
  routers.splice(0).forEach((router) => router.dispose());
});

describe("ReturnNavigationProvider held handoff revocation", () => {
  it.each([
    { operation: "keep the authorized origin", control: null, retained: true },
    { operation: "forget the current entry", control: "Forget current reading entry", retained: false },
    { operation: "revoke the origin pathname", control: "Revoke origin pathname", retained: false },
    { operation: "change the owner", control: "Change authorized owner", retained: false },
  ])("does not revive an invalidated handoff when we $operation before proceeding", async ({ control, retained }) => {
    const router = mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("link", { name: "Inspect related work" }));
    await screen.findByRole("region", { name: "Held departure" });
    expect(router.state.location.pathname).toBe(origin);
    expect(window.location.pathname).toBe(origin);
    expect(screen.queryByRole("heading", { name: "Destination committed" })).not.toBeInTheDocument();
    expect([...router.state.blockers.values()].some((blocker) => blocker.state === "blocked")).toBe(true);

    if (control) await user.click(screen.getByRole("button", { name: control }));
    // Invalidation itself does not navigate or reset this independent blocker.
    expect(router.state.location.pathname).toBe(origin);
    expect(screen.getByRole("region", { name: "Held departure" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Continue held navigation" }));
    await screen.findByRole("heading", { name: "Destination committed" });
    expect(router.state.location.pathname).toBe(destination);
    expect(screen.queryByRole("region", { name: "Held departure" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Destination handoff")).toHaveTextContent(retained ? JSON.stringify(identity) : "No handoff");

    const state = window.history.state.usr;
    expect(Object.keys(state)).toEqual(["bpReturn"]);
    expect(Object.keys(state.bpReturn).sort()).toEqual(["originIdx", "originKey", "v"]);
    expect(state.bpReturn).toMatchObject({ v: 1, originIdx: 0, originKey: expect.any(String) });
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(destination);
    for (const privateValue of [identity.workspace_id, identity.entity_id]) {
      expect(JSON.stringify(window.history.state)).not.toContain(privateValue);
    }
  });
});
