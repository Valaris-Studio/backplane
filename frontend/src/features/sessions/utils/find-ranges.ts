// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

export function utf8Range(text: string, byteStart: number, byteEnd: number, offset = 0): [number, number] | null {
  const start = byteStart - offset;
  const end = byteEnd - offset;
  if (start < 0 || end <= start) return null;
  let bytes = 0;
  let units = 0;
  let startIndex: number | undefined;
  for (const character of text) {
    if (bytes === start) startIndex = units;
    if (bytes === end) return startIndex === undefined ? null : [startIndex, units];
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    units += character.length;
    if (bytes > end) return null;
  }
  return bytes === end && startIndex !== undefined ? [startIndex, units] : null;
}

export function eventField(data: Record<string, unknown>, field: string): string | null {
  let value: unknown = data;
  for (const escaped of field.split(".")) {
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch { return null; }
    }
    const segment = escaped.replace(/~1/g, ".").replace(/~0/g, "~");
    if (value === null || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, segment)) return null;
    value = (value as Record<string, unknown>)[segment];
  }
  return typeof value === "string" ? value : null;
}
