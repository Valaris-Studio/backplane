// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ConsoleMessage, Page } from "@playwright/test";

export interface CapturedMessage {
  /** "console.error" or "pageerror" — pageerror is an uncaught exception. */
  source: "console.error" | "pageerror";
  text: string;
  /** The page URL at the moment the message fired, i.e. which flow produced it. */
  pageUrl: string;
  /** Emitting script location, when the browser reports one. */
  origin: string;
}

interface AllowlistEntry {
  /** Finding ID + why this is by design. Shown in failure output for context. */
  rationale: string;
  matches: (message: CapturedMessage) => boolean;
}

/**
 * By-design console noise. Every entry names the finding it pins and why the
 * message is acceptable. Patterns are anchored to a specific message shape or
 * a specific URL — never to a bare status code or log level — so that the same
 * class of error on any OTHER endpoint still fails the gate.
 *
 * Adding an entry here is a product decision, not a test fix: it asserts the
 * message is unavoidable and harmless. Anything else must be fixed in the app.
 */
export const ALLOWLIST: AllowlistEntry[] = [
  {
    // BP-FE-008 (wontfix by design): React StrictMode double-mounts the
    // WebSocket provider in dev, so the first socket is torn down mid-handshake
    // and Chromium logs the aborted connection. Dev-only — StrictMode's second
    // mount does not happen in the production build. Anchored to the app's own
    // /ws/workspaces/... endpoint AND the "closed before the connection is
    // established" shape: a genuine WS failure (refused, 500, auth reject)
    // reports different text and still fails the gate.
    rationale:
      "BP-FE-008 wontfix: React StrictMode double-mount aborts the dev WebSocket handshake",
    matches: (m) =>
      m.text.includes("WebSocket connection to") &&
      m.text.includes("/ws/workspaces/") &&
      m.text.includes("closed before the connection is established"),
  },
  {
    // BP-FE-009 (deliberate self-host design, pinned by this test): the SPA
    // probes /api/auth/modes on every page so a signed-out visitor learns
    // whether a login exists at all (see AuthModesBootstrap). On deployments
    // where the endpoint is closed to unauthenticated callers the probe answers
    // 403 and the browser logs the resource failure. The probe is expected to
    // be rejectable; the app handles it. Anchored to the auth-modes URL, so a
    // 403 on any other endpoint remains a gate failure.
    rationale:
      "BP-FE-009 by design: AuthModesBootstrap pre-auth probe of /api/auth/modes may answer 403",
    matches: (m) =>
      m.text.includes("Failed to load resource") &&
      m.text.includes("403") &&
      m.origin.includes("/api/auth/modes"),
  },
];

function isAllowlisted(message: CapturedMessage): boolean {
  return ALLOWLIST.some((entry) => entry.matches(message));
}

export class ConsoleCollector {
  private readonly captured: CapturedMessage[] = [];

  private constructor(private readonly page: Page) {}

  /** Attaches listeners. Call before the first navigation or messages are lost. */
  static attach(page: Page): ConsoleCollector {
    const collector = new ConsoleCollector(page);

    page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() !== "error") return;
      const loc = msg.location();
      collector.captured.push({
        source: "console.error",
        text: msg.text(),
        pageUrl: page.url(),
        origin: loc.url ? `${loc.url}:${loc.lineNumber}:${loc.columnNumber}` : "",
      });
    });

    page.on("pageerror", (err: Error) => {
      collector.captured.push({
        source: "pageerror",
        text: `${err.name}: ${err.message}`,
        pageUrl: page.url(),
        origin: err.stack?.split("\n")[1]?.trim() ?? "",
      });
    });

    return collector;
  }

  /** Everything seen so far, allowlisted or not. Used by the self-test. */
  all(): CapturedMessage[] {
    return [...this.captured];
  }

  violations(): CapturedMessage[] {
    return this.captured.filter((m) => !isAllowlisted(m));
  }

  /** Verbatim report of the offending messages, for assertion failure output. */
  report(flow: string): string {
    const violations = this.violations();
    const lines = violations.map(
      (m, i) =>
        `  ${i + 1}. [${m.source}] ${m.text}\n` +
        `     page:   ${m.pageUrl}\n` +
        `     origin: ${m.origin || "(none reported)"}`,
    );
    const allowed = this.captured.length - violations.length;
    return (
      `Console was not clean after flow "${flow}": ` +
      `${violations.length} non-allowlisted error(s) ` +
      `(${allowed} allowlisted message(s) ignored).\n` +
      lines.join("\n")
    );
  }
}
