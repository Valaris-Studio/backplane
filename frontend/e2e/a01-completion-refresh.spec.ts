// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { BoardDetail, Card } from "../src/types/kanban";
import type { CompletionPolicy, CompletionPolicyResolution } from "../src/types/completion";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import { sha, stamp, type RequestReceipt } from "./fixtures/session-window-fixture";
import { boardId, slug, boardPath, cardA, cardB, cardHref, cardNames, originalCards,
  installCardNavigationFixture, type CardNavigationFixture, type CardWrite } from "./fixtures/uxc-card-navigation-review";

test.skip(process.env.BACKPLANE_E2E_UXC_CARD_NAVIGATION_FIXTURE !== "1", "Requires synthetic built-AppShell fixture opt-in");
test.use({ storageState: { cookies: [], origins: [] }, reducedMotion: "reduce", serviceWorkers: "block" });

// This supported configured-board fixture does not alter or represent the
// live programme board's legacy/null policy. Completion really changes column.
const policy: CompletionPolicy = { version: 1, landing_actor: "human", landing_methods: ["external"], source_review: "none",
  review_role: null, require_forge_checks: false, postmerge_validation: null, evidence_only: { enabled: false, approval: "none", review_role: null },
  dependency_release: "done", auto_complete: true };
const resolution: CompletionPolicyResolution = { override: policy, workspace_policy: null, effective_policy: policy, origin: "board",
  policy_hash: "synthetic-completion-refresh-policy", capabilities: {}, incompatibilities: [] };
const apiPath = `/api/workspaces/${slug}/boards/${boardId}`;
const detailPath = `${apiPath}/cards/${cardA}`;
const policyPath = `${apiPath}/completion/policy`;
const completionPath = `${apiPath}/completion/cards/${cardA}`;
const doneColumn = "column-completion-done";
const laterTitle = "Later unsaved browser title café 🙂";
const inputFiles = ["e2e/a01-completion-refresh.spec.ts", "e2e/fixtures/uxc-card-navigation-review.ts", "e2e/fixtures/uxc-navigation-fixture.ts",
  "e2e/fixtures/session-window-fixture.ts", "playwright.config.ts", "src/i18n/locales/en.json"];
const productionFiles = ["src/features/kanban/components/BoardView.tsx", "src/features/kanban/components/CardDetailSheet.tsx",
  "src/features/kanban/components/CardCompletionSection.tsx", "src/features/kanban/api/use-cards.ts",
  "src/features/kanban/hooks/use-optimistic-card-move.ts", "src/features/kanban/api/use-card-detail.ts", "src/features/kanban/api/use-completion.ts",
  "src/hooks/useDomainSync.ts", "src/providers/WebSocketProvider.tsx", "src/components/shared/RichTextEditorImpl.tsx"];
const hashes = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))]));
const manifestPath = process.env.BACKPLANE_E2E_UXC_CARD_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as {
  head: string; tree: string; files: Record<string, string>; source_files: Record<string, string>;
} : null;
type DetailRead = { snapshot: Card; held: boolean; startedAt: number; finishedAt?: number; outcome?: "fulfilled" | "aborted" };
interface Fixture extends CardNavigationFixture {
  accepted: boolean;
  acceptedAt?: number;
  holdNextDetail: boolean;
  detailReads: DetailRead[];
  heldDetail: (() => void)[];
  releaseDetail: () => void;
  acceptCompletion: () => void;
}
const states = new Map<Page, { fixture: Fixture; inputsBefore: ReturnType<typeof hashes>; productionBefore: ReturnType<typeof hashes>; observations: unknown[] }>();
const sheet = (page: Page) => page.getByRole("dialog", { name: en.cards.editTitle, exact: true, includeHidden: true });
const title = (page: Page) => sheet(page).getByRole("textbox", { name: en.cards.titleLabel, exact: true });
const body = (page: Page) => sheet(page).locator('[contenteditable="true"]');
const save = (page: Page) => sheet(page).getByRole("button", { name: en.common.save, exact: true });
const close = (page: Page) => sheet(page).getByRole("button", { name: en.common.close, exact: true });
const priority = (page: Page) => sheet(page).locator('button[id$="-priority"]');
const column = (page: Page) => sheet(page).locator('button[id$="-column"]');
const prompt = (page: Page) => page.getByRole("alertdialog", { name: en.unsavedChanges.title, exact: true });
const routeIdentity = (page: Page) => new URL(page.url()).pathname + new URL(page.url()).search;
const activate = (control: Locator, width: number) => width === 390 ? control.tap() : control.click();
async function frames(page: Page) { await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
async function unloadWarns(page: Page) { return page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }); }
async function observation(page: Page, name: string) {
  const state = states.get(page)!;
  const value = { name, route: routeIdentity(page), sheetVisible: await sheet(page).isVisible(),
    title: await title(page).count() ? await title(page).inputValue() : null,
    description: await body(page).count() ? await body(page).textContent() : null,
    priority: await priority(page).count() ? await priority(page).textContent() : null,
    column: await column(page).count() ? await column(page).textContent() : null,
    saveEnabled: await save(page).count() ? await save(page).isEnabled() : null,
    unloadWarns: await unloadWarns(page), promptVisible: await prompt(page).isVisible(),
    focus: await page.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute("aria-label"),
      id: document.activeElement?.id, insidePrompt: !!document.activeElement?.closest('[role="alertdialog"]') })),
    saved: structuredClone([...state.fixture.cards.values()]), writes: structuredClone(state.fixture.cardWrites), reads: structuredClone(state.fixture.detailReads) };
  state.observations.push(value);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  return value;
}

