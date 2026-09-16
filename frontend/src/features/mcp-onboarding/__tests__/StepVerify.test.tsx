// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { QueryClient } from "@tanstack/react-query";
import {
  act,
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { apiKeyKeys } from "@/lib/query-keys";
import { WebSocketContext } from "@/providers/WebSocketProvider";
import type { WebSocketEvent } from "@/lib/websocket";
import type { ApiKey } from "@/types/api-key";
import {
  StepVerify,
  VERIFY_POLL_MS,
  VERIFY_TIMEOUT_MS,
} from "../components/StepVerify";
import { apiKey, mockApiKeys, mockMe, stubMatchMedia } from "./wizard-harness";

// renderWithProviders mounts NO WebSocketProvider, and useWebSocket() returns a
// no-op `subscribe` when the context is absent — so by default the WS path is
// inert here and these tests prove the data-derived path (last_used_at in the
// keys cache) carries the feature on its own. The WS listener gets its own
// context-providing tests below; the real WebSocketProvider is deliberately not
// used for those, because it opens an actual socket.
function renderVerify(
  props: Partial<React.ComponentProps<typeof StepVerify>> = {},
  queryClient?: QueryClient,
) {
  const onDone = vi.fn();
  const onConnectAnother = vi.fn();
  const utils = renderWithProviders(
    <StepVerify
      apiKeyId="key-1"
      alreadyConnected={false}
      onConnectAnother={onConnectAnother}
      onDone={onDone}
      {...props}
    />,
    queryClient ? { queryClient } : undefined,
  );
  return { ...utils, onDone, onConnectAnother };
}

function testClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

beforeEach(() => {
  stubMatchMedia(true);
  mockMe();
  mockApiKeys([apiKey()]);
});

afterEach(() => {
  stubMatchMedia(false);
  vi.useRealTimers();
});

describe("StepVerify — waiting state", () => {
  it("announces that it is waiting for the agent, with no celebration yet", async () => {
    renderVerify();

    const status = await screen.findByTestId("wizard-verify-waiting");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByTestId("wizard-verify-auth-observed")).toBeNull();
    expect(screen.queryByTestId("wizard-verify-celebration")).toBeNull();
  });

  it("offers no connect-another action while waiting", async () => {
    renderVerify();

    await screen.findByTestId("wizard-verify-waiting");
    expect(screen.queryByTestId("wizard-connect-another")).toBeNull();
  });
});

describe("StepVerify — data-derived authentication", () => {
  it("records authentication once the selected key's last_used_at lands in the cache", async () => {
    const client = testClient();
    client.setQueryData<ApiKey[]>(apiKeyKeys.all, [apiKey({ last_used_at: null })]);
    renderVerify({}, client);

    await screen.findByTestId("wizard-verify-waiting");

    // The stamp arriving is the whole signal — however it got there (WS-driven
    // invalidation or the polling backstop), the pane must flip.
    client.setQueryData<ApiKey[]>(apiKeyKeys.all, [
      apiKey({ last_used_at: "2026-08-04T09:00:00Z" }),
    ]);

    expect(await screen.findByTestId("wizard-verify-auth-observed")).toBeInTheDocument();
    expect(screen.getByTestId("wizard-verify-tool-status")).toHaveTextContent(/pending|not.*verified/i);
    expect(screen.queryByTestId("wizard-verify-celebration")).toBeNull();
    expect(screen.queryByTestId("wizard-verify-waiting")).toBeNull();
  });

  it("ignores a different key being used", async () => {
    const client = testClient();
    client.setQueryData<ApiKey[]>(apiKeyKeys.all, [apiKey({ id: "key-1" })]);
    renderVerify({ apiKeyId: "key-1" }, client);

    await screen.findByTestId("wizard-verify-waiting");

    client.setQueryData<ApiKey[]>(apiKeyKeys.all, [
      apiKey({ id: "key-1", last_used_at: null }),
      apiKey({ id: "key-2", last_used_at: "2026-08-04T09:00:00Z" }),
    ]);

    await waitFor(() =>
      expect(screen.getByTestId("wizard-verify-waiting")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("wizard-verify-auth-observed")).toBeNull();
    expect(screen.queryByTestId("wizard-verify-celebration")).toBeNull();
  });

  // The WS event is best-effort by contract: the backend drops it permanently
  // on publish failure. Polling is therefore the ONLY mechanism that guarantees
  // authentication is eventually observed, so this touches no cache and no
  // socket — just the server changing its answer and time passing.
  it("finds the stamp by polling alone, with no cache push and no WS event", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let used = false;
    server.use(
      http.get("/api/me/api-keys", () =>
        HttpResponse.json([
          apiKey({ last_used_at: used ? "2026-08-04T09:00:00Z" : null }),
        ]),
      ),
    );
    renderVerify();

    await screen.findByTestId("wizard-verify-waiting");
    used = true;

    await vi.advanceTimersByTimeAsync(VERIFY_POLL_MS + 1000);

    await waitFor(() =>
      expect(screen.getByTestId("wizard-verify-auth-observed")).toBeInTheDocument(),
    );
  });

  it("names the key in the authentication evidence when it is known", async () => {
    const client = testClient();
    client.setQueryData<ApiKey[]>(apiKeyKeys.all, [
      apiKey({ name: "claude-code — Ada", last_used_at: "2026-08-04T09:00:00Z" }),
    ]);
    renderVerify({}, client);

    const evidence = await screen.findByTestId("wizard-verify-auth-observed");
    expect(evidence).toHaveTextContent("claude-code — Ada");
  });
});

