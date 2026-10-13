// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import {
  markReturnedFromSignIn,
  redirectToLogin,
  returnedFromSignInTo,
} from "@/features/auth/redirect-to-login";
import { CompanionPairPage } from "../components/CompanionPairPage";
import { ResumeAfterSignIn } from "@/features/auth/components/ResumeAfterSignIn";

vi.mock("@/features/auth/redirect-to-login", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/auth/redirect-to-login")>()),
  redirectToLogin: vi.fn(),
}));

const PAIRING = "/api/me/companion/pairing";
const PENDING = {
  name: "Studio Mac",
  platform: "darwin",
  arch: "arm64",
  requested_at: "2026-09-28T12:00:00Z",
  expires_at: "2026-09-28T12:10:00Z",
  state: "pending",
};

function errorBody(status: number, error_code: string) {
  return HttpResponse.json(
    { detail: error_code, error_code, error_params: {}, context: null },
    { status },
  );
}

// Every URL the app sends a request to or navigates to, to prove the code
// only ever travels in request bodies.
let requestedUrls: string[] = [];
let visitedLocations: string[] = [];

function lookupAnswers(answer: (userCode: string) => Response | Promise<Response>) {
  const codes: string[] = [];
  server.use(
    http.post(`${PAIRING}/lookup`, async ({ request }) => {
      requestedUrls.push(request.url);
      const { user_code } = (await request.json()) as { user_code: string };
      codes.push(user_code);
      return answer(user_code);
    }),
  );
  return codes;
}

function decisionAnswers(decision: "approve" | "deny", answer: () => Response) {
  const codes: string[] = [];
  server.use(
    http.post(`${PAIRING}/${decision}`, async ({ request }) => {
      requestedUrls.push(request.url);
      codes.push(((await request.json()) as { user_code: string }).user_code);
      return answer();
    }),
  );
  return codes;
}

function LocationProbe() {
  const location = useLocation();
  const shown = location.pathname + location.search + location.hash;
  visitedLocations.push(shown);
  return <output data-testid="location">{shown}</output>;
}

function renderPage(entry = "/companion/pair#code=BCDF-GHJK") {
  return renderWithProviders(
    <Routes>
      <Route
        path="/companion/pair"
        element={
          <>
            <CompanionPairPage />
            <LocationProbe />
          </>
        }
      />
    </Routes>,
    { routerProps: { initialEntries: [entry] } },
  );
}

function expectCodeNeverInAURL(...codes: string[]) {
  const variants = codes.flatMap((code) => [code, code.replace("-", "")]);
  // The entry location is where the code arrived; everything after it is ours.
  for (const url of [...requestedUrls, ...visitedLocations.slice(1)]) {
    for (const variant of variants) expect(url).not.toContain(variant);
  }
}

function serverModes(answer: () => Response) {
  server.use(http.get("/api/auth/modes", answer));
}

function companionEnabled(enabled: boolean) {
  serverModes(() =>
    HttpResponse.json({
      oidc_enabled: false,
      password_enabled: true,
      dev_mode: false,
      login_path: "/api/auth/oidc/login",
      logout_path: "/api/auth/oidc/logout",
      companion_enabled: enabled,
    }),
  );
}

beforeEach(() => {
  requestedUrls = [];
  visitedLocations = [];
  window.sessionStorage.clear();
  companionEnabled(true);
});
afterEach(() => vi.clearAllMocks());