async function installFixture(page: Page): Promise<Fixture> {
  const inherited = await installCardNavigationFixture(page);
  function emit(event: string, payload: Record<string, unknown>) {
    assert(state.socket, "The actual AppShell must connect before fixture events");
    const frame = { event, event_id: `synthetic-completion-refresh-${state.socketLedger.length}`, timestamp: stamp, payload };
    state.socketLedger.push({ kind: "event", at: Date.now(), connection: state.socketsOpened, payload: frame });
    state.socket.send(JSON.stringify(frame));
  }
  function activity(action: string, changes: Record<string, unknown>) {
    const payload = { entity_type: "card", entity_id: cardA, action, actor_id: "owner", board_id: boardId, changes };
    emit(`activity.card.${action}`, payload); emit(`card.${action}`, payload);
  }
  const state: Fixture = Object.assign(inherited, {
    accepted: false, holdNextDetail: false, detailReads: [] as DetailRead[], heldDetail: [] as (() => void)[],
    releaseDetail() { state.heldDetail.splice(0).forEach((resolve) => resolve()); },
    acceptCompletion() {
      assert(state.subscriptions.some((pattern) => pattern === "completion.*" || pattern === "*"), "Mount the actual completion subscriber first");
      state.cards.set(cardA, { ...state.cards.get(cardA)!, column_id: doneColumn });
      state.accepted = true; state.acceptedAt = Date.now(); state.holdNextDetail = true;
      activity("moved", { column_id: { old: "column-synthetic", new: doneColumn }, from_column: "In progress", to_column: "Done" });
      emit("completion.updated", { board_id: boardId, card_id: cardA, candidate_id: "50000000-0000-4000-8000-000000000001", status: "accepted" });
    },
  });
  const paths = new Set([apiPath, `/api/workspaces/${slug}/boards`, detailPath, policyPath, completionPath]);
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!paths.has(path)) return route.fallback();
    const receipt: RequestReceipt = { path, method: request.method(), query: url.search, mode: null, callId: null, cursor: null, startedAt: Date.now() };
    state.requests.push(receipt); state.inflight += 1;
    let read: DetailRead | undefined;
    try {
      assert(!request.headers().authorization && !request.headers().cookie, "Synthetic requests carry no credentials");
      let value: unknown;
      if (path === detailPath && request.method() === "PATCH") {
        const payload = request.postDataJSON() as Record<string, unknown>;
        assert.deepEqual(payload, { priority: "high" }, "Only the explicit priority save is committed");
        receipt.payload = request.postData() ?? "";
        const write: CardWrite = { cardId: cardA, payload: structuredClone(payload), before: structuredClone(state.cards.get(cardA)!) };
        state.cardWrites.push(write);
        if (state.holdA) await new Promise<void>((resolve) => state.heldA.push(resolve));
        state.cards.set(cardA, { ...state.cards.get(cardA)!, priority: "high", updated_at: "2026-10-19T02:00:00Z" });
        write.status = 200; write.after = structuredClone(state.cards.get(cardA)!); value = write.after;
        // Priority is not a completion-contract field. Publish its ordinary
        // activity twins; do not invent another completion event to fix the read.
        activity("updated", { fields: ["priority"] });
      } else {
        assert.equal(request.method(), "GET");
        if (path === detailPath) {
          read = { snapshot: structuredClone(state.cards.get(cardA)!), held: state.holdNextDetail, startedAt: Date.now() };
          state.holdNextDetail = false; state.detailReads.push(read);
          if (read.held) await new Promise<void>((resolve) => state.heldDetail.push(resolve));
          value = read.snapshot;
        } else if (path === policyPath) value = resolution;
        else if (path === completionPath) value = { completion_mode: "source", attempts: [], candidate: state.accepted ? {
          id: "50000000-0000-4000-8000-000000000001", status: "accepted", source_sha: "a".repeat(40), merge_sha: "b".repeat(40),
          pr_url: null, policy_hash: "synthetic-completion-refresh-policy", contract_hash: "synthetic-contract", summary: null,
        } : null };
        else {
          const board: BoardDetail = { id: boardId, slug: "synthetic-card-navigation", workspace_id: "workspace-synthetic", name: "Synthetic card navigation",
            description: "", tags: [], is_frozen: false, loop_configured: false, created_at: stamp, updated_at: stamp,
            columns: [
              { id: "column-synthetic", name: "In progress", column_type: "active" as const, position: 1024 },
              { id: doneColumn, name: "Done", column_type: "done" as const, position: 2048 },
            ].map((column) => ({ ...column, board_id: boardId, cards: [...state.cards.values()].filter((card) => card.column_id === column.id), created_at: stamp, updated_at: stamp })),
          };
          value = path === apiPath ? board : [board];
        }
      }
      receipt.status = 200; receipt.bytes = Buffer.byteLength(JSON.stringify(value));
      await route.fulfill({ status: 200, json: value });
      if (read) read.outcome = "fulfilled";
    } catch (error) {
      if (request.failure()?.errorText === "net::ERR_ABORTED") { if (read) read.outcome = "aborted"; }
      else { state.unexpected.push(String(error)); await route.fulfill({ status: 500, json: { detail: "Completion refresh fixture failed" } }).catch(() => {}); }
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
  const path = info.outputPath("completion-refresh-ledger.json");
  writeFileSync(path, JSON.stringify({ scope: "Actual built AppShell, real editor/Query/WebSocket/completion routing; configured synthetic auto-complete policy, not live programme policy; no backend persistence claim",
    policy: resolution, baseURL: process.env.BACKPLANE_E2E_BASE_URL, manifestPath, manifestSha256: manifestBytes && sha(manifestBytes),
    artifactHead: manifest?.head, artifactTree: manifest?.tree, artifactSourceFiles: manifest?.source_files,
    browser: page.context().browser()?.version(), viewport: page.viewportSize(), touchPoints: await page.evaluate(() => navigator.maxTouchPoints),
    reducedMotion: await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), status: info.status,
    inputsBefore: state.inputsBefore, inputsAfter, productionBefore: state.productionBefore, productionAfter, assets, observations: state.observations,
    requests: state.fixture.requests, sockets: state.fixture.socketLedger, reads: state.fixture.detailReads, writes: state.fixture.cardWrites,
    saved: [...state.fixture.cards.values()], acceptedAt: state.fixture.acceptedAt,
    unexpected: state.fixture.unexpected, consoleErrors: state.fixture.consoleErrors, failures: state.fixture.failures,
  }, null, 2));
  await info.attach("completion-refresh-ledger", { path, contentType: "application/json" });
  expect.soft(inputsAfter).toEqual(state.inputsBefore); expect.soft(productionAfter).toEqual(state.productionBefore);
  expect.soft(state.fixture.unexpected).toEqual([]); expect.soft(state.fixture.consoleErrors).toEqual([]);
  expect.soft(state.fixture.failures.filter((failure) => !failure.endsWith("net::ERR_ABORTED"))).toEqual([]);
  expect.soft(assets.length).toBeGreaterThan(0); expect.soft(assets.filter((asset) => asset.status !== 200 || asset.sha256 !== asset.expected)).toEqual([]);
  states.delete(page);
});

