// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { renderNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import { useHandoffDraft } from "../../hooks/use-handoff-drafts";
import type { ExcerptNoteDraft } from "../../utils/excerpt-note";
import { makeContent, makeSession, ME } from "../../__tests__/fixtures";
import { ExcerptNoteDialog } from "../ExcerptNoteDialog";

vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: ({ content, onChange, editable }: { content: string; onChange: (value: string) => void; editable: boolean }) =>
    <textarea aria-label="Handoff body" value={content} disabled={!editable} onChange={(event) => onChange(event.target.value)} />,
}));

type SourceState = "stale" | "failed" | "recovered";
const draftDocument = JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Private draft" }] }] });
const draft: ExcerptNoteDraft = {
  fingerprint: "retained-source", session: makeSession({ id: "source" }),
  bodies: [{ item: makeContent({ id: "source-content", session_id: "source", preview: null }), text: "Private source" }],
  document: draftDocument,
};

function setup() {
  let resolve!: () => void;
  const pending = new Promise<void>((done) => { resolve = done; });
  const recheck = vi.fn(() => pending);
  const control: { update: (state: SourceState) => void } = { update: () => {} };
  function Source() {
    const [state, setState] = useState<SourceState>("stale");
    control.update = setState;
    const handoff = useHandoffDraft("acme", "source");
    return <>
      <button onClick={() => handoff.setDraft(draft)}>Prepare handoff</button>
      {handoff.state.draft ? <ExcerptNoteDialog draft={handoff.state.draft} handoff={handoff}
        stale={state === "stale"} sourceCheckFailed={state === "failed"} onRecheckSources={recheck}
        onDiscard={handoff.clear} onComplete={() => handoff.setDraft(null)} /> : null}
    </>;
  }
  const view = renderNavigationRouter([{ path: "/", element: <Source /> }]);
  return { ...view, recheck, resolve, control };
}

beforeEach(() => {
  stubReducedMotion(true);
  server.use(
    http.get("/api/workspaces", () => HttpResponse.json([])),
    http.get("/api/me", () => HttpResponse.json({ id: ME, name: "Owner", email: "owner@example.test" })),
  );
});
afterEach(() => stubReducedMotion(false));

describe("ExcerptNoteDialog source recheck focus", () => {
  it.each(["stale", "failed", "recovered"] as const)("keeps the active check focusable and preserves the draft when sources become %s", async (outcome) => {
    const view = setup();
    const user = userEvent.setup();
    try {
      await user.click(screen.getByRole("button", { name: "Prepare handoff" }));
      const dialog = await screen.findByRole("dialog", { name: "Share as note" });
      const title = within(dialog).getByRole("textbox", { name: "Note title" });
      await user.clear(title);
      await user.type(title, "Reviewed private title");
      const recheck = within(dialog).getByRole("button", { name: "Check again" });
      recheck.focus();
      await user.keyboard("{Enter}");
      expect(view.recheck).toHaveBeenCalledTimes(1);
      expect(recheck).toBeEnabled();
      expect(recheck).toHaveAttribute("aria-disabled", "true");
      expect(recheck).toHaveAttribute("aria-busy", "true");
      expect(recheck).toHaveFocus();
      await user.keyboard("{Enter} ");
      expect(view.recheck).toHaveBeenCalledTimes(1);

      act(() => view.control.update(outcome));
      expect(recheck).toBeInTheDocument();
      expect(recheck).toHaveFocus();
      expect(title).toHaveValue("Reviewed private title");
      expect(within(dialog).getByRole("textbox", { name: "Handoff body" })).toHaveValue(draftDocument);
      await act(async () => view.resolve());
      if (outcome === "recovered") {
        await waitFor(() => expect(recheck).not.toBeInTheDocument());
        expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
      } else {
        await waitFor(() => expect(recheck).not.toHaveAttribute("aria-busy"));
        expect(recheck).not.toHaveAttribute("aria-disabled");
        expect(recheck).toHaveFocus();
        expect(within(dialog).getByRole("alert")).toHaveTextContent(outcome === "failed"
          ? "Couldn't check the selected sources." : "Selected sources changed or are unavailable.");
        await user.keyboard(" ");
        await waitFor(() => expect(view.recheck).toHaveBeenCalledTimes(2));
      }
      expect(title).toHaveValue("Reviewed private title");
      expect(within(dialog).getByRole("textbox", { name: "Handoff body" })).toHaveValue(draftDocument);
      expect(within(dialog).getByRole("button", { name: "Save note" })).toBeDisabled();
    } finally {
      view.resolve();
      view.unmount();
      view.client.clear();
    }
  });

  it("does not steal focus after the user leaves Recheck before recovery", async () => {
    const view = setup();
    const user = userEvent.setup();
    try {
      await user.click(screen.getByRole("button", { name: "Prepare handoff" }));
      const dialog = await screen.findByRole("dialog", { name: "Share as note" });
      const recheck = within(dialog).getByRole("button", { name: "Check again" });
      recheck.focus();
      await user.keyboard(" ");
      expect(recheck).toBeEnabled();
      await user.tab();
      const next = window.document.activeElement;
      expect(next).not.toBe(recheck);
      act(() => view.control.update("recovered"));
      await act(async () => view.resolve());
      await waitFor(() => expect(recheck).not.toBeInTheDocument());
      expect(window.document.activeElement).toBe(next);
    } finally {
      view.resolve();
      view.unmount();
      view.client.clear();
    }
  });
});
