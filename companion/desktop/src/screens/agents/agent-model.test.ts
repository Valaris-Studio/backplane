// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
  AGENTS_NOW,
  brokenAgent,
  capturingAgent,
  entryFor,
  idleAgent,
  invalidConfigAgent,
  needsTrustAgent,
  notConfiguredAgent,
  notInstalledAgent,
  otelConflictAgent,
  quietCapturingAgent,
} from "./agents-fixtures";
import { agentRowKind, applyAgentEntry, configFileName, formatAgo, nextEnabledAgents, orderedAgents } from "./agent-model";

describe("agentRowKind", () => {
  it("reads receiving and uploading as capturing", () => {
    expect(agentRowKind(capturingAgent("claude_code"), null)).toBe("capturing");
    expect(agentRowKind(quietCapturingAgent("claude_code"), null)).toBe("capturing");
  });

  it("reads the quiet daemon states as idle", () => {
    for (const state of ["idle", "paused", "not_connected", "revoked"]) {
      expect(agentRowKind({ ...idleAgent("claude_code"), state }, null)).toBe("idle");
    }
  });

  it("maps each problem state to its own kind", () => {
    expect(agentRowKind(needsTrustAgent("codex_cli"), null)).toBe("needs_trust");
    expect(agentRowKind(brokenAgent("claude_code"), null)).toBe("broken");
    expect(agentRowKind(invalidConfigAgent("codex_cli"), null)).toBe("invalid_config");
    expect(agentRowKind(notInstalledAgent("pi_cli"), null)).toBe("not_installed");
  });

  it("reads a broken agent whose problem is an OpenTelemetry conflict as its own kind", () => {
    expect(agentRowKind(otelConflictAgent("codex_cli"), null)).toBe("otel_conflict");
  });

  describe("a broken integration, by what can fix it (DK-12p)", () => {
    const kindFor = (problems: string[], id = "claude_code") => agentRowKind(brokenAgent(id, problems), null);

    it("sends a file the Companion can't read to the editor, never to Repair", () => {
      for (const problem of ["settings_invalid", "hooks_invalid", "config_invalid", "config_unreadable", "extension_unreadable", "SessionStart:invalid"]) {
        expect(kindFor([problem]), problem).toBe("invalid_config");
      }
    });

    it("keeps the OpenTelemetry conflict its own kind", () => {
      expect(kindFor(["conflict_existing_otel"], "codex_cli")).toBe("otel_conflict");
    });

    it("reads hooks turned off inside Codex as the user's switch, not a repair", () => {
      expect(kindFor(["hook_disabled_in_codex"], "codex_cli")).toBe("hooks_disabled");
    });

    it("reads a foreign Pi extension as one the Companion won't overwrite", () => {
      expect(kindFor(["extension_not_owned"], "pi_cli")).toBe("foreign_extension");
    });

    it("offers Repair only for what Repair rewrites", () => {
      for (const problem of ["companion_executable_missing", "PreToolUse:missing", "Stop:stale", "otel:missing", "otel:stale", "extension:stale"]) {
        expect(kindFor([problem]), problem).toBe("broken");
      }
    });

    it("never offers Repair for a problem code this build doesn't know", () => {
      expect(kindFor(["brand_new_problem"])).toBe("unknown");
    });

    it("never offers Repair when a known repairable code comes with an unknown one", () => {
      expect(kindFor(["Stop:stale", "brand_new_problem"])).toBe("unknown");
      expect(kindFor(["companion_executable_missing", "otel:brand_new"], "codex_cli")).toBe("unknown");
    });

    it("still offers Repair when Codex also needs a restart", () => {
      expect(kindFor(["otel:stale", "restart_required"], "codex_cli")).toBe("broken");
    });

    it("never offers Repair when any problem is one Repair can't fix", () => {
      expect(kindFor(["Stop:stale", "config_invalid"], "codex_cli")).toBe("invalid_config");
      expect(kindFor(["otel:stale", "hook_disabled_in_codex"], "codex_cli")).toBe("hooks_disabled");
      expect(kindFor(["otel:stale", "conflict_existing_otel"], "codex_cli")).toBe("otel_conflict");
    });
  });

  it("reads an agent left out of enabled_agents as disabled", () => {
    expect(agentRowKind(idleAgent("pi_cli"), ["claude_code", "codex_cli"])).toBe("disabled");
  });

  it("reads null enabled_agents as every agent on", () => {
    expect(agentRowKind(idleAgent("pi_cli"), null)).toBe("idle");
  });

  it("reads an installed agent without its hook as disabled", () => {
    expect(agentRowKind(notConfiguredAgent("codex_cli"), null)).toBe("disabled");
  });

  it("keeps not installed over disabled, since there is nothing to turn on", () => {
    expect(agentRowKind(notInstalledAgent("pi_cli"), ["claude_code"])).toBe("not_installed");
  });

  it("reads a state it does not know as unknown instead of guessing", () => {
    expect(agentRowKind({ ...idleAgent("claude_code"), state: "warp_drive" }, null)).toBe("unknown");
  });
});

