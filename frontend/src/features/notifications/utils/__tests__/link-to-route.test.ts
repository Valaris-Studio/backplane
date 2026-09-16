// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { linkToRoute } from "../link-to-route";
import type { NotificationLink } from "../../api/notifications-api";

describe("linkToRoute", () => {
  it("returns null for a null/undefined link", () => {
    expect(linkToRoute(null, "acme")).toBeNull();
    expect(linkToRoute(undefined, "acme")).toBeNull();
  });

  it("deep-links a card to the board with the ?card param", () => {
    const link: NotificationLink = {
      kind: "card",
      board_id: "b1",
      card_id: "c1",
    };
    expect(linkToRoute(link, "acme")).toBe("/acme/boards/b1?card=c1");
  });

  it("prefers the link's own workspace_slug over the fallback (rollup rows)", () => {
    const link: NotificationLink = {
      kind: "card",
      workspace_slug: "other",
      board_id: "b1",
      card_id: "c1",
    };
    expect(linkToRoute(link, "acme")).toBe("/other/boards/b1?card=c1");
  });

  it("routes to the bare board when a card link has no card_id", () => {
    const link: NotificationLink = { kind: "card", board_id: "b1", card_id: null };
    expect(linkToRoute(link, "acme")).toBe("/acme/boards/b1");
  });

  it("returns null when a card link is missing its board_id (unresolvable)", () => {
    const link: NotificationLink = { kind: "card", card_id: "c1" };
    expect(linkToRoute(link, "acme")).toBeNull();
  });

  it("returns null when no slug is available anywhere", () => {
    const link: NotificationLink = { kind: "card", board_id: "b1", card_id: "c1" };
    expect(linkToRoute(link, undefined)).toBeNull();
  });

  it("routes approval and workspace kinds", () => {
    expect(linkToRoute({ kind: "approval", approval_id: "a1" }, "acme")).toBe(
      "/acme/approvals",
    );
    expect(linkToRoute({ kind: "workspace" }, "acme")).toBe("/acme");
  });

  it("returns null for an unknown kind (no FE destination yet)", () => {
    expect(linkToRoute({ kind: "resource", resource_id: "r1" }, "acme")).toBeNull();
  });

  it("deep-links a board-scoped note to the board notes tab with ?note", () => {
    const link: NotificationLink = {
      kind: "note",
      board_id: "b1",
      note_id: "n1",
    };
    expect(linkToRoute(link, "acme")).toBe("/acme/boards/b1/notes?note=n1");
  });

  it("deep-links a workspace-scoped note (no board) to the workspace notes tab", () => {
    const link: NotificationLink = {
      kind: "note",
      board_id: null,
      note_id: "n1",
    };
    expect(linkToRoute(link, "acme")).toBe("/acme/notes?note=n1");
  });

  it("prefers the note link's own workspace_slug over the fallback", () => {
    const link: NotificationLink = {
      kind: "note",
      workspace_slug: "other",
      board_id: null,
      note_id: "n1",
    };
    expect(linkToRoute(link, "acme")).toBe("/other/notes?note=n1");
  });

  it("returns null when a note link is missing its note_id (unresolvable)", () => {
    const link: NotificationLink = { kind: "note", board_id: "b1" };
    expect(linkToRoute(link, "acme")).toBeNull();
  });
});
