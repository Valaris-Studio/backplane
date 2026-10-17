// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { HttpResponse } from "@/test/msw-server";
import type { SessionContent, SessionContentPage, SessionContentWindow } from "@/types/agent-session";

type Boundary = [string, number, string];
interface FixtureCursor { page: number; low: Boundary | null; high: Boundary | null }
const boundary = (item: SessionContent): Boundary => [item.occurred_at, item.source.order, item.id];
function compare(left: Boundary, right: Boundary) {
  return left[0].localeCompare(right[0]) || left[1] - right[1] || left[2].localeCompare(right[2]);
}
const encode = (cursor: FixtureCursor) => btoa(JSON.stringify(cursor));
const decode = (cursor: string) => JSON.parse(atob(cursor)) as FixtureCursor;

// Small fixture pages model separate bounded windows; refresh retains their
// original tuple bounds even when the mutable backing records change.
export function contentWindow(pages: SessionContentPage[], params = new URLSearchParams()): SessionContentWindow {
  const mode = (params.get("mode") ?? "latest") as SessionContentWindow["mode"];
  const requested = params.get("cursor");
  const cursor = requested ? decode(requested) : null;
  let index = mode === "beginning" ? 0 : pages.length - 1;
  if (mode === "anchor") index = pages.findIndex((page) => page.items.some((item) => item.id === params.get("anchor_id")));
  if (cursor) index = cursor.page;
  const page = pages[index] ?? { items: [], next_cursor: null };
  let items = page.items;
  if (mode === "refresh" && cursor?.low && cursor.high) {
    items = pages.flatMap((candidate) => candidate.items).filter((item) => compare(boundary(item), cursor.low!) >= 0 && compare(boundary(item), cursor.high!) <= 0);
  }
  const ordered = [...items].sort((left, right) => compare(boundary(left), boundary(right)));
  const bounds = mode === "refresh" && cursor ? cursor : { page: index, low: ordered[0] ? boundary(ordered[0]) : null, high: ordered.at(-1) ? boundary(ordered.at(-1)!) : null };
  return {
    capability: "content-window-v1", mode, items,
    earlier_cursor: index > 0 ? encode({ page: index - 1, low: null, high: null }) : null,
    later_cursor: index < pages.length - 1 ? encode({ page: index + 1, low: null, high: null }) : null,
    window_cursor: encode(bounds), anchor_id: mode === "anchor" ? params.get("anchor_id") : null,
  };
}

export function contentWindowResponse(pages: SessionContentPage[], params = new URLSearchParams()) {
  if (params.get("mode") === "anchor" && !pages.some((page) => page.items.some((item) => item.id === params.get("anchor_id")))) {
    return HttpResponse.json({ detail: "Content not found", error_code: "content_not_found" }, { status: 404 });
  }
  return HttpResponse.json(contentWindow(pages, params));
}

export async function windowFromResponse(response: Response, params: URLSearchParams) {
  if (!response.ok) return response;
  return contentWindowResponse([await response.json() as SessionContentPage], params);
}

export function selectedMetadata(items: SessionContent[], ids: string[]) {
  const requested = new Set(ids);
  const available = items.filter((item) => requested.has(item.id)).sort((left, right) => compare(boundary(left), boundary(right)));
  return { items: available.map((item) => ({ ...item, preview: null })), unavailable_ids: ids.filter((id) => !available.some((item) => item.id === id)) };
}
