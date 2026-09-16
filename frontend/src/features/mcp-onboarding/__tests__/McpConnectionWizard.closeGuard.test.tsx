// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, userEvent } from "@/test/test-utils";

// A raw key minted in this session lives ONLY in wizard state — closing the
// wizard destroys the secret permanently. The key stays server-side but is
// unusable, so the user has to notice, delete it, and mint another. Guard the
// close with a confirm whenever an unsaved minted secret is in memory.
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

async function mintAKey() {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  renderWizard(onOpenChange);
  await user.click(await screen.findByTestId("wizard-next"));
  await user.click(await screen.findByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-key");
  await user.click(await screen.findByTestId("wizard-create-key"));
  await screen.findByTestId("wizard-raw-key");
  return { user, onOpenChange };
}

describe("McpConnectionWizard — guarding an unsaved minted secret", () => {
  it("intercepts the close and warns instead of discarding the secret", async () => {
    mockApiKeys([]);
    const { user, onOpenChange } = await mintAKey();

    await user.keyboard("{Escape}");

    expect(await screen.findByTestId("wizard-close-guard")).toHaveTextContent(
      /won't be shown again/i,
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("stays open when the user backs out of the guard", async () => {
    mockApiKeys([]);
    const { user, onOpenChange } = await mintAKey();

    await user.keyboard("{Escape}");
    await screen.findByTestId("wizard-close-guard");

    await user.click(screen.getByTestId("wizard-close-guard-cancel"));

    await waitFor(() => expect(screen.queryByTestId("wizard-close-guard")).toBeNull());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByTestId("wizard-raw-key")).toBeInTheDocument();
  });

  it("closes for real when the user confirms", async () => {
    mockApiKeys([]);
    const { user, onOpenChange } = await mintAKey();

    await user.keyboard("{Escape}");
    await screen.findByTestId("wizard-close-guard");

    await user.click(screen.getByTestId("wizard-close-guard-confirm"));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("does not guard when no secret was minted this session", async () => {
    mockApiKeys([apiKey({ id: "k1" })]);
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWizard(onOpenChange);

    await screen.findByTestId("wizard-step-key");
    await user.click(screen.getByTestId("wizard-pick-key-k1"));
    await user.keyboard("{Escape}");

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(screen.queryByTestId("wizard-close-guard")).toBeNull();
  });
});


it("guards the verify-step Close button while a one-time secret is retained", async () => {
  mockApiKeys([]);
  const { user, onOpenChange } = await mintAKey();
  await user.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-connect");
  await user.click(screen.getByTestId("wizard-next"));
  await user.click(await screen.findByTestId("wizard-done"));
  expect(await screen.findByTestId("wizard-close-guard")).toBeInTheDocument();
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
});
