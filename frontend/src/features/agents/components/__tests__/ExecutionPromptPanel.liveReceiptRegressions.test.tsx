// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import {
  ReceiptWireSocket, loaded, openSocket, renderReceiptReader, settle,
} from "./receiptLiveWire";

// Implementer-authored regression (mutation-driven): reconciliation belongs to
// a REconnect only. The first connect must not reread summaries or the count.
beforeEach(() => {
  ReceiptWireSocket.instances = [];
  ReceiptWireSocket.observer = false;
  vi.stubGlobal("WebSocket", ReceiptWireSocket);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("receipt live updates on the first connection", () => {
  it("does not reread summaries, the count or any body when the socket first connects", async () => {
    const { calls } = renderReceiptReader();
    await loaded(2);
    await settle();
    const before = { ...calls, details: [...calls.details] };
    await openSocket();
    await settle();
    expect(calls).toEqual(before);
  });
});
