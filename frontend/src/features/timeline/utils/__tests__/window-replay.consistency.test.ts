// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, it } from "vitest";
import { card, historyEvent, readyWindow } from "../../__tests__/history-fixtures";
import { reconstructWindowState } from "../window-replay";

it("compares snapshot objects by values regardless of JSON property order", () => {
  const { anchor } = readyWindow();
  const participant = { user_id: "user", agent_id: null, name: "Alice", role: "builder", avatar_url: null };
  anchor.state.cards = [card({ participants: [participant] })];
  const before = card({ participants: [{ role: "builder", name: "Alice", user_id: "user", avatar_url: null, agent_id: null }] });
  const event = historyEvent(0, { entity_type: "card", entity_id: "card-one", action: "updated", before_state: before, after_state: card() });
  expect(reconstructWindowState(anchor, [event], 0).partial).toBe(false);
});
