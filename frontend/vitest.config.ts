// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    // Scoped to src/ so vitest never picks up e2e/*.spec.ts — those are
    // Playwright specs that import @playwright/test and would explode in jsdom.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
