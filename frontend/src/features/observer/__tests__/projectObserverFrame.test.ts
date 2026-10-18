// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  OBSERVER_FRAME_MAX_BYTES,
  REDACTED_VALUE,
  projectObserverFrame,
} from "../utils/projectObserverFrame";

function project(payload: Record<string, unknown>) {
  return projectObserverFrame({
    event: "execution.completed",
    event_id: "evt-1",
    timestamp: "2026-10-18T20:00:00Z",
    payload,
  });
}

// The safety suite proves secrets go; this pins what must stay readable, so the
// diagnostic view does not redact the very fields an operator inspects.
describe("projectObserverFrame keeps ordinary diagnostic fields", () => {
  it("leaves token counts, key identifiers and message keys untouched", () => {
    const payload = {
      input_tokens: 1200,
      token_count: 3,
      key_id: "key-1",
      key_name: "CI runner",
      message_key: "activity.card.moved",
      execution_id: "exec-1",
      has_secret: true,
    };

    const { frame } = project(payload);

    expect(frame.payload).toEqual(payload);
    expect(frame.projection).toEqual({ redacted: false, truncated: false });
  });

  it("does not treat prose about a bearer as a credential", () => {
    const { frame } = project({ summary: "Handed to the bearer of the card" });

    expect(frame.payload.summary).toBe("Handed to the bearer of the card");
  });

  it("redacts a Backplane API key and keeps the frame within its byte bound", () => {
    const { frame, bytes } = project({
      summary: "used vlr_SYNTHETIC0123456789abcdef to call the API",
    });

    expect(frame.payload.summary).toBe(`used ${REDACTED_VALUE} to call the API`);
    expect(frame.projection.redacted).toBe(true);
    expect(bytes).toBeLessThanOrEqual(OBSERVER_FRAME_MAX_BYTES);
  });
});


describe("projectObserverFrame handles Backplane credentials in free text", () => {
  it.each([
    ["Companion device token", `bpc_${"SYNTHETIC".padEnd(43, "X")}`],
    ["Cookie header", "Cookie: session=SYNTHETIC_COOKIE_SESSION; csrf=SYNTHETIC_CSRF_COOKIE"],
  ])("redacts %s before retaining a diagnostic projection", (_label, sensitiveText) => {
    const payload = { summary: `Delivery diagnostic: ${sensitiveText}`, execution_id: "safe-execution-id" };
    const { frame, bytes } = project(payload);
    expect(JSON.stringify(frame)).not.toContain(sensitiveText);
    if (sensitiveText.startsWith("Cookie:")) {
      expect(JSON.stringify(frame)).not.toContain("SYNTHETIC_COOKIE_SESSION");
      expect(JSON.stringify(frame)).not.toContain("SYNTHETIC_CSRF_COOKIE");
    }
    expect(frame.payload.execution_id).toBe("safe-execution-id");
    expect(frame.projection.redacted).toBe(true);
    expect(bytes).toBeLessThanOrEqual(OBSERVER_FRAME_MAX_BYTES);
    expect(payload.summary).toContain(sensitiveText);
  });
});
