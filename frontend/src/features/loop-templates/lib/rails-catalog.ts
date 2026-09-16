// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// The rails/tools/setup-contract slice of a template's content bag, typed.
//
// Same rationale as `slot-catalog.ts`: the Rails and Contract tabs WRITE these
// fields back through the autosave draft, so a lossy read would silently drop
// an author's data on the next PATCH. Every reader here round-trips unknown
// keys untouched.

import type { ColumnType } from "@/types/kanban";

/** The numeric rails, in render order. Mirrors BoardLoopConfig. */
export const NUMERIC_RAILS = [
  "max_iterations",
  "iteration_delay_seconds",
  "iteration_timeout_seconds",
  "budget_usd",
  "max_consecutive_failures",
  "max_blocked_on_human",
] as const;

export type NumericRail = (typeof NUMERIC_RAILS)[number];

/** _STARVATION_POLICIES in app/services/loop_config_validation.py. */
export const STARVATION_POLICIES = ["park", "always_run"] as const;

/** _MERGE_GATES in app/services/loop_config_validation.py. */
export const MERGE_GATES = ["forge_ci", "none"] as const;

/**
 * Tier vocabulary mirrors the runner's llm.tier_providers aliases. Anything
 * else is a concrete model id, round-tripped verbatim and never resolved
 * client-side. Duplicated from BoardLoopDialog/LlmEditor, which both keep it
 * module-private; this is the loop-templates copy.
 */
export const MODEL_TIERS = ["premium", "mid", "low"] as const;

/** Sentinel for the free-entry choice — `<SelectItem value="">` is illegal. */
export const CUSTOM_MODEL = "__custom__";

/**
 * The enum rails, each with its closed vocabulary. Order is the UI's order.
 * `budget_usd` allows decimals; the rest are integer counts/seconds.
 */
export const ENUM_RAILS = {
  starvation_policy: STARVATION_POLICIES,
  loop_landing: ["self_merge", "human", "merge_queue"],
  merge_gate: MERGE_GATES,
} as const;

export type EnumRail = keyof typeof ENUM_RAILS;

export const ENUM_RAIL_NAMES = [
  "starvation_policy",
  "loop_landing",
  "merge_gate",
] as const;

/**
 * Which numeric rails accept decimals. `budget_usd` is dollars; every other
 * numeric rail is a whole count or a whole number of seconds, and a
 * fractional iteration budget is meaningless.
 */
export const DECIMAL_RAILS = new Set<string>(["budget_usd"]);

export interface RailsDefaults {
  max_iterations?: unknown;
  iteration_delay_seconds?: unknown;
  iteration_timeout_seconds?: unknown;
  budget_usd?: unknown;
  max_consecutive_failures?: unknown;
  max_blocked_on_human?: unknown;
  starvation_policy?: unknown;
  loop_landing?: unknown;
  merge_gate?: unknown;
  model?: unknown;
  provider?: unknown;
  [key: string]: unknown;
}

/**
 * `set_board_loop` is the grant that lets a loop stop ITSELF. The backend
 * rejects a bind while enabled when it is absent (`off_switch_removed`), so
 * the tab warns before the operator gets there.
 *
 * Both spellings circulate: `ToolPicker` and BoardLoopConfig store the fully
 * prefixed id, while the loop-template profile fixtures use the bare MCP name.
 * Accept EITHER — matching only one silently mis-warns on half the templates.
 */
const OFF_SWITCH_IDS = new Set([
  "set_board_loop",
  "mcp__valaris__set_board_loop",
]);

export function hasOffSwitch(tools: readonly string[]): boolean {
  return tools.some((tool) => OFF_SWITCH_IDS.has(tool));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readRailsDefaults(
  content: Record<string, unknown> | undefined,
): RailsDefaults {
  return asRecord(content?.rails_defaults);
}

/**
 * Rails values render into text inputs, so they are read as STRINGS. A rail
 * the template never set reads as "" — distinct from an explicit 0, which the
 * backend treats as a real value (`max_blocked_on_human: 0` opts out).
 */
export function railValue(rails: RailsDefaults, rail: string): string {
  const value = rails[rail];
  if (value === undefined || value === null) return "";
  return String(value);
}

/**
 * Apply one rail edit, returning the next `rails_defaults` map.
 *
 * An emptied field DELETES the key rather than storing `undefined`: the rail
 * has a server-side default, and a present-but-undefined key is erased by
 * JSON serialization anyway — so the two only differ in-process, which is
 * exactly where this function is asserted.
 */
export function applyRail(
  rails: RailsDefaults,
  rail: string,
  value: unknown,
): RailsDefaults {
  const next = { ...rails };
  if (value === undefined) delete next[rail];
  else next[rail] = value;
  return next;
}

/**
 * Coerce a rail's raw input string to the value the backend stores.
 * `undefined` means "unset this rail" — a blank or unparseable entry.
 */
export function parseRailInput(rail: string, raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const parsed = DECIMAL_RAILS.has(rail)
    ? Number.parseFloat(trimmed)
    : Number.parseInt(trimmed, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function readTools(
  content: Record<string, unknown> | undefined,
): string[] {
  const tools = content?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.filter((tool): tool is string => typeof tool === "string");
}

export function readDerivedRails(
  content: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return asRecord(content?.derived_rails);
}

export interface SetupContract {
  required_column_types: ColumnType[];
  optional_column_types: ColumnType[];
  requires_run_label: boolean;
  definition_keys: string[];
  pinned_notes: string[];
  card_sections: string[];
  git_repo_bound: boolean;
  agent_bound_with_tools: boolean;
  dependencies_server_side: boolean;
  /** Anything the backend added that this UI does not model yet. */
  extra: Record<string, unknown>;
}

/** The contract's own boolean flags, in render order. */
export const CONTRACT_FLAGS = [
  "requires_run_label",
  "git_repo_bound",
  "agent_bound_with_tools",
  "dependencies_server_side",
] as const;

export type ContractFlag = (typeof CONTRACT_FLAGS)[number];

/** The contract's chip lists, in render order. */
export const CONTRACT_CHIP_LISTS = [
  "definition_keys",
  "pinned_notes",
  "card_sections",
] as const;

export type ContractChipList = (typeof CONTRACT_CHIP_LISTS)[number];

const MODELLED_CONTRACT_KEYS = new Set<string>([
  "required_column_types",
  "optional_column_types",
  ...CONTRACT_FLAGS,
  ...CONTRACT_CHIP_LISTS,
]);

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function readSetupContract(
  content: Record<string, unknown> | undefined,
): SetupContract {
  const raw = asRecord(content?.setup_contract);
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!MODELLED_CONTRACT_KEYS.has(key)) extra[key] = value;
  }
  return {
    required_column_types: stringList(raw.required_column_types) as ColumnType[],
    optional_column_types: stringList(raw.optional_column_types) as ColumnType[],
    requires_run_label: raw.requires_run_label === true,
    definition_keys: stringList(raw.definition_keys),
    pinned_notes: stringList(raw.pinned_notes),
    card_sections: stringList(raw.card_sections),
    git_repo_bound: raw.git_repo_bound === true,
    agent_bound_with_tools: raw.agent_bound_with_tools === true,
    dependencies_server_side: raw.dependencies_server_side === true,
    extra,
  };
}

/** Serialize back to the wire shape, preserving unmodelled keys. */
export function writeSetupContract(
  contract: SetupContract,
): Record<string, unknown> {
  const { extra, ...modelled } = contract;
  return { ...extra, ...modelled };
}
