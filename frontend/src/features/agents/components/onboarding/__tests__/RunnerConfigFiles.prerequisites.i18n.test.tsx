// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "@/i18n/config";
import { renderWithProviders, screen } from "@/test/test-utils";
import { RunnerConfigFiles } from "../RunnerConfigFiles";

const BASE_CONFIG = {
  runner_yaml: "valaris: {}",
  mcp_config_json: "{}",
};

interface StructuredPrerequisiteMessage {
  code: string;
  params: Record<string, unknown>;
}

function boardPrerequisiteMessages(): StructuredPrerequisiteMessage[] {
  return [
    { code: "agent_key_create", params: {} },
    {
      code: "coding_agents_on_path",
      params: { provider_ids: ["claude-cli", "codex-cli"] },
    },
    { code: "mcp_uv", params: {} },
    { code: "github_auth", params: {} },
  ];
}

function agentPrerequisiteMessages(
  agentName: string,
  extraAgentParams: Record<string, unknown> = {},
): StructuredPrerequisiteMessage[] {
  return [
    {
      code: "agent_key_export_or_rotate",
      params: { agent_name: agentName, ...extraAgentParams },
    },
    {
      code: "coding_agents_on_path",
      params: { provider_ids: ["claude-cli"] },
    },
    { code: "mcp_uv", params: {} },
    { code: "github_auth", params: {} },
  ];
}

function extendedForgePrerequisiteMessages(): StructuredPrerequisiteMessage[] {
  return [
    { code: "agent_key_create", params: {} },
    { code: "team_binding", params: { workspace_slug: "sandbox-workspace" } },
    {
      code: "coding_agents_on_path",
      params: { provider_ids: ["custom-provider"] },
    },
    { code: "mcp_uv", params: {} },
    { code: "forge_auth", params: { forge: "gitea" } },
    { code: "visual_testing", params: {} },
    { code: "git_repo_missing", params: {} },
  ];
}

function legacyPrerequisites(
  messages: StructuredPrerequisiteMessage[],
  prefix = "legacy prerequisite",
) {
  return messages.map((_message, index) => `${prefix} ${index}`);
}

function replaceParams(
  messages: StructuredPrerequisiteMessage[],
  code: string,
  params: Record<string, unknown>,
) {
  return messages.map((message) =>
    message.code === code ? { ...message, params } : message,
  );
}

