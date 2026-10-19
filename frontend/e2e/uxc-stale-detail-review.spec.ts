// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Card } from "../src/types/kanban";
import type { CompletionPolicy, CompletionPolicyResolution } from "../src/types/completion";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import { sha, stamp, type RequestReceipt } from "./fixtures/session-window-fixture";
import { boardId, slug } from "./fixtures/uxc-card-navigation-review";
import { boardPath, cardA, cardB, cardHref, cardNames, installFinalSeamsFixture, originalCards, type FinalSeamsFixture } from "./fixtures/uxc-card-final-seams-review";

test.skip(process.env.BACKPLANE_E2E_UXC_CARD_NAVIGATION_FIXTURE !== "1", "Requires synthetic built-AppShell fixture opt-in");
test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: "reduce", serviceWorkers: "block" });

// A configured synthetic board mounts the existing completion-detail subscriber.
// The live programme board's legacy/null policy is not changed or represented.
const policy: CompletionPolicy = { version: 1, landing_actor: "human", landing_methods: ["external"], source_review: "none", review_role: null, require_forge_checks: false, postmerge_validation: null, evidence_only: { enabled: false, approval: "none", review_role: null }, dependency_release: "done", auto_complete: false };
const resolution: CompletionPolicyResolution = { override: policy, workspace_policy: null, effective_policy: policy, origin: "board", policy_hash: "synthetic-stale-detail-policy", capabilities: {}, incompatibilities: [] };
const detailPath = `/api/workspaces/${slug}/boards/${boardId}/cards/${cardA}`;
const policyPath = `/api/workspaces/${slug}/boards/${boardId}/completion/policy`;
const inputFiles = ["e2e/uxc-stale-detail-review.spec.ts", "e2e/fixtures/uxc-card-final-seams-review.ts", "e2e/fixtures/uxc-card-navigation-review.ts", "e2e/fixtures/uxc-navigation-fixture.ts", "e2e/fixtures/session-window-fixture.ts", "playwright.config.ts", "src/i18n/locales/en.json"];
const productionFiles = ["src/features/kanban/components/CardDetailSheet.tsx", "src/features/kanban/components/CardCompletionSection.tsx", "src/features/kanban/api/use-cards.ts", "src/features/kanban/api/use-card-detail.ts", "src/features/kanban/api/use-completion.ts", "src/hooks/useDomainSync.ts", "src/providers/WebSocketProvider.tsx", "src/components/shared/RichTextEditorImpl.tsx"];
const hashes = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))]));
const manifestPath = process.env.BACKPLANE_E2E_UXC_CARD_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as { head: string; tree: string; files: Record<string, string>; source_files: Record<string, string> } : null;
type DetailRead = { snapshot: Card; held: boolean; startedAt: number; finishedAt?: number; outcome?: "fulfilled" | "aborted" };
type Fixture = FinalSeamsFixture & { holdNextDetail: boolean; detailReads: DetailRead[]; heldDetail: (() => void)[]; releaseDetail: () => void; refreshDetail: () => void };
const states = new Map<Page, { fixture: Fixture; inputsBefore: ReturnType<typeof hashes>; productionBefore: ReturnType<typeof hashes>; observations: unknown[] }>();
const sheet = (page: Page) => page.getByRole("dialog", { name: en.cards.editTitle, exact: true, includeHidden: true });
const title = (page: Page) => sheet(page).getByRole("textbox", { name: en.cards.titleLabel, exact: true });
const body = (page: Page) => sheet(page).locator('[contenteditable="true"]');
const save = (page: Page) => sheet(page).getByRole("button", { name: en.common.save, exact: true });
const prompt = (page: Page) => page.getByRole("alertdialog", { name: en.unsavedChanges.title, exact: true });
const route = (page: Page) => new URL(page.url()).pathname + new URL(page.url()).search;
const activate = (control: Locator, width: number) => width === 390 ? control.tap() : control.click();
const doc = (text: string) => JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
async function frames(page: Page) { await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
async function unloadWarns(page: Page) { return page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }); }
async function observation(page: Page, name: string) {
  const fixture = states.get(page)!.fixture;
  const value = { name, route: route(page), sheetVisible: await sheet(page).isVisible(), title: await title(page).count() ? await title(page).inputValue() : null,
    description: await body(page).count() ? await body(page).textContent() : null, saveEnabled: await save(page).count() ? await save(page).isEnabled() : null,
    unloadWarns: await unloadWarns(page), promptVisible: await prompt(page).isVisible(),
    focus: await page.evaluate(() => ({ tag: document.activeElement?.tagName, contentEditable: document.activeElement?.getAttribute("contenteditable"), insidePrompt: !!document.activeElement?.closest('[role="alertdialog"]') })),
    writes: structuredClone(fixture.cardWrites), detailReads: structuredClone(fixture.detailReads), saved: structuredClone([...fixture.cards.values()]) };
  states.get(page)!.observations.push(value);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  return value;
}
async function installFixture(page: Page): Promise<Fixture> {
  const inherited = await installFinalSeamsFixture(page);
  const state: Fixture = Object.assign(inherited, { holdNextDetail: false, detailReads: [] as DetailRead[], heldDetail: [] as (() => void)[],
    releaseDetail() { state.heldDetail.splice(0).forEach((resolve) => resolve()); },
    refreshDetail() {
      assert(state.socket, "The real AppShell must connect before the refresh signal");
      assert(state.subscriptions.some((pattern) => pattern === "completion.*" || pattern === "*"), "The real completion subscriber must be mounted");
      const frame = { event: "completion.updated", event_id: `synthetic-stale-detail-${state.socketLedger.length}`, timestamp: stamp, payload: { board_id: boardId, card_id: cardA, candidate_id: "50000000-0000-4000-8000-000000000001", status: "accepted" } };
      state.socketLedger.push({ kind: "event", at: Date.now(), connection: state.socketsOpened, payload: frame });
      state.socket.send(JSON.stringify(frame));
    },
  });
  state.descriptionResponse = "echo";
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== "GET" || ![detailPath, policyPath].includes(url.pathname)) return route.fallback();
    const receipt: RequestReceipt = { path: url.pathname, method: "GET", query: url.search, mode: null, callId: null, cursor: null, startedAt: Date.now() };
    state.requests.push(receipt); state.inflight += 1;
    let read: DetailRead | undefined;
    try {
      assert(!request.headers().authorization && !request.headers().cookie, "Synthetic requests carry no credentials");
      let value: unknown = resolution;
      if (url.pathname === detailPath) {
        read = { snapshot: structuredClone(state.cards.get(cardA)!), held: state.holdNextDetail, startedAt: Date.now() };
        state.holdNextDetail = false; state.detailReads.push(read);
        if (read.held) await new Promise<void>((resolve) => state.heldDetail.push(resolve));
        value = read.snapshot;
      }
      receipt.status = 200; receipt.bytes = Buffer.byteLength(JSON.stringify(value));
      await route.fulfill({ status: 200, json: value });
      if (read) read.outcome = "fulfilled";
    } catch (error) {
      if (request.failure()?.errorText === "net::ERR_ABORTED") { if (read) read.outcome = "aborted"; }
      else { state.unexpected.push(String(error)); await route.fulfill({ status: 500, json: { detail: "Stale-detail fixture failed" } }).catch(() => {}); }
    } finally { if (read) read.finishedAt = Date.now(); state.inflight -= 1; }
  });
  return state;
}

