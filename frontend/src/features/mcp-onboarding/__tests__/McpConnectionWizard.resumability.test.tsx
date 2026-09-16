// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, userEvent } from "@/test/test-utils";

// House rule: derive the opening step from live data, never from a stored step
// cursor. A user who already minted a key should not be walked through the
// explainers again, and a user whose key has already been used should land on
// the celebration rather than re-do the connection.
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
});

afterEach(() => {
  stubMatchMedia(false);
  vi.restoreAllMocks();
});

describe("McpConnectionWizard — resumability derived from API-key state", () => {
  it("opens at intro when the user has no API keys", async () => {
    mockApiKeys([]);
    renderWizard();

    expect(await screen.findByTestId("wizard-step-intro")).toBeInTheDocument();
  });

  it("opens at the key step when keys exist but none has ever been used", async () => {
    mockApiKeys([apiKey({ id: "k1", last_used_at: null })]);
    renderWizard();

    expect(await screen.findByTestId("wizard-step-key")).toBeInTheDocument();
  });

  it("opens at verify when a key has already been used", async () => {
    mockApiKeys([
      apiKey({ id: "k1", last_used_at: null }),
      apiKey({ id: "k2", last_used_at: "2026-08-03T12:00:00Z" }),
    ]);
    renderWizard();

    expect(await screen.findByTestId("wizard-step-verify")).toBeInTheDocument();
  });

  it("waits for the key list before choosing a step, so it never flashes intro", () => {
    mockApiKeys([apiKey({ last_used_at: "2026-08-03T12:00:00Z" })]);
    renderWizard();

    expect(screen.queryByTestId("wizard-step-intro")).toBeNull();
    expect(screen.getByTestId("wizard-loading")).toBeInTheDocument();
  });
});


it("keeps a minted secret in memory while changing presets and never resumes with that raw key", async () => {
  mockApiKeys([]);
  mockCreateApiKey();
  const storageWrites = vi.spyOn(Storage.prototype, "setItem");
  const user = userEvent.setup();
  const wizard = renderWizard();
  await user.click(await screen.findByTestId("wizard-next"));
  await user.click(await screen.findByTestId("wizard-next"));
  await user.click(await screen.findByTestId("wizard-create-key"));
  await screen.findByTestId("wizard-raw-key");
  await user.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-connect");
  await user.click(screen.getAllByRole("radio")[1]!);
  await user.click(screen.getByTestId("wizard-back"));
  await screen.findByTestId("wizard-step-key");
  await user.click(screen.getByTestId("wizard-next"));
  expect(await screen.findByTestId("wizard-agent-message"))
    .toHaveTextContent("VALARIS_API_KEY=vlr_secret_minted_key");
  await user.keyboard("{Escape}");
  expect(await screen.findByTestId("wizard-close-guard")).toBeInTheDocument();
  expect(JSON.stringify(storageWrites.mock.calls)).not.toContain("vlr_secret_minted_key");
  for (const storage of [localStorage, sessionStorage]) {
    for (let index = 0; index < storage.length; index += 1) {
      expect(storage.getItem(storage.key(index)!)).not.toContain("vlr_secret_minted_key");
    }
  }
  wizard.unmount();
  mockApiKeys([apiKey({ id: "key-new" })]);
  renderWizard();
  await user.click(await screen.findByTestId("wizard-pick-key-key-new"));
  await user.click(screen.getByTestId("wizard-next"));
  expect(await screen.findByTestId("wizard-agent-message"))
    .toHaveTextContent("<your API key vlr_…>");
  expect(screen.getByTestId("wizard-agent-message")).not.toHaveTextContent("vlr_secret_minted_key");
  expect(screen.getByTestId("wizard-key-substitute-hint")).toBeInTheDocument();
  storageWrites.mockRestore();
});
