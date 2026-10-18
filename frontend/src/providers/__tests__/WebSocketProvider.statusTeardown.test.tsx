// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { useWebSocket } from "@/hooks/use-websocket";
import { WebSocketProvider } from "@/providers/WebSocketProvider";

// A torn-down socket must not leave its last status behind: the Observer and
// the top-bar indicator both read this value.
class TeardownSocket {
  static instances: TeardownSocket[] = [];
  static readonly OPEN = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 0;

  constructor(public url: string) {
    TeardownSocket.instances.push(this);
  }

  send() {}

  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }

  open() {
    this.readyState = TeardownSocket.OPEN;
    this.onopen?.();
  }
}

function StatusProbe() {
  const { status } = useWebSocket();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="status">{status}</output>
      <button type="button" onClick={() => navigate("/")}>Leave workspace</button>
    </>
  );
}

beforeEach(() => {
  TeardownSocket.instances = [];
  vi.stubGlobal("WebSocket", TeardownSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WebSocketProvider status after teardown", () => {
  it("reports disconnected, not the old socket's connected, after leaving the workspace", () => {
    render(
      <MemoryRouter initialEntries={["/alpha/boards"]}>
        <WebSocketProvider>
          <StatusProbe />
        </WebSocketProvider>
      </MemoryRouter>,
    );
    act(() => TeardownSocket.instances.at(-1)!.open());
    expect(screen.getByTestId("status")).toHaveTextContent(/^connected$/);

    fireEvent.click(screen.getByRole("button", { name: "Leave workspace" }));

    expect(TeardownSocket.instances).toHaveLength(1);
    expect(screen.getByTestId("status")).toHaveTextContent(/^disconnected$/);
  });
});