describe("RunnerConfigFiles prerequisite localization", () => {
  beforeEach(async () => {
    await act(async () => {
      await i18n.changeLanguage("en");
    });
  });

  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage("en");
    });
  });

  it("prefers an aligned structured message and preserves provider IDs", () => {
    const messages = boardPrerequisiteMessages();
    const legacy = legacyPrerequisites(messages, "legacy provider prerequisite");

    renderWithProviders(
      <RunnerConfigFiles
        data={{
          ...BASE_CONFIG,
          prerequisites: legacy,
          prerequisite_messages: messages,
        }}
        isLoading={false}
        isError={false}
      />,
    );

    expect(screen.getByText(/claude-cli, codex-cli/)).toBeInTheDocument();
    expect(screen.queryByText(legacy[0]!)).not.toBeInTheDocument();
  });

  it("rerenders a structured message when the language changes", async () => {
    const messages = agentPrerequisiteMessages("runner-brasil");

    renderWithProviders(
      <RunnerConfigFiles
        data={{
          ...BASE_CONFIG,
          prerequisites: legacyPrerequisites(messages),
          prerequisite_messages: messages,
        }}
        isLoading={false}
        isError={false}
      />,
    );

    expect(screen.getByText(/export the key for 'runner-brasil'/i)).toBeInTheDocument();

    await act(async () => {
      await i18n.changeLanguage("pt-BR");
    });

    const portugueseMessage = screen.getByText(
      /exporte a chave de 'runner-brasil'/i,
    );
    expect(portugueseMessage).toHaveTextContent("VALARIS_API_KEY");
  });

  it("falls back when wire params contain translation options", () => {
    const messages = agentPrerequisiteMessages("runner-safe", {
      defaultValue: "wire options must not render",
      lng: "pt-BR",
      ns: "untrusted-namespace",
    });
    const legacy = legacyPrerequisites(messages, "translation-options legacy");

    renderWithProviders(
      <RunnerConfigFiles
        data={{
          ...BASE_CONFIG,
          prerequisites: legacy,
          prerequisite_messages: messages,
        }}
        isLoading={false}
        isError={false}
      />,
    );

    for (const legacyPrerequisite of legacy) {
      expect(screen.getByText(legacyPrerequisite)).toBeInTheDocument();
    }
    expect(screen.queryByText("wire options must not render")).not.toBeInTheDocument();
  });

  it("accepts the optional messages and the forge authentication variant", () => {
    const messages = extendedForgePrerequisiteMessages();
    const legacy = legacyPrerequisites(messages);

    renderWithProviders(
      <RunnerConfigFiles
        data={{
          ...BASE_CONFIG,
          prerequisites: legacy,
          prerequisite_messages: messages,
        }}
        isLoading={false}
        isError={false}
      />,
    );

    expect(screen.getByText(/sandbox-workspace/)).toBeInTheDocument();
    expect(screen.getByText(/gitea/)).toBeInTheDocument();
    expect(screen.getByText(/valaris-visual-testing/)).toBeInTheDocument();
    expect(screen.queryByText(legacy[0]!)).not.toBeInTheDocument();
  });

  it("renders the exact legacy prerequisite when structured messages are absent", () => {
    const legacyPrerequisite = "Legacy text from the API, unchanged.";

    renderWithProviders(
      <RunnerConfigFiles
        data={{
          ...BASE_CONFIG,
          prerequisites: [legacyPrerequisite],
        }}
        isLoading={false}
        isError={false}
      />,
    );

    expect(screen.getByText(legacyPrerequisite)).toBeInTheDocument();
  });

  it("falls back to the entire legacy list when any code is unknown", () => {
    const messages = [
      ...boardPrerequisiteMessages(),
      { code: "future_prerequisite", params: {} },
    ];
    const legacy = legacyPrerequisites(messages, "unknown-code legacy text");

    renderWithProviders(
      <RunnerConfigFiles
        data={{
          ...BASE_CONFIG,
          prerequisites: legacy,
          prerequisite_messages: messages,
        }}
        isLoading={false}
        isError={false}
      />,
    );

    for (const legacyPrerequisite of legacy) {
      expect(screen.getByText(legacyPrerequisite)).toBeInTheDocument();
    }
    expect(screen.queryByText(/uvx backplane-mcp/)).not.toBeInTheDocument();
  });

  it("falls back to the entire legacy list when structured messages are misaligned", () => {
    const messages = boardPrerequisiteMessages();
    const legacy = [
      ...legacyPrerequisites(messages, "misaligned legacy prerequisite"),
      "extra legacy prerequisite",
    ];

    renderWithProviders(
      <RunnerConfigFiles
        data={{
          ...BASE_CONFIG,
          prerequisites: legacy,
          prerequisite_messages: messages,
        }}
        isLoading={false}
        isError={false}
      />,
    );

    for (const legacyPrerequisite of legacy) {
      expect(screen.getByText(legacyPrerequisite)).toBeInTheDocument();
    }
    expect(screen.queryByText(/uvx backplane-mcp/)).not.toBeInTheDocument();
  });

  it.each([
    [
      "a duplicate known code",
      [...boardPrerequisiteMessages(), { code: "mcp_uv", params: {} }],
    ],
    [
      "both agent-key variants",
      [
        { code: "agent_key_export_or_rotate", params: { agent_name: "runner" } },
        ...boardPrerequisiteMessages(),
      ],
    ],
    [
      "no agent-key variant",
      boardPrerequisiteMessages().filter(
        ({ code }) => code !== "agent_key_create",
      ),
    ],
    [
      "no coding-agent prerequisite",
      boardPrerequisiteMessages().filter(
        ({ code }) => code !== "coding_agents_on_path",
      ),
    ],
    [
      "no MCP prerequisite",
      boardPrerequisiteMessages().filter(({ code }) => code !== "mcp_uv"),
    ],
    [
      "both forge-auth variants",
      [
        ...boardPrerequisiteMessages(),
        { code: "forge_auth", params: { forge: "gitea" } },
      ],
    ],
    [
      "no forge-auth variant",
      boardPrerequisiteMessages().filter(({ code }) => code !== "github_auth"),
    ],
  ])(
    "falls back to the entire legacy list when structured messages contain %s",
    (_scenario, messages) => {
      const legacy = legacyPrerequisites(
        messages,
        "invalid-combination legacy prerequisite",
      );

      renderWithProviders(
        <RunnerConfigFiles
          data={{
            ...BASE_CONFIG,
            prerequisites: legacy,
            prerequisite_messages: messages,
          }}
          isLoading={false}
          isError={false}
        />,
      );

      for (const legacyPrerequisite of legacy) {
        expect(screen.getByText(legacyPrerequisite)).toBeInTheDocument();
      }
      expect(screen.queryByText(/uvx backplane-mcp/)).not.toBeInTheDocument();
    },
  );

  it.each([
    [
      "agent_key_create has extra params",
      replaceParams(boardPrerequisiteMessages(), "agent_key_create", {
        extra: true,
      }),
    ],
    [
      "agent_key_export_or_rotate is missing agent_name",
      replaceParams(
        agentPrerequisiteMessages("runner"),
        "agent_key_export_or_rotate",
        {},
      ),
    ],
    [
      "agent_key_export_or_rotate has a non-string agent_name",
      replaceParams(
        agentPrerequisiteMessages("runner"),
        "agent_key_export_or_rotate",
        { agent_name: 7 },
      ),
    ],
    [
      "agent_key_export_or_rotate has an extra param",
      replaceParams(
        agentPrerequisiteMessages("runner"),
        "agent_key_export_or_rotate",
        { agent_name: "runner", extra: true },
      ),
    ],
    [
      "team_binding has a non-string workspace_slug",
      replaceParams(
        extendedForgePrerequisiteMessages(),
        "team_binding",
        { workspace_slug: 7 },
      ),
    ],
    [
      "coding_agents_on_path has a non-array provider_ids",
      replaceParams(
        boardPrerequisiteMessages(),
        "coding_agents_on_path",
        { provider_ids: "claude-cli" },
      ),
    ],
    [
      "coding_agents_on_path has a non-string provider ID",
      replaceParams(
        boardPrerequisiteMessages(),
        "coding_agents_on_path",
        { provider_ids: ["claude-cli", 7] },
      ),
    ],
    [
      "mcp_uv has extra params",
      replaceParams(boardPrerequisiteMessages(), "mcp_uv", { extra: true }),
    ],
    [
      "github_auth has extra params",
      replaceParams(boardPrerequisiteMessages(), "github_auth", {
        extra: true,
      }),
    ],
    [
      "forge_auth has a non-string forge",
      replaceParams(
        extendedForgePrerequisiteMessages(),
        "forge_auth",
        { forge: 7 },
      ),
    ],
    [
      "visual_testing has extra params",
      replaceParams(
        extendedForgePrerequisiteMessages(),
        "visual_testing",
        { extra: true },
      ),
    ],
    [
      "git_repo_missing has extra params",
      replaceParams(
        extendedForgePrerequisiteMessages(),
        "git_repo_missing",
        { extra: true },
      ),
    ],
  ])(
    "falls back to the entire legacy list when %s",
    (_scenario, messages) => {
      const legacy = legacyPrerequisites(
        messages,
        "invalid-params legacy prerequisite",
      );

      renderWithProviders(
        <RunnerConfigFiles
          data={{
            ...BASE_CONFIG,
            prerequisites: legacy,
            prerequisite_messages: messages,
          }}
          isLoading={false}
          isError={false}
        />,
      );

      for (const legacyPrerequisite of legacy) {
        expect(screen.getByText(legacyPrerequisite)).toBeInTheDocument();
      }
      expect(screen.queryByText(/uvx backplane-mcp/)).not.toBeInTheDocument();
    },
  );

  it.each([
    ["missing", undefined],
    ["null", null],
    ["array", []],
  ])(
    "falls back to the entire legacy list when params are %s",
    (_scenario, invalidParams) => {
      const messages = replaceParams(
        agentPrerequisiteMessages("runner-safe"),
        "github_auth",
        invalidParams as unknown as Record<string, unknown>,
      );
      const legacy = legacyPrerequisites(
        messages,
        "malformed-params legacy prerequisite",
      );

      renderWithProviders(
        <RunnerConfigFiles
          data={{
            ...BASE_CONFIG,
            prerequisites: legacy,
            prerequisite_messages: messages,
          }}
          isLoading={false}
          isError={false}
        />,
      );

      for (const legacyPrerequisite of legacy) {
        expect(screen.getByText(legacyPrerequisite)).toBeInTheDocument();
      }
      expect(screen.queryByText(/uvx backplane-mcp/)).not.toBeInTheDocument();
    },
  );
});
