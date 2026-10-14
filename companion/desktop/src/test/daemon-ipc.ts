// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { mockIPC } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";

import type { CompanionStatus, DaemonStreamMessage } from "../ipc/bindings";
import statusFixture from "../../src-tauri/tests/fixtures/status.json";

export const fixtureStatus = statusFixture as unknown as CompanionStatus;

type CommandHandler = (args: Record<string, unknown>) => unknown;

export interface FakeDaemonIpc {
  /** Delivers a message on the most recent `subscribe_events` channel, in order. */
  emit(message: DaemonStreamMessage): void;
  subscribeCalls(): number;
  invoked(): string[];
}

/**
 * Stands in for the Rust side: `subscribe_events` captures the Channel the
 * store hands over, and emit() pushes through Tauri's real channel callback
 * path (indexed messages via runCallback), not a shortcut.
 */
export function mockDaemonIpc(handlers: Record<string, CommandHandler> = {}): FakeDaemonIpc {
  let channel: Channel<DaemonStreamMessage> | null = null;
  let nextIndex = 0;
  let subscribeCalls = 0;
  const invoked: string[] = [];

  mockIPC(
    (command, payload) => {
      invoked.push(command);
      const args = (payload ?? {}) as Record<string, unknown>;
      const handler = handlers[command];
      if (command === "subscribe_events") {
        subscribeCalls += 1;
        if (handler) return handler(args);
        channel = args.onEvent as Channel<DaemonStreamMessage>;
        nextIndex = 0;
        return null;
      }
      if (handler) return handler(args);
      throw `unexpected command ${command}`;
    },
    { shouldMockEvents: true },
  );

  return {
    emit(message) {
      if (!channel) throw new Error("no subscribe_events channel yet");
      window.__TAURI_INTERNALS__.runCallback(channel.id, { index: nextIndex++, message });
    },
    subscribeCalls: () => subscribeCalls,
    invoked: () => invoked,
  };
}

declare global {
  interface Window {
    __TAURI_INTERNALS__: { runCallback: (id: number, data: unknown) => void };
  }
}
