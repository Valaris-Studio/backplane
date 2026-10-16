// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { act, renderWithProviders, screen, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { AgentSession, SessionCallPage, SessionUsageList } from "@/types/agent-session";
import { SLUG, callPage, contentPage, makeCall, makeContent, makeSession, makeTurn, minutesAgo, stubAuthModes } from "../../__tests__/fixtures";
import { setPromptsHidden } from "../../hooks/use-hide-prompts";
import { SessionDetailPage } from "../SessionDetailPage";

const SESSION_ID = "sess-live";
const OWNER = "carol";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

interface DetailServer {
  callRequests: URLSearchParams[];
  deleted: string[];
}

interface ServeOptions {
  session?: Partial<AgentSession>;
  pages?: SessionCallPage[] | ((params: URLSearchParams) => SessionCallPage);
  usage?: SessionUsageList;
  children?: AgentSession[];
}

const USAGE: SessionUsageList = {
  price_table_version: "2026-09-30",
  items: [
    {
      model: "claude-opus-5-5",
      provider: "anthropic",
      service_tier: null,
      auth_kind: "subscription",
      pricing_status: "priced",
      usage_count: 12,
      input_uncached_tokens: 180_000,
      cache_read_tokens: 1_800_000,
      cache_write_5m_tokens: 90_000,
      cache_write_1h_tokens: 0,
      output_tokens: 20_000,
      reasoning_tokens: 0,
      cost_usd: 5.71,
      cost_reported_usd: null,
      cost_estimated_usd: 5.71,
      cost_source: "estimated",
      cost_basis: "api_equivalent",
      unpriced_usage_count: 0,
      stale_usage_count: 0,
    },
  ],
};

function liveSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return makeSession({
    id: SESSION_ID,
    title: "Fix linked_summary double-counting overlapping subagent spans",
    status: "active",
    display_state: "active",
    started_at: minutesAgo(72),
    last_event_at: minutesAgo(1),
    ended_at: null,
    ended_reason: null,
    harness_version: "2.1",
    model: "claude-opus-5-5",
    repository: "valaris/backplane",
    branch: "fix/linked-summary-union",
    cost_usd: 6.18,
    cost_basis: "api_equivalent",
    cost_source: "reported",
    input_tokens: 214_000,
    output_tokens: 142_000,
    cache_read_tokens: 1_860_000,
    cache_creation_tokens: 196_000,
    prompt_count: 3,
    tool_call_count: 41,
    error_count: 1,
    ...overrides,
  });
}