// The WS event is the latency path: it must invalidate the keys query when it
// names OUR key, and stay silent for anyone else's. Both halves matter — a
// filter that always returns true makes every user's first call refetch on
// every open wizard in the deployment.
describe("StepVerify — WS latency path", () => {
  function renderWithSocket(apiKeyId: string | null = "key-1") {
    const handlers = new Map<string, (event: WebSocketEvent) => void>();
    const subscribe = (pattern: string, handler: (e: WebSocketEvent) => void) => {
      handlers.set(pattern, handler);
      return () => handlers.delete(pattern);
    };
    const emit = (payload: Record<string, unknown>) =>
      act(() => {
        for (const [pattern, handler] of handlers) {
          // Mirror WebSocketService's prefix matching for `domain.*`.
          const prefix = pattern.replace(/\*$/, "");
          if (`api_key.first_used`.startsWith(prefix)) {
            handler({
              event: "api_key.first_used",
              timestamp: "2026-08-04T09:00:00Z",
              event_id: "evt-1",
              payload,
            });
          }
        }
      });

    const client = testClient();
    client.setQueryData<ApiKey[]>(apiKeyKeys.all, [apiKey({ last_used_at: null })]);
    const invalidated = vi.spyOn(client, "invalidateQueries");

    renderWithProviders(
      <WebSocketContext.Provider value={{ status: "connected", subscribe }}>
        <StepVerify
          apiKeyId={apiKeyId}
          alreadyConnected={false}
          onConnectAnother={() => {}}
          onDone={() => {}}
        />
      </WebSocketContext.Provider>,
      { queryClient: client },
    );
    return { emit, invalidated };
  }

  it("invalidates the keys query when the event names our key", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { emit, invalidated } = renderWithSocket("key-1");
    await screen.findByTestId("wizard-verify-waiting");
    invalidated.mockClear();

    emit({ api_key_id: "key-1", key_name: "claude-code — Ada" });
    // useDomainSync debounces before invalidating.
    await vi.advanceTimersByTimeAsync(500);

    expect(invalidated).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: apiKeyKeys.all }),
    );
  });

  it("a first-used event records authentication without verifying native tools", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { emit } = renderWithSocket();
    await screen.findByTestId("wizard-verify-waiting");
    mockApiKeys([apiKey({ last_used_at: "2026-08-04T09:00:00Z" })]);
    emit({ api_key_id: "key-1", key_name: "claude-code — Ada" });
    await vi.advanceTimersByTimeAsync(500);
    expect(await screen.findByTestId("wizard-verify-auth-observed")).toBeInTheDocument();
    expect(screen.getByTestId("wizard-verify-tool-status")).toHaveTextContent(/pending|not.*verified/i);
    expect(screen.queryByTestId("wizard-verify-celebration")).toBeNull();
  });

  it("ignores an event for somebody else's key", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { emit, invalidated } = renderWithSocket("key-1");
    await screen.findByTestId("wizard-verify-waiting");
    invalidated.mockClear();

    emit({ api_key_id: "someone-elses-key", key_name: "other" });
    await vi.advanceTimersByTimeAsync(500);

    expect(invalidated).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: apiKeyKeys.all }),
    );
  });
});

