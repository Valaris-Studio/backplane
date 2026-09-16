// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createTestQueryClient,
  renderWithProviders,
  screen,
  waitFor,
  userEvent,
} from "@/test/test-utils";
import { apiKey, mockApiKeys, stubMatchMedia } from "./wizard-harness";
import { server, http, HttpResponse } from "@/test/msw-server";
import { apiKeyKeys } from "@/lib/query-keys";
import { ConnectAgentCallout } from "../components/ConnectAgentCallout";

const SLUG = "acme";

beforeEach(() => {
  window.localStorage.clear();
  stubMatchMedia(true);
});
afterEach(() => stubMatchMedia(false));

function renderCallout(
  onConnect: () => void = () => {},
  options?: Parameters<typeof renderWithProviders>[1],
) {
  return renderWithProviders(
    <ConnectAgentCallout slug={SLUG} onConnect={onConnect} />,
    options,
  );
}

describe("ConnectAgentCallout — visible until the first MCP call lands or the user closes it", () => {
  it("renders nothing while the key list is still unknown", async () => {
    server.use(
      http.get("/api/me/api-keys", () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );
    const { container } = renderCallout();

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("renders with no keys at all", async () => {
    mockApiKeys([]);
    renderCallout();

    expect(
      await screen.findByTestId("connect-agent-callout"),
    ).toBeInTheDocument();
  });

  it("renders while keys exist but none has been used", async () => {
    mockApiKeys([apiKey({ last_used_at: null })]);
    renderCallout();

    expect(
      await screen.findByTestId("connect-agent-callout"),
    ).toBeInTheDocument();
  });

  it("disappears once any key reports a last_used_at", async () => {
    mockApiKeys([
      apiKey({ id: "k1", last_used_at: null }),
      apiKey({ id: "k2", last_used_at: "2026-08-04T09:00:00Z" }),
    ]);
    const { container } = renderCallout();

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("invokes onConnect from the CTA", async () => {
    mockApiKeys([]);
    const onConnect = vi.fn();
    const user = userEvent.setup();
    renderCallout(onConnect);

    await user.click(await screen.findByTestId("connect-agent-callout-cta"));

    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  // The wizard's WS listener and 25s polling both write through apiKeyKeys.all,
  // so verification success must retire the callout with no reload.
  it("disappears live when the shared apiKeyKeys cache reports a used key", async () => {
    mockApiKeys([apiKey({ id: "k1", last_used_at: null })]);
    const queryClient = createTestQueryClient();
    const { container } = renderCallout(() => {}, { queryClient });

    await screen.findByTestId("connect-agent-callout");

    queryClient.setQueryData(apiKeyKeys.all, [
      apiKey({ id: "k1", last_used_at: "2026-08-04T09:30:00Z" }),
    ]);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

describe("ConnectAgentCallout — explicit dismissal", () => {
  it("hides when the dismiss control is clicked", async () => {
    mockApiKeys([]);
    const user = userEvent.setup();
    const { container } = renderCallout();

    await user.click(await screen.findByTestId("connect-agent-callout-dismiss"));

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("stays hidden on remount — dismissal is persisted per workspace", async () => {
    mockApiKeys([]);
    const user = userEvent.setup();
    const first = renderCallout();

    await user.click(await screen.findByTestId("connect-agent-callout-dismiss"));
    await waitFor(() => expect(first.container).toBeEmptyDOMElement());
    first.unmount();

    const second = renderCallout();
    // Zero-delay settle: the component decides synchronously from the stored
    // flag, so an initial flash would surface as a non-empty container here.
    await waitFor(() => expect(second.container).toBeEmptyDOMElement());
    expect(screen.queryByTestId("connect-agent-callout")).toBeNull();
  });

  it("still shows in a workspace whose flag is for ANOTHER slug", async () => {
    mockApiKeys([]);
    window.localStorage.setItem("valaris:mcpCallout:dismissed:other-ws", "1");
    renderCallout();

    expect(
      await screen.findByTestId("connect-agent-callout"),
    ).toBeInTheDocument();
  });
});