describe("CompanionPairPage", () => {
  it("tells the visitor pairing is not available when the server has the companion off", async () => {
    companionEnabled(false);
    const looked = lookupAnswers(() => HttpResponse.json(PENDING));
    renderPage();

    expect(
      await screen.findByRole("heading", { name: /companion is not available/i }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/pairing code/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sign in/i })).not.toBeInTheDocument();
    expect(looked).toEqual([]);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("still checks the code when the server's modes cannot be read", async () => {
    serverModes(() => new HttpResponse(null, { status: 500 }));
    const looked = lookupAnswers(() => HttpResponse.json(PENDING));
    renderPage();

    expect(await screen.findByText("Studio Mac")).toBeInTheDocument();
    expect(looked).toEqual(["BCDF-GHJK"]);
  });

  it("prefills the code from the link fragment and shows the device asking to connect", async () => {
    const looked = lookupAnswers(() => HttpResponse.json(PENDING));
    renderPage();

    expect(screen.getByLabelText(/pairing code/i)).toHaveValue("BCDF-GHJK");
    expect(await screen.findByText("Studio Mac")).toBeInTheDocument();
    expect(screen.getByText("darwin/arm64")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Only approve if you just started this on your own computer. Backplane will never ask you for this code.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /deny/i })).toBeEnabled();
    expect(looked).toEqual(["BCDF-GHJK"]);
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/companion\/pair$/);
    expectCodeNeverInAURL("BCDF-GHJK");
  });

  it("accepts the legacy query link and strips the code from the address bar", async () => {
    const looked = lookupAnswers(() => HttpResponse.json(PENDING));
    renderPage("/companion/pair?code=BCDF-GHJK");
    expect(await screen.findByText("Studio Mac")).toBeInTheDocument();
    expect(looked).toEqual(["BCDF-GHJK"]);
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/companion\/pair$/);
    expectCodeNeverInAURL("BCDF-GHJK");
  });

  it("names an unnamed device by its platform", async () => {
    lookupAnswers(() => HttpResponse.json({ ...PENDING, name: null }));
    renderPage();
    expect(await screen.findByText(/unnamed device/i)).toBeInTheDocument();
  });

  it("approves and shows the connected state", async () => {
    lookupAnswers(() => HttpResponse.json(PENDING));
    const approved = decisionAnswers("approve", () =>
      HttpResponse.json({ ...PENDING, state: "approved" }),
    );
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /approve/i }));

    expect(await screen.findByRole("heading", { name: /device connected/i })).toBeInTheDocument();
    expect(approved).toEqual(["BCDF-GHJK"]);
    expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
    expectCodeNeverInAURL("BCDF-GHJK");
  });

  it("denies and shows the denied state", async () => {
    lookupAnswers(() => HttpResponse.json(PENDING));
    const denied = decisionAnswers("deny", () => HttpResponse.json({ ...PENDING, state: "denied" }));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /deny/i }));
    expect(await screen.findByRole("heading", { name: /request denied/i })).toBeInTheDocument();
    expect(denied).toEqual(["BCDF-GHJK"]);
  });

  it("shows the expired state for an expired request", async () => {
    lookupAnswers(() => HttpResponse.json({ ...PENDING, state: "expired" }));
    renderPage();
    expect(await screen.findByRole("heading", { name: /code expired/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
  });

  it("shows the expired state when approval races the expiry", async () => {
    lookupAnswers(() => HttpResponse.json(PENDING));
    decisionAnswers("approve", () => errorBody(409, "pairing_expired"));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /approve/i }));
    expect(await screen.findByRole("heading", { name: /code expired/i })).toBeInTheDocument();
  });

  it("shows the invalid-code state for an unknown code and lets the person retype it", async () => {
    const looked = lookupAnswers((code) =>
      code === "CDFG-HJKL" ? HttpResponse.json(PENDING) : errorBody(404, "not_found"),
    );
    renderPage();
    expect(await screen.findByRole("heading", { name: /code not recognized/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();

    const input = screen.getByLabelText(/pairing code/i);
    await userEvent.clear(input);
    await userEvent.type(input, "cdfg hjkl");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(await screen.findByText("Studio Mac")).toBeInTheDocument();
    expect(looked).toEqual(["BCDF-GHJK", "CDFG-HJKL"]);
    expectCodeNeverInAURL("BCDF-GHJK", "CDFG-HJKL");
  });

  it("explains the guessing cap instead of showing a device", async () => {
    lookupAnswers(() => errorBody(429, "rate_limited"));
    renderPage();
    expect(await screen.findByText(/too many codes/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
  });

  it("does not look up a malformed code", async () => {
    const looked = lookupAnswers(() => HttpResponse.json(PENDING));
    renderPage("/companion/pair#code=hello");
    expect(await screen.findByRole("button", { name: /continue/i })).toBeInTheDocument();
    expect(looked).toEqual([]);
    expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
  });

  it("keeps the code through sign-in without putting it in any URL", async () => {
    const redirect = vi.mocked(redirectToLogin);
    lookupAnswers(() => errorBody(401, "authentication_required"));
    const { unmount } = renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(redirect).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
    unmount();

    // Back from sign-in: ResumeAfterSignIn lands on the bare page and marks it.
    markReturnedFromSignIn("/companion/pair");
    const looked = lookupAnswers(() => HttpResponse.json(PENDING));
    renderPage("/companion/pair");
    expect(await screen.findByText("Studio Mac")).toBeInTheDocument();
    expect(screen.getByLabelText(/pairing code/i)).toHaveValue("BCDF-GHJK");
    expect(looked).toEqual(["BCDF-GHJK"]);
    expectCodeNeverInAURL("BCDF-GHJK");
    expect(returnedFromSignInTo("/companion/pair")).toBe(false);
  });

  it("does not refill a carried code on a bare visit that is not a return from sign-in", async () => {
    lookupAnswers(() => errorBody(401, "authentication_required"));
    const { unmount } = renderPage();
    await screen.findByRole("button", { name: /sign in/i });
    unmount();

    const looked = lookupAnswers(() => HttpResponse.json(PENDING));
    renderPage("/companion/pair");
    expect(await screen.findByRole("button", { name: /continue/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/pairing code/i)).toHaveValue("");
    expect(looked).toEqual([]);
  });

  // The app as it lands on home: ResumeAfterSignIn decides where to go next.
  function renderApp(entry: string) {
    return renderWithProviders(
      <>
        <ResumeAfterSignIn />
        <Routes>
          <Route path="/" element={<output>home</output>} />
          <Route path="/companion/pair" element={<CompanionPairPage />} />
        </Routes>
      </>,
      { routerProps: { initialEntries: [entry] } },
    );
  }

  function leaveForSignInWithCode() {
    window.sessionStorage.setItem(
      "backplane.returnAfterSignIn",
      JSON.stringify({ path: "/companion/pair", savedAt: Date.now() }),
    );
  }

  it("does not refill on a return path used without signing in", async () => {
    lookupAnswers(() => errorBody(401, "authentication_required"));
    const first = renderPage();
    await screen.findByRole("button", { name: /sign in/i });
    first.unmount();
    leaveForSignInWithCode();

    // Already signed in elsewhere: home is visited, but no login completed.
    const looked = lookupAnswers(() => HttpResponse.json(PENDING));
    renderApp("/");
    expect(await screen.findByRole("button", { name: /continue/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/pairing code/i)).toHaveValue("");
    expect(looked).toEqual([]);
  });

  it("refills when single sign-on completes and returns to the page", async () => {
    lookupAnswers(() => errorBody(401, "authentication_required"));
    const first = renderPage();
    await screen.findByRole("button", { name: /sign in/i });
    first.unmount();
    leaveForSignInWithCode();

    const looked = lookupAnswers(() => HttpResponse.json(PENDING));
    renderApp("/#signed_in");
    expect(await screen.findByText("Studio Mac")).toBeInTheDocument();
    expect(screen.getByLabelText(/pairing code/i)).toHaveValue("BCDF-GHJK");
    expect(looked).toEqual(["BCDF-GHJK"]);
  });

  it("refills the carried code only once per return from sign-in", async () => {
    lookupAnswers(() => errorBody(401, "authentication_required"));
    const first = renderPage();
    await screen.findByRole("button", { name: /sign in/i });
    first.unmount();

    markReturnedFromSignIn("/companion/pair");
    lookupAnswers(() => HttpResponse.json(PENDING));
    const returned = renderPage("/companion/pair");
    expect(await screen.findByText("Studio Mac")).toBeInTheDocument();
    returned.unmount();

    const looked = lookupAnswers(() => HttpResponse.json(PENDING));
    renderPage("/companion/pair");
    expect(await screen.findByRole("button", { name: /continue/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/pairing code/i)).toHaveValue("");
    expect(looked).toEqual([]);
  });

  it("does not resurrect a code once the device was approved", async () => {
    lookupAnswers(() => HttpResponse.json(PENDING));
    decisionAnswers("approve", () => HttpResponse.json({ ...PENDING, state: "approved" }));
    const { unmount } = renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /approve/i }));
    await screen.findByRole("heading", { name: /device connected/i });
    unmount();

    const looked = lookupAnswers(() => HttpResponse.json(PENDING));
    renderPage("/companion/pair");
    expect(await screen.findByRole("button", { name: /continue/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/pairing code/i)).toHaveValue("");
    expect(looked).toEqual([]);
  });
});
