// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { QueryClient, useQuery } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/api-error";
import { sessionKeys } from "@/lib/query-keys";
import { act, renderWithProviders, screen, userEvent, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { SLUG, makeContent, makeSession } from "../../__tests__/fixtures";
import { useContentBodyPages, useContentImage, useDownloadContent, useSessionContents } from "../use-session-contents";

const SESSION = "nested-private";
const SIBLING = "unrelated-private";
const CONTENT = makeContent({ id: "nested-content", session_id: SESSION });
const session = makeSession({ id: SESSION, title: "Retained private session" });
const sibling = makeSession({ id: SIBLING, title: "Other authorized session" });
const rootKey = sessionKeys.detail(SLUG, SESSION);
const retainedKey = sessionKeys.contentBody(SLUG, SESSION, "retained-body", "retained-digest", 0);
const siblingKey = sessionKeys.contentBody(SLUG, SIBLING, "other-body", "other-digest", 0);
const surfaces = ["call contents", "body", "image", "download"] as const;
type Surface = typeof surfaces[number];
const clients: QueryClient[] = [];
const responseInterceptors: number[] = [];
const requestInterceptors: number[] = [];

afterEach(() => {
  responseInterceptors.splice(0).forEach((id) => api.interceptors.response.eject(id));
  requestInterceptors.splice(0).forEach((id) => api.interceptors.request.eject(id));
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
});

function path(surface: Surface) {
  const contents = `/api/workspaces/${SLUG}/sessions/${SESSION}/contents`;
  return surface === "call contents" ? contents : `${contents}/${CONTENT.id}/${surface === "body" ? "body" : "download"}`;
}

function retainedClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 300_000 }, mutations: { retry: false } } });
  clients.push(client);
  client.setQueryData(rootKey, session);
  client.setQueryData(retainedKey, { text: "Previously disclosed private body" });
  client.setQueryData(sessionKeys.selectedMetadata(SLUG, SESSION, [CONTENT.id]), { items: [CONTENT], unavailable_ids: [] });
  client.setQueryData(sessionKeys.detail(SLUG, SIBLING), sibling);
  client.setQueryData(siblingKey, { text: "Other session body" });
  return client;
}

function descendants(client: QueryClient) {
  return client.getQueryCache().findAll({ queryKey: rootKey, predicate: (query) => query.queryKey.length > rootKey.length });
}

function ReadState({ failed }: { failed: boolean }) {
  return <p role="status">{failed ? "Private read failed" : "Private read pending"}</p>;
}

function CallContentsRead() {
  const query = useSessionContents(SLUG, SESSION, "literal-call");
  return <ReadState failed={query.failureCount > 0 || query.isError} />;
}

function BodyRead() {
  const [query] = useContentBodyPages(SLUG, SESSION, CONTENT, [0]);
  return <ReadState failed={query!.failureCount > 0 || query!.isError} />;
}

function ImageRead() {
  const query = useContentImage(SLUG, SESSION, CONTENT, true);
  return <ReadState failed={query.failureCount > 0 || query.isError} />;
}

function DownloadRead() {
  const download = useDownloadContent(SLUG, SESSION, CONTENT);
  return <><button onClick={() => download.mutate()}>Download private record</button><ReadState failed={download.isError} /></>;
}

function AuthorityReader({ surface }: { surface: Surface }) {
  const [opened, setOpened] = useState(false);
  const authority = useQuery({ queryKey: rootKey, queryFn: async () => session, enabled: false });
  if (authority.data === null) return <p>Session unavailable</p>;
  return <>
    <h1>{authority.data?.title}</h1>
    <button onClick={() => setOpened(true)}>Inspect private record</button>
    {opened ? surface === "call contents" ? <CallContentsRead /> : surface === "body" ? <BodyRead /> : surface === "image" ? <ImageRead /> : <DownloadRead /> : null}
  </>;
}

async function openRead(surface: Surface, client: QueryClient) {
  const view = renderWithProviders(<AuthorityReader surface={surface} />, { queryClient: client });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Inspect private record" }));
  if (surface === "download") await user.click(screen.getByRole("button", { name: "Download private record" }));
  return view;
}

function rejectRead(surface: Surface, status: number) {
  let reads = 0;
  server.use(http.get(path(surface), ({ request }) => {
    if (surface === "call contents") expect(new URL(request.url).searchParams.get("call_id")).toBe("literal-call");
    reads += 1;
    return HttpResponse.json({ detail: "Synthetic private read refusal", error_code: status === 404 ? "content_not_found" : "forbidden" }, { status });
  }));
  return () => reads;
}

describe.each(surfaces)("%s authority", (surface) => {
  it.each([401, 403])("purges retained private evidence on a current %s while preserving an unrelated session", async (status) => {
    const reads = rejectRead(surface, status);
    const client = retainedClient();
    await openRead(surface, client);
    await waitFor(() => expect(reads()).toBe(1));
    await waitFor(() => expect(client.getQueryData(rootKey)).toBeNull());
    expect(await screen.findByText("Session unavailable")).toBeVisible();
    await waitFor(() => expect(descendants(client)).toEqual([]));
    expect(client.getQueryData(sessionKeys.detail(SLUG, SIBLING))).toEqual(sibling);
    expect(client.getQueryData(siblingKey)).toEqual({ text: "Other session body" });
  });

  it.each([404, 503])("keeps a record-level %s local without revoking session authority", async (status) => {
    rejectRead(surface, status);
    const client = retainedClient();
    await openRead(surface, client);
    await screen.findByText("Private read failed");
    expect(client.getQueryData(rootKey)).toEqual(session);
    expect(client.getQueryData(retainedKey)).toEqual({ text: "Previously disclosed private body" });
    expect(client.getQueryData(siblingKey)).toEqual({ text: "Other session body" });
    expect(screen.getByRole("heading", { name: session.title! })).toBeVisible();
  });

  it("ignores an older denial that settles after cancellation and newer authorized data", async () => {
    rejectRead(surface, 403);
    const client = retainedClient();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let rejected = false;
    let signal: { readonly aborted: boolean } | undefined;
    requestInterceptors.push(api.interceptors.request.use((config) => {
      if (config.url === path(surface).slice(4)) signal = config.signal;
      return config;
    }));
    // Hold the actual HTTP rejection until after its consuming reader leaves.
    // This exercises the late-denial guard, not only transport cancellation.
    responseInterceptors.push(api.interceptors.response.use(undefined, async (error) => {
      if (isApiError(error) && error.status === 403) {
        rejected = true;
        await pending;
      }
      throw error;
    }));
    const requests = vi.spyOn(api, "get");
    const view = await openRead(surface, client);
    try {
      await waitFor(() => expect(rejected).toBe(true));
      const index = requests.mock.calls.findIndex(([url]) => url === path(surface).slice(4));
      const request = requests.mock.results[index];
      if (!request || request.type !== "return") throw new Error("Expected the private request");
      const settled = Promise.resolve(request.value).catch(() => undefined);
      view.unmount();
      await waitFor(() => expect(signal?.aborted).toBe(true));
      const newer = { ...session, title: "Newer authorized session" };
      client.setQueryData(rootKey, newer);
      client.setQueryData(retainedKey, { text: "Newer authorized body" });
      await act(async () => { release(); await settled; });
      expect(client.getQueryData(rootKey)).toEqual(newer);
      expect(client.getQueryData(retainedKey)).toEqual({ text: "Newer authorized body" });
      expect(client.getQueryData(siblingKey)).toEqual({ text: "Other session body" });
    } finally { release(); }
  });
});
