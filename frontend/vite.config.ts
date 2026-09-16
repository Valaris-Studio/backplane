// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: true,
    proxy: {
      "/api": {
        target: process.env.API_URL || "http://localhost:8000",
        changeOrigin: true,
      },
      "/ws": {
        target: process.env.API_URL || "http://localhost:8000",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
