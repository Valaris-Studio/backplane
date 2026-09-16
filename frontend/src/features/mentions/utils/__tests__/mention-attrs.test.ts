// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { memberToMentionAttrs } from "@/features/mentions/utils/mention-attrs";
import type { WorkspaceMember } from "@/types/member";

const member = (over: Partial<WorkspaceMember> = {}): WorkspaceMember => ({
  user_id: "11111111-1111-1111-1111-111111111111",
  email: "alice@valaris.dev",
  name: "Alice Adams",
  role: "member",
  joined_at: "2026-06-14T00:00:00Z",
  ...over,
});

describe("memberToMentionAttrs", () => {
  it("maps a member to mention node attrs {id, label} keyed by user_id (MEN-1)", () => {
    expect(memberToMentionAttrs(member())).toEqual({
      id: "11111111-1111-1111-1111-111111111111",
      label: "Alice Adams",
    });
  });

  it("falls back to email as the label when name is blank", () => {
    expect(memberToMentionAttrs(member({ name: "" }))).toEqual({
      id: "11111111-1111-1111-1111-111111111111",
      label: "alice@valaris.dev",
    });
  });

  it("trims a padded name so the chip label is clean", () => {
    expect(memberToMentionAttrs(member({ name: "  Bob  " })).label).toBe("Bob");
  });
});
