// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { platformCopy } from "../platform/copy";

export const PRIVACY_LEVELS = ["metadata", "standard", "full", "rich"] as const;
export type PrivacyLevel = (typeof PRIVACY_LEVELS)[number];

// The promise is about what leaves the device ("sent"); the server stores at most that.
// Full: agent sessions are readable only by their owner (contract v1.2).
// Getters name the device only once the platform is known.
export const PRIVACY_LEVEL_COPY: Record<PrivacyLevel, { label: string; lead: string; rest: string }> = {
  metadata: {
    label: "Metadata",
    lead: "Activity only.",
    get rest() {
      return `Sends counts, timing, cost, tool and model names, the repository, branch and folder name. Prompts, commands and output stay on ${platformCopy().thisDevice}.`;
    },
  },
  standard: {
    label: "Standard",
    lead: "Adds your prompts, commands and tool arguments.",
    get rest() {
      return `Your first prompt titles the session. Tool output and the agent’s replies stay on ${platformCopy().thisDevice}.`;
    },
  },
  full: {
    label: "Full",
    lead: "Adds tool output, the agent’s replies and file diffs.",
    rest: "Each output is cut at 16 KB, and some agents don’t report theirs. Only you can read sessions in Backplane.",
  },
  rich: {
    label: "Rich",
    lead: "Adds complete output and replies, and the images you attach.",
    rest: "Nothing is cut at 16 KB, and links are never fetched. Only you can read sessions in Backplane.",
  },
};

export interface PrivacyLevelDetail {
  sent: readonly string[];
  /** What stays on the device; headed "Stays on {thisDevice}". */
  kept: readonly string[];
  note: string | null;
}

export const PRIVACY_LEVEL_DETAIL: Record<PrivacyLevel, PrivacyLevelDetail> = {
  metadata: {
    sent: [
      "Counts, timing, tokens and cost",
      "Agent, model, tool and MCP tool names",
      "Repository and branch",
      "The working folder’s name, like “api”",
      "Command exit codes and durations",
    ],
    kept: ["Your prompts, so sessions have no title", "Commands, tool arguments and file paths", "Error messages", "Tool output, the agent’s replies and diffs"],
    note: "Withheld text is sent only as its size and a fingerprint, so repeats can be matched.",
  },
  standard: {
    sent: [
      "Everything in Metadata",
      "Your prompts",
      "Commands and tool arguments, including file paths",
      "The working folder’s path inside the project",
      "Error messages",
    ],
    kept: ["Tool and command output", "The agent’s replies", "File diffs and file contents that commands write"],
    note: "Each prompt, command or argument is cut at 4 KB.",
  },
  full: {
    sent: [
      "Everything in Standard",
      "Tool and command output, up to 16 KB each",
      "The agent’s replies, when the agent reports them",
      "File diffs and file contents that commands write",
    ],
    kept: ["Images and other binary data"],
    note: null,
  },
  rich: {
    sent: ["Everything in Full", "Complete tool output and replies, beyond 16 KB", "Images and files attached to prompts"],
    kept: ["Files outside the project folder"],
    note: "Links in captured content are never followed or fetched.",
  },
};

// Candid on purpose: the secret masking is a pattern heuristic, not a guarantee.
export const PRIVACY_ALWAYS =
  "At every level, your computer and user names are removed, paths become relative to the project (or start with ~), and text that looks like a key or password is masked. Masking matches patterns, so it can miss some.";
