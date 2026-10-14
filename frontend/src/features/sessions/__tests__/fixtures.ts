// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { http, HttpResponse, server } from "@/test/msw-server";
import type {
  AgentSession,
  SessionCallItem,
  SessionCallPage,
  SessionContent,
  SessionContentPage,
  SessionTurn,
} from "@/types/agent-session";

export const SLUG = "acme";
export const ME = "user-me";

export function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

export function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "sess-1",
    workspace_id: "ws-1",
    owner_id: ME,
    installation_id: "inst-1",
    harness: "claude_code",
    harness_display_name: "Claude Code",
    native_session_id: "native-1",
    parent_session_id: null,
    mapping_id: "map-1",
    board_id: null,
    status: "ended",
    started_at: minutesAgo(90),
    last_event_at: minutesAgo(18),
    ended_at: minutesAgo(18),
    cwd: "backplane/packages/api",
    repository: "valaris/backplane",
    branch: "dk-web/i18n",
    model: "claude-opus-5-5",
    harness_version: "2.1",
    title: "Audit i18n keys for the sessions namespace",
    input_tokens: 100_000,
    output_tokens: 20_000,
    cache_read_tokens: 15_000,
    cache_creation_tokens: 5_000,
    reasoning_tokens: 0,
    cost_usd: 0.74,
    cost_reported_usd: null,
    cost_estimated_usd: 0.74,
    cost_source: "estimated",
    cost_basis: "api_equivalent",
    cost_complete: true,
    auth_kind: "subscription",
    provider: "anthropic",
    service_tier: null,
    event_count: 40,
    prompt_count: 2,
    tool_call_count: 18,
    error_count: 0,
    capture_gaps: 0,
    activity_event_count: 38,
    coverage: "activity",
    capture_levels: ["standard"],
    display_state: "ended",
    ended_reason: "session_end_event",
    idle_since: null,
    ...overrides,
  };
}

export function makeCall(overrides: Partial<SessionCallItem> = {}): SessionCallItem {
  return {
    key: "call-1",
    kind: "tool",
    turn_index: 1,
    call_id: "toolu_01",
    name: "Grep",
    mcp_server: null,
    mcp_tool: null,
    started_at: minutesAgo(60),
    ended_at: minutesAgo(60),
    duration_ms: 100,
    event_count: 2,
    outcome: "succeeded",
    exit_code: null,
    args_preview: "total_duration_seconds backend/app",
    prompt_preview: null,
    output: "none",
    withheld: [],
    work_refs: [],
    subagent: null,
    ...overrides,
  };
}

export function makeTurn(overrides: Partial<SessionTurn> = {}): SessionTurn {
  return {
    turn_index: 1,
    started_at: minutesAgo(61),
    ended_at: minutesAgo(42),
    call_count: 14,
    failure_count: 0,
    reasoning_count: 0,
    ...overrides,
  };
}

export function callPage(
  items: SessionCallItem[],
  turns: SessionTurn[] = [makeTurn()],
  next_cursor: string | null = null,
): SessionCallPage {
  return { items, turns, next_cursor };
}

export function stubAuthModes(companionEnabled: boolean, { richCaptureEnabled = true }: { richCaptureEnabled?: boolean } = {}) {
  server.use(
    http.get("/api/auth/modes", () =>
      HttpResponse.json({
        oidc_enabled: false,
        password_enabled: false,
        dev_mode: true,
        login_path: "/api/auth/oidc/login",
        logout_path: "/api/auth/oidc/logout",
        companion_enabled: companionEnabled,
        rich_capture_enabled: richCaptureEnabled,
      }),
    ),
    http.get("/api/me", () =>
      HttpResponse.json({ id: ME, email: "me@example.com", name: "Me", avatar_url: null }),
    ),
  );
}

export function makeContent(overrides: Partial<SessionContent> = {}): SessionContent {
  return {
    id: "content-1",
    session_id: "sess-1",
    event_id: null,
    call_id: null,
    parent_call_id: null,
    turn_id: null,
    role: "assistant",
    channel: "reply",
    display_path: null,
    media_type: "text/plain",
    coverage: "captured",
    coverage_reason: null,
    byte_count: 32,
    original_byte_count: null,
    sha256: "a".repeat(64),
    redaction: { filter_version: "redact/1", replacements: 0 },
    source: { kind: "claude_transcript", order: 1 },
    occurred_at: minutesAgo(5),
    render: "text",
    preview: { text: "Done: the retry is in place.", truncated: false },
    ...overrides,
  };
}

export function contentPage(items: SessionContent[], next_cursor: string | null = null): SessionContentPage {
  return { items, next_cursor };
}
