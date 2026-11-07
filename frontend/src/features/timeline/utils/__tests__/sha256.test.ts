// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256 } from "../sha256";

const encode = (text: string) => new TextEncoder().encode(text);
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const native = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("SHA-256 continuity digest", () => {
  // Standard SHA-256 known-answer messages pin all 256 bits, independently of
  // the separate UUID truncation tests. Keep the full expected digests literal.
  it.each([
    ["empty", "", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["448-bit message", "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"],
    ["896-bit message", "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmn" + "hijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu", "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1"],
    ["one million a", "a".repeat(1_000_000), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"],
  ])("matches the full known digest for %s", (_name, message, expected) => {
    const input = encode(message);
    expect(native(input)).toBe(expected);
    const actual = sha256(input);
    expect(actual).toBeInstanceOf(Uint8Array);
    expect(actual).toHaveLength(32);
    expect(hex(actual)).toBe(expected);
  });

  it.each([0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129])("matches platform SHA-256 across the %i-byte padding boundary", (length) => {
    const input = Uint8Array.from({ length }, (_, index) => (index * 73 + 193) & 0xff);
    expect(hex(sha256(input))).toBe(native(input));
  });

  it("matches 1,000 deterministic binary inputs without retaining prior digest state", () => {
    let seed = 0x5a17c0de;
    for (let sample = 0; sample < 1_000; sample += 1) {
      const input = Uint8Array.from({ length: sample % 301 }, () => {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
        return seed >>> 24;
      });
      expect(hex(sha256(input)), `sample ${sample}, bytes ${input.length}`).toBe(native(input));
    }
  });

  it.each(["séba 🧭 / 研究", "se\u0301ba 🧭 / 研究", 'quotes" slash\\ null\u0000 brackets[]', "\u0000\u007f\u0080\uffff\u{10ffff}"])("hashes the exact UTF-8 byte sequence %j", (message) => {
    const input = encode(message);
    expect(hex(sha256(input))).toBe(native(input));
  });

  it("honors a byte view's offset and length without mutating input or sharing output buffers", () => {
    const backing = Uint8Array.from({ length: 151 }, (_, index) => (index * 47 + 211) & 0xff);
    const before = backing.slice();
    const input = backing.subarray(7, 127);
    const expected = native(input);
    const first = sha256(input);
    expect(hex(first)).toBe(expected);
    expect(backing).toEqual(before);
    const second = sha256(encode("another independent call"));
    expect(hex(second)).toBe(native(encode("another independent call")));
    expect(hex(first)).toBe(expected);
    first.fill(0);
    expect(backing).toEqual(before);
    expect(hex(sha256(input))).toBe(expected);
  });
});
