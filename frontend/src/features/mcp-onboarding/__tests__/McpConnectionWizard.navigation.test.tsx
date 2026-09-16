// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, within, userEvent } from "@/test/test-utils";

// Contract for the MCP Connection Wizard shell — the activation moment that
// takes a user from "I have a workspace" to "my coding agent just made its
// first authenticated MCP call".
//
// The shell owns the step cursor (intro → positioning → key → connect →
// verify) and the numbered indicator; each step owns its own footer. The step
// cursor is NEVER persisted: the opening step is derived from live API-key
// data (see McpConnectionWizard.resumability.test).
import { apiKey, mockApiKeys, mockMe, renderWizard, stubMatchMedia } from "./wizard-harness";

const verifyInputs = vi.hoisted(() => vi.fn());
vi.mock("../components/StepVerify", async (importOriginal) => {
  const original = await importOriginal<typeof import("../components/StepVerify")>();
  return {
    ...original,
    StepVerify: (props: Parameters<typeof original.StepVerify>[0]) => {
      verifyInputs(props);
      return <original.StepVerify {...props} />;
    },
  };
});

beforeEach(() => {
  stubMatchMedia(true);
  mockMe();
  mockApiKeys([]);
});

afterEach(() => stubMatchMedia(false));

describe("McpConnectionWizard — shell and step navigation", () => {
  it("opens on the intro step with all five steps named in the indicator", async () => {
    renderWizard();

    const dialog = await screen.findByRole("dialog");
    expect(await screen.findByTestId("wizard-step-intro")).toBeInTheDocument();

    const indicator = within(dialog).getByRole("list", {
      name: "Wizard steps",
    });
    expect(
      within(indicator).getAllByRole("listitem").map((li) => li.textContent),
    ).toEqual([
      expect.stringContaining("What MCP is"),
      expect.stringContaining("MCP or runners"),
      expect.stringContaining("API key"),
      expect.stringContaining("Connect"),
      expect.stringContaining("Verify"),
    ]);
  });

  it("explains the tool surface and promises three short steps on intro", async () => {
    renderWizard();

    const step = await screen.findByTestId("wizard-step-intro");
    expect(step).toHaveTextContent(/dozens of platform tools/);
    expect(step).toHaveTextContent(/Model Context Protocol/);
    expect(step).toHaveTextContent(/three short steps/i);
  });

  it("advances intro → positioning → key when Next is pressed", async () => {
    const user = userEvent.setup();
    renderWizard();

    await user.click(await screen.findByTestId("wizard-next"));
    expect(await screen.findByTestId("wizard-step-positioning")).toBeInTheDocument();

    await user.click(screen.getByTestId("wizard-next"));
    expect(await screen.findByTestId("wizard-step-key")).toBeInTheDocument();
  });

  it("goes back to the previous step without losing the wizard", async () => {
    const user = userEvent.setup();
    renderWizard();

    await user.click(await screen.findByTestId("wizard-next"));
    await screen.findByTestId("wizard-step-positioning");

    await user.click(screen.getByTestId("wizard-back"));
    expect(await screen.findByTestId("wizard-step-intro")).toBeInTheDocument();
  });

  it("has no Back button on the first step", async () => {
    renderWizard();

    await screen.findByTestId("wizard-step-intro");
    expect(screen.queryByTestId("wizard-back")).toBeNull();
  });

  it("contrasts your agent with runners and says the runner is not required", async () => {
    const user = userEvent.setup();
    renderWizard();

    await user.click(await screen.findByTestId("wizard-next"));
    const step = await screen.findByTestId("wizard-step-positioning");

    expect(within(step).getByText("Your agent over MCP")).toBeInTheDocument();
    expect(within(step).getByText("Runners")).toBeInTheDocument();
    expect(within(step).getByText("experimental")).toBeInTheDocument();
    expect(step).toHaveTextContent(/do not need a runner to use MCP/i);
    expect(step).toHaveTextContent(/next_assignment/);
  });

  it("links to the runners documentation section", async () => {
    const user = userEvent.setup();
    renderWizard();

    await user.click(await screen.findByTestId("wizard-next"));
    const link = await screen.findByTestId("wizard-runners-docs-link");

    await waitFor(() =>
      expect(link).toHaveAttribute("href", expect.stringContaining("/documentation")),
    );
  });
});


async function reachConnectWithExistingKey() {
  mockApiKeys([apiKey({ id: "k1" })]);
  const user = userEvent.setup();
  renderWizard();
  await user.click(await screen.findByTestId("wizard-pick-key-k1"));
  await user.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-connect");
  return user;
}

it.each([
  [1, "default,autonomous-operations"],
  [2, "all"],
] as const)("retains preset %s after going back to the key step and forward again", async (index, toolsets) => {
  const user = await reachConnectWithExistingKey();
  await user.click(screen.getAllByRole("radio")[index]!);
  await user.click(screen.getByTestId("wizard-back"));
  await screen.findByTestId("wizard-step-key");
  await user.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-connect");
  expect(screen.getAllByRole("radio")[index]).toBeChecked();
  expect(screen.getByTestId("wizard-agent-message").textContent?.split("\n"))
    .toContain(`  VALARIS_MCP_TOOLSETS=${toolsets}`);
  await user.click(screen.getByTestId("wizard-advanced-toggle"));
  expect(JSON.parse(screen.getByTestId("wizard-mcp-json").textContent!)
    .mcpServers.valaris.env.VALARIS_MCP_TOOLSETS).toBe(toolsets);
});

it.each([
  [0, "interactive"],
  [1, "loops"],
  [2, "everything"],
] as const)("passes preset %s and the selected key to verification", async (index, intent) => {
  const user = await reachConnectWithExistingKey();
  await user.click(screen.getAllByRole("radio")[index]!);
  await user.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-verify");
  expect(verifyInputs).toHaveBeenLastCalledWith(expect.objectContaining({
    intent,
    apiKeyId: "k1",
    alreadyConnected: false,
  }));
});
