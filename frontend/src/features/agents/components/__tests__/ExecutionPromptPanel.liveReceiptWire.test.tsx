// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { focusManager } from "@tanstack/react-query";
import i18n from "@/i18n/config";
import { agentKeys } from "@/lib/query-keys";
import {
  EXECUTION_ID, RECEIPT_EVENT, SLUG, ReceiptWireSocket, chooseEarlier,
  loaded, openSocket, receipt, renderReceiptReader, settle,
} from "./receiptLiveWire";

const NOTICE = "Live updates unavailable. Use Refresh to check for new invocations.";

beforeEach(async () => {
  ReceiptWireSocket.instances = [];
  ReceiptWireSocket.observer = false;
  vi.stubGlobal("WebSocket", ReceiptWireSocket);
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  cleanup();
  focusManager.setFocused(undefined);
  vi.unstubAllGlobals();
  await i18n.changeLanguage("en");
});

describe("receipt live updates through the actual provider and socket service", () => {
  it("sends the exact reader-authorized receipt subscription to the server", async () => {
    renderReceiptReader();
    await loaded(2);
    const socket = await openSocket();
    expect(socket.url).toContain(`/ws/workspaces/${SLUG}/events`);
    expect(socket.sent.at(-1)?.subscribe).toEqual([RECEIPT_EVENT]);
    expect(screen.getByTestId("socket-status")).toHaveTextContent("connected");
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it("receives a member's exact event and offers the new invocation without replacing history", async () => {
    const { calls, state } = renderReceiptReader();
    await loaded(2);
    const socket = await openSocket();
    await chooseEarlier();
    const bodies = [...calls.details];
    state.rows.unshift(receipt(3));
    let delivered = false;
    await act(async () => { delivered = socket.publish(3); });
    expect(delivered).toBe(true);
    expect(await screen.findByText("New invocation available")).toBeVisible();
    await settle();
    await loaded(1);
    expect(calls.details).toEqual(bodies);
    fireEvent.click(screen.getByRole("button", { name: "View latest" }));
    await loaded(3);
    expect(calls.details).toEqual([...bodies, "receipt-3"]);
  });

  it("coalesces an accepted event burst and ignores other executions without refetching historical bodies", async () => {
    ReceiptWireSocket.observer = true;
    const { calls, state } = renderReceiptReader();
    await loaded(2);
    const socket = await openSocket();
    await chooseEarlier();
    await settle();
    const initial = { lists: calls.lists, executions: calls.executions, details: [...calls.details] };
    await act(async () => { for (let index = 0; index < 25; index++) socket.publish(4, "another-execution"); });
    await settle();
    expect(calls).toEqual(initial);
    state.rows.unshift(receipt(3));
    await act(async () => { for (let index = 0; index < 25; index++) socket.publish(3); });
    await settle();
    expect(calls).toEqual({ lists: initial.lists + 1, executions: initial.executions + 1, details: initial.details });
    expect(screen.getAllByText("New invocation available")).toHaveLength(1);
    await loaded(1);
  });

  it.each([
    ["en", NOTICE, "Refresh"],
    ["es", "Las actualizaciones en vivo no están disponibles. Usa Actualizar para buscar invocaciones nuevas.", "Actualizar"],
    ["pt-BR", "As atualizações em tempo real estão indisponíveis. Use Atualizar para procurar novas invocações.", "Atualizar"],
  ])("shows an accurate receipt subscription denial in %s while the socket remains connected", async (locale, notice, refresh) => {
    ReceiptWireSocket.observer = true;
    await i18n.changeLanguage(locale);
    renderReceiptReader();
    await loaded(2);
    const socket = await openSocket();
    await act(async () => socket.deny([RECEIPT_EVENT]));
    expect(screen.getByTestId("socket-status")).toHaveTextContent("connected");
    expect(await screen.findByText(notice)).toBeVisible();
    expect(screen.getByRole("button", { name: refresh })).toBeEnabled();
    await loaded(2);
  });

  it("does not confuse an unrelated observer-pattern denial with receipt delivery loss", async () => {
    ReceiptWireSocket.observer = true;
    const { state } = renderReceiptReader();
    await loaded(2);
    const socket = await openSocket();
    await act(async () => socket.deny(["agent.*", "approval.*", "*"]));
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    state.rows.unshift(receipt(3));
    await act(async () => socket.publish(3));
    expect(await screen.findByText("New invocation available")).toBeVisible();
  });

  it("retains explicit and focus revalidation during denial and evicts bodies after HTTP authorization loss", async () => {
    ReceiptWireSocket.observer = true;
    const { calls, state, queryClient } = renderReceiptReader();
    await loaded(2);
    const socket = await openSocket();
    await chooseEarlier();
    await act(async () => socket.deny([RECEIPT_EVENT]));
    const before = calls.details.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(calls.details.length).toBe(before + 1));
    await loaded(1);
    await act(async () => focusManager.setFocused(false));
    await act(async () => focusManager.setFocused(true));
    await waitFor(() => expect(calls.details.length).toBe(before + 2));
    await loaded(1);
    state.detailStatus = 403;
    state.listStatus = 403;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("You no longer have access to this invocation snapshot.")).toBeVisible();
    expect(screen.queryByTestId("execution-prompt-body")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy prompt" })).not.toBeInTheDocument();
    const retainedBodies = queryClient.getQueriesData({
      queryKey: agentKeys.executionContextReceiptDetails(SLUG, EXECUTION_ID),
    }).map(([, data]) => data).filter((data) => data !== undefined);
    expect(retainedBodies).toEqual([]);
    const after = { ...calls, details: [...calls.details] };
    await settle();
    expect(calls).toEqual(after);
  });

  it("reconciles a missed invocation once after reconnection without moving historical selection", async () => {
    ReceiptWireSocket.observer = true;
    const { calls, state } = renderReceiptReader();
    await loaded(2);
    const first = await openSocket();
    await chooseEarlier();
    await settle();
    const before = { lists: calls.lists, executions: calls.executions, details: [...calls.details] };
    await act(async () => first.close(1006));
    expect(await screen.findByText(NOTICE)).toBeVisible();
    state.rows.unshift(receipt(3));
    await waitFor(() => expect(ReceiptWireSocket.instances).toHaveLength(2), { timeout: 2000 });
    const second = await openSocket();
    expect(second).not.toBe(first);
    expect(second.sent.length).toBeGreaterThan(0);
    await waitFor(() => expect(calls.lists).toBe(before.lists + 1));
    await settle();
    expect(calls).toEqual({ lists: before.lists + 1, executions: before.executions + 1, details: before.details });
    expect(await screen.findByText("New invocation available")).toBeVisible();
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    await loaded(1);
  });

  it("cancels queued receipt invalidation and closes the transport on unmount", async () => {
    ReceiptWireSocket.observer = true;
    const { calls, unmount } = renderReceiptReader();
    await loaded(2);
    const socket = await openSocket();
    await settle();
    const before = { ...calls, details: [...calls.details] };
    await act(async () => socket.publish(3));
    unmount();
    await settle();
    expect(socket.readyState).toBe(3);
    expect(calls).toEqual(before);
  });
});
