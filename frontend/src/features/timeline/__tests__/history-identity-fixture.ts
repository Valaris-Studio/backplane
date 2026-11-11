// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { http, HttpResponse, server } from "@/test/msw-server";

const originalSubtle = Object.getOwnPropertyDescriptor(globalThis.crypto, "subtle");
beforeAll(() => {
  // jsdom omits SubtleCrypto. Exercise the actual digest, never a mock ID.
  if (!globalThis.crypto.subtle) Object.defineProperty(globalThis.crypto, "subtle", { configurable: true, value: webcrypto.subtle });
});
afterAll(() => {
  if (originalSubtle) Object.defineProperty(globalThis.crypto, "subtle", originalSubtle);
  else Reflect.deleteProperty(globalThis.crypto, "subtle");
});
beforeEach(() => {
  // Generation identity now requires an authorized viewer before the POST.
  server.use(http.get("/api/me", () => HttpResponse.json({
    id: "timeline-viewer", name: "Timeline viewer", email: "timeline@example.test", avatar_url: null,
  })));
});
