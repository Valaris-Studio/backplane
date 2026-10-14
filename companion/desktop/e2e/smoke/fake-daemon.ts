// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// A contract-A daemon stand-in for the smoke test: serves /v1/status and a
// /v1/events stream over a Unix socket in a throwaway data dir, writing the
// control.json the shell discovers it through. No real companion is touched.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATUS_FIXTURE = readFileSync(new URL("../../src-tauri/tests/fixtures/status.json", import.meta.url), "utf8");
const PING_INTERVAL_MS = 15_000;

export interface FakeDaemon {
  dataDir: string;
  homeDir: string;
  stop(): Promise<void>;
}

function sendStatusStream(response: ServerResponse) {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  response.write(`event: status\ndata: ${JSON.stringify(JSON.parse(STATUS_FIXTURE))}\n\n`);
  const ping = setInterval(() => response.write(": ping\n\n"), PING_INTERVAL_MS);
  response.on("close", () => clearInterval(ping));
}

export async function startFakeDaemon(): Promise<FakeDaemon> {
  // Short root: macOS caps Unix socket paths at 104 bytes.
  const root = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "bpc-smoke-"));
  const dataDir = join(root, "data");
  const homeDir = join(root, "home");
  const socket = join(dataDir, "control.sock");
  for (const dir of [dataDir, homeDir]) {
    mkdirSync(dir, { mode: 0o700 });
  }

  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/status") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(STATUS_FIXTURE);
    } else if (request.method === "GET" && request.url === "/v1/events") {
      sendStatusStream(response);
    } else {
      response
        .writeHead(404, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: { code: "not_found", message: "not in the smoke fake", detail: null } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  writeFileSync(
    join(dataDir, "control.json"),
    JSON.stringify({ version: 1, socket, pid: process.pid, started_at: new Date().toISOString() }),
    { mode: 0o600 },
  );

  return {
    dataDir,
    homeDir,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
