// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import { session, sessionPath, sha, slug, type RequestReceipt } from "./fixtures/session-window-fixture";
import { notePath, originalNoteTitle, privateDraftBody, privateDraftTitle } from "./fixtures/uxc-navigation-fixture";
import { installA04Fixture, privateBodyReads, unexpectedConsole, type A04Fixture } from "./fixtures/a04-related-continuity";

test.skip(process.env.BACKPLANE_E2E_A04_RELATED_FIXTURE !== "1", "Set BACKPLANE_E2E_A04_RELATED_FIXTURE=1 for synthetic actual-AppShell qualification");
test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce", serviceWorkers: "block" });
// The unchanged repository configuration supplies 90s cases / 15s expectations.
const listPath = `/api/workspaces/${slug}/sessions`;
const listHref = `/${slug}/sessions`;
const inputPaths = ["e2e/a04-list-family-scope.review.spec.ts", "e2e/fixtures/a04-related-continuity.ts",
  "e2e/fixtures/uxc-navigation-fixture.ts", "e2e/fixtures/session-window-fixture.ts", "playwright.config.ts", "src/i18n/locales/en.json"];
const sourcePaths = ["src/main.tsx", "src/App.tsx", "src/features/sessions/components/SessionStates.tsx",
  "src/features/sessions/components/MySessionsPage.tsx", "src/features/sessions/components/CompanionGate.tsx",
  "src/features/sessions/components/SessionsTabs.tsx", "src/features/sessions/components/AgentMark.tsx",
  "src/features/sessions/components/SessionsFilterBar.tsx", "src/features/sessions/api/use-sessions.ts",
  "src/features/sessions/api/use-linked-sessions.ts", "src/features/sessions/hooks/use-session-filters.ts",
  "src/components/layout/EmptyState.tsx", "src/components/ui/button.tsx", "src/lib/query-keys.ts"];
const hashes = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))]));
const manifestPath = process.env.BACKPLANE_E2E_A04_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as {
  head?: string; tree?: string; source_manifest?: string; files: Record<string, string>;
} : null;

type Attempt = RequestReceipt & { kind: "main" | "root-probe" | "any-probe";
  heldAt?: number; releasedAt?: number; fulfilledAt?: number; error?: string };
async function installFamilyProbe(page: Page, state: A04Fixture) {
  const origin = new URL(process.env.BACKPLANE_E2E_BASE_URL ?? "http://localhost:5173").origin;
  const attempts: Attempt[] = [], held = new Map<Attempt, () => void>();
  let armed = false, released = false, active = 0;
  // This one collection extension permits only the actual period list and
  // its two bounded history probes; all other API/WS rules stay unchanged.
  await page.route((url) => url.origin === origin && url.pathname === listPath, async (route) => {
    const request = route.request(), url = new URL(request.url());
    const kind = url.searchParams.has("since") ? "main"
      : url.searchParams.get("root_only") === "true" ? "root-probe" : "any-probe";
    const earlierProbe = attempts.find((attempt) => attempt.kind === "any-probe");
    const attempt: Attempt = { path: url.pathname, query: url.search, method: request.method(), startedAt: Date.now(),
      mode: null, callId: null, cursor: url.searchParams.get("cursor"), kind };
    attempts.push(attempt); state.requests.push(attempt); active += 1; state.inflight += 1;
    try {
      assert.equal(url.origin, origin); assert.equal(url.pathname, listPath);
      assert.equal(request.method(), "GET"); assert.equal(request.postData(), null);
      assert(!request.headers().authorization && !request.headers().cookie, "No fixture credentials");
      if (kind === "main") {
        assert.deepEqual([...url.searchParams.keys()].sort(), ["limit", "root_only", "since", "sort"]);
        assert.equal(url.searchParams.get("limit"), "50");
        assert.equal(url.searchParams.get("root_only"), "true");
        assert.equal(url.searchParams.get("sort"), "recent");
        assert(Number.isFinite(Date.parse(url.searchParams.get("since")!)), "The real period filter supplies an instant");
      } else {
        assert.deepEqual([...url.searchParams.keys()].sort(), ["limit", "root_only"]);
        assert.equal(url.searchParams.get("limit"), "1");
        assert.equal(url.searchParams.get("root_only"), kind === "root-probe" ? "true" : "false");
      }
      if (kind === "any-probe" && earlierProbe) {
        assert(armed, "Only explicit keyboard Retry starts another failed history probe");
        assert.equal(url.search, earlierProbe.query, "Retry preserves the exact failed probe query");
        if (!released) {
          attempt.heldAt = Date.now();
          await new Promise<void>((resolve) => held.set(attempt, () => {
            attempt.releasedAt = Date.now(); held.delete(attempt); resolve();
          }));
        }
      }
      const value = kind === "any-probe" ? { detail: "Synthetic history probe access denied" } : { items: [], next_cursor: null };
      const status = kind === "any-probe" ? 403 : 200;
      attempt.status = status; attempt.bytes = Buffer.byteLength(JSON.stringify(value));
      await route.fulfill({ status, json: value, headers: { "Cache-Control": "private, no-store" } });
      attempt.fulfilledAt = Date.now();
    } catch (error) {
      attempt.error = String(error); state.unexpected.push(`Family probe fixture: ${String(error)}`);
      await route.fulfill({ status: 500, json: { detail: "Synthetic family probe fixture contract failed" } }).catch(() => {});
    } finally { active -= 1; state.inflight -= 1; }
  });
  return { attempts, held, get active() { return active; }, arm() { armed = true; }, release() {
    released = true; for (const release of held.values()) release();
  } };
}