test.afterEach(async ({ page }, info) => {
  const state = states.get(page); if (!state) return;
  state.fixture.releaseDetail(); state.fixture.releaseA(); state.fixture.release();
  await observation(page, "final-state");
  await Promise.all(state.fixture.pendingAssets);
  const assets = state.fixture.assets.map((asset) => ({ ...asset, expected: manifest?.files[asset.path.replace(/^\//, "")] ?? null }));
  const inputsAfter = hashes(inputFiles), productionAfter = hashes(productionFiles);
  const path = info.outputPath("stale-detail-ledger.json");
  writeFileSync(path, JSON.stringify({
    scope: "Actual built AppShell, real title/TipTap, real completion.updated WebSocket routing; explicitly configured synthetic policy, not live programme legacy/null policy; synthetic authorized HTTP, no backend persistence claim",
    policy: resolution, baseURL: process.env.BACKPLANE_E2E_BASE_URL, manifestPath, manifestSha256: manifestBytes && sha(manifestBytes), head: manifest?.head, tree: manifest?.tree,
    browser: page.context().browser()?.version(), viewport: page.viewportSize(), touchPoints: await page.evaluate(() => navigator.maxTouchPoints), reducedMotion: await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
    status: info.status, inputsBefore: state.inputsBefore, inputsAfter, productionBefore: state.productionBefore, productionAfter, assets, observations: state.observations,
    requests: state.fixture.requests, sockets: state.fixture.socketLedger, detailReads: state.fixture.detailReads, writes: state.fixture.cardWrites, saved: [...state.fixture.cards.values()],
    unexpected: state.fixture.unexpected, consoleErrors: state.fixture.consoleErrors, failures: state.fixture.failures,
  }, null, 2));
  await info.attach("stale-detail-ledger", { path, contentType: "application/json" });
  expect.soft(inputsAfter).toEqual(state.inputsBefore); expect.soft(productionAfter).toEqual(state.productionBefore);
  expect.soft(state.fixture.unexpected).toEqual([]); expect.soft(state.fixture.consoleErrors).toEqual([]);
  expect.soft(state.fixture.failures.filter((failure) => !failure.endsWith("net::ERR_ABORTED"))).toEqual([]);
  expect.soft(assets.length).toBeGreaterThan(0); expect.soft(assets.filter((asset) => asset.status !== 200 || asset.sha256 !== asset.expected)).toEqual([]);
  states.delete(page);
});

for (const [field, width] of [["title", 1440], ["description", 390]] as const) {
  test.describe(`${width} ${field} stale detail`, () => {
    test.use({ hasTouch: width === 390 });
    test("late undo survives an older real detail response and a fresh signal, then saves explicitly", async ({ page }) => {
      expect(manifest).not.toBeNull();
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      const fixture = await installFixture(page), productionBefore = hashes(productionFiles);
      states.set(page, { fixture, inputsBefore: hashes(inputFiles), productionBefore, observations: [] });
      for (const [path, hash] of Object.entries(productionBefore)) expect(hash, `Frozen build source: ${path}`).toBe(manifest!.source_files[path]);
      await page.goto(boardPath); await expect(page.getByRole("main")).toBeVisible();
      await expect.poll(() => fixture.inflight).toBe(0);
      await activate(page.getByRole("main").getByText(cardNames[cardA], { exact: true }), width);
      await expect(sheet(page)).toBeVisible(); await expect(body(page)).toHaveText("Saved browser description A");
      await expect.poll(() => fixture.inflight).toBe(0);
      expect(fixture.detailReads.some((read) => !!read.finishedAt)).toBe(true);
      await expect(sheet(page).getByRole("region", { name: en.completionPolicy.title, exact: true })).toBeVisible();
      await expect(save(page)).toBeDisabled(); expect(await unloadWarns(page)).toBe(false);
      const initialReads = fixture.detailReads.length;
      fixture.holdNextDetail = true; fixture.refreshDetail();
      await expect.poll(() => fixture.detailReads.length).toBe(initialReads + 1);
      await expect.poll(() => fixture.heldDetail.length).toBe(1);
      const oldRead = fixture.detailReads.at(-1)!;
      expect(oldRead.snapshot).toEqual(originalCards[0]); expect(oldRead.finishedAt).toBeUndefined();
      const control = field === "title" ? title(page) : body(page);
      const originalText = field === "title" ? cardNames[cardA] : "Saved browser description A";
      const submittedText = `Submitted ${field} before stale response`;
      const originalValue = field === "title" ? originalText : doc(originalText);
      const submittedValue = field === "title" ? submittedText : doc(submittedText);
      await control.fill(submittedText); await expect(save(page)).toBeEnabled();
      fixture.holdA = true; await activate(save(page), width);
      await expect.poll(() => fixture.heldA.length).toBe(1);
      expect(fixture.cardWrites[0]!.payload).toEqual({ [field]: submittedValue });
      await control.fill(originalText); await expect(control).toBeFocused();
      expect(await unloadWarns(page)).toBe(true);
      fixture.releaseA(); await expect.poll(() => fixture.cardWrites[0]?.status).toBe(200);
      await expect(sheet(page).getByRole("button", { name: en.common.saving, exact: true })).toHaveCount(0);
      await expect(save(page)).toBeEnabled(); await frames(page);
      const committed = await observation(page, "writes-committed-old-http-still-held");
      expect(committed[field]).toBe(originalText); expect(committed.unloadWarns).toBe(true);
      expect(fixture.cards.get(cardA)![field]).toBe(submittedValue); expect(oldRead.finishedAt).toBeUndefined();
      fixture.releaseDetail(); await expect.poll(() => oldRead.finishedAt !== undefined).toBe(true);
      await expect.poll(() => fixture.inflight).toBe(0); await frames(page);
      const afterOld = await observation(page, "old-http-completed-query-acceptance-unspecified");
      expect.soft(afterOld[field], "The old read cannot change the later draft").toBe(originalText);
      expect.soft(afterOld.unloadWarns, "Old HTTP completion must not remove the later draft guard").toBe(true);
      expect.soft(afterOld.saveEnabled).toBe(true);
      const beforeFresh = fixture.detailReads.length; fixture.refreshDetail();
      await expect.poll(() => fixture.detailReads.length).toBe(beforeFresh + 1);
      await expect.poll(() => fixture.inflight).toBe(0); await frames(page);
      expect(fixture.detailReads.at(-1)!.snapshot[field]).toBe(submittedValue);
      const afterFresh = await observation(page, "fresh-signal-read-current-saved-value");
      expect(afterFresh[field], "A fresh authorized detail read must preserve the unsaved later undo").toBe(originalText);
      expect(afterFresh.unloadWarns).toBe(true); expect(afterFresh.saveEnabled).toBe(true);
      expect(route(page)).toBe(cardHref(cardA)); expect(fixture.cardWrites).toHaveLength(1);
      await activate(sheet(page).getByRole("button", { name: en.common.close, exact: true }), width);
      await expect(prompt(page)).toBeVisible();
      for (const label of [en.unsavedChanges.save, en.unsavedChanges.discard, en.unsavedChanges.keepEditing]) await expect(prompt(page).getByRole("button", { name: label, exact: true })).toBeVisible();
      await activate(prompt(page).getByRole("button", { name: en.unsavedChanges.keepEditing, exact: true }), width);
      await activate(save(page), width); await expect.poll(() => fixture.cardWrites[1]?.status).toBe(200);
      await expect(sheet(page)).toBeHidden();
      expect(fixture.cardWrites.map((write) => write.payload)).toEqual([{ [field]: submittedValue }, { [field]: originalValue }]);
      expect(fixture.cards.get(cardA)![field]).toBe(originalValue); expect(fixture.cards.get(cardB)).toEqual(originalCards[1]);
      expect(fixture.moves).toEqual([]); expect(route(page)).toBe(boardPath); expect(await unloadWarns(page)).toBe(false);
    });
  });
}