for (const [timing, width] of [["before-save", 1440], ["during-write", 390]] as const) {
  test.describe(`${width} ${timing} completion refresh`, () => {
    test.use({ hasTouch: width === 390 });
    test("adopts remote Done while preserving the later title draft, guard and focus", async ({ page }) => {
      expect(manifest).not.toBeNull();
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      const fixture = await installFixture(page), productionBefore = hashes(productionFiles);
      states.set(page, { fixture, inputsBefore: hashes(inputFiles), productionBefore, observations: [] });
      for (const [path, hash] of Object.entries(productionBefore)) expect(hash, `Frozen artifact source: ${path}`).toBe(manifest!.source_files[path]);
      await page.goto(boardPath); await expect(page.getByRole("main")).toBeVisible();
      await expect.poll(() => fixture.inflight).toBe(0);
      await activate(page.getByRole("main").getByText(cardNames[cardA], { exact: true }), width);
      await expect(sheet(page)).toBeVisible(); await expect(body(page)).toHaveText("Saved browser description A");
      await expect(sheet(page).getByText(en.completionPolicy.noCandidate, { exact: true })).toBeVisible();
      await expect.poll(() => fixture.inflight).toBe(0);
      expect(fixture.detailReads).toHaveLength(1); expect(fixture.detailReads[0]!.snapshot).toEqual(originalCards[0]);
      await expect(save(page)).toBeDisabled(); expect(await unloadWarns(page)).toBe(false);
      await expect(column(page)).toHaveText("In progress");
      await activate(priority(page), width);
      await activate(page.getByRole("option", { name: en.cards.priorities.high, exact: true }), width);
      await expect(save(page)).toBeEnabled();
      if (timing === "before-save") {
        fixture.acceptCompletion();
        await expect.poll(() => fixture.heldDetail.length).toBe(1);
      }
      fixture.holdA = true; await activate(save(page), width);
      await expect.poll(() => fixture.heldA.length).toBe(1);
      expect(fixture.cardWrites[0]!.payload).toEqual({ priority: "high" });
      expect(fixture.cardWrites[0]!.status).toBeUndefined();
      if (timing === "during-write") {
        fixture.acceptCompletion();
        await expect.poll(() => fixture.heldDetail.length).toBe(1);
      }
      const heldRead = fixture.detailReads.find((read) => read.held)!;
      expect(heldRead.snapshot).toMatchObject({ title: cardNames[cardA], column_id: doneColumn, priority: "medium" });
      expect(heldRead.finishedAt).toBeUndefined();
      await title(page).fill(laterTitle); await expect(title(page)).toBeFocused();
      expect(await unloadWarns(page)).toBe(true);
      await observation(page, "pending-priority-save-and-held-completion-read");
      fixture.releaseA();
      await expect.poll(() => fixture.cardWrites[0]!.status).toBe(200);
      await expect(sheet(page).getByRole("button", { name: en.common.saving, exact: true })).toHaveCount(0);
      fixture.releaseDetail();
      await expect.poll(() => heldRead.finishedAt !== undefined).toBe(true);
      await expect.poll(() => fixture.inflight).toBe(0); await frames(page);
      await expect(sheet(page).getByText(en.completionPolicy.status.accepted, { exact: true })).toBeVisible();
      expect(fixture.cards.get(cardA)).toMatchObject({ title: cardNames[cardA], priority: "high", column_id: doneColumn });
      await expect(column(page)).toHaveText("Done"); await expect(priority(page)).toHaveText(en.cards.priorities.high);
      await expect(title(page)).toHaveValue(laterTitle); await expect(title(page)).toBeFocused();
      await expect(save(page)).toBeEnabled(); expect(await unloadWarns(page)).toBe(true);
      expect(routeIdentity(page)).toBe(cardHref(cardA)); expect(fixture.cardWrites).toHaveLength(1);
      await observation(page, "remote-done-and-committed-priority-with-later-draft");
      await activate(close(page), width); await expect(prompt(page)).toBeVisible();
      for (const label of [en.unsavedChanges.save, en.unsavedChanges.discard, en.unsavedChanges.keepEditing]) await expect(prompt(page).getByRole("button", { name: label, exact: true })).toBeVisible();
      await expect(prompt(page).getByRole("button", { name: en.unsavedChanges.keepEditing, exact: true })).toBeFocused();
      expect(routeIdentity(page)).toBe(cardHref(cardA));
      await activate(prompt(page).getByRole("button", { name: en.unsavedChanges.keepEditing, exact: true }), width);
      await expect(prompt(page)).toBeHidden(); await expect(close(page)).toBeFocused();
      await expect(title(page)).toHaveValue(laterTitle); await expect(column(page)).toHaveText("Done");
      await expect(save(page)).toBeEnabled(); expect(await unloadWarns(page)).toBe(true);
      await observation(page, "keep-editing-preserves-draft-and-return-focus");
      await activate(close(page), width); await expect(prompt(page)).toBeVisible();
      await activate(prompt(page).getByRole("button", { name: en.unsavedChanges.discard, exact: true }), width);
      await expect(sheet(page)).toBeHidden(); expect(routeIdentity(page)).toBe(boardPath);
      expect(await unloadWarns(page)).toBe(false);
      expect(fixture.cardWrites.map((write) => write.payload)).toEqual([{ priority: "high" }]);
      expect(fixture.cards.get(cardA)).toMatchObject({ title: cardNames[cardA], priority: "high", column_id: doneColumn });
      expect(fixture.cards.get(cardB)).toEqual(originalCards[1]);
      expect(fixture.requests.filter((request) => request.method !== "GET")).toHaveLength(1);
    });
  });
}
