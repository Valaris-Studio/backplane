// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, describe, expect, it } from "vitest";
import { useLocation } from "react-router-dom";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { ResumeAfterSignIn } from "../ResumeAfterSignIn";
import { returnedFromSignInTo } from "../../redirect-to-login";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search + location.hash}</output>;
}

function renderAt(entry: string) {
  return renderWithProviders(
    <>
      <ResumeAfterSignIn />
      <LocationProbe />
    </>,
    { routerProps: { initialEntries: [entry] } },
  );
}

describe("ResumeAfterSignIn", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("continues to the saved page when single sign-on lands on the home page", async () => {
    window.sessionStorage.setItem(
      "backplane.returnAfterSignIn",
      JSON.stringify({ path: "/companion/pair?code=BCDF-GHJK", savedAt: Date.now() }),
    );
    renderAt("/");
    expect(await screen.findByTestId("location")).toHaveTextContent(
      "/companion/pair?code=BCDF-GHJK",
    );
  });

  it("marks the page it resumes as a return from sign-in when single sign-on just completed", async () => {
    window.sessionStorage.setItem(
      "backplane.returnAfterSignIn",
      JSON.stringify({ path: "/companion/pair", savedAt: Date.now() }),
    );
    renderAt("/#signed_in");
    expect(await screen.findByTestId("location")).toHaveTextContent(/^\/companion\/pair$/);
    expect(returnedFromSignInTo("/companion/pair")).toBe(true);
  });

  it("does not mark a return from sign-in when no sign-in completed", async () => {
    window.sessionStorage.setItem(
      "backplane.returnAfterSignIn",
      JSON.stringify({ path: "/companion/pair", savedAt: Date.now() }),
    );
    renderAt("/");
    expect(await screen.findByTestId("location")).toHaveTextContent("/companion/pair");
    expect(returnedFromSignInTo("/companion/pair")).toBe(false);
  });

  it("drops the sign-in signal from the address bar when nothing waits", async () => {
    renderAt("/#signed_in");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
    expect(returnedFromSignInTo("/")).toBe(false);
  });

  it("stays on the home page when nothing asked for sign-in", () => {
    renderAt("/");
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
    expect(returnedFromSignInTo("/companion/pair")).toBe(false);
  });

  it("does not hijack a page other than home", () => {
    window.sessionStorage.setItem(
      "backplane.returnAfterSignIn",
      JSON.stringify({ path: "/companion/pair?code=BCDF-GHJK", savedAt: Date.now() }),
    );
    renderAt("/acme/boards");
    expect(screen.getByTestId("location")).toHaveTextContent("/acme/boards");
  });
});
