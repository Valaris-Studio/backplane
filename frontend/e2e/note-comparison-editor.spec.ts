// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import en from "../src/i18n/locales/en.json" with { type: "json" };
import es from "../src/i18n/locales/es.json" with { type: "json" };
import pt from "../src/i18n/locales/pt-BR.json" with { type: "json" };
import { publicationBoard, publicationRoute, publicationSlug } from "./fixtures/uxc-publication-fixture";
import { historyNote, installHistoryFixture, revisionDetail, sha, type HistoryFixture, type HistoryRequest } from "./note-history-fixtures";

test.skip(process.env.BACKPLANE_E2E_B04_FIXTURE !== "1", "Set BACKPLANE_E2E_B04_FIXTURE=1 for synthetic built-AppShell comparison qualification");
test.use({ storageState: { cookies: [], origins: [] }, serviceWorkers: "block", reducedMotion: "reduce" });
const catalogs = { en, es, "pt-BR": pt };
type Locale = keyof typeof catalogs;
const originalOpening = "Original opening";
const revisedOpening = "Revised opening";
const unchangedText = ["Unchanged paragraph", "Unchanged runbook", "Unchanged ordered item", "Unchanged code", "Unchanged bold and italic", "Unchanged closing"];
const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const originalContent = JSON.stringify({ type: "doc", content: [
  paragraph(originalOpening),
  paragraph(unchangedText[0]!),
  { type: "paragraph", content: [{ type: "text", text: unchangedText[1], marks: [{ type: "link", attrs: { href: "https://example.test/runbook" } }] }] },
  { type: "orderedList", content: [{ type: "listItem", content: [paragraph(unchangedText[2]!)] }] },
  { type: "codeBlock", content: [{ type: "text", text: `${unchangedText[3]}\n` }] },
  { type: "paragraph", content: [{ type: "text", text: unchangedText[4], marks: [{ type: "italic" }, { type: "bold" }] }] },
  paragraph(unchangedText[5]!),
] });
const manifestPath = process.env.BACKPLANE_E2E_B04_ASSET_MANIFEST;
const manifestBytes = manifestPath ? readFileSync(manifestPath) : null;
const manifest = manifestBytes ? JSON.parse(manifestBytes.toString()) as { head: string; tree: string; files: Record<string, string> } : null;
const inputFiles = ["e2e/note-comparison-editor.spec.ts", "e2e/note-history-fixtures.ts", "e2e/fixtures/uxc-publication-fixture.ts", "playwright.config.ts",
  ...["en", "es", "pt-BR"].map((locale) => `src/i18n/locales/${locale}.json`)];
const inputHashes = () => Object.fromEntries(inputFiles.map((path) => [path, sha(readFileSync(path))]));

function savedRevision(sequence: number, content: string) {
  const revision = revisionDetail(sequence);
  revision.snapshot = { ...revision.snapshot, content, title: historyNote.title };
  return { ...revision, title: historyNote.title, content_bytes: Buffer.byteLength(content),
    content_sha256: sha(content), revision_digest: sha(JSON.stringify(revision.snapshot)) };
}

interface EditorRun {
  state: HistoryFixture;
  locale: Locale;
  inputs: ReturnType<typeof inputHashes>;
  revisions: ReturnType<typeof savedRevision>[];
  saves: { path: string; rawBody: string; content: string; sha256: string; at: number }[];
}
const runs = new Map<Page, EditorRun>();

