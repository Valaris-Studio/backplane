// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

// The table the Go device filter is asserted against (companion/internal/privacy/levels_test.go):
// copy and filter share it, so neither can drift from the other.
import levelsGolden from "../../../internal/privacy/testdata/levels.golden.json";
import { PRIVACY_LEVEL_DETAIL, PRIVACY_LEVELS, type PrivacyLevel } from "./privacy-levels";

type Treatment = "sent" | "withheld" | "removed" | "name_only" | "project_relative";
type SentTreatment = Extract<Treatment, "sent" | "name_only" | "project_relative">;

interface Category {
  id: string;
  sends: Record<PrivacyLevel, Treatment>;
}

const categories = levelsGolden.categories as Category[];
const SENT_TREATMENTS: ReadonlySet<Treatment> = new Set<Treatment>(["sent", "name_only", "project_relative"]);

type SentClaim = { inherit: PrivacyLevel } | { categories: readonly string[]; treatment?: SentTreatment } | { outsideTable: string };
type KeptClaim = { categories: readonly string[] } | { outsideTable: string };

// What each bullet promises, in the fixture's categories. A bullet missing here fails the test, so new copy needs a claim.
const SENT_CLAIMS: Record<string, SentClaim> = {
  "Counts, timing, tokens and cost": { categories: ["activity_counts"] },
  "Agent, model, tool and MCP tool names": { categories: ["tool_names"] },
  "Repository and branch": { outsideTable: "added by placement, outside the payload filter, at every level" },
  "The working folder’s name, like “api”": { categories: ["working_folder"], treatment: "name_only" },
  "Command exit codes and durations": { categories: ["activity_counts"] },
  "Everything in Metadata": { inherit: "metadata" },
  "Your prompts": { categories: ["prompts"] },
  "Commands and tool arguments, including file paths": { categories: ["tool_arguments"] },
  "The working folder’s path inside the project": { categories: ["working_folder"], treatment: "project_relative" },
  "Error messages": { categories: ["error_messages"] },
  "Everything in Standard": { inherit: "standard" },
  "Tool and command output, up to 16 KB each": { categories: ["tool_output"] },
  "The agent’s replies, when the agent reports them": { categories: ["agent_replies"] },
  "File diffs and file contents that commands write": { categories: ["file_diffs", "command_file_content"] },
  "Everything in Full": { inherit: "full" },
  "Complete tool output and replies, beyond 16 KB": { outsideTable: "rich content bodies, sent beside the events (contract §2)" },
  "Images and files attached to prompts": { outsideTable: "rich attachment bodies (contract §6)" },
};

const KEPT_CLAIMS: Record<string, KeptClaim> = {
  "Your prompts, so sessions have no title": { categories: ["prompts"] },
  "Commands, tool arguments and file paths": { categories: ["tool_arguments", "command_file_content"] },
  "Tool output, the agent’s replies and diffs": { categories: ["tool_output", "agent_replies", "file_diffs"] },
  "Error messages": { categories: ["error_messages"] },
  "Tool and command output": { categories: ["tool_output"] },
  "The agent’s replies": { categories: ["agent_replies"] },
  "File diffs and file contents that commands write": { categories: ["file_diffs", "command_file_content"] },
  "Images and other binary data": { outsideTable: "binary is replaced by the device's redaction at every level" },
  "Files outside the project folder": { outsideTable: "withheld as outside_mapped_root (contract §6)" },
};

/** The category → treatment the level's "Sent" list promises, following "Everything in …" and letting the level's own bullets override it. */
function promisedSent(level: PrivacyLevel): Map<string, SentTreatment> {
  const promised = new Map<string, SentTreatment>();
  for (const bullet of PRIVACY_LEVEL_DETAIL[level].sent) {
    const claim = SENT_CLAIMS[bullet];
    if (!claim) throw new Error(`no claim for the Sent bullet “${bullet}”`);
    if ("inherit" in claim) for (const [id, treatment] of promisedSent(claim.inherit)) promised.set(id, treatment);
    else if ("categories" in claim) for (const id of claim.categories) promised.set(id, claim.treatment ?? "sent");
  }
  return promised;
}

function promisedKept(level: PrivacyLevel): Set<string> {
  const kept = new Set<string>();
  for (const bullet of PRIVACY_LEVEL_DETAIL[level].kept) {
    const claim = KEPT_CLAIMS[bullet];
    if (!claim) throw new Error(`no claim for the Stays bullet “${bullet}”`);
    if ("categories" in claim) for (const id of claim.categories) kept.add(id);
  }
  return kept;
}

describe("privacy copy ↔ levels.golden.json", () => {
  it("covers exactly the fixture's levels", () => {
    expect(levelsGolden.levels).toEqual([...PRIVACY_LEVELS]);
  });

  it("claims only categories the fixture knows", () => {
    const known = new Set(categories.map((category) => category.id));
    const claimed = [...Object.values(SENT_CLAIMS), ...Object.values(KEPT_CLAIMS)].flatMap((claim) => ("categories" in claim ? claim.categories : []));
    expect(claimed.filter((id) => !known.has(id))).toEqual([]);
  });

  it.each(PRIVACY_LEVELS)("says %s sends exactly what the filter sends, in the same form", (level) => {
    const promised = promisedSent(level);
    for (const category of categories) {
      const treatment = category.sends[level];
      const expected = SENT_TREATMENTS.has(treatment) ? treatment : undefined;
      expect(promised.get(category.id), `${level}: ${category.id} is ${treatment}`).toBe(expected);
    }
  });

  it.each(PRIVACY_LEVELS)("lists as staying on the device at %s only what the filter withholds or removes", (level) => {
    for (const id of promisedKept(level)) {
      const category = categories.find((candidate) => candidate.id === id);
      expect(category && SENT_TREATMENTS.has(category.sends[level]), `${level}: “stays” claims ${id}`).toBe(false);
    }
  });

  it("names, at every level, each content category it withholds", () => {
    // Each level lists what it keeps back, so nothing a level withholds is silently omitted.
    for (const level of PRIVACY_LEVELS) {
      const kept = promisedKept(level);
      const withheld = categories.filter((category) => category.sends[level] === "withheld").map((category) => category.id);
      expect(withheld.filter((id) => !kept.has(id)), level).toEqual([]);
    }
  });
});
