// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { act, screen, stubReducedMotion, userEvent, waitFor } from "@/test/test-utils";
import { renderNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import { sessionKeys } from "@/lib/query-keys";
import { ExcerptNoteDialog } from "@/features/sessions/components/ExcerptNoteDialog";
import { useHandoffDraft } from "@/features/sessions/hooks/use-handoff-drafts";
import type { ExcerptNoteDraft } from "@/features/sessions/utils/excerpt-note";
import { makeContent, makeSession, ME } from "@/features/sessions/__tests__/fixtures";

vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: ({ content }: { content: string }) => <textarea aria-label="Handoff body" value={content} readOnly />,
}));

const origin = "/acme/sessions/source";
const destination = "/acme/boards/work/kanban";
const draft: ExcerptNoteDraft = {
  fingerprint: "retained-source", session: makeSession({ id: "source" }),
  bodies: [{ item: makeContent({ id: "source-content", session_id: "source", preview: null }), text: "" }],
  document: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Private draft" }] }] }),
};

function Source() {
  const handoff = useHandoffDraft("acme", "source");
  return <>
    <button onClick={() => handoff.setDraft(draft)}>Prepare handoff</button>
    {handoff.state.draft ? <ExcerptNoteDialog draft={handoff.state.draft} handoff={handoff} stale={false}
      onDiscard={handoff.clear} onComplete={() => handoff.setDraft(null)} /> : <p>Handoff unavailable</p>}
  </>;
}

beforeEach(() => {
  stubReducedMotion(true);
  server.use(
    http.get("/api/workspaces", () => HttpResponse.json([])),
    http.get("/api/me", () => HttpResponse.json({ id: ME, name: "Owner", email: "owner@example.test" })),
  );
});
afterEach(() => stubReducedMotion(false));

describe("NavigationGuardProvider source revocation", () => {
  it("does not leave a hidden blocked route after source loss unmounts the actual handoff editor", async () => {
    const { router, client } = renderNavigationRouter([
      { path: origin, element: <Source /> },
      { path: destination, element: <h1>Related board</h1> },
    ], { initialEntries: [origin] });
    const user = userEvent.setup();
    try {
      await user.click(screen.getByRole("button", { name: "Prepare handoff" }));
      fireEvent.change(await screen.findByLabelText("Note title"), { target: { value: "Reviewed private title" } });
      await act(async () => { await router.navigate(destination); });
      expect(router.state.location.pathname).toBe(origin);
      expect(screen.getByTestId("unsaved-changes-prompt")).toBeVisible();
      expect([...router.state.blockers.values()].some((blocker) => blocker.state === "blocked")).toBe(true);

      // This is the application's actual source-loss signal. The authenticated
      // handoff provider purges it, which unmounts ExcerptNoteDialog's guard.
      act(() => { client.setQueryData(sessionKeys.detail("acme", "source"), null); });
      await waitFor(() => expect(screen.queryByLabelText("Note title")).not.toBeInTheDocument());
      await waitFor(() => expect(screen.queryByTestId("unsaved-changes-prompt")).not.toBeInTheDocument());
      expect([...router.state.blockers.values()].some((blocker) => blocker.state === "blocked")).toBe(false);
      await act(async () => { await router.navigate(destination); });
      expect(screen.getByRole("heading", { name: "Related board" })).toBeVisible();
    } finally { client.clear(); }
  });
});
