// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, within, userEvent } from "@/test/test-utils";
import i18n from "@/i18n/config";
import { copyTextToClipboard } from "@/lib/clipboard";

vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: vi.fn() }));

// Step 4 is the money step. Its primary surface is ONE copyable block phrased
// as a message to the user's coding agent — English regardless of UI locale,
// because the reader is an agent, not the user. It carries the real origin and,
// when the key was minted in this session, the real key: removing the most
// error-prone manual step is the whole point. The closing `whoami` instruction
// is load-bearing — it is what makes step 5's listener fire.
import {
  apiKey,
  mockApiKeys,
  mockCreateApiKey,
  mockMe,
  ORIGIN,
  renderWizard,
  stubMatchMedia,
} from "./wizard-harness";

beforeEach(() => {
  stubMatchMedia(true);
  mockMe();
  mockCreateApiKey();
  vi.mocked(copyTextToClipboard).mockResolvedValue(true);
});

afterEach(() => stubMatchMedia(false));

async function connectAfterMinting() {
  const user = userEvent.setup();
  renderWizard();
  await user.click(await screen.findByTestId("wizard-next"));
  await user.click(await screen.findByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-key");
  await user.click(await screen.findByTestId("wizard-create-key"));
  await screen.findByTestId("wizard-raw-key");
  await user.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-connect");
  return user;
}

async function connectAfterPickingExisting() {
  const user = userEvent.setup();
  renderWizard();
  await screen.findByTestId("wizard-step-key");
  await user.click(await screen.findByTestId("wizard-pick-key-k1"));
  await user.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-connect");
  return user;
}

describe("StepConnect — the agent handoff message", () => {
  it("carries the uvx invocation, the origin, and the whoami instruction", async () => {
    mockApiKeys([]);
    await connectAfterMinting();

    const message = screen.getByTestId("wizard-agent-message");
    expect(message).toHaveTextContent("uvx backplane-mcp");
    expect(message).toHaveTextContent(`VALARIS_API_URL=${ORIGIN}`);
    expect(message).toHaveTextContent(/whoami/);
    expect(message).toHaveTextContent(/backplane-mcp/);
    expect(message).toHaveTextContent(/mcp-server/);
  });

  it("interpolates the key minted in this session", async () => {
    mockApiKeys([]);
    await connectAfterMinting();

    expect(screen.getByTestId("wizard-agent-message")).toHaveTextContent(
      "VALARIS_API_KEY=vlr_secret_minted_key",
    );
  });

  it("uses a placeholder plus a substitution hint when an existing key was picked", async () => {
    mockApiKeys([apiKey({ id: "k1" })]);
    await connectAfterPickingExisting();

    const message = screen.getByTestId("wizard-agent-message");
    expect(message).toHaveTextContent("<your API key vlr_…>");
    expect(message).not.toHaveTextContent("vlr_secret_minted_key");
    expect(screen.getByTestId("wizard-key-substitute-hint")).toBeInTheDocument();
  });

  it("keeps the advanced configuration behind a disclosure", async () => {
    mockApiKeys([]);
    const user = await connectAfterMinting();

    expect(screen.queryByTestId("wizard-mcp-json")).toBeNull();

    await user.click(screen.getByTestId("wizard-advanced-toggle"));

    const json = await screen.findByTestId("wizard-mcp-json");
    expect(json).toHaveTextContent('"mcpServers"');
    expect(json).toHaveTextContent('"valaris"');
    expect(json).toHaveTextContent('"command": "uvx"');
    expect(json).toHaveTextContent('"backplane-mcp"');
    expect(json).toHaveTextContent(ORIGIN);
  });

  it("documents all three environment variables in the advanced pane", async () => {
    mockApiKeys([]);
    const user = await connectAfterMinting();
    await user.click(screen.getByTestId("wizard-advanced-toggle"));

    const envs = await screen.findByTestId("wizard-env-vars");
    expect(within(envs).getByText("VALARIS_API_URL")).toBeInTheDocument();
    expect(within(envs).getByText("VALARIS_API_KEY")).toBeInTheDocument();
    expect(within(envs).getByText("VALARIS_AGENT_EMAIL")).toBeInTheDocument();
  });

  it("offers the git install fallback and the package links", async () => {
    mockApiKeys([]);
    const user = await connectAfterMinting();
    await user.click(screen.getByTestId("wizard-advanced-toggle"));

    expect(await screen.findByTestId("wizard-git-install")).toHaveTextContent(
      "uvx --from \"git+https://github.com/Valaris-Studio/backplane.git#subdirectory=mcp-server\" backplane-mcp",
    );
    expect(screen.getByTestId("wizard-pypi-link")).toHaveAttribute(
      "href",
      "https://pypi.org/project/backplane-mcp/",
    );
    expect(screen.getByTestId("wizard-github-link")).toHaveAttribute(
      "href",
      "https://github.com/Valaris-Studio/backplane",
    );
  });

  it("names the message's copy button accessibly", async () => {
    mockApiKeys([]);
    await connectAfterMinting();

    expect(
      screen.getByRole("button", { name: "Copy the message for your agent" }),
    ).toBeInTheDocument();
  });
});

// --- MCP #2: toolset intent picker -----------------------------------------
//
// The wizard picks the server's toolset hand for the user: interactive
// sessions get `default`, loops add autonomous operations, and everything
// gets `all`. Labels come from i18n (mcpOnboarding.connectIntent*);
// the test resolves them through the same catalog the component reads so a
// renamed key fails here rather than shipping raw-key fallback copy.

function intentCopy(key: string): string {
  const fullKey = `mcpOnboarding.${key}`;
  const value = i18n.t(fullKey);
  expect(value, `${fullKey} is missing from en.json`).not.toBe(fullKey);
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function intentTile(name: string) {
  return screen.getByRole("radio", { name: new RegExp(escapeRegExp(name)) });
}

async function openAdvancedJson(user: ReturnType<typeof userEvent.setup>) {
  if (!screen.queryByTestId("wizard-mcp-json")) await user.click(screen.getByTestId("wizard-advanced-toggle"));
  return screen.findByTestId("wizard-mcp-json");
}

describe("StepConnect — the toolset intent picker", () => {
  it("renders a labelled radio group with exactly three intent tiles", async () => {
    mockApiKeys([]);
    await connectAfterMinting();
    await userEvent.setup().click(screen.getByTestId("wizard-advanced-toggle"));

    const picker = screen.getByRole("radiogroup", {
      name: new RegExp(escapeRegExp(intentCopy("connectIntentHeading"))),
    });
    expect(within(picker).getAllByRole("radio")).toHaveLength(3);
    expect(intentTile(intentCopy("connectIntentInteractive"))).toBeInTheDocument();
    expect(intentTile(intentCopy("connectIntentRunner"))).toBeInTheDocument();
    expect(intentTile(intentCopy("connectIntentEverything"))).toBeInTheDocument();
  });

  it("describes each tile with its i18n body copy", async () => {
    mockApiKeys([]);
    await connectAfterMinting();
    await userEvent.setup().click(screen.getByTestId("wizard-advanced-toggle"));

    const step = screen.getByTestId("wizard-step-connect");
    expect(step).toHaveTextContent(intentCopy("connectIntentInteractiveBody"));
    expect(step).toHaveTextContent(intentCopy("connectIntentRunnerBody"));
    expect(step).toHaveTextContent(intentCopy("connectIntentEverythingBody"));
  });

  it("selects the interactive tile by default", async () => {
    mockApiKeys([]);
    await connectAfterMinting();
    await userEvent.setup().click(screen.getByTestId("wizard-advanced-toggle"));

    expect(intentTile(intentCopy("connectIntentInteractive"))).toBeChecked();
    expect(intentTile(intentCopy("connectIntentRunner"))).not.toBeChecked();
    expect(intentTile(intentCopy("connectIntentEverything"))).not.toBeChecked();
  });

  it("emits VALARIS_MCP_TOOLSETS=default in the JSON while interactive is selected", async () => {
    mockApiKeys([]);
    const user = await connectAfterMinting();
    await user.click(screen.getByTestId("wizard-advanced-toggle"));

    const json = await openAdvancedJson(user);
    expect(json).toHaveTextContent('"VALARIS_MCP_TOOLSETS": "default"');
  });

  it("switches the JSON to the interactive loop groups when the middle tile is chosen", async () => {
    mockApiKeys([]);
    const user = await connectAfterMinting();
    await user.click(screen.getByTestId("wizard-advanced-toggle"));

    await user.click(intentTile(intentCopy("connectIntentRunner")));
    expect(intentTile(intentCopy("connectIntentRunner"))).toBeChecked();
    expect(intentTile(intentCopy("connectIntentInteractive"))).not.toBeChecked();

    const json = await openAdvancedJson(user);
    expect(json).toHaveTextContent('"VALARIS_MCP_TOOLSETS": "default,autonomous-operations"');
    expect(json).not.toHaveTextContent('"VALARIS_MCP_TOOLSETS": "default"');
  });

  it("switches the JSON to all for everything and back to default for interactive", async () => {
    mockApiKeys([]);
    const user = await connectAfterMinting();
    await user.click(screen.getByTestId("wizard-advanced-toggle"));
    const json = await openAdvancedJson(user);

    await user.click(intentTile(intentCopy("connectIntentEverything")));
    expect(json).toHaveTextContent('"VALARIS_MCP_TOOLSETS": "all"');

    await user.click(intentTile(intentCopy("connectIntentInteractive")));
    expect(json).toHaveTextContent('"VALARIS_MCP_TOOLSETS": "default"');
  });

  it("re-composes the agent message when the intent changes", async () => {
    mockApiKeys([]);
    const user = await connectAfterMinting();
    await user.click(screen.getByTestId("wizard-advanced-toggle"));

    const message = screen.getByTestId("wizard-agent-message");
    expect(message).toHaveTextContent("VALARIS_MCP_TOOLSETS=default");
    expect(message).toHaveTextContent(/get_server_info/);
    // The server can widen its catalog; the client still needs to discover it.
    expect(message).toHaveTextContent(/enable_toolsets/);

    await user.click(intentTile(intentCopy("connectIntentRunner")));
    expect(message).toHaveTextContent("VALARIS_MCP_TOOLSETS=default,autonomous-operations");
    expect(message).toHaveTextContent(/whoami/);
  });

  it("lists VALARIS_MCP_TOOLSETS in the env table with its i18n description", async () => {
    mockApiKeys([]);
    const user = await connectAfterMinting();
    await user.click(screen.getByTestId("wizard-advanced-toggle"));

    const envs = await screen.findByTestId("wizard-env-vars");
    expect(within(envs).getByText("VALARIS_MCP_TOOLSETS")).toBeInTheDocument();
    expect(envs).toHaveTextContent(intentCopy("connectEnvToolsets"));
    // The three original rows survive; the new one joins them.
    expect(within(envs).getByText("VALARIS_API_URL")).toBeInTheDocument();
    expect(within(envs).getByText("VALARIS_API_KEY")).toBeInTheDocument();
    expect(within(envs).getByText("VALARIS_AGENT_EMAIL")).toBeInTheDocument();
  });
});


it("shows startup tool choices before the message while keeping skills in advanced", async () => {
  mockApiKeys([]);
  const user = await connectAfterMinting();
  const picker = screen.getByRole("radiogroup");
  expect(picker).toBeVisible();
  expect(
    picker.compareDocumentPosition(screen.getByTestId("wizard-agent-message")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await user.click(intentTile(intentCopy("connectIntentEverything")));
  expect(screen.getByTestId("wizard-agent-message")).toHaveTextContent("VALARIS_MCP_TOOLSETS=all");
  expect(screen.queryByTestId("wizard-skills-fit")).toBeNull();
  expect(screen.getByTestId("wizard-agent-message")).toHaveTextContent("whoami");
  await user.click(screen.getByTestId("wizard-advanced-toggle"));
  expect(screen.getByRole("radiogroup")).toBeInTheDocument();
});


it("names the three human connection presets without offering actual runner execution", async () => {
  mockApiKeys([apiKey({ id: "k1" })]);
  await connectAfterPickingExisting();
  expect(screen.getAllByRole("radio").map((radio) => radio.getAttribute("value")))
    .toEqual(["interactive", "loops", "everything"]);
  expect(screen.getByRole("radio", { name: "Everyday project work" })).toBeChecked();
  expect(screen.getByRole("radio", { name: "Loops and runners" })).not.toBeChecked();
  expect(screen.getByRole("radio", { name: "Everything" })).not.toBeChecked();
});

it("copies the current preset in both artifacts after each selection change", async () => {
  mockApiKeys([]);
  const user = await connectAfterMinting();
  await openAdvancedJson(user);
  const radios = screen.getAllByRole("radio");
  for (const [index, toolsets] of [
    [0, "default"],
    [1, "default,autonomous-operations"],
    [2, "all"],
    [0, "default"],
  ] as const) {
    await user.click(radios[index]!);
    await user.click(screen.getByRole("button", { name: "Copy the message for your agent" }));
    const message = vi.mocked(copyTextToClipboard).mock.lastCall?.[0];
    expect(message).toBe(screen.getByTestId("wizard-agent-message").textContent);
    expect(message?.split("\n")).toContain(`  VALARIS_MCP_TOOLSETS=${toolsets}`);
    expect(message).toContain("whoami");
    await user.click(screen.getByRole("button", { name: i18n.t("a11y.mcpOnboarding.copyJson") }));
    const json = vi.mocked(copyTextToClipboard).mock.lastCall?.[0];
    expect(json).toBe(screen.getByTestId("wizard-mcp-json").textContent);
    expect(JSON.parse(json!).mcpServers.valaris.env).toEqual({
      VALARIS_API_URL: ORIGIN,
      VALARIS_API_KEY: "vlr_secret_minted_key",
      VALARIS_MCP_TOOLSETS: toolsets,
    });
  }
});

it("supports keyboard selection before any configuration is expanded", async () => {
  mockApiKeys([apiKey({ id: "k1" })]);
  const user = await connectAfterPickingExisting();
  const radios = screen.getAllByRole("radio");
  radios[0]!.focus();
  await user.keyboard("{ArrowRight}");
  expect(radios[1]).toBeChecked();
  expect(radios[1]).toHaveFocus();
  expect(screen.getByTestId("wizard-agent-message").textContent?.split("\n"))
    .toContain("  VALARIS_MCP_TOOLSETS=default,autonomous-operations");
  expect(screen.queryByTestId("wizard-mcp-json")).toBeNull();
});
