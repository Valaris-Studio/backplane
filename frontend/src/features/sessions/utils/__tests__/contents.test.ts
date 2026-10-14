// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeAll, describe, expect, it } from "vitest";
import i18n from "@/i18n/config";
import { CONTENT_COVERAGES, COVERAGE_REASONS } from "@/types/agent-session";
import { makeContent } from "../../__tests__/fixtures";
import { sessionKeys } from "@/lib/query-keys";
import { changeable } from "../../api/use-session-realtime";
import { downloadName, transcriptEntries } from "../contents";

describe("transcriptEntries", () => {
  it("keeps the server's order and gathers a call's parts where the call first appears", () => {
    const items = [
      makeContent({ id: "prompt", channel: "prompt", role: "user" }),
      makeContent({ id: "in-a", channel: "tool_input", call_id: "a" }),
      makeContent({ id: "in-b", channel: "tool_input", call_id: "b" }),
      makeContent({ id: "out-a", channel: "tool_output", call_id: "a" }),
      makeContent({ id: "reply", channel: "reply" }),
      makeContent({ id: "out-b", channel: "tool_output", call_id: "b" }),
    ];

    const entries = transcriptEntries(items, { includeRaw: false });

    expect(entries.map((entry) => (entry.type === "call" ? `call:${entry.parts.map((part) => part.id).join("+")}` : entry.item.id))).toEqual([
      "prompt",
      "call:in-a+out-a",
      "call:in-b+out-b",
      "reply",
    ]);
  });

  it("keeps a reply or prompt that names a call as its own message", () => {
    const entries = transcriptEntries([makeContent({ id: "reply", channel: "reply", call_id: "a" })], { includeRaw: false });
    expect(entries).toEqual([{ type: "message", item: expect.objectContaining({ id: "reply" }) }]);
  });

  it("leaves raw native records out unless asked for", () => {
    const items = [makeContent({ id: "reply" }), makeContent({ id: "raw", channel: "native_record", role: "unknown" })];
    expect(transcriptEntries(items, { includeRaw: false })).toHaveLength(1);
    expect(transcriptEntries(items, { includeRaw: true })).toHaveLength(2);
  });
});

describe("downloadName", () => {
  it("takes the server's RFC 5987 name, stripped of any path and control characters", () => {
    expect(downloadName("attachment; filename*=UTF-8''..%2F..%2Freport%0A.pdf", "content-1.bin")).toBe("report.pdf");
    expect(downloadName("inline; filename*=UTF-8''C%3A%5Cevil%5Cnotes.md", "content-1.bin")).toBe("notes.md");
    expect(downloadName("attachment; filename*=UTF-8''screenshot%20%E2%9C%93.png", "content-1.bin")).toBe("screenshot ✓.png");
    // Bidi controls could make "report‮fdp.exe" read as "reportexe.pdf".
    expect(downloadName("attachment; filename*=UTF-8''report%E2%80%AEfdp.exe", "content-1.bin")).toBe("reportfdp.exe");
    expect(downloadName("attachment; filename*=UTF-8''a%E2%81%A6b%E2%81%A9c.txt", "content-1.bin")).toBe("abc.txt");
  });

  it("falls back to the content id when the server names nothing usable", () => {
    expect(downloadName(undefined, "content-1.bin")).toBe("content-1.bin");
    expect(downloadName("attachment; filename*=UTF-8''..", "content-1.bin")).toBe("content-1.bin");
    expect(downloadName("attachment; filename*=UTF-8''%E0%A4%A", "content-1.bin")).toBe("content-1.bin");
  });
});

// Mirrors backend COVERAGE_REASONS (contract §8): a reason without copy would render its raw key.
describe("coverage copy", () => {
  // es and pt-BR load on demand, through changeLanguage.
  beforeAll(async () => {
    await i18n.changeLanguage("es");
    await i18n.changeLanguage("pt-BR");
    await i18n.changeLanguage("en");
  });

  for (const language of ["en", "es", "pt-BR"]) {
    it(`explains every coverage state and reason in ${language}, each in its own words`, () => {
      const t = i18n.getFixedT(language);
      const reasons = COVERAGE_REASONS.filter((reason) => reason !== "secret_filter");
      for (const key of [...CONTENT_COVERAGES.map((coverage) => `sessions.contents.coverage.${coverage}`), ...reasons.map((reason) => `sessions.contents.reasons.${reason}`)]) {
        expect(i18n.exists(key, { lng: language, fallbackLng: false }), key).toBe(true);
      }
      expect(i18n.exists("sessions.contents.reasons.secret_filter_one", { lng: language, fallbackLng: false })).toBe(true);
      const sentences = reasons.map((reason) => t(`sessions.contents.reasons.${reason}`));
      expect(new Set(sentences).size).toBe(sentences.length);
    });
  }

  it("covers the contract's 25 reasons and 8 states", () => {
    expect(COVERAGE_REASONS).toHaveLength(25);
    expect(CONTENT_COVERAGES).toHaveLength(8);
  });
});

describe("which session queries an event refreshes", () => {
  it("refreshes lists and details but never a digest-keyed body or file", () => {
    expect(changeable({ queryKey: sessionKeys.contents("acme", "s1", { limit: 100 }) })).toBe(true);
    expect(changeable({ queryKey: sessionKeys.detail("acme", "s1") })).toBe(true);
    expect(changeable({ queryKey: sessionKeys.list("acme", {}) })).toBe(true);
    expect(changeable({ queryKey: sessionKeys.contentBody("acme", "s1", "c1", "a".repeat(64), 0) })).toBe(false);
    expect(changeable({ queryKey: sessionKeys.contentFile("acme", "s1", "c1", "a".repeat(64)) })).toBe(false);
  });
});
