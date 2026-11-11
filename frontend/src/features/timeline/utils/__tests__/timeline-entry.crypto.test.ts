// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { timelineRequestId } from "../timeline-entry";

type Identity = [nonce: string, ownerId: string, slug: string, boardId: string];
const GOLDEN: Identity = ["11111111-2222-4333-8444-555555555555", "viewer-a", "test-ws", "4b733c45-d729-4b72-b110-aa5a1eaf2743"];
const GOLDEN_DIGEST = "d81920e00c8266c5c17300262da0842ffbee21f2a97f10b64702a6e8e6a01633";
const GOLDEN_REQUEST = "d81920e0-0c82-86c5-8173-00262da0842f";
const originalSubtle = Object.getOwnPropertyDescriptor(globalThis.crypto, "subtle");
const originalRandomUUID = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");
const originalGetRandomValues = globalThis.crypto.getRandomValues;

function framed(identity: Identity) {
  return JSON.stringify(["bp.timeline.request.v1", ...identity]);
}

function nodeRequestId(identity: Identity): string {
  // Independent platform hash, with the accepted UUIDv8 envelope applied to
  // its first 128 bits. Never call the production digest from this oracle.
  const digest = createHash("sha256").update(framed(identity), "utf8").digest();
  const bytes = digest.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function expectV8(id: string) {
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
}

function removeSecureContextMembers() {
  // Shadow prototype members too: deleting only an own property could expose
  // jsdom's inherited randomUUID again and fail to model the absent capability.
  Object.defineProperty(globalThis.crypto, "subtle", { configurable: true, value: undefined });
  Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: undefined });
  expect(globalThis.crypto.subtle).toBeUndefined();
  expect(globalThis.crypto.randomUUID).toBeUndefined();
  expect(globalThis.crypto.getRandomValues).toBe(originalGetRandomValues);
  expect(typeof globalThis.crypto.getRandomValues).toBe("function");
}

beforeEach(() => {
  // Exercise the real native digest in the baseline-capability controls even
  // though jsdom itself does not implement SubtleCrypto.
  Object.defineProperty(globalThis.crypto, "subtle", { configurable: true, value: webcrypto.subtle });
  Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: webcrypto.randomUUID.bind(webcrypto) });
});
afterEach(() => {
  for (const [name, descriptor] of [["subtle", originalSubtle], ["randomUUID", originalRandomUUID]] as const) {
    if (descriptor) Object.defineProperty(globalThis.crypto, name, descriptor);
    else Reflect.deleteProperty(globalThis.crypto, name);
  }
});

describe("timeline request identity across crypto capability boundaries", () => {
  it("preserves the deployed JSON framing, SHA-256 truncation and UUIDv8 golden", async () => {
    expect(createHash("sha256").update(framed(GOLDEN), "utf8").digest("hex")).toBe(GOLDEN_DIGEST);
    expect(nodeRequestId(GOLDEN)).toBe(GOLDEN_REQUEST);
    const request = timelineRequestId(...GOLDEN);
    expect(request).toBeInstanceOf(Promise);
    const id = await request;
    expect(id).toBe(GOLDEN_REQUEST);
    expectV8(id);
  });

  it("derives the identical request when subtle and randomUUID are unavailable but getRandomValues remains", async () => {
    removeSecureContextMembers();
    const id = await timelineRequestId(...GOLDEN);
    expect(id).toBe(GOLDEN_REQUEST);
    expect(id).toBe(nodeRequestId(GOLDEN));
    expectV8(id);
  });

  it.each([true, false])("keeps UTF-8 and JSON-delimited identities distinct with secure members present=%s", async (secureMembers) => {
    if (!secureMembers) removeSecureContextMembers();
    const identities: Identity[] = [
      [GOLDEN[0], "a|b", "c", GOLDEN[3]],
      [GOLDEN[0], "a", "b|c", GOLDEN[3]],
      [GOLDEN[0], "a\u0000b", "c", GOLDEN[3]],
      [GOLDEN[0], "a", "b\u0000c", GOLDEN[3]],
      [GOLDEN[0], 'owner","slug', "board", GOLDEN[3]],
      [GOLDEN[0], "owner", 'slug","board', GOLDEN[3]],
      [GOLDEN[0], "séba 🧭", "café/研究", 'board"\\\u0000[]'],
      [GOLDEN[0], "se\u0301ba 🧭", "café/研究", 'board"\\\u0000[]'],
    ];
    const ids: string[] = [];
    for (const identity of identities) {
      const id = await timelineRequestId(...identity);
      expect(id, JSON.stringify(identity)).toBe(nodeRequestId(identity));
      expectV8(id); ids.push(id);
    }
    expect(new Set(ids).size).toBe(identities.length);
  });

  it("binds each identity field and returns to the original id after another owner", async () => {
    const alternatives: Identity[] = [
      ["11111111-2222-4333-8444-555555555556", GOLDEN[1], GOLDEN[2], GOLDEN[3]],
      [GOLDEN[0], "viewer-b", GOLDEN[2], GOLDEN[3]],
      [GOLDEN[0], GOLDEN[1], "another-workspace", GOLDEN[3]],
      [GOLDEN[0], GOLDEN[1], GOLDEN[2], "4b733c45-d729-4b72-b110-aa5a1eaf2744"],
    ];
    for (const identity of alternatives) {
      const id = await timelineRequestId(...identity);
      expect(id).toBe(nodeRequestId(identity));
      expect(id).not.toBe(GOLDEN_REQUEST);
      expectV8(id);
    }
    expect(await timelineRequestId(...GOLDEN)).toBe(GOLDEN_REQUEST);
  });
});
