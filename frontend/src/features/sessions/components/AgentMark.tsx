// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cn } from "@/lib/utils";

type AgentFamily = "claude" | "codex" | "pi" | "other";

// Monograms match the Companion desktop app, so one agent reads the same on
// both surfaces. They are marks, not copy, and are never translated.
const MONOGRAM_BY_FAMILY: Record<Exclude<AgentFamily, "other">, string> = {
  claude: "CC",
  codex: "Cx",
  pi: "Pi",
};

const FAMILY_BY_HARNESS: Record<string, AgentFamily> = {
  claude_code: "claude",
  codex_cli: "codex",
  codex_desktop: "codex",
  pi_cli: "pi",
};

const HUE_BY_FAMILY: Record<AgentFamily, string> = {
  claude: "var(--color-agent-claude)",
  codex: "var(--color-agent-codex)",
  pi: "var(--color-agent-pi)",
  other: "var(--color-agent-other)",
};

export function agentFamily(harness: string): AgentFamily {
  return FAMILY_BY_HARNESS[harness] ?? "other";
}

// An agent as people see it: one mark per family (Codex CLI and the Codex app
// are both "Cx"), an unknown harness on its own. Product names, not copy.
const FAMILY_NAMES: Record<Exclude<AgentFamily, "other">, string> = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
};
const FAMILY_HARNESSES: Record<Exclude<AgentFamily, "other">, string[]> = {
  claude: ["claude_code"],
  codex: ["codex_cli", "codex_desktop"],
  pi: ["pi_cli"],
};
export const AGENT_KEY_ORDER = ["claude", "codex", "pi"];

// Device heartbeats name harnesses by id only; sessions carry the server's
// display name. Product names, not copy.
const HARNESS_NAMES: Record<string, string> = {
  claude_code: "Claude Code",
  codex_cli: "Codex CLI",
  codex_desktop: "Codex app",
  pi_cli: "Pi",
};

export function harnessName(harness: string): string {
  return HARNESS_NAMES[harness] ?? harness;
}

export function agentKey(harness: string): string {
  const family = agentFamily(harness);
  return family === "other" ? harness : family;
}

export function agentKeyName(key: string, fallback?: string): string {
  return key in FAMILY_NAMES ? FAMILY_NAMES[key as keyof typeof FAMILY_NAMES] : (fallback ?? key);
}

// The list endpoint filters one exact harness; a family with several needs
// the filter applied to the loaded rows instead.
export function serverHarnessFor(key: string): string | undefined {
  if (!(key in FAMILY_HARNESSES)) return key;
  const harnesses = FAMILY_HARNESSES[key as keyof typeof FAMILY_HARNESSES];
  return harnesses.length === 1 ? harnesses[0] : undefined;
}

// Agent keys use the family; a bare harness in an older link still resolves.
export function normaliseAgentKey(value: string): string {
  return FAMILY_BY_HARNESS[value] ? agentKey(value) : value;
}

// The harness to draw a family's mark with.
export function markHarnessFor(key: string): string {
  return key in FAMILY_HARNESSES ? (FAMILY_HARNESSES[key as keyof typeof FAMILY_HARNESSES][0] ?? key) : key;
}

export function agentMonogram(harness: string, displayName: string): string {
  const family = agentFamily(harness);
  if (family !== "other") return MONOGRAM_BY_FAMILY[family];
  const letters = displayName.replace(/[^\p{L}\p{N}]/gu, "");
  return (letters.slice(0, 1).toUpperCase() + letters.slice(1, 2).toLowerCase()) || "?";
}

const SIZE_CLASSES = {
  sm: "size-[1.6rem] text-[0.79rem]",
  md: "size-[1.9rem] text-[0.79rem]",
  lg: "size-11 text-base",
} as const;

interface AgentMarkProps {
  harness: string;
  displayName: string;
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
  decorative?: boolean;
}

export function AgentMark({ harness, displayName, size = "md", className, decorative = false }: AgentMarkProps) {
  const hue = HUE_BY_FAMILY[agentFamily(harness)];
  return (
    <span
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : displayName}
      aria-hidden={decorative || undefined}
      title={decorative ? undefined : displayName}
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-[var(--radius-cap)] border font-bold tracking-[0.02em]",
        SIZE_CLASSES[size],
        className,
      )}
      style={{
        borderColor: `color-mix(in oklab, ${hue} 45%, transparent)`,
        backgroundColor: `color-mix(in oklab, ${hue} 18%, var(--color-card))`,
        color: `color-mix(in oklab, ${hue} 42%, var(--color-foreground))`,
      }}
    >
      {agentMonogram(harness, displayName)}
    </span>
  );
}
