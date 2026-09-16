// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import "@testing-library/jest-dom/vitest";
import { server } from "./msw-server";
import { afterAll, afterEach, beforeAll } from "vitest";

// jsdom doesn't implement matchMedia
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// jsdom doesn't implement IntersectionObserver (used for infinite-scroll sentinels)
class NoopIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
Object.defineProperty(window, "IntersectionObserver", {
  writable: true,
  value: NoopIntersectionObserver,
});
Object.defineProperty(globalThis, "IntersectionObserver", {
  writable: true,
  value: NoopIntersectionObserver,
});

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