async function installEditorSave(page: Page, locale: Locale) {
  const state = await installHistoryFixture(page, locale);
  const run: EditorRun = { state, locale, inputs: inputHashes(), revisions: [savedRevision(1, originalContent)], saves: [] };
  runs.set(page, run);
  const notePath = new RegExp(`^/api/workspaces/${publicationSlug}/(?:boards/${publicationBoard}/)?notes/${historyNote.id}(/revisions(?:/(compare|[0-9]+))?)?$`);
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), match = notePath.exec(url.pathname);
    if (!match) return route.fallback();
    const kind: HistoryRequest["kind"] = !match[1] ? "note" : match[2] === "compare" ? "compare" : match[2] ? "detail" : "list";
    const receipt: HistoryRequest = { path: url.pathname, query: url.search, method: request.method(), noteId: historyNote.id, kind, at: Date.now() };
    state.historyRequests.push(receipt); state.inflight++;
    try {
      assert(!request.headers().authorization && !request.headers().cookie, "Synthetic fixture must carry no real credentials");
      if (request.method() === "PUT" && kind === "note") {
        assert.equal(run.saves.length, 0, "This journey performs one explicit UI Save");
        const payload: unknown = request.postDataJSON();
        assert(payload && typeof payload === "object" && "content" in payload && typeof payload.content === "string");
        assert("title" in payload && payload.title === historyNote.title);
        assert.deepEqual(Object.keys(payload).sort(), ["content", "title"]);
        assert.equal(JSON.parse(payload.content).type, "doc");
        run.saves.push({ path: url.pathname, rawBody: request.postData()!, content: payload.content, sha256: sha(payload.content), at: Date.now() });
        // The comparison must consume the exact real editor payload; this route
        // deliberately performs no rich-text normalization or expected rewrite.
        run.revisions.push(savedRevision(2, payload.content));
      } else assert.equal(request.method(), "GET", `Unexpected ${request.method()} ${url.pathname}`);
      const current = run.revisions.at(-1)!;
      let value: unknown;
      if (kind === "note") value = { ...historyNote, ...current.snapshot, history_revision: current.revision,
        revision_digest: current.revision_digest, updated_at: current.recorded_at };
      else if (kind === "list") {
        const before = Number(url.searchParams.get("before_revision") ?? current.revision + 1);
        receipt.before = before;
        value = { items: run.revisions.filter((revision) => revision.revision < before).toReversed().map(({ snapshot: _snapshot, ...summary }) => summary),
          latest_recorded_revision: current.revision, next_before_revision: null, capture_boundary: { first_revision: 1, capture_kind: "baseline" } };
      } else if (kind === "detail") {
        value = run.revisions.find((revision) => revision.revision === Number(match[2]));
        assert(value, "Only captured revisions exist");
      } else {
        receipt.from = Number(url.searchParams.get("from_revision")); receipt.to = Number(url.searchParams.get("to_revision"));
        const before = run.revisions.find((revision) => revision.revision === receipt.from);
        const after = run.revisions.find((revision) => revision.revision === receipt.to);
        assert(before && after, "Comparison must request two captured saved revisions");
        value = { before, after, changed_fields: ["content"] };
      }
      receipt.status = 200;
      await route.fulfill({ status: 200, json: value, headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      if (request.failure()?.errorText !== "net::ERR_ABORTED") {
        state.unexpected.push(String(error));
        await route.fulfill({ status: 500, json: { detail: "Synthetic editor-save fixture failed" } }).catch(() => {});
      }
    } finally { state.inflight--; }
  });
  return run;
}

async function settle(state: HistoryFixture) {
  await expect.poll(() => state.inflight).toBe(0);
  expect(state.unexpected).toEqual([]);
}

test.afterEach(async ({ page }, info) => {
  const run = runs.get(page); if (!run) return;
  run.state.release();
  await Promise.all(run.state.pendingAssets);
  await expect.poll(() => run.state.inflight).toBe(0);
  const ledger = info.outputPath("note-comparison-editor-ledger.json");
  writeFileSync(ledger, JSON.stringify({
    scope: "Synthetic HTTP/WS around built App/AppShell; actual UI edit and Save payload reused verbatim as saved history. Not live authorization, backend normalization or installation proof.",
    status: info.status, locale: run.locale, browser: page.context().browser()?.version(), viewport: page.viewportSize(), baseURL: info.project.use.baseURL,
    candidate: manifest && { head: manifest.head, tree: manifest.tree }, manifestPath, manifestSha256: manifestBytes && sha(manifestBytes),
    inputsBefore: run.inputs, inputsAfter: inputHashes(), originalContentSha256: sha(originalContent), saves: run.saves,
    revisions: run.revisions.map(({ revision, content_sha256, revision_digest }) => ({ revision, content_sha256, revision_digest })),
    assets: run.state.assets, requests: run.state.historyRequests, shellRequests: run.state.requests, sockets: run.state.socketLedger,
    unexpected: run.state.unexpected, console: run.state.console.all(), failures: run.state.failures,
  }, null, 2));
  await info.attach("note-comparison-editor-ledger", { path: ledger, contentType: "application/json" });
  await page.screenshot({ path: info.outputPath("comparison-editor-final.png") });
  expect.soft(inputHashes()).toEqual(run.inputs);
  expect.soft(run.state.assets.some((asset) => asset.key === "index.html")).toBe(true);
  expect.soft(run.state.assets.some((asset) => asset.key.endsWith(".js"))).toBe(true);
  expect.soft(run.state.assets.some((asset) => asset.key.endsWith(".css"))).toBe(true);
  expect.soft(run.state.assets.filter((asset) => asset.status !== 200 || asset.sha256 !== manifest?.files[asset.key])).toEqual([]);
  expect.soft(run.state.unexpected).toEqual([]);
  expect.soft(run.state.consoleViolations()).toEqual([]);
  expect.soft(run.state.failures.filter(({ reason }) => reason !== "net::ERR_ABORTED")).toEqual([]);
  runs.delete(page);
});

