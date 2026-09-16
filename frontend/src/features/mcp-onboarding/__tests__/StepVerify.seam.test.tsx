// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { screen, userEvent, renderWithProviders } from "@/test/test-utils";

// The shell-to-step-5 seam, exercised through the whole wizard: that the shell
// reaches verify, hands it the right props, and that connect-another routes
// back to the key step. Step 5's own behaviour (authentication listener, timeout, native check)
// is covered in StepVerify.test.tsx against the component directly.
import { McpConnectionWizard } from "../McpConnectionWizard";

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

describe("StepVerify — shell seam", () => {
  it("renders the verify pane when a key has already been used", async () => {
    mockApiKeys([apiKey({ last_used_at: "2026-08-03T12:00:00Z" })]);
    renderWizard();

    expect(await screen.findByTestId("wizard-step-verify")).toBeInTheDocument();
  });

  it("lets an already-connected user go back and connect another agent", async () => {
    // The verify shortcut is right for the common case, but it must not trap a
    // returning user who wants to connect a SECOND agent — without this they
    // can never reach the key/connect steps again.
    mockApiKeys([apiKey({ last_used_at: "2026-08-03T12:00:00Z" })]);
    const user = userEvent.setup();
    renderWizard();

    await screen.findByTestId("wizard-step-verify");
    await user.click(screen.getByTestId("wizard-connect-another"));

    expect(await screen.findByTestId("wizard-step-key")).toBeInTheDocument();
  });

  it("offers no connect-another action while still waiting for a first call", async () => {
    mockApiKeys([]);
    const user = userEvent.setup();
    renderWizard();

    await user.click(await screen.findByTestId("wizard-next"));
    await user.click(await screen.findByTestId("wizard-next"));
    await screen.findByTestId("wizard-step-key");
    await user.click(await screen.findByTestId("wizard-create-key"));
    await screen.findByTestId("wizard-raw-key");
    await user.click(screen.getByTestId("wizard-next"));
    await screen.findByTestId("wizard-step-connect");
    await user.click(screen.getByTestId("wizard-next"));

    await screen.findByTestId("wizard-step-verify");
    expect(screen.queryByTestId("wizard-connect-another")).toBeNull();
  });
});

it("resuming from historical key activity leaves the native check pending", async () => {
  mockApiKeys([apiKey({ last_used_at: "2026-08-03T12:00:00Z" })]);
  renderWizard();
  await screen.findByTestId("wizard-step-verify");
  expect(screen.getByTestId("wizard-verify-auth-observed")).toHaveTextContent(/previous|historical/i);
  expect(screen.getByTestId("wizard-verify-tool-status")).toHaveTextContent(/pending|not.*verified/i);
  expect(screen.queryByTestId("wizard-verify-celebration")).toBeNull();
});

it.each([
  [0, "interactive"],
  [1, "loops"],
  [2, "everything"],
] as const)("verifies the selected %s preset after back/forward navigation without leaking the minted key", async (index, intent) => {
  mockApiKeys([]);
  const user = userEvent.setup();
  renderWizard();
  await user.click(await screen.findByTestId("wizard-next"));
  await user.click(await screen.findByTestId("wizard-next"));
  await user.click(await screen.findByTestId("wizard-create-key"));
  await screen.findByTestId("wizard-raw-key");
  await user.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-connect");
  await user.click(screen.getAllByRole("radio")[index]!);
  await user.click(screen.getByTestId("wizard-back"));
  await screen.findByTestId("wizard-step-key");
  await user.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-connect");
  await user.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-verify");
  const prompt = screen.getByTestId("wizard-verification-prompt").textContent!;
  expect(prompt).toContain("whoami");
  if (intent === "interactive") {
    expect(prompt).toContain("get_project_context");
    expect(prompt).not.toContain("list_loop_templates");
  } else {
    expect(prompt).toContain("list_loop_templates");
    expect(prompt).toMatch(/list_agents\(\s*\)/);
  }
  if (intent === "everything") expect(prompt).toMatch(/sample|representative/i);
  expect(prompt).not.toMatch(/vlr_secret_minted_key|VALARIS_API_KEY|Bearer /);
  expect(screen.getByTestId("wizard-step-verify")).not.toHaveTextContent("vlr_secret_minted_key");
  expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(prompt);
  expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain("vlr_secret_minted_key");
});


it("opens recovery docs separately without discarding an uncopied minted key", async () => {
  mockApiKeys([]);
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  renderWithProviders(
    <Routes>
      <Route path="/:slug/settings" element={
        <McpConnectionWizard open onOpenChange={onOpenChange} />
      } />
      <Route path="/:slug/documentation/mcp-toolsets" element={
        <div data-testid="recovery-docs-page">MCP toolset recovery</div>
      } />
    </Routes>,
    { routerProps: { initialEntries: ["/acme/settings"] } },
  );

  await user.click(await screen.findByTestId("wizard-next"));
  await user.click(await screen.findByTestId("wizard-next"));
  await user.click(await screen.findByTestId("wizard-create-key"));
  expect(await screen.findByTestId("wizard-raw-key")).toHaveTextContent("vlr_secret_minted_key");
  await user.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-connect");
  await user.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-verify");

  const recoveryLink = screen.getByTestId("wizard-verify-docs-link");
  expect(recoveryLink).toHaveAttribute("href", "/acme/documentation/mcp-toolsets#discovery");
  await user.click(recoveryLink);

  // A real route boundary catches the unmount that a bare MemoryRouter misses.
  expect(screen.queryByTestId("recovery-docs-page")).not.toBeInTheDocument();
  expect(screen.getByTestId("wizard-step-verify")).toBeInTheDocument();
  expect(recoveryLink).toHaveAttribute("target", "_blank");
  expect((recoveryLink.getAttribute("rel") ?? "").split(/\s+/)).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
  expect(onOpenChange).not.toHaveBeenCalled();

  // The close guard still recognizes the secret held by this live wizard.
  await user.click(screen.getByTestId("wizard-done"));
  expect(await screen.findByTestId("wizard-close-guard")).toBeInTheDocument();
  expect(onOpenChange).not.toHaveBeenCalled();
  await user.click(screen.getByTestId("wizard-close-guard-cancel"));
  expect(screen.getByTestId("wizard-step-verify")).toBeInTheDocument();
  expect(screen.getByTestId("wizard-step-verify")).not.toHaveTextContent("vlr_secret_minted_key");
  for (const storage of [localStorage, sessionStorage]) {
    for (let index = 0; index < storage.length; index += 1) {
      expect(storage.getItem(storage.key(index)!)).not.toContain("vlr_secret_minted_key");
    }
  }
});