describe("nextEnabledAgents", () => {
  const all = ["claude_code", "codex_cli", "pi_cli"] as const;

  it("turns one off from null by writing the other agents explicitly", () => {
    expect(nextEnabledAgents(null, "codex_cli", false, all)).toEqual(["claude_code", "pi_cli"]);
  });

  it("turns one off from an explicit list", () => {
    expect(nextEnabledAgents(["claude_code", "codex_cli"], "codex_cli", false, all)).toEqual(["claude_code"]);
  });

  it("adds an agent back in the daemon's order", () => {
    expect(nextEnabledAgents(["pi_cli"], "claude_code", true, all)).toEqual(["claude_code", "pi_cli"]);
  });

  it("writes every id explicitly once every agent is on, never null", () => {
    expect(nextEnabledAgents(["claude_code", "pi_cli"], "codex_cli", true, all)).toEqual(["claude_code", "codex_cli", "pi_cli"]);
    expect(nextEnabledAgents(null, "codex_cli", true, all)).toEqual(["claude_code", "codex_cli", "pi_cli"]);
  });

  it("never duplicates an agent that is already listed", () => {
    expect(nextEnabledAgents(["claude_code"], "claude_code", true, all)).toEqual(["claude_code"]);
  });

  it("keeps ids already listed even when this app does not know them", () => {
    expect(nextEnabledAgents(["claude_code", "gemini_cli"], "pi_cli", true, all)).toEqual(["claude_code", "pi_cli", "gemini_cli"]);
    expect(nextEnabledAgents(["gemini_cli", "codex_cli"], "codex_cli", false, all)).toEqual(["gemini_cli"]);
  });

  it("starts from every id the daemon reports when the value is null", () => {
    expect(nextEnabledAgents(null, "codex_cli", false, ["claude_code", "codex_cli", "pi_cli", "gemini_cli"])).toEqual(["claude_code", "pi_cli", "gemini_cli"]);
  });
});

describe("configFileName", () => {
  it("shows only the file's base name", () => {
    expect(configFileName("/home/tester/.codex/hooks.json")).toBe("hooks.json");
    expect(configFileName("/home/tester/.claude/settings.json")).toBe("settings.json");
    expect(configFileName("C:\\home\\tester\\.codex\\hooks.json")).toBe("hooks.json");
  });

  it("never shows a directory, even one that climbs out of home", () => {
    expect(configFileName("/home/x/../../etc/passwd")).toBe("passwd");
    expect(configFileName("/home/evil/home/victim/secret.json")).toBe("secret.json");
  });

  it("rejects empty, dot and dot-dot names", () => {
    for (const path of ["", "/", "/home/x/", "/home/x/.", "/home/x/..", ".", ".."]) expect(configFileName(path)).toBeNull();
    expect(configFileName(null)).toBeNull();
  });

  it("strips control and format characters, including bidi overrides", () => {
    expect(configFileName("/tmp/\u202Egnp.json")).toBe("gnp.json");
    expect(configFileName("/tmp/a\u0007b\u0000.json")).toBe("ab.json");
    expect(configFileName("/tmp/\u200B\u2066")).toBeNull();
    expect(configFileName("/tmp/.\u200B.")).toBeNull();
  });

  it("strips line and paragraph separators and lone surrogates", () => {
    expect(configFileName("/tmp/\u2028hooks\u2029.json")).toBe("hooks.json");
    expect(configFileName("/tmp/a\uD800b\uDC00.json")).toBe("ab.json");
    expect(configFileName("/tmp/\u2028\uD800")).toBeNull();
  });
});

describe("formatAgo", () => {
  const at = (ms: number) => new Date(AGENTS_NOW.getTime() - ms).toISOString();

  it("rounds to the largest sensible unit", () => {
    expect(formatAgo(at(8_000), AGENTS_NOW)).toBe("8 s ago");
    expect(formatAgo(at(3 * 60_000 + 10_000), AGENTS_NOW)).toBe("3 min ago");
    expect(formatAgo(at(2 * 3_600_000 + 60_000), AGENTS_NOW)).toBe("2 h ago");
    expect(formatAgo(at(3 * 86_400_000), AGENTS_NOW)).toBe("3 d ago");
  });

  it("reads a timestamp from a clock ahead of ours as just now", () => {
    expect(formatAgo(new Date(AGENTS_NOW.getTime() + 5_000).toISOString(), AGENTS_NOW)).toBe("just now");
  });

  it("returns null for a missing or unparseable timestamp", () => {
    expect(formatAgo(null, AGENTS_NOW)).toBeNull();
    expect(formatAgo("yesterday-ish", AGENTS_NOW)).toBeNull();
  });
});

describe("applyAgentEntry", () => {
  it("takes the fresh integration state from a re-check", () => {
    const trusted = applyAgentEntry(needsTrustAgent("codex_cli"), entryFor(needsTrustAgent("codex_cli"), { state: "installed", trust: "trusted" }));
    expect(agentRowKind(trusted, null)).toBe("idle");
  });

  it("keeps not installed while the agent is still missing", () => {
    const pi = notInstalledAgent("pi_cli");
    expect(agentRowKind(applyAgentEntry(pi, entryFor(pi)), null)).toBe("not_installed");
  });

  it("reads a newly installed agent without a hook as off", () => {
    const pi = notInstalledAgent("pi_cli");
    expect(agentRowKind(applyAgentEntry(pi, entryFor(pi, {}, true)), null)).toBe("disabled");
  });

  it("ignores an entry without an integration", () => {
    const codex = needsTrustAgent("codex_cli");
    expect(applyAgentEntry(codex, { ...entryFor(codex), integration: null })).toBe(codex);
  });
});

describe("orderedAgents", () => {
  it("puts the known agents in their fixed order, then extras", () => {
    const ids = orderedAgents([idleAgent("pi_cli"), idleAgent("gemini_cli"), idleAgent("claude_code"), idleAgent("codex_cli")]).map((agent) => agent.id);
    expect(ids).toEqual(["claude_code", "codex_cli", "pi_cli", "gemini_cli"]);
  });

  it("skips an id that is not a plain identifier", () => {
    const ids = orderedAgents([idleAgent("claude_code"), idleAgent("<img src=x>"), idleAgent("")]).map((agent) => agent.id);
    expect(ids).toEqual(["claude_code"]);
  });
});