for (const locale of ["en", "es", "pt-BR"] as const) {
  for (const width of [1440, 390]) {
    test.describe(`${locale} ${width} editor comparison`, () => {
      test.use({ hasTouch: width === 390 });
      test("saving one paragraph keeps untouched rich content collapsed in History", async ({ page }) => {
        expect(manifest, "Bind qualification to a preserved production-build manifest").not.toBeNull();
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
        const run = await installEditorSave(page, locale), copy = catalogs[locale];
        await page.goto(publicationRoute);
        await expect(page.getByRole("banner")).toBeVisible();
        await expect(page.getByRole("main")).toBeVisible();
        const row = page.getByRole("button").filter({ has: page.getByText(historyNote.title, { exact: true }) });
        const open = async () => {
          if (width === 390) await row.tap(); else await row.click();
          return page.getByRole("dialog", { name: copy.notes.editTitle, exact: true });
        };
        let sheet = await open();
        const editor = sheet.locator(".tiptap[contenteditable=true]");
        await expect(editor).toContainText(originalOpening);
        const save = sheet.getByRole("button", { name: copy.common.save, exact: true });
        await expect(save).toBeDisabled();
        await editor.locator("p").first().fill(revisedOpening);
        await expect(save).toBeEnabled();
        await save.click();
        await expect(sheet).not.toBeVisible();
        await settle(run.state);
        expect(run.saves).toHaveLength(1);
        const payload = JSON.parse(run.saves[0]!.content);
        expect(payload.content[0]).toEqual(paragraph(revisedOpening));
        expect(payload.content).toHaveLength(JSON.parse(originalContent).content.length);
        expect(run.revisions[1]!.snapshot.content).toBe(run.saves[0]!.content);
        expect(run.revisions[0]!.snapshot.content).toBe(originalContent);

        sheet = await open();
        await expect(sheet.locator(".tiptap[contenteditable=true]")).toContainText(revisedOpening);
        await expect(sheet.getByRole("button", { name: copy.common.save, exact: true })).toBeDisabled();
        const history = sheet.getByRole("button", { name: copy.notes.history.action, exact: true });
        if (width === 390) await history.tap(); else { await history.focus(); await page.keyboard.press("Enter"); }
        const dialog = page.getByRole("dialog", { name: copy.notes.history.action, exact: true });
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: copy.notes.history.revision.replace("{{revision}}", "2"), exact: true }).click();
        await expect(dialog.getByText(originalOpening, { exact: true })).toBeVisible();
        await expect(dialog.getByText(revisedOpening, { exact: true })).toBeVisible();
        await settle(run.state);
        expect(run.state.historyRequests.filter((request) => request.kind === "compare").map(({ from, to }) => [from, to])).toEqual([[1, 2]]);
        for (const text of unchangedText) {
          const retained = dialog.getByText(text, { exact: true });
          await expect(retained, `Retain one collapsed copy of ${text}`).toHaveCount(1);
          await expect(retained).not.toBeVisible();
          expect(await retained.evaluate((element) => element.closest("details")?.open)).toBe(false);
        }
        const disclosure = dialog.getByText(unchangedText[1]!, { exact: true }).locator("xpath=ancestor::details[1]");
        await disclosure.locator(":scope > summary").click();
        for (const text of unchangedText) await expect(dialog.getByText(text, { exact: true })).toBeVisible();
        await expect(dialog.locator('a[href="https://example.test/runbook"]')).toHaveCount(1);
        await expect(dialog.locator("strong em, em strong").filter({ hasText: unchangedText[4] })).toHaveCount(1);
        await disclosure.locator(":scope > summary").click();
        await expect(dialog.getByText(unchangedText[1]!, { exact: true })).not.toBeVisible();
        expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1);
        await test.info().attach("comparison-accessibility", { body: await dialog.ariaSnapshot(), contentType: "text/plain" });
        expect(run.state.historyRequests.filter((request) => request.method !== "GET").map(({ method, kind }) => [method, kind])).toEqual([["PUT", "note"]]);
      });
    });
  }
}