describe("StepVerify — timeout", () => {
  it("shows calm troubleshooting hints after the timeout elapses", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderVerify();

    await screen.findByTestId("wizard-verify-waiting");

    await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS + 1000);

    const hints = await screen.findByTestId("wizard-verify-troubleshooting");
    expect(screen.getByTestId("wizard-verify-tool-status")).toHaveTextContent(/pending|not.*verified/i);
    expect(screen.queryByTestId("wizard-verify-celebration")).toBeNull();
    expect(hints).toHaveTextContent("VALARIS_API_URL");
    expect(hints).toHaveTextContent("VALARIS_API_KEY");
    expect(hints).toHaveTextContent(/uvx?/);
    expect(screen.getByTestId("wizard-verify-keep-waiting")).toBeInTheDocument();
    expect(screen.getByTestId("wizard-verify-skip")).toBeInTheDocument();
  });

  it("keeps listening after the user dismisses the hints", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const client = testClient();
    client.setQueryData<ApiKey[]>(apiKeyKeys.all, [apiKey({ last_used_at: null })]);
    renderVerify({}, client);

    await screen.findByTestId("wizard-verify-waiting");
    await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS + 1000);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(await screen.findByTestId("wizard-verify-keep-waiting"));

    expect(screen.queryByTestId("wizard-verify-troubleshooting")).toBeNull();
    expect(screen.getByTestId("wizard-verify-waiting")).toBeInTheDocument();

    // The listener was never torn down: a late stamp still records authentication.
    client.setQueryData<ApiKey[]>(apiKeyKeys.all, [
      apiKey({ last_used_at: "2026-08-04T09:05:00Z" }),
    ]);
    expect(await screen.findByTestId("wizard-verify-auth-observed")).toBeInTheDocument();
    expect(screen.getByTestId("wizard-verify-tool-status")).toHaveTextContent(/pending|not.*verified/i);
    expect(screen.queryByTestId("wizard-verify-celebration")).toBeNull();
  });

  // Asserted on the timer itself, not on a console warning: React 19 dropped
  // the "state update on an unmounted component" message, so a console.error
  // spy here passes whether or not the cleanup exists (verified — that version
  // of this test survived a no-op-cleanup mutant).
  it("cancels the pending timeout on unmount", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { unmount } = renderVerify();

    await screen.findByTestId("wizard-verify-waiting");
    const whileWaiting = vi.getTimerCount();

    unmount();

    // Measured at unmount, not after advancing: once time moves the timer
    // fires and is consumed either way, so a post-advance count of 0 proves
    // nothing. Exactly one timer — the verify timeout — must disappear here.
    expect(vi.getTimerCount()).toBe(whileWaiting - 1);
  });

  it("closes the wizard when the user skips", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { onDone } = renderVerify();

    await screen.findByTestId("wizard-verify-waiting");
    await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS + 1000);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(await screen.findByTestId("wizard-verify-skip"));

    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe("StepVerify — authenticated activity", () => {
  it("keeps native tool checks pending after authenticated activity", async () => {
    renderVerify({ alreadyConnected: true });
    const evidence = await screen.findByTestId("wizard-verify-auth-observed");
    expect(evidence).toHaveTextContent(/authenticat|activity/i);
    expect(screen.getByTestId("wizard-verify-tool-status")).toHaveTextContent(/pending|not.*verified/i);
    expect(screen.queryByTestId("wizard-verify-celebration")).toBeNull();
    expect(screen.queryByText("bulk_create_cards")).toBeNull();
  });

  it("links to canonical toolset recovery outside a workspace", async () => {
    renderVerify({ alreadyConnected: true });
    expect(await screen.findByTestId("wizard-verify-docs-link"))
      .toHaveAttribute("href", "/documentation/mcp-toolsets#discovery");
  });

  it("scopes recovery and the check to the actual matched workspace route", async () => {
    renderWithProviders(
      <Routes><Route path="/:slug/settings" element={
        <StepVerify apiKeyId={null} alreadyConnected intent="loops"
          onConnectAnother={() => {}} onDone={() => {}} />
      } /></Routes>,
      { routerProps: { initialEntries: ["/acme/settings"] } },
    );
    expect(await screen.findByTestId("wizard-verify-docs-link"))
      .toHaveAttribute("href", "/acme/documentation/mcp-toolsets#discovery");
    const prompt = screen.getByTestId("wizard-verification-prompt").textContent!;
    expect(prompt).toContain("acme");
    expect(prompt).toMatch(/authoriz/i);
  });

  it("wires the connect-another action", async () => {
    const user = userEvent.setup();
    const { onConnectAnother } = renderVerify({ alreadyConnected: true });

    await user.click(await screen.findByTestId("wizard-connect-another"));
    expect(onConnectAnother).toHaveBeenCalledTimes(1);
  });

  it("closes on done", async () => {
    const user = userEvent.setup();
    const { onDone } = renderVerify({ alreadyConnected: true });

    await user.click(await screen.findByTestId("wizard-done"));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe("StepVerify — alreadyConnected", () => {
  it("records historical authentication immediately with no waiting state", async () => {
    renderVerify({ apiKeyId: null, alreadyConnected: true });

    expect(await screen.findByTestId("wizard-verify-auth-observed")).toBeInTheDocument();
    expect(screen.getByTestId("wizard-verify-tool-status")).toHaveTextContent(/pending|not.*verified/i);
    expect(screen.queryByTestId("wizard-verify-celebration")).toBeNull();
    expect(screen.queryByTestId("wizard-verify-waiting")).toBeNull();
  });

  it("never schedules a timeout", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderVerify({ apiKeyId: null, alreadyConnected: true });

    await screen.findByTestId("wizard-verify-auth-observed");
    await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS * 2);

    expect(screen.queryByTestId("wizard-verify-troubleshooting")).toBeNull();
  });
});


describe("StepVerify — recovery and evidence", () => {
  it.each([403, 500, 0])("shows request failure %s and retries explicitly", async (status) => {
    let failing = true;
    server.use(http.get("/api/me/api-keys", () => failing
      ? (status === 0 ? HttpResponse.error() : new HttpResponse(null, { status }))
      : HttpResponse.json([apiKey()])));
    renderVerify();
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not check/i);
    expect(screen.queryByTestId("wizard-verify-waiting")).toBeNull();
    failing = false;
    await userEvent.setup().click(screen.getByRole("button", { name: /retry/i }));
    await screen.findByTestId("wizard-verify-waiting");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stops fallback requests after observed use", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let used = false;
    let requests = 0;
    server.use(http.get("/api/me/api-keys", () => {
      requests++;
      return HttpResponse.json([apiKey({ last_used_at: used ? "2026-08-04T09:00:00Z" : null })]);
    }));
    renderVerify();
    await waitFor(() => expect(requests).toBe(1));
    used = true;
    await vi.advanceTimersByTimeAsync(VERIFY_POLL_MS + 1000);
    await screen.findByTestId("wizard-verify-auth-observed");
    const completedRequests = requests;
    await vi.advanceTimersByTimeAsync(VERIFY_POLL_MS * 3);
    expect(requests).toBe(completedRequests);
  });

  it("labels historical activity without claiming present agent health", async () => {
    renderVerify({ alreadyConnected: true, apiKeyId: null });
    const panel = await screen.findByTestId("wizard-verify-auth-observed");
    expect(panel).toHaveTextContent(/previous/i);
    expect(screen.getByTestId("wizard-verification-prompt")).toHaveTextContent(/whoami/);
    expect(panel).not.toHaveTextContent("Your agent is connected");
  });
});


describe("StepVerify — native check handoff", () => {
  function checkPrompt() {
    return screen.getByTestId("wizard-verification-prompt").textContent!;
  }

  it.each(["interactive", "loops", "everything"] as const)(
    "offers a credential-free, read-only native check before authentication for %s",
    async (intent) => {
      renderVerify({ intent });
      await screen.findByTestId("wizard-step-verify");
      const prompt = checkPrompt();
      expect(prompt).toMatch(/native.*MCP|MCP.*native/i);
      expect(prompt).toMatch(/read.only/i);
      expect(prompt).toContain("whoami");
      expect(prompt).toContain("list_workspaces");
      expect(prompt.indexOf("whoami")).toBeLessThan(prompt.indexOf("list_workspaces"));
      expect(prompt).toMatch(/authoriz/i);
      expect(prompt).toMatch(/ambiguous|more than one|multiple/i);
      expect(prompt).toMatch(/do not invent|never invent|do not guess/i);
      expect(prompt).toMatch(/empty.*(success|valid)|success.*empty/i);
      expect(prompt).toMatch(/(?:do not|never|no)[^.\n]*(?:curl|REST|HTTP API)/i);
      expect(prompt).not.toMatch(/vlr_|VALARIS_API_KEY|Bearer |ada@example\.com/);
      expect(screen.queryByTestId("wizard-verify-celebration")).toBeNull();
    },
  );

  it("checks an existing authorized project in the everyday preset", async () => {
    renderVerify({ intent: "interactive" });
    await screen.findByTestId("wizard-step-verify");
    const prompt = checkPrompt();
    expect(prompt).toContain("list_boards");
    expect(prompt).toContain("get_project_context");
    expect(prompt).toMatch(/existing|returned/i);
    expect(prompt).not.toContain("list_loop_templates");
    expect(prompt).not.toContain("propose_skill");
  });

  it("checks loop tools using their real signatures and only inspects the skill mutation", async () => {
    renderVerify({ intent: "loops" });
    await screen.findByTestId("wizard-step-verify");
    const prompt = checkPrompt();
    expect(prompt).toMatch(/list_loop_templates\([^)]*workspace_slug/);
    expect(prompt).toMatch(/list_agents\(\s*\)/);
    expect(prompt).not.toMatch(/list_agents\([^)]*workspace_slug/);
    expect(prompt).toMatch(/list_executions\([^)]*workspace_slug[^)]*limit\s*[=:]\s*1/);
    expect(prompt).toMatch(/(?:inspect|presence|available|availability)[^.\n]*propose_skill|propose_skill[^.\n]*(?:inspect|presence|available|availability)/i);
    expect(prompt).toMatch(/(?:do not|never)[^.\n]*(?:call|invoke)[^.\n]*propose_skill/i);
    expect(prompt).not.toMatch(/propose_skill\s*\(/);
    expect(prompt).toMatch(/(?:do not|never|no)[^.\n]*(?:creat|mutat|writ)/i);
  });

  it("labels Everything as representative read checks, not catalog certification", async () => {
    renderVerify({ intent: "everything" });
    await screen.findByTestId("wizard-step-verify");
    const prompt = checkPrompt();
    expect(prompt).toMatch(/representative|sample/i);
    expect(prompt).toMatch(/(?:not|does not|cannot)[^.\n]*(?:every tool|all tools|full.catalog|whole.catalog)/i);
    expect(prompt).toContain("list_loop_templates");
    expect(prompt).toContain("get_project_context");
  });

  it("copies exactly the displayed native check, without copying authentication details", async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, "writeText");
    renderVerify({ intent: "loops" });
    await screen.findByTestId("wizard-step-verify");
    await user.click(screen.getByRole("button", { name: /copy.*check/i }));
    expect(write).toHaveBeenCalledWith(checkPrompt());
    expect(write.mock.calls[0]?.[0]).not.toMatch(/vlr_|VALARIS_API_KEY|Bearer /);
  });
});

