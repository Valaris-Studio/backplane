// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { renderWithProviders } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import type { ApiKey } from "@/types/api-key";
import { McpConnectionWizard } from "../McpConnectionWizard";

export const ORIGIN = window.location.origin;

// Entrance tweens are skipped under reduced motion, so role/text queries see
// fully visible content immediately (WelcomeModal.test precedent — setup.ts
// stubs matchMedia to matches:false, which would leave tweened content at
// opacity 0 in jsdom).
export function stubMatchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

export function apiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "key-1",
    name: "claude-code — Ada",
    key_prefix: "vlr_abcd",
    created_at: "2026-08-01T10:00:00Z",
    last_used_at: null,
    ...overrides,
  };
}

export function mockMe(name = "Ada Lovelace", email = "ada@example.com") {
  server.use(
    http.get("/api/me", () =>
      HttpResponse.json({ id: "u1", email, name, avatar_url: null }),
    ),
  );
}

export function mockApiKeys(keys: ApiKey[]) {
  server.use(http.get("/api/me/api-keys", () => HttpResponse.json(keys)));
}

export function mockCreateApiKey(rawKey = "vlr_secret_minted_key") {
  server.use(
    http.post("/api/me/api-keys", async ({ request }) => {
      const body = (await request.json()) as { name: string };
      return HttpResponse.json({
        ...apiKey({ id: "key-new", name: body.name }),
        raw_key: rawKey,
      });
    }),
  );
}

export function renderWizard(onOpenChange: (open: boolean) => void = () => {}) {
  return renderWithProviders(
    <McpConnectionWizard open onOpenChange={onOpenChange} />,
  );
}
