// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, waitFor, userEvent } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { CardCompletionSection } from "../CardCompletionSection";
const admin = { value: true };
vi.mock("@/hooks/useWorkspaceAdmin", () => ({ useWorkspaceAdmin: () => ({ isAdmin: admin.value, role: admin.value ? "admin" : "member" }) }));
const base = "/api/workspaces/acme/boards/board-1/completion";
const candidate = { id: "candidate-1", status: "failed", source_sha: "abc123", merge_sha: "def456", summary: "Export installation failed on the merged commit" };
const result = { completion_mode: "source", candidate, attempts: [] };
async function renderSection() {
  return renderWithProviders(<CardCompletionSection slug="acme" boardId="board-1" cardId="card-1" />);
}
function handlers() {
  admin.value = true;
  server.use(
    http.get(`${base}/policy`, () => HttpResponse.json({ effective_policy: { evidence_only: { enabled: true } }, incompatibilities: [] })),
    http.get(`${base}/cards/card-1`, () => HttpResponse.json(result)),
  );
}
describe("card completion controls", () => {
  it("shows exact revisions and failed evidence and retries only through the completion endpoint", async () => {
    handlers();
    let retried = false;
    server.use(http.post(`${base}/cards/card-1/retry`, () => { retried = true; return HttpResponse.json(result); }));
    await renderSection();
    expect(await screen.findByText(candidate.summary)).toBeVisible();
    expect(screen.getByText("abc123")).toBeVisible();
    expect(screen.getByText("def456")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry completion checks" }));
    await waitFor(() => expect(retried).toBe(true));
  });
  it("requires an explicit operator mode action and hides it from members", async () => {
    handlers();
    const modes: unknown[] = [];
    server.use(http.put(`${base}/cards/card-1/mode`, async ({ request }) => { modes.push(await request.json()); return HttpResponse.json(result); }));
    const rendered = await renderSection();
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Completion mode" }), "evidence_only");
    expect(modes).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Apply completion mode" }));
    await waitFor(() => expect(modes).toEqual([{ completion_mode: "evidence_only" }]));
    rendered.unmount();
    admin.value = false;
    await renderSection();
    await screen.findByText(candidate.summary);
    expect(screen.queryByRole("combobox", { name: "Completion mode" })).toBeNull();
  });
});

it("renders attempt kinds, outcomes, summaries and check receipts from the nested result", async () => {
  handlers();
  server.use(http.get(`${base}/cards/card-1`, () => HttpResponse.json({ ...result, attempts: [{
    id: "attempt-1", kind: "validation", status: "failed", created_at: "2026-09-13T12:00:00Z",
    result: { summary: "Clean install could not load the package", checks: [{ id: "clean-install", source_sha: "abc123", exit_code: 1, output: "Missing package entry point" }] },
  }] })));
  await renderSection();
  await userEvent.click(await screen.findByText("Completion attempts"));
  expect(screen.getByText("Validation")).toBeVisible();
  expect(screen.getByText("Failed")).toBeVisible();
  expect(screen.getByText("Clean install could not load the package")).toBeVisible();
  expect(screen.getByText("clean-install")).toBeVisible();
  expect(screen.getByText("Missing package entry point")).toBeVisible();
});

it("explains rejected context and links the changed note without presenting its passing summary as acceptance", async () => {
  handlers();
  server.use(http.get(`${base}/cards/card-1`, () => HttpResponse.json({ ...result, attempts: [{
    id: "attempt-old", kind: "review", status: "rejected", created_at: "2026-09-16T12:00:00Z",
    result: { summary: "Review passed on previous context", receipt: { status: "rejected", code: "completion_context_changed", retryable: true,
      changed_sources: [{ kind: "note", id: "note-changed", change: "changed" }] } },
  }] })));
  await renderSection();
  await userEvent.click(await screen.findByText("Completion attempts"));
  expect(screen.getByText("Changed completion inputs")).toBeVisible();
  expect(screen.getByRole("link", { name: /note-changed/ })).toHaveAttribute("href", "/acme/notes?note=note-changed");
  expect(screen.getByText(/This result was rejected/)).toBeVisible();
});

it("offers explicit context revalidation for a claimed attempt without automatically retrying", async () => {
  handlers();
  let retries = 0;
  server.use(
    http.get(`${base}/cards/card-1`, () => HttpResponse.json({ ...result, candidate: { ...candidate, status: "awaiting_review" }, attempts: [{ id: "active", kind: "review", status: "claimed", created_at: "2026-09-16T12:00:00Z", result: null }] })),
    http.post(`${base}/cards/card-1/retry`, () => { retries++; return HttpResponse.json(result); }),
  );
  await renderSection();
  const button = await screen.findByRole("button", { name: "Recheck completion context" });
  expect(retries).toBe(0);
  await userEvent.click(button);
  await waitFor(() => expect(retries).toBe(1));
});