function serveDetail(options: ServeOptions = {}): DetailServer {
  const callRequests: URLSearchParams[] = [];
  const deleted: string[] = [];
  const session = liveSession(options.session);
  const pages = options.pages ?? [callPage([])];
  server.use(
    http.get("/api/workspaces", () => HttpResponse.json([{ id: "ws-1", slug: SLUG, name: "Acme" }])),
    http.get(`/api/workspaces/${SLUG}/sessions/${SESSION_ID}`, () => HttpResponse.json(session)),
    http.delete(`/api/workspaces/${SLUG}/sessions/${SESSION_ID}`, () => {
      deleted.push(SESSION_ID);
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(`/api/workspaces/${SLUG}/sessions/${SESSION_ID}/calls`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      callRequests.push(params);
      if (typeof pages === "function") return HttpResponse.json(pages(params));
      const cursor = params.get("cursor");
      const page = cursor ? pages.find((_, index) => `page-${index}` === cursor) : pages[0];
      return HttpResponse.json(page ?? callPage([]));
    }),
    http.get(`/api/workspaces/${SLUG}/sessions/${SESSION_ID}/usage`, () => HttpResponse.json(options.usage ?? USAGE)),
    http.get(`/api/workspaces/${SLUG}/sessions/${SESSION_ID}/rhythm`, () =>
      HttpResponse.json({
        start: session.started_at,
        end: session.last_event_at,
        live: session.display_state === "active",
        bucket_seconds: 60,
        buckets: [{ t: session.started_at, prompt: 1, tool: 2, file: 0, work: 0, error: 0 }],
        idle_spans: [],
        children: [],
        capture_gaps: session.capture_gaps,
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/sessions/${SESSION_ID}/links`, () => HttpResponse.json({ items: [] })),
    http.get(`/api/workspaces/${SLUG}/sessions/${SESSION_ID}/contents`, () => HttpResponse.json({ items: [], next_cursor: null })),
    http.get(`/api/workspaces/${SLUG}/sessions/${SESSION_ID}/children`, () =>
      HttpResponse.json({ items: options.children ?? [] }),
    ),
    http.get(`/api/workspaces/${SLUG}/boards`, () => HttpResponse.json([{ id: "board-1", name: "Backplane" }])),
  );
  return { callRequests, deleted };
}

function renderDetail() {
  stubAuthModes(true);
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/sessions/:sessionId"
        element={
          <>
            <SessionDetailPage />
            <LocationProbe />
          </>
        }
      />
      <Route path="/:slug/sessions" element={<LocationProbe />} />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/sessions/${SESSION_ID}`] } },
  );
}

function callRow(name: string) {
  const row = screen.getByText(name, { selector: "[data-call-name]" }).closest("[data-call-row]");
  if (!row) throw new Error(`no call row named ${name}`);
  return row as HTMLElement;
}

const PROMPT = makeCall({
  key: "prompt-1",
  kind: "prompt",
  turn_index: 1,
  name: "prompt.submitted",
  outcome: null,
  prompt_preview: "Write the failing test first: a parent 14:00-15:00 with a child 14:10-14:30 should total 3600 seconds.",
  args_preview: null,
  call_id: null,
  duration_ms: null,
});

afterEach(() => {
  // The store notifies every mounted subscriber; reset inside act().
  act(() => setPromptsHidden(false));
  window.localStorage.clear();
});

describe("Session detail — header", () => {
  it("titles the page with the captured first prompt and states the facts", async () => {
    serveDetail();
    renderDetail();

    expect(await screen.findByRole("heading", { level: 1, name: "Fix linked_summary double-counting overlapping subagent spans" })).toBeInTheDocument();
    const header = screen.getByRole("region", { name: "Session" });
    expect(within(header).getByText("Live")).toBeInTheDocument();
    expect(within(header).getByText("Claude Code 2.1")).toBeInTheDocument();
    expect(within(header).getByText("claude-opus-5-5")).toBeInTheDocument();
    expect(within(header).getByText("valaris/backplane")).toBeInTheDocument();
    expect(within(header).getByText(/^Started/)).toBeInTheDocument();
    expect(header.querySelector("time[datetime]")).not.toBeNull();
  });

  it("copies a link to the session", async () => {
    const user = userEvent.setup();
    serveDetail();
    renderDetail();

    await user.click(await screen.findByRole("button", { name: "Copy link" }));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toContain(`/${SLUG}/sessions/${SESSION_ID}`));
  });

  it("deletes the session and its subagents from Backplane after confirmation, then returns to the list", async () => {
    const { deleted } = serveDetail({ children: [makeSession({ id: "child-1", parent_session_id: SESSION_ID })] });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "More actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete session" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/its 1 subagent session from Backplane\. It stays on your device\./)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleted).toEqual([SESSION_ID]));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/${SLUG}/sessions`));
  });

  it("says a deleted or expired session isn't here anymore", async () => {
    stubAuthModes(true);
    server.use(
      http.get(`/api/workspaces/${SLUG}/sessions/${SESSION_ID}`, () => HttpResponse.json({ detail: "Not found" }, { status: 404 })),
    );
    renderDetail();
    expect(await screen.findByRole("heading", { name: "This session isn't here anymore" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to My sessions" })).toHaveAttribute("href", `/${SLUG}/sessions`);
  });

  it("links a subagent session up to its parent", async () => {
    serveDetail({ session: { parent_session_id: "parent-1" } });
    server.use(
      http.get(`/api/workspaces/${SLUG}/sessions/parent-1`, () =>
        HttpResponse.json(makeSession({ id: "parent-1", title: "Parent session prompt" })),
      ),
    );
    renderDetail();
    expect(await screen.findByRole("link", { name: "Parent session prompt" })).toHaveAttribute("href", `/${SLUG}/sessions/parent-1`);
  });
});

describe("Session detail — timeline of turns and calls", () => {
  it("opens each turn with your prompt and its stats", async () => {
    serveDetail({
      pages: [
        callPage(
          [PROMPT, makeCall({ key: "c-1", name: "Grep" })],
          [makeTurn({ turn_index: 1, call_count: 24, failure_count: 1, started_at: minutesAgo(51), ended_at: minutesAgo(32) })],
        ),
      ],
    });
    renderDetail();

    const turn = await screen.findByRole("article");
    expect(within(turn).getByText("You")).toBeInTheDocument();
    expect(within(turn).getByText(/Write the failing test first/)).toBeInTheDocument();
    expect(within(turn).getByText("24 calls")).toBeInTheDocument();
    expect(within(turn).getByText("1 failed")).toBeInTheDocument();
    expect(within(turn).getByText("19m")).toBeInTheDocument();
    expect(screen.getByText("Session totals: 3 turns · 41 calls")).toBeInTheDocument();
  });

  it("does not label ingested failure events as the timeline failed-call total", async () => {
    serveDetail({
      session: { error_count: 2 },
      pages: [callPage(
        [PROMPT, makeCall({ key: "historical-failure", name: "Read", outcome: "failed" })],
        [makeTurn({ turn_index: 1, failure_count: 1 })],
      )],
    });
    server.use(http.get(`/api/workspaces/${SLUG}/sessions/${SESSION_ID}/rhythm`, () =>
      HttpResponse.json({
        start: minutesAgo(72), end: minutesAgo(1), live: true, bucket_seconds: 60,
        buckets: [{ t: minutesAgo(72), prompt: 1, tool: 0, file: 0, work: 0, error: 1 }],
        idle_spans: [], children: [], capture_gaps: 0,
      }),
    ));
    renderDetail();

    const turn = await screen.findByRole("article");
    expect(within(turn).getByText("1 failed")).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: /Session rhythm.*1 prompt, 1 call, 1 failed/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Failures" })).toBeInTheDocument();
    expect(screen.getByText("Session totals: 3 turns · 41 calls")).toBeInTheDocument();
    expect(screen.queryByText(/3 turns · 41 calls · 2 failed/)).not.toBeInTheDocument();
  });

  it("is explicit about output: withheld with its size, or none at all", async () => {
    serveDetail({
      pages: [
        callPage([
          PROMPT,
          makeCall({ key: "c-grep", name: "Grep", output: "withheld", withheld: [{ field: "output", bytes: 1229 }] }),
          makeCall({ key: "c-edit", name: "Edit", output: "none", args_preview: "backend/tests/test_session_lifecycle.py" }),
        ]),
      ],
    });
    renderDetail();

    await screen.findByText("Output withheld · 1.2 KB as reported");
    expect(within(callRow("Grep")).getByLabelText("Output not sent at this capture level, 1.2 KB as reported")).toBeInTheDocument();
    expect(within(callRow("Edit")).getByText("No output")).toBeInTheDocument();
    expect(within(callRow("Edit")).getByText("backend/tests/test_session_lifecycle.py")).toBeInTheDocument();
  });

  it("never shows a call as succeeded without a completion signal", async () => {
    serveDetail({
      pages: [
        callPage([
          PROMPT,
          makeCall({ key: "c-ok", name: "Read", outcome: "succeeded" }),
          makeCall({ key: "c-run", name: "Bash", outcome: "running", args_preview: "pytest -k overlap" }),
          makeCall({ key: "c-unk", name: "WebFetch", outcome: "unknown" }),
        ]),
      ],
    });
    renderDetail();

    await screen.findByText("pytest -k overlap");
    expect(within(callRow("Read")).getByLabelText("Succeeded")).toBeInTheDocument();
    expect(within(callRow("Bash")).getByText("Running")).toBeInTheDocument();
    expect(within(callRow("WebFetch")).getByText("No result captured")).toBeInTheDocument();
    expect(within(callRow("WebFetch")).queryByLabelText("Succeeded")).not.toBeInTheDocument();
  });

  it("opens a failed call with its error and exit code", async () => {
    serveDetail({
      pages: [
        callPage([
          PROMPT,
          makeCall({ key: "c-fail", name: "Bash", outcome: "failed", exit_code: 1, args_preview: "pytest tests/test_session_lifecycle.py -k overlap", call_id: "toolu_01HcR9x2", output: "withheld", withheld: [{ field: "output", bytes: 6553 }] }),
        ]),
      ],
    });
    server.use(
      http.get(`/api/workspaces/${SLUG}/sessions/${SESSION_ID}/calls/c-fail`, () =>
        HttpResponse.json({
          key: "c-fail",
          events: [
            {
              id: "e1", event_id: "e1", capture_id: "cap", occurred_at: minutesAgo(40), received_at: minutesAgo(40),
              action: "tool.failed", kind: "tool", category: null, fidelity: null, collection_method: "hook",
              tool_name: "Bash", native_tool_call_id: "toolu_01HcR9x2", mcp_server: null, mcp_tool: null, outcome: "failed",
              data: { error: { message: "AssertionError: assert 4800.0 == 3600.0" } },
            },
          ],
        }),
      ),
    );
    renderDetail();

    const row = await waitFor(() => callRow("Bash"));
    expect(within(row).getByText("Exit 1")).toBeInTheDocument();
    const toggle = within(row).getByRole("button", { name: /Bash/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("AssertionError: assert 4800.0 == 3600.0")).toBeInTheDocument();
    expect(screen.getByText("toolu_01HcR9x2")).toBeInTheDocument();
    expect(screen.getByText("Output stayed on your device.")).toBeInTheDocument();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("carries the exact card an MCP call touched", async () => {
    serveDetail({
      pages: [
        callPage([
          PROMPT,
          makeCall({
            key: "c-mcp",
            kind: "mcp",
            name: "mcp__valaris__get_card",
            mcp_server: "valaris",
            mcp_tool: "get_card",
            work_refs: [
              { entity_type: "card", entity_id: "card-1", workspace_id: "ws-1", board_id: "board-1", title: "Bug: linked_summary double-counts", relation: "consulted", provenance: "exact" },
            ],
          }),
        ]),
      ],
    });
    server.use(http.get(`/api/workspaces/${SLUG}/boards/board-1/cards/card-1`, () =>
      HttpResponse.json({ id: "card-1", board_id: "board-1", title: "Bug: linked_summary double-counts" }),
    ));
    renderDetail();

    const row = await waitFor(() => callRow("valaris · get_card"));
    expect(await within(row).findByRole("link", { name: "Consulted: Bug: linked_summary double-counts" })).toHaveAttribute(
      "href",
      `/${SLUG}/boards/board-1/kanban?card=card-1`,
    );
  });

  it("places a subagent at its start, with a link to its own session", async () => {
    serveDetail({
      pages: [
        callPage([
          PROMPT,
          makeCall({
            key: "sub-1",
            kind: "subagent",
            name: null,
            outcome: null,
            subagent: makeSession({ id: "child-1", title: "Explore · map linked_summary callers", tool_call_count: 23, status: "active", display_state: "active" }),
          }),
        ]),
      ],
    });
    renderDetail();

    const open = await screen.findByRole("link", { name: "Open subagent session: Explore · map linked_summary callers" });
    expect(open).toHaveAttribute("href", `/${SLUG}/sessions/child-1`);
    const row = open.closest("[data-subagent-row]") as HTMLElement;
    expect(within(row).getByText("Live")).toBeInTheDocument();
    expect(within(row).getByText("23 calls so far")).toBeInTheDocument();
  });

  it("says a prompt was not sent, with its size, instead of showing it", async () => {
    serveDetail({
      pages: [callPage([{ ...PROMPT, prompt_preview: null, withheld: [{ field: "prompt", bytes: 1434 }] }])],
    });
    renderDetail();
    expect(await screen.findByText("Prompt not sent · 1.4 KB as reported")).toBeInTheDocument();
  });

  it("collapses a run of routine reads behind one row you can expand", async () => {
    const reads = ["Read", "Grep", "Read", "Glob", "Read", "Grep"].map((name, index) =>
      makeCall({ key: `r-${index}`, name, args_preview: `file-${index}.py` }),
    );
    serveDetail({ pages: [callPage([PROMPT, ...reads])] });
    renderDetail();

    const summary = await screen.findByText("5 more calls");
    expect(summary.closest("li")).toHaveTextContent("Read ×2");
    expect(screen.queryByText("file-5.py")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Show/ }));
    expect(screen.getByText("file-5.py")).toBeInTheDocument();
  });

  it("filters to failures through the calls endpoint", async () => {
    const { callRequests } = serveDetail({ pages: [callPage([PROMPT])] });
    renderDetail();
    await userEvent.click(await screen.findByRole("button", { name: "Failures" }));
    await waitFor(() => expect(callRequests.at(-1)?.get("filter")).toBe("failures"));
    expect(screen.getByRole("button", { name: "Failures" })).toHaveAttribute("aria-pressed", "true");
  });

  it("loads earlier calls above the newest page", async () => {
    const { callRequests } = serveDetail({
      pages: [
        callPage([makeCall({ key: "late", name: "Edit", args_preview: "late.py", started_at: minutesAgo(10) })], [makeTurn()], "page-1"),
        callPage([PROMPT, makeCall({ key: "early", name: "Read", args_preview: "early.py", started_at: minutesAgo(60) })]),
      ],
    });
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Load earlier calls" }));
    const early = await screen.findByText("early.py");
    expect(callRequests.at(-1)?.get("cursor")).toBe("page-1");
    expect(early.compareDocumentPosition(screen.getByText("late.py")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("tells you new calls appear while the session is live", async () => {
    serveDetail({ pages: [callPage([PROMPT])] });
    renderDetail();
    expect(await screen.findByText("New calls appear as they arrive")).toBeInTheDocument();
  });

  it("hides prompts in the timeline and the title when presenting", async () => {
    serveDetail({ pages: [callPage([PROMPT])] });
    renderDetail();
    await screen.findByText(/Write the failing test first/);
    await userEvent.click(screen.getByRole("button", { name: "Presenter mode" }));
    expect(screen.getByText(/Write the failing test first/)).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Fix linked_summary double-counting overlapping subagent spans")).toHaveAttribute("aria-hidden", "true");
  });

  it("hides call content too when presenting, keeping tool names, file paths and the command verb", async () => {
    const SECRET = "deploy --token sk-live-4242";
    serveDetail({
      pages: [
        callPage([
          PROMPT,
          makeCall({ key: "c-edit", name: "Edit", args_preview: "backend/app/services/agent_session.py", output: "none" }),
          makeCall({ key: "c-grep", name: "Grep", args_preview: "STRIPE_SECRET backend/app" }),
          makeCall({ key: "c-mcp", kind: "mcp", name: "mcp__valaris__create_note", mcp_server: "valaris", mcp_tool: "create_note", args_preview: '{"title":"Customer churn list"}' }),
          makeCall({ key: "c-fail", name: "Bash", outcome: "failed", exit_code: 1, args_preview: `./scripts/${SECRET}`, output: "sent", call_id: "toolu_9" }),
        ]),
      ],
    });
    server.use(
      http.get(`/api/workspaces/${SLUG}/sessions/${SESSION_ID}/calls/c-fail`, () =>
        HttpResponse.json({
          key: "c-fail",
          events: [
            {
              id: "e1", event_id: "e1", capture_id: "cap", occurred_at: minutesAgo(40), received_at: minutesAgo(40),
              action: "tool.failed", kind: "tool", category: null, fidelity: null, collection_method: "hook",
              tool_name: "Bash", native_tool_call_id: "toolu_9", mcp_server: null, mcp_tool: null, outcome: "failed",
              data: { error: { message: "denied for user carol@acme.test" }, command: { stdout: "rows: 4,812 customers" } },
            },
          ],
        }),
      ),
    );
    renderDetail();
    expect(await screen.findByText("rows: 4,812 customers")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Presenter mode" }));

    // Visible structure survives: tool names, the file an edit touched, the verb.
    expect(within(callRow("Edit")).getByText("backend/app/services/agent_session.py")).not.toHaveAttribute("aria-hidden");
    expect(within(callRow("Bash")).getByText("./scripts/deploy")).not.toHaveAttribute("aria-hidden");
    for (const sensitive of ["--token sk-live-4242", "STRIPE_SECRET backend/app", '{"title":"Customer churn list"}', "denied for user carol@acme.test", "rows: 4,812 customers"]) {
      expect(screen.getByText(sensitive)).toHaveAttribute("aria-hidden", "true");
    }
    // Nothing hidden reaches assistive tech or the clipboard.
    const bash = within(callRow("Bash")).getByRole("button", { name: /Bash/ });
    expect(bash).not.toHaveAccessibleName(/sk-live/);
    expect(screen.queryByRole("button", { name: "Copy output" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Content hidden", { selector: ".sr-only" }).length).toBeGreaterThanOrEqual(4);
  });

  it("states a zero-byte withheld output as 0 B, not as an unknown size", async () => {
    serveDetail({ pages: [callPage([PROMPT, makeCall({ key: "c-0", name: "Read", output: "withheld", withheld: [{ field: "output", bytes: 0 }] })])] });
    renderDetail();
    expect(await screen.findByText("Output withheld · 0 B as reported")).toBeInTheDocument();
  });
});

describe("Session detail — banners", () => {
  it("warns that records were not captured", async () => {
    serveDetail({ session: { display_state: "incomplete", capture_gaps: 3 } });
    renderDetail();
    expect(await screen.findByText("3 records weren't captured", { selector: "[role=note] *" })).toBeInTheDocument();
  });

  it("explains a usage-only session instead of an empty timeline", async () => {
    const { callRequests } = serveDetail({
      session: { coverage: "usage_only", harness: "codex_desktop", harness_display_name: "Codex Desktop", title: null, prompt_count: 0, tool_call_count: 0 },
    });
    renderDetail();
    expect(await screen.findByText(/Codex Desktop reported token usage for this session, but no activity/)).toBeInTheDocument();
    expect(callRequests).toHaveLength(0);
  });
});

describe("Session detail — facts rail", () => {
  it("puts the transcript before secondary facts in the middle-width reading order", async () => {
    serveDetail({ session: { capture_levels: ["rich"] } });
    server.use(http.get(`/api/workspaces/${SLUG}/sessions/${SESSION_ID}/contents`, () =>
      HttpResponse.json(contentPage([makeContent({ id: "read-first", session_id: SESSION_ID })])),
    ));
    renderDetail();

    // The default media-query fixture is neither compact nor wide: the rail
    // and reader share one column, so document order is also reading order.
    const transcript = await screen.findByRole("region", { name: "Transcript" });
    for (const name of ["Cost", "Tokens", "What was captured"]) {
      const facts = screen.getByRole("region", { name });
      expect(transcript.compareDocumentPosition(facts) & Node.DOCUMENT_POSITION_FOLLOWING, `${name} follows the reader`).toBeTruthy();
    }
  });

  it("states cost with its basis and what a subscription means", async () => {
    serveDetail();
    renderDetail();

    const cost = await screen.findByRole("region", { name: "Cost" });
    expect(within(cost).getByText("$6.18")).toBeInTheDocument();
    expect(within(cost).getByText("API-equivalent")).toBeInTheDocument();
    expect(within(cost).getByText(/Your subscription covers them, so this isn't money spent/)).toBeInTheDocument();
    expect(await within(cost).findByRole("cell", { name: "claude-opus-5-5" })).toBeInTheDocument();
    expect(within(cost).getByRole("cell", { name: /^\$5\.71/ })).toHaveTextContent("est.");
  });

  it("breaks tokens down by kind", async () => {
    serveDetail();
    renderDetail();
    const tokens = await screen.findByRole("region", { name: "Tokens" });
    expect(within(tokens).getByText("Cache read")).toBeInTheDocument();
    expect(within(tokens).getByText("1.86M")).toBeInTheDocument();
    expect(within(tokens).getByText("2.41M")).toBeInTheDocument();
  });

  it("lists the work this session changed or consulted, titled from the work itself", async () => {
    serveDetail();
    server.use(
      http.get(`/api/workspaces/${SLUG}/sessions/${SESSION_ID}/links`, () =>
        HttpResponse.json({
          items: [
            { entity_type: "card", entity_id: "card-1", workspace_id: "ws-1", board_id: "board-1", relation: "changed", first_seen_at: minutesAgo(60), last_seen_at: minutesAgo(5), invocation_count: 3, provenance: "exact" },
          ],
        }),
      ),
      http.get(`/api/workspaces/${SLUG}/boards/board-1/cards/card-1`, () =>
        HttpResponse.json({ id: "card-1", title: "Bug: agent_session linked_summary double-counts", board_id: "board-1" }),
      ),
    );
    renderDetail();

    const linked = await screen.findByRole("region", { name: "Linked work" });
    expect(await within(linked).findByRole("link", { name: "Bug: agent_session linked_summary double-counts" })).toBeInTheDocument();
    expect(within(linked).getByText(/Changed/)).toBeInTheDocument();
    expect(within(linked).getByText(/3 recorded tool calls/)).toBeInTheDocument();
  });

  it("describes missing work links without claiming no work happened", async () => {
    serveDetail();
    renderDetail();
    const linked = await screen.findByRole("region", { name: "Linked work" });
    expect(await within(linked).findByText("No card or note links have been recorded for this session.")).toBeInTheDocument();
    expect(within(linked).queryByText(/didn't change or consult/)).not.toBeInTheDocument();
  });

  it("never claims a level for a session captured before levels were recorded", async () => {
    serveDetail({ session: { capture_levels: [] } });
    renderDetail();
    const captured = await screen.findByRole("region", { name: "What was captured" });
    expect(within(captured).getByText("Captured before levels were recorded")).toBeInTheDocument();
    expect(within(captured).queryByText("Standard")).not.toBeInTheDocument();
    expect(within(captured).getByText("No capture gaps reported")).toBeInTheDocument();
  });

  it("shows the folder as the server sends it: the bound folder and the path inside it", async () => {
    serveDetail({ session: { cwd: "backplane/packages/api" } });
    renderDetail();
    const captured = await screen.findByRole("region", { name: "What was captured" });
    expect(within(captured).getByText("backplane/packages/api")).toBeInTheDocument();
  });

  it("falls back to the last folder for an older row that still holds a device path", async () => {
    serveDetail({ session: { cwd: `/home/${OWNER}/code/backplane` } });
    renderDetail();
    const captured = await screen.findByRole("region", { name: "What was captured" });
    expect(within(captured).getByText("backplane")).not.toHaveAttribute("title");
    expect(document.body.innerHTML).not.toContain(`/home/${OWNER}`);
  });

  it("shows the session's rhythm above the timeline", async () => {
    serveDetail();
    renderDetail();
    expect(await screen.findByRole("region", { name: "Session rhythm" })).toBeInTheDocument();
  });

  it("tells keyboard users how to move between turns", async () => {
    serveDetail({
      pages: [callPage([PROMPT, { ...PROMPT, key: "prompt-2", turn_index: 2 }], [makeTurn({ turn_index: 1 }), makeTurn({ turn_index: 2 })])],
    });
    renderDetail();
    expect(await screen.findByText("Press [ or ] to move between turns")).toBeInTheDocument();
  });

  it("reads usage-only from coverage, never guesses it from counts", async () => {
    serveDetail({ session: { coverage: "activity", prompt_count: 0, tool_call_count: 0 } });
    renderDetail();
    await screen.findByRole("region", { name: "What was captured" });
    expect(screen.queryByText(/reported token usage for this session, but no activity/)).not.toBeInTheDocument();
  });

  it("moves between turns with [ and ]", async () => {
    serveDetail({
      pages: [
        callPage(
          [PROMPT, makeCall({ key: "a" }), { ...PROMPT, key: "prompt-2", turn_index: 2, prompt_preview: "Second turn prompt" }],
          [makeTurn({ turn_index: 1 }), makeTurn({ turn_index: 2 })],
        ),
      ],
    });
    renderDetail();
    const turns = await screen.findAllByRole("article");
    expect(turns).toHaveLength(2);

    await userEvent.click(within(callRow("Grep")).getByRole("button", { name: /Grep/ }));
    await userEvent.keyboard("]");
    expect(turns[1]).toHaveFocus();
    await userEvent.keyboard("[[");
    expect(turns[0]).toHaveFocus();
  });

  it("drops local paths and home folders entirely in presenter mode", async () => {
    // Built at runtime: the public-export denylist rejects a literal macOS
    // home path in source, and this test must still prove macOS redaction.
    const macHome = ["", "Users", OWNER].join("/");
    const macPath = `${macHome}/code/backplane/app/main.py`;
    serveDetail({
      session: { device_name: "Carol's MacBook Pro" },
      pages: [
        callPage([
          PROMPT,
          makeCall({ key: "c-abs", name: "Read", args_preview: macPath }),
          makeCall({ key: "c-sh", name: "Bash", args_preview: `/home/${OWNER}/bin/deploy --prod` }),
        ]),
      ],
    });
    renderDetail();
    await screen.findByText(macPath);

    await userEvent.click(screen.getByRole("button", { name: "Presenter mode" }));

    const captured = screen.getByRole("region", { name: "What was captured" });
    expect(within(captured).getByText("backplane/packages/api")).toBeInTheDocument();
    expect(within(callRow("Read")).getByText("~/code/backplane/app/main.py")).toBeInTheDocument();
    expect(within(callRow("Bash")).getByText("~/bin/deploy")).toBeInTheDocument();
    expect(screen.getByText("Carol's MacBook Pro")).toHaveAttribute("aria-hidden", "true");
    expect(document.body.innerHTML).not.toContain(`${macHome}/`);
    expect(document.body.innerHTML).not.toMatch(/\/home\/(carol|operator)\//);
  });

  it("names the level and what stayed on the device once levels are recorded", async () => {
    serveDetail({ session: { capture_levels: ["standard"] } });
    renderDetail();
    const captured = await screen.findByRole("region", { name: "What was captured" });
    expect(within(captured).getByText("Standard")).toBeInTheDocument();
    expect(within(captured).getByText("Prompts, commands and tool arguments")).toBeInTheDocument();
    expect(within(captured).getByText("Tool output and the agent's replies stayed on your device")).toBeInTheDocument();
  });

  it("names the rich level on the four-step meter", async () => {
    serveDetail({ session: { capture_levels: ["full", "rich"] } });
    renderDetail();
    const captured = await screen.findByRole("region", { name: "What was captured" });
    expect(within(captured).getByText("Rich")).toBeInTheDocument();
    expect(within(captured).getByRole("img", { name: "Capture level: Rich" }).children).toHaveLength(4);
    expect(within(captured).getByText("Prompts, replies, complete tool output, edits and attached images")).toBeInTheDocument();
    expect(within(captured).getByText("Anything outside the bound folder stayed on your device")).toBeInTheDocument();
  });
});
