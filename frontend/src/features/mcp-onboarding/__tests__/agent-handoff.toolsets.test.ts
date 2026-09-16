// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  composeAgentMessage,
  composeMcpServersJson,
  toolsetsForIntent,
  DEFAULT_HANDOFF_INTENT,
  type HandoffIntent,
} from "../agent-handoff";

// The handoff picks the server's toolset hand for the user: an interactive
// session gets `default`, interactive loop preparation adds autonomous operations,
// and an actual runner or
// an "everything" session gets the whole surface (`all`) so a stage allowlist
// is the only narrowing. The env var rides in BOTH artifacts the wizard hands
// over (the agent message and the mcpServers JSON) — a config that names only
// two env vars silently lands on the default hand, which is exactly what a
// runner launch must never do.
const ORIGIN = "https://backplane.example.test";
const API_KEY = "vlr_secret_minted_key";

interface McpServersConfig {
  mcpServers: {
    valaris: {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
  };
}

function parseJson(intent?: HandoffIntent): McpServersConfig {
  return JSON.parse(
    composeMcpServersJson(
      intent === undefined
        ? { origin: ORIGIN, apiKey: API_KEY }
        : { origin: ORIGIN, apiKey: API_KEY, intent },
    ),
  ) as McpServersConfig;
}

describe("toolsetsForIntent", () => {
  it("is exported as a function", () => {
    expect(toolsetsForIntent).toBeTypeOf("function");
  });

  it.each([
    ["interactive", "default"],
    ["loops", "default,autonomous-operations"],
    ["runner", "all"],
    ["everything", "all"],
  ] as const)("maps %s to %j", (intent, expected) => {
    expect(toolsetsForIntent(intent)).toBe(expected);
  });

  it("is pure: the same intent always yields the same value", () => {
    for (const intent of ["interactive", "loops", "runner", "everything"] as const) {
      expect(toolsetsForIntent(intent)).toBe(toolsetsForIntent(intent));
    }
  });

  it("emits supported startup selections without widening the compact default", () => {
    for (const intent of ["interactive", "loops", "runner", "everything"] as const) {
      expect(["default", "default,autonomous-operations", "all"]).toContain(toolsetsForIntent(intent));
    }
  });
});

describe("composeMcpServersJson — VALARIS_MCP_TOOLSETS per intent", () => {
  it("pins the interactive intent to the default hand", () => {
    const config = parseJson("interactive");
    expect(config.mcpServers.valaris.env.VALARIS_MCP_TOOLSETS).toBe("default");
  });

  it("gives the runner intent the whole surface", () => {
    const config = parseJson("runner");
    expect(config.mcpServers.valaris.env.VALARIS_MCP_TOOLSETS).toBe("all");
  });

  it("gives the everything intent the whole surface", () => {
    const config = parseJson("everything");
    expect(config.mcpServers.valaris.env.VALARIS_MCP_TOOLSETS).toBe("all");
  });

  it("defaults to the interactive hand when intent is omitted", () => {
    const config = parseJson();
    expect(config.mcpServers.valaris.env.VALARIS_MCP_TOOLSETS).toBe("default");
  });

  it("keeps the two original env vars next to the new one", () => {
    const env = parseJson("interactive").mcpServers.valaris.env;
    expect(env).toEqual({
      VALARIS_API_URL: ORIGIN,
      VALARIS_API_KEY: API_KEY,
      VALARIS_MCP_TOOLSETS: "default",
    });
  });

  it("still serializes as pretty-printed JSON with the toolsets line", () => {
    expect(
      composeMcpServersJson({ origin: ORIGIN, apiKey: API_KEY, intent: "interactive" }),
    ).toContain('"VALARIS_MCP_TOOLSETS": "default"');
    expect(
      composeMcpServersJson({ origin: ORIGIN, apiKey: API_KEY, intent: "runner" }),
    ).toContain('"VALARIS_MCP_TOOLSETS": "all"');
  });
});

describe("composeAgentMessage — toolsets guidance per intent", () => {
  it("interactive names the env var, the default hand, and how to widen it", () => {
    const message = composeAgentMessage({
      origin: ORIGIN,
      apiKey: API_KEY,
      intent: "interactive",
    });
    expect(message).toContain("VALARIS_MCP_TOOLSETS=default");
    expect(message).toContain("get_server_info");
    expect(message).toContain("VALARIS_MCP_TOOLSETS=all");
  });

  it("interactive explains client-dependent refresh and recovery for a cached catalog", () => {
    const message = composeAgentMessage({
      origin: ORIGIN,
      apiKey: API_KEY,
      intent: "interactive",
    });
    expect(message).toMatch(/enable_toolsets/);
    expect(message).toContain("returned restart_env");
    expect(message).not.toMatch(/without a restart/i);
    expect(message).toContain("tools/list_changed");
    expect(message).toContain("VALARIS_MCP_TOOLSETS=default,autonomous-operations");
    expect(message).toMatch(/restart the MCP server.*new agent session/i);
    expect(message).toMatch(/old server process/i);
  });

  it("interactive is the default when intent is omitted", () => {
    expect(composeAgentMessage({ origin: ORIGIN, apiKey: API_KEY })).toContain(
      "VALARIS_MCP_TOOLSETS=default",
    );
  });

  it("runner sets the env var to all and says every tool loads", () => {
    const message = composeAgentMessage({
      origin: ORIGIN,
      apiKey: API_KEY,
      intent: "runner",
    });
    expect(message).toContain("VALARIS_MCP_TOOLSETS=all");
    expect(message).not.toContain("VALARIS_MCP_TOOLSETS=default");
    expect(message).toMatch(/every tool/i);
  });

  it("everything sets the env var to all", () => {
    expect(
      composeAgentMessage({ origin: ORIGIN, apiKey: API_KEY, intent: "everything" }),
    ).toContain("VALARIS_MCP_TOOLSETS=all");
  });

  it.each(["interactive", "loops", "runner", "everything"] as const)(
    "%s still ends with the whoami instruction (step 5 listens for it)",
    (intent) => {
      const lines = composeAgentMessage({ origin: ORIGIN, apiKey: API_KEY, intent })
        .trim()
        .split("\n");
      expect(lines.at(-1)).toMatch(/`whoami`/);
    },
  );

  it.each(["interactive", "loops", "runner", "everything"] as const)(
    "%s keeps the origin and key lines intact",
    (intent) => {
      const message = composeAgentMessage({ origin: ORIGIN, apiKey: API_KEY, intent });
      expect(message).toContain(`VALARIS_API_URL=${ORIGIN}`);
      expect(message).toContain(`VALARIS_API_KEY=${API_KEY}`);
    },
  );
});


describe("interactive loop preparation is distinct from actual runner execution", () => {
  it("keeps everyday work as the shared default", () => {
    expect(DEFAULT_HANDOFF_INTENT).toBe("interactive");
  });

  it("starts the loop connection with default and autonomous operations in both artifacts", () => {
    const message = composeAgentMessage({ origin: ORIGIN, apiKey: API_KEY, intent: "loops" });
    const env = parseJson("loops").mcpServers.valaris.env;
    expect(env.VALARIS_MCP_TOOLSETS).toBe("default,autonomous-operations");
    expect(message.split("\n")).toContain("  VALARIS_MCP_TOOLSETS=default,autonomous-operations");
    expect(env.VALARIS_API_URL).toBe(ORIGIN);
    expect(env.VALARIS_API_KEY).toBe(API_KEY);
  });

  it("preserves actual runner all selection and the stage allowlist contract", () => {
    expect(toolsetsForIntent("runner")).toBe("all");
    expect(parseJson("runner").mcpServers.valaris.env.VALARIS_MCP_TOOLSETS).toBe("all");
    const message = composeAgentMessage({ origin: ORIGIN, apiKey: API_KEY, intent: "runner" });
    expect(message).toMatch(/stage allowlist.*only narrowing/i);
  });

  it.each(["interactive", "loops"] as const)(
    "%s recovery preserves the returned custom startup groups",
    (intent) => {
      const message = composeAgentMessage({ origin: ORIGIN, apiKey: API_KEY, intent });
      expect(message).toContain("restart_env");
      expect(message).toMatch(/preserv[^.]*?(every|all)[^.]*?(group|toolset)/i);
      expect(message).toMatch(/restart the MCP server.*new agent session/i);
    },
  );

  it.each(["interactive", "loops", "everything"] as const)(
    "%s remains a local stdio launch even with a remote API origin",
    (intent) => {
      const server = parseJson(intent).mcpServers.valaris;
      expect(server.command).toBe("uvx");
      expect(server.args).toEqual(["backplane-mcp"]);
      expect(server).not.toHaveProperty("url");
      expect(server).not.toHaveProperty("transport", "http");
      expect(server.env.VALARIS_API_URL).toBe(ORIGIN);
      const message = composeAgentMessage({ origin: ORIGIN, apiKey: API_KEY, intent });
      expect(message).toContain("uvx backplane-mcp");
    },
  );
});


it.each(["interactive", "loops", "runner", "everything"] as const)(
  "%s handoff preserves existing operator configuration and allowlists",
  (intent) => {
    const message = composeAgentMessage({ origin: ORIGIN, apiKey: API_KEY, intent });
    expect(message).toMatch(/fresh (local )?(stdio )?connection/i);
    expect(message).toMatch(/preserve[^.]*existing[^.]*custom[^.]*toolset/i);
    expect(message).toMatch(/never remove[^.]*allowlist/i);
    expect(message).toMatch(/remote MCP HTTP[^.]*operator/i);
    expect(message).toMatch(/local client env[^.]*cannot configure/i);
  },
);
