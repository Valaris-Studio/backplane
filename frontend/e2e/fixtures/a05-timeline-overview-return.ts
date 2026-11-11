// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import type { HistoryOverview, HistorySearchPage } from "../../src/features/timeline/types";
import { installTimelineFixture, sequence, sha, targetOffset, targetSummary, timelineApi,
  type TimelineFixture, type TimelineReceipt } from "./a05-timeline-navigation";

export const overviewSearch = "browser";
export const unsentOverviewSearch = "PRIVATE unsent overview filter";
export const selectedDate = "2026-10-08";
export const selectedPeriod = "week";
export const pageTwoCursor = "synthetic-overview-search-page-two";
export const pageOneFirstSummary = "browser retained overview result 360";
export const pageTwoFirstSummary = "browser retained overview result 410";
const timestamp = (offset: number) => new Date(Date.UTC(2026, 9, 8) + offset * 1000).toISOString();

interface OverviewReceipt extends TimelineReceipt {
  responseSha256?: string;
  resultPage?: 1 | 2;
  resultSequences?: string[];
  bucketCount?: number;
}

export interface OverviewFixture extends TimelineFixture {
  overviewRequests: OverviewReceipt[];
}

function overview(generationId: string): HistoryOverview {
  const starts = [0, 2500, 5000, 7500];
  return {
    generation_id: generationId, first_seq: sequence(0), head_seq: sequence(10000), event_count: "10001",
    first_at: timestamp(0), last_at: timestamp(10000),
    buckets: starts.map((start, index) => {
      const last = index === starts.length - 1 ? 10000 : starts[index + 1]! - 1;
      return { start_at: timestamp(start), end_at: timestamp(last + 1), count: String(last - start + 1),
        first_seq: sequence(start), last_seq: sequence(last) };
    }),
  };
}

function searchPage(generationId: string, page: 1 | 2): HistorySearchPage {
  const first = page === 1 ? 360 : 410;
  return {
    generation_id: generationId, scope: "generation",
    matches: Array.from({ length: 50 }, (_, index) => {
      const offset = first + index;
      return { id: `timeline-browser-event-${offset}`, seq: sequence(offset), created_at: timestamp(offset),
        summary: offset === targetOffset ? targetSummary : `browser retained overview result ${offset}` };
    }),
    next_cursor: page === 1 ? pageTwoCursor : null,
  };
}

/** Only the overview and its paginated search differ from the frozen shell fixture. */
export async function installOverviewFixture(page: Page, locale: string): Promise<OverviewFixture> {
  const inherited = await installTimelineFixture(page, locale, { kind: "card" });
  const fixture: OverviewFixture = Object.assign(inherited, { overviewRequests: [] as OverviewReceipt[] });
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url());
    const match = url.pathname.match(new RegExp(`^${timelineApi}/generations/([0-9a-f-]{36})/(overview|search)$`, "i"));
    if (!match) return route.fallback();
    const generationId = match[1]!, kind = match[2] as "overview" | "search";
    const receipt: OverviewReceipt = { path: url.pathname, query: url.search, method: request.method(),
      owner: fixture.owner, generationId, kind, mode: null, callId: null, cursor: url.searchParams.get("cursor"), startedAt: Date.now() };
    fixture.overviewRequests.push(receipt); fixture.timelineRequests.push(receipt); fixture.requests.push(receipt); fixture.inflight += 1;
    try {
      assert.equal(url.origin, new URL(page.url()).origin);
      assert.equal(request.method(), "GET");
      assert(!request.headers().authorization && !request.headers().cookie, "No synthetic credentials");
      assert([...fixture.store.byRequest.values()].some((value) => value.id === generationId), "Read only an actually established generation");
      assert(!fixture.store.expired.has(generationId), "Expiration is covered by the unchanged main browser fixture");
      let value: HistoryOverview | HistorySearchPage;
      if (kind === "overview") {
        assert.deepEqual([...url.searchParams.keys()], ["buckets"]);
        assert.equal(url.searchParams.get("buckets"), "128");
        value = overview(generationId); receipt.bucketCount = value.buckets.length;
      } else {
        assert.deepEqual([...url.searchParams.keys()].sort(), receipt.cursor ? ["cursor", "limit", "q"] : ["limit", "q"]);
        assert.equal(url.searchParams.get("q"), overviewSearch);
        assert.equal(url.searchParams.get("limit"), "50");
        assert(receipt.cursor === null || receipt.cursor === pageTwoCursor, "Use only the returned continuation");
        receipt.resultPage = receipt.cursor ? 2 : 1;
        value = searchPage(generationId, receipt.resultPage);
        receipt.resultSequences = value.matches.map((row) => row.seq);
      }
      const body = JSON.stringify(value);
      receipt.status = 200; receipt.bytes = Buffer.byteLength(body); receipt.responseSha256 = sha(Buffer.from(body));
      await route.fulfill({ status: 200, contentType: "application/json", body });
    } catch (error) {
      if (request.failure()?.errorText !== "net::ERR_ABORTED") {
        fixture.unexpected.push(`Overview fixture: ${String(error)}`);
        await route.fulfill({ status: 500, json: { detail: "Synthetic overview contract failed" } }).catch(() => {});
      }
    } finally { receipt.completedAt = Date.now(); fixture.inflight -= 1; }
  });
  return fixture;
}