describe("StepVerify — agent-reported outcome and recovery", () => {
  async function report(value: string) {
    const user = userEvent.setup();
    renderVerify({ alreadyConnected: true, apiKeyId: null, intent: "loops" });
    await screen.findByTestId("wizard-step-verify");
    await user.selectOptions(screen.getByRole("combobox", { name: /agent.*result/i }), value);
    return screen.getByTestId("wizard-verification-result");
  }

  it("keeps a successful user report distinct from automatic verification", async () => {
    const panel = await report("success");
    expect(panel).toHaveTextContent(/you reported|user.reported/i);
    expect(panel).toHaveTextContent(/not.*independent|not.*automatic|cannot.*verif/i);
    expect(screen.getByTestId("wizard-verify-auth-observed")).toBeInTheDocument();
    expect(screen.queryByTestId("wizard-verify-celebration")).toBeNull();
    expect(screen.queryByText(/all tools (are )?verified|selected tools (are )?verified/i)).toBeNull();
    expect(screen.getByTestId("wizard-done")).toBeEnabled();
  });

  it("does not manufacture authentication evidence from a reported successful check", async () => {
    const user = userEvent.setup();
    renderVerify({ alreadyConnected: false });
    await screen.findByTestId("wizard-verify-waiting");
    await user.selectOptions(screen.getByRole("combobox", { name: /agent.*result/i }), "success");
    expect(screen.getByTestId("wizard-verification-result")).toHaveTextContent(/you reported|user.reported/i);
    expect(screen.queryByTestId("wizard-verify-auth-observed")).toBeNull();
    expect(screen.queryByTestId("wizard-verify-celebration")).toBeNull();
  });

  it("explains exact restart_env preservation and correct transport recovery for missing tools", async () => {
    const panel = await report("missing-tools");
    expect(panel).toHaveTextContent(/native.*tools|tools.*missing/i);
    expect(panel).toHaveTextContent(/exact.*restart_env|restart_env.*exact/i);
    expect(panel).toHaveTextContent(/preserv.*(?:all|every|custom)/i);
    expect(panel).toHaveTextContent(/local.*stdio|stdio.*local/i);
    expect(panel).toHaveTextContent(/remote.*HTTP|HTTP.*remote/i);
    expect(panel).toHaveTextContent(/operator/i);
    expect(panel).toHaveTextContent(/launch environment|server environment/i);
    expect(panel).toHaveTextContent(/local.*(?:cannot|does not|will not)|(?:cannot|does not|will not).*local/i);
    expect(panel).toHaveTextContent(/restart.*(?:server|connection)/i);
    expect(panel).toHaveTextContent(/(?:then|after).*fresh.*(?:session|agent)/i);
    expect(panel).toHaveTextContent(/new chat.*(?:alone|not|reuse)|(?:alone|not|reuse).*new chat/i);
    expect(panel).toHaveTextContent(/enable_toolsets/);
    expect(panel).toHaveTextContent(/rerun|run.*again/i);
    expect(panel).toHaveTextContent(/fresh.*(?:example|connection)|(?:example|connection).*fresh/i);
    expect(panel).toHaveTextContent(/allowlist/i);
    expect(panel).toHaveTextContent(/(?:preserv|respect|keep|do not remove)[^.]*allowlist|allowlist[^.]*(?:preserv|respect|keep|do not remove)/i);
    expect(screen.getByTestId("wizard-verify-docs-link"))
      .toHaveAttribute("href", "/documentation/mcp-toolsets#discovery");
  });

  it.each([
    ["auth", /credential|API key|permission/i, /authoriz|access|scope/i],
    ["network", /network|reachab|connectivity/i, /URL|endpoint|DNS/i],
    ["version-allowlist", /version/i, /allowlist/i],
  ] as const)("provides distinct %s recovery without declaring tools healthy", async (outcome, first, second) => {
    const panel = await report(outcome);
    expect(panel).toHaveTextContent(first);
    expect(panel).toHaveTextContent(second);
    expect(screen.queryByTestId("wizard-verify-celebration")).toBeNull();
    expect(screen.getByTestId("wizard-done")).toBeEnabled();
  });

  it("lets the user leave while the native check is still pending", async () => {
    const user = userEvent.setup();
    const { onDone } = renderVerify();
    await screen.findByTestId("wizard-step-verify");
    expect(screen.getByTestId("wizard-verify-tool-status")).toHaveTextContent(/pending|not.*verified/i);
    await user.click(screen.getByTestId("wizard-done"));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("wizard-verify-celebration")).toBeNull();
  });
});
