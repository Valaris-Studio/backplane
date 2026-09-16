// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { screen, waitFor, within, userEvent } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";

// Step 3 provisions the key in place rather than sending the user to Settings.
// Two things carry real product weight here:
//  - the key NAME is the identity shown in activity history when the key acts,
//    so it is explained BEFORE the input and defaulted to something honest;
//  - the vlr_… secret is shown exactly once and lives only in wizard state.
// The copy button must carry an accessible name (a11y parity with
// CreateApiKeyDialog.a11y.test — an icon-only button is otherwise unnamed).
import {
  apiKey,
  mockApiKeys,
  mockCreateApiKey,
  mockMe,
  renderWizard,
  stubMatchMedia,
} from "./wizard-harness";

beforeEach(() => {
  stubMatchMedia(true);
  mockMe();
  mockCreateApiKey();
});

afterEach(() => stubMatchMedia(false));

async function gotoKeyStep() {
  const user = userEvent.setup();
  renderWizard();
  await user.click(await screen.findByTestId("wizard-next"));
  await user.click(await screen.findByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-key");
  return user;
}

describe("StepKey — provisioning the key in place", () => {
  it("explains that the key name is the identity in activity history", async () => {
    mockApiKeys([]);
    const step = (await gotoKeyStep(), await screen.findByTestId("wizard-step-key"));

    expect(step).toHaveTextContent(/activity history/i);
  });

  it("defaults the name to claude-code plus the user's first name", async () => {
    mockApiKeys([]);
    await gotoKeyStep();

    await waitFor(() =>
      expect(screen.getByTestId("wizard-key-name")).toHaveValue(
        "claude-code — Ada",
      ),
    );
  });

  it("falls back to the email local-part when the user has no name", async () => {
    mockMe("", "grace@example.com");
    mockApiKeys([]);
    await gotoKeyStep();

    await waitFor(() =>
      expect(screen.getByTestId("wizard-key-name")).toHaveValue(
        "claude-code — grace",
      ),
    );
  });

  it("mints a key and reveals the secret once with a warning", async () => {
    mockApiKeys([]);
    const user = await gotoKeyStep();

    await user.click(await screen.findByTestId("wizard-create-key"));

    const secret = await screen.findByTestId("wizard-raw-key");
    expect(secret).toHaveTextContent("vlr_secret_minted_key");
    expect(screen.getByTestId("wizard-step-key")).toHaveTextContent(
      /won't see (it|this) again/i,
    );
  });

  it("gives the secret's copy button an accessible name", async () => {
    mockApiKeys([]);
    const user = await gotoKeyStep();

    await user.click(await screen.findByTestId("wizard-create-key"));
    await screen.findByTestId("wizard-raw-key");

    const copyButton = screen.getByRole("button", {
      name: "Copy the API key",
    });
    expect(copyButton).toBeInTheDocument();
  });

  it("offers pick-existing-or-create-new when the user already has keys", async () => {
    mockApiKeys([
      apiKey({ id: "k1", name: "laptop", key_prefix: "vlr_aaaa" }),
      apiKey({ id: "k2", name: "desktop", key_prefix: "vlr_bbbb" }),
    ]);
    const user = userEvent.setup();
    renderWizard();

    const step = await screen.findByTestId("wizard-step-key");
    expect(await within(step).findByText("laptop")).toBeInTheDocument();
    expect(within(step).getByText("desktop")).toBeInTheDocument();

    await user.click(screen.getByTestId("wizard-pick-key-k1"));
    await user.click(screen.getByTestId("wizard-next"));

    expect(await screen.findByTestId("wizard-step-connect")).toBeInTheDocument();
  });

  it("blocks advancing until a key is created or picked", async () => {
    mockApiKeys([apiKey({ id: "k1" })]);
    renderWizard();

    await screen.findByTestId("wizard-step-key");
    expect(screen.getByTestId("wizard-next")).toBeDisabled();
  });

  it("surfaces a failed mint and leaves the user able to retry", async () => {
    // A silent failure here is a dead end: no key, no message, and the create
    // button just goes back to idle as if nothing was asked.
    mockApiKeys([]);
    server.use(
      http.post("/api/me/api-keys", () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );
    const user = await gotoKeyStep();

    await user.click(await screen.findByTestId("wizard-create-key"));

    const error = await screen.findByTestId("wizard-key-error");
    expect(error).toHaveTextContent(/couldn't create/i);
    // The form is still there and the button is live again, so retry is possible.
    expect(screen.getByTestId("wizard-create-key")).toBeEnabled();
    expect(screen.getByTestId("wizard-key-name")).toBeInTheDocument();
  });

  it("clears the error once a retry succeeds", async () => {
    mockApiKeys([]);
    let attempt = 0;
    server.use(
      http.post("/api/me/api-keys", () => {
        attempt += 1;
        if (attempt === 1) {
          return HttpResponse.json({ detail: "boom" }, { status: 500 });
        }
        return HttpResponse.json({
          ...apiKey({ id: "key-new" }),
          raw_key: "vlr_secret_minted_key",
        });
      }),
    );
    const user = await gotoKeyStep();

    await user.click(await screen.findByTestId("wizard-create-key"));
    await screen.findByTestId("wizard-key-error");

    await user.click(screen.getByTestId("wizard-create-key"));

    expect(await screen.findByTestId("wizard-raw-key")).toHaveTextContent(
      "vlr_secret_minted_key",
    );
    expect(screen.queryByTestId("wizard-key-error")).toBeNull();
  });
});
