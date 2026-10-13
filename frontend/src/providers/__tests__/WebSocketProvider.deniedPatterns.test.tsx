// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { useSubscriptionDenied, useWebSocketEvent } from "@/hooks/use-websocket";
import { WebSocketProvider } from "@/providers/WebSocketProvider";
import {
  RECEIPT_EVENT,
  ReceiptWireSocket,
} from "@/features/agents/components/__tests__/receiptLiveWire";

// Implementer-authored regression: the provider's per-connection record of
// refused patterns, driven through the real WebSocketService and a raw socket
// double that enforces the accepted receipt subscription policy.
function DenialProbe() {
  useWebSocketEvent(RECEIPT_EVENT, () => {});
  const receiptDenied = useSubscriptionDenied(RECEIPT_EVENT);
  const observerDenied = useSubscriptionDenied("agent.*");
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="receipt-denied">{String(receiptDenied)}</output>
      <output data-testid="observer-denied">{String(observerDenied)}</output>
      <button type="button" onClick={() => navigate("/other-workspace/agents")}>switch</button>
    </>
  );
}

function renderProbe() {
  return render(
    <MemoryRouter initialEntries={["/denial-workspace/agents"]}>
      <WebSocketProvider><DenialProbe /></WebSocketProvider>
    </MemoryRouter>,
  );
}

async function openLatest() {
  await waitFor(() => expect(ReceiptWireSocket.instances.length).toBeGreaterThan(0));
  const socket = ReceiptWireSocket.instances.at(-1)!;
  await act(async () => socket.open());
  return socket;
}

const receiptDenied = () => screen.getByTestId("receipt-denied").textContent;
const observerDenied = () => screen.getByTestId("observer-denied").textContent;

beforeEach(() => {
  ReceiptWireSocket.instances = [];
  ReceiptWireSocket.observer = false;
  vi.stubGlobal("WebSocket", ReceiptWireSocket);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("WebSocketProvider denied patterns", () => {
  it("reports only the patterns the server refused on this connection", async () => {
    renderProbe();
    const socket = await openLatest();
    expect(receiptDenied()).toBe("false");
    await act(async () => socket.deny(["agent.*", "*"]));
    expect(observerDenied()).toBe("true");
    expect(receiptDenied()).toBe("false");
    await act(async () => socket.deny([RECEIPT_EVENT]));
    expect(receiptDenied()).toBe("true");
    expect(observerDenied()).toBe("true");
  });

  it("forgets earlier refusals once a new connection has resubscribed", async () => {
    renderProbe();
    const first = await openLatest();
    await act(async () => first.deny([RECEIPT_EVENT, "agent.*"]));
    expect(receiptDenied()).toBe("true");
    await act(async () => first.close(1006));
    await waitFor(() => expect(ReceiptWireSocket.instances).toHaveLength(2), { timeout: 2000 });
    const second = await openLatest();
    expect(second.sent.at(-1)?.subscribe).toEqual([RECEIPT_EVENT]);
    expect(receiptDenied()).toBe("false");
    expect(observerDenied()).toBe("false");
  });

  it("reports a refusal again when the new connection is denied once more", async () => {
    renderProbe();
    const first = await openLatest();
    await act(async () => first.deny([RECEIPT_EVENT]));
    await act(async () => first.close(1006));
    await waitFor(() => expect(ReceiptWireSocket.instances).toHaveLength(2), { timeout: 2000 });
    const second = await openLatest();
    expect(receiptDenied()).toBe("false");
    await act(async () => second.deny([RECEIPT_EVENT]));
    expect(receiptDenied()).toBe("true");
  });

  it("starts a different workspace with no inherited refusals", async () => {
    renderProbe();
    const first = await openLatest();
    await act(async () => first.deny([RECEIPT_EVENT]));
    expect(receiptDenied()).toBe("true");
    await act(async () => screen.getByRole("button", { name: "switch" }).click());
    await waitFor(() => expect(ReceiptWireSocket.instances).toHaveLength(2));
    expect(ReceiptWireSocket.instances[1]!.url).toContain("/ws/workspaces/other-workspace/events");
    expect(receiptDenied()).toBe("false");
  });

  it("ignores refusals from a closed workspace's socket", async () => {
    renderProbe();
    const first = await openLatest();
    await act(async () => screen.getByRole("button", { name: "switch" }).click());
    await waitFor(() => expect(ReceiptWireSocket.instances).toHaveLength(2));
    await act(async () => first.deny([RECEIPT_EVENT]));
    expect(receiptDenied()).toBe("false");
  });
});