type Run = { state: A04Fixture; gate: Awaited<ReturnType<typeof installFamilyProbe>>;
  beforeInputs: ReturnType<typeof hashes>; beforeSource: ReturnType<typeof hashes>; observations: unknown[];
  listHeaders: { query: string; status: number; cacheControl: string; at: number }[] };
const runs = new Map<Page, Run>();

async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 64; step += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return step;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
  return 64;
}

async function viewSnapshot(page: Page) {
  // Bounded, passive native observations; no DOM/cache/provider state writes.
  return page.evaluate(({ retryLabel, noMatchLabel, denialLabel }) => {
    const main = document.querySelector("main");
    const retry = [...(main?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
      .find((button) => button.textContent?.trim() === retryLabel);
    const active = document.activeElement as HTMLElement | null;
    return { retryExists: !!retry, ariaBusy: retry?.getAttribute("aria-busy") ?? null,
      ariaDisabled: retry?.getAttribute("aria-disabled") ?? null,
      noMatchPresent: [...(main?.querySelectorAll("h1,h2,h3") ?? [])].some((heading) => heading.textContent?.trim() === noMatchLabel),
      denialPresent: main?.textContent?.includes(denialLabel) ?? false,
      skeletonPresent: document.querySelector('[data-testid="sessions-skeleton"]') !== null,
      active: active ? { tag: active.tagName, id: active.id, text: active.textContent?.slice(0, 160) } : null,
      href: location.href, historyState: history.state, historyLength: history.length, at: performance.now() };
  }, { retryLabel: en.sessions.loadError.retry, noMatchLabel: en.sessions.noMatch.title, denialLabel: en.sessions.loadError.accessDenied });
}

async function observe(page: Page, name: string) {
  const run = runs.get(page)!;
  run.observations.push({ name, ...await viewSnapshot(page), attempts: run.gate.attempts.length,
    held: run.gate.held.size, requestCount: run.state.requests.length });
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}
const navigationSnapshot = (page: Page) => page.evaluate(() => ({ href: location.href, history: history.state,
  historyLength: history.length, local: { ...localStorage }, session: { ...sessionStorage } }));

async function expectPrivateDataAbsent(page: Page, state: A04Fixture) {
  await expect(page.getByText(session.title!, { exact: true })).toHaveCount(0);
  await expect(page.getByText(originalNoteTitle, { exact: true })).toHaveCount(0);
  await expect(page.getByText(/SYNTHETIC (COMPLETE RECORD|PREVIEW)/)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(privateBodyReads(state)).toEqual([]);
  expect(state.requests.filter((request) => request.path === sessionPath || request.path.startsWith(`${sessionPath}/`) || request.path === notePath)).toEqual([]);
  expect(state.requests.filter((request) => !["GET", "HEAD"].includes(request.method))).toEqual([]);
  expect(state.noteWrites).toEqual([]);
  const exposed = await navigationSnapshot(page);
  for (const value of [session.title!, originalNoteTitle, privateDraftTitle, privateDraftBody, "selectedWork", "excerpt_source"])
    expect(JSON.stringify(exposed)).not.toContain(value);
}

test.afterEach(async ({ page }, info) => {
  const run = runs.get(page); if (!run) return;
  const { state, gate } = run;
  gate.release(); state.release(); state.releaseRelated();
  let screenshotError: string | null = null, drainError: string | null = null;
  try { if (!page.isClosed()) await page.screenshot({ path: info.outputPath("final-shell.png") }); }
  catch (error) { screenshotError = String(error); }
  try {
    await expect.poll(() => gate.active + gate.held.size + state.inflight + state.pendingBrowserRequests.size
      + state.pendingProofs + state.held.length + state.heldRelated.length).toBe(0);
  } catch (error) { drainError = String(error); }
  state.observationCutoff = Date.now();
  const afterInputs = hashes(inputPaths), afterSource = hashes(sourcePaths);
  const assets = state.builtAssets.map((asset) => ({ ...asset, expected: manifest?.files[asset.manifestKey] ?? null }));
  const receiptPath = info.outputPath("a04-list-family-scope-ledger.json");
  writeFileSync(receiptPath, JSON.stringify({
    scope: "Actual built AppShell MySessions; empty period list, history probe403, held native Retry, local Codex-family change and late403. No injected cache/provider/draft state or live authorization claim.",
    status: info.status, browser: page.context().browser()?.version(), baseURL: process.env.BACKPLANE_E2E_BASE_URL,
    locale: "en", viewport: page.viewportSize(), manifestPath, manifestSha256: manifestBytes && sha(manifestBytes),
    builtSource: { head: manifest?.head, tree: manifest?.tree, source_manifest: manifest?.source_manifest },
    beforeInputs: run.beforeInputs, afterInputs, beforeSource: run.beforeSource, afterSource,
    attempts: gate.attempts, listHeaders: run.listHeaders, observations: run.observations, assets, screenshotError, drainError,
    cutoff: { at: state.observationCutoff, complete: drainError === null, gateActive: gate.active,
      gateHeld: gate.held.size, inflight: state.inflight, pendingRequests: [...state.pendingBrowserRequests.values()],
      pendingProofs: state.pendingProofs, heldRequests: state.held.length + state.heldRelated.length },
    observationLimit: "The cutoff excludes later attachment/page closure/runner teardown. Observed later events are marked. No screenshot forces focus or scrolling.",
    requests: state.requests, responses: state.responseReceipts, browserRequests: state.browserRequests,
    sockets: state.socketLedger, failures: state.failures, unexpected: state.unexpected, console: state.consoleReceipts,
    unexpectedConsole: unexpectedConsole(state), afterCutoffEvents: state.afterCutoffEvents, noteWrites: state.noteWrites,
  }, null, 2));
  await info.attach("a04-list-family-scope-ledger", { path: receiptPath, contentType: "application/json" });
  expect.soft(screenshotError).toBeNull(); expect.soft(drainError).toBeNull();
  expect.soft(afterInputs).toEqual(run.beforeInputs); expect.soft(afterSource).toEqual(run.beforeSource);
  for (const suffix of ["index.html", ".js", ".css"])
    expect.soft(assets.some((asset) => asset.manifestKey.endsWith(suffix))).toBe(true);
  expect.soft(assets.filter((asset) => asset.status !== 200 || asset.sha256 !== asset.expected)).toEqual([]);
  expect.soft(state.unexpected).toEqual([]); expect.soft(unexpectedConsole(state)).toEqual([]);
  expect.soft(state.failures).toEqual([]);
  runs.delete(page);
});

test("A04 Codex family change drops a held history-probe failure without another main-list request", async ({ page }) => {
  expect(manifest, "Root must bind this run to the actual supplied dist manifest").not.toBeNull();
  const state = await installA04Fixture(page, "en");
  const gate = await installFamilyProbe(page, state);
  const run: Run = { state, gate, beforeInputs: hashes(inputPaths), beforeSource: hashes(sourcePaths), observations: [], listHeaders: [] };
  runs.set(page, run);
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname === listPath) run.listHeaders.push({ query: url.search, status: response.status(),
      cacheControl: response.headers()["cache-control"] ?? "", at: Date.now() });
  });
  await page.goto(listHref);
  await expect(page.getByRole("banner")).toBeVisible();
  const main = page.getByRole("main");
  const retry = main.getByRole("button", { name: en.sessions.loadError.retry, exact: true });
  const noMatch = main.getByRole("heading", { name: en.sessions.noMatch.title, exact: true });
  const denied = main.getByText(en.sessions.loadError.accessDenied, { exact: true });
  await expect(main.getByRole("heading", { name: en.sessions.loadError.title, exact: true })).toBeVisible();
  await expect(denied).toBeVisible();
  await expect(retry).toBeEnabled();
  await expect.poll(() => gate.active + state.inflight + state.pendingBrowserRequests.size + state.pendingProofs).toBe(0);
  expect(gate.attempts.filter((attempt) => attempt.kind === "main")).toHaveLength(1);
  expect(gate.attempts.filter((attempt) => attempt.kind === "root-probe")).toHaveLength(1);
  expect(gate.attempts.filter((attempt) => attempt.kind === "any-probe")).toHaveLength(1);
  expect(gate.attempts.every((attempt) => attempt.fulfilledAt !== undefined)).toBe(true);
  expect(gate.attempts.filter((attempt) => attempt.kind !== "any-probe").every((attempt) => attempt.status === 200)).toBe(true);
  await expectPrivateDataAbsent(page, state);
  const tabSteps = await tabTo(page, retry); await expect(retry).toBeFocused();
  run.observations.push({ name: "initial-native-tab-count", tabSteps });
  await observe(page, "initial-probe-denial-focus");
  gate.arm();
  await page.keyboard.press("Enter");
  await expect.poll(() => gate.held.size).toBe(1);
  expect(gate.attempts).toHaveLength(4);
  // R1 is an explicit prerequisite: an older build that unmounts Retry does
  // not reach the local-family R2 seam and must not be reported as its RED.
  await expect(retry, "R1 prerequisite: the held probe retry remains mounted and busy").toHaveAttribute("aria-busy", "true");
  await expect(retry).toBeFocused();
  await observe(page, "history-probe-retry-held");

  const codex = main.getByRole("button", { name: en.sessions.filters.agentToggle.replace("{{agent}}", "Codex"), exact: true });
  await codex.click();
  await expect(codex).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => new URL(page.url()).searchParams.get("agent")).toBe("codex");
  await observe(page, "codex-selected-probe-still-held");
  // Keep the late-response control reachable if any of these independent
  // held-state assertions fail at the repository's unchanged default deadline.
  await expect.soft(noMatch, "The local Codex view must show its own empty result while the old probe is held").toBeVisible();
  await expect.soft(denied, "The prior history-probe denial must not belong to the new family view").toHaveCount(0);
  await expect.soft(retry, "The old busy Retry must not remain in the Codex view").toHaveCount(0);
  expect(gate.held.size).toBe(1);
  expect(gate.attempts.filter((attempt) => attempt.kind === "main")).toHaveLength(1);
  expect(gate.attempts.filter((attempt) => attempt.kind === "root-probe")).toHaveLength(1);
  expect(gate.attempts.filter((attempt) => attempt.kind === "any-probe")).toHaveLength(2);
  expect(gate.attempts.every((attempt) => !new URLSearchParams(attempt.query).has("harness"))).toBe(true);
  expect(state.browserRequests.filter((request) => request.path === listPath)).toHaveLength(4);
  await expectPrivateDataAbsent(page, state);

  gate.release();
  await expect.poll(() => state.responseReceipts.filter((response) => response.path === listPath && response.status === 403).length).toBe(2);
  await expect.poll(() => gate.active + state.inflight + state.pendingBrowserRequests.size + state.pendingProofs).toBe(0);
  await expect(noMatch).toBeVisible();
  await expect(denied).toHaveCount(0);
  await expect(retry).toHaveCount(0);
  await expect(main.getByTestId("sessions-skeleton")).toHaveCount(0);
  await expect(codex).toHaveAttribute("aria-pressed", "true");
  await observe(page, "late-probe-denial-keeps-codex-no-match");
  expect(gate.attempts).toHaveLength(4);
  expect(gate.attempts.filter((attempt) => attempt.kind === "main")).toHaveLength(1);
  const probes = gate.attempts.filter((attempt) => attempt.kind === "any-probe");
  expect(probes).toHaveLength(2);
  expect(probes[1]!.query).toBe(probes[0]!.query);
  expect(probes.every((attempt) => attempt.status === 403 && attempt.fulfilledAt !== undefined)).toBe(true);
  expect(probes.filter((attempt) => attempt.heldAt !== undefined)).toHaveLength(1);
  expect(run.listHeaders).toHaveLength(4);
  expect(run.listHeaders.every((response) => response.cacheControl === "private, no-store")).toBe(true);
  expect(run.listHeaders.map((response) => response.status).sort()).toEqual([200, 200, 403, 403]);
  expect(state.browserRequests.filter((request) => request.path === listPath)).toHaveLength(4);
  await expectPrivateDataAbsent(page, state);
  const url = new URL(page.url());
  expect(url.pathname).toBe(listHref);
  expect([...url.searchParams.entries()]).toEqual([["agent", "codex"]]);
});
