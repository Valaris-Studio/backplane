// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { act, screen, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import i18n from "@/i18n/config";
import { SUPPORTED_LANGUAGES } from "@/i18n/supported-languages";
import { clearHistoryFixtures, deferred, expectReadOnly, historyName, makeNote, mountHistory,
  openHistory, OWNER, revision, selectRevision, settled } from "./note-history-fixtures";

vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: ({ content, onChange }: { content: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Note content editor" value={content} onChange={(event) => onChange(event.target.value)} />
  ),
}));

beforeEach(async () => {
  stubReducedMotion(true);
  await i18n.changeLanguage("en");
});
afterEach(async () => {
  cleanup();
  clearHistoryFixtures();
  stubReducedMotion(false);
  await i18n.changeLanguage("en");
});

describe("note history through the editor", () => {
  it.each(["workspace", "board", "card"] as const)("offers deliberate history for an ordinary %s note and discloses retained text before use", async (scope) => {
    const { state, client, historyBase } = mountHistory({ note: makeNote({
      board_id: scope === "workspace" ? null : "history-board", card_id: scope === "card" ? "linked-card" : null,
    }) });
    await settled(client);
    expect(state.historyRequests).toEqual([]);
    expect(screen.queryByRole("button", { name: /compare with original handoff/i })).not.toBeInTheDocument();
    const action = screen.getByRole("button", { name: historyName() });
    expect(action).toHaveAccessibleDescription(/earlier|previous|retained|history/i);
    expect(screen.getByText(/deleting.*(?:current|today)|(?:current|today).*delet/i)).toBeVisible();

    fireEvent.click(action);
    const dialog = await screen.findByRole("dialog", { name: /history/i });
    expect((await within(dialog).findAllByText(/Ana Torres/))[0]).toBeVisible();
    await settled(client);

    expect(state.historyRequests.map((url) => url.pathname)).toEqual([historyBase]);
    expect(state.historyRequests[0]!.searchParams.get("limit")).toBe("50");
    expect(within(dialog).queryByText(/Saved revision \d body/)).not.toBeInTheDocument();
    expectReadOnly(state);
  });

  it("groups close edits from one actor and channel while retaining every paginated revision", async () => {
    const revisions = Array.from({ length: 52 }, (_, index) => revision(52 - index, {
      recorded_at: new Date(Date.UTC(2026, 9, 23, 10, 0, (52 - index) * 5)).toISOString(),
      operation: "append",
    }));
    const { state, client } = mountHistory({ revisions, note: makeNote({ history_revision: 52 }) });
    const { dialog } = await openHistory();
    const group = await within(dialog).findByRole("button", { name: /(?:show|expand|view).*(?:revisions|edits)|(?:revisions|edits).*\d/i });
    expect(group).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(group);
    expect(group).toHaveAttribute("aria-expanded", "true");
    expect(within(dialog).getByRole("button", { name: /^Revision 52(?:\D|$)/i })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: /^Revision 3(?:\D|$)/i })).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: /load older revisions/i }));
    await settled(client);
    const collapsedGroups = within(dialog).queryAllByRole("button", { expanded: false });
    collapsedGroups.forEach((button) => fireEvent.click(button));
    await selectRevision(dialog, 1);
    expect(await within(dialog).findByText("Saved revision 1 body")).toBeVisible();
    const pages = state.historyRequests.filter((url) => !/\/revisions\//.test(url.pathname));
    expect(pages.map((url) => url.searchParams.get("before_revision"))).toEqual([null, "3"]);
    expect(within(dialog).queryByRole("button", { name: /load older revisions/i })).not.toBeInTheDocument();
    expectReadOnly(state);
  });

  it("shows recorded actor, channel and absolute time without inventing authorship for baseline or gaps", async () => {
    const revisions = [
      revision(4, { actor: { ...revision(4).actor!, user_id: "other-user", user_name: "Inez Soto" },
        recorded_at: "2026-10-23T11:47:19Z", channel: "mcp_reported", operation: "append" }),
      revision(3, { capture_kind: "gap_baseline", actor: null, operation: "capture" }),
      revision(2, { operation: "section" }),
      revision(1, { capture_kind: "baseline", actor: null, operation: "capture" }),
    ];
    mountHistory({ revisions });
    const { dialog } = await openHistory();
    expect(await within(dialog).findByText(/Inez Soto/)).toBeVisible();
    expect(within(dialog).getByText(/MCP.*reported|reported.*MCP/i)).toBeVisible();
    expect(within(dialog).queryByText(/verified.*MCP|attested|edited in (?:the )?UI/i)).not.toBeInTheDocument();
    expect(dialog.querySelector('time[datetime="2026-10-23T11:47:19Z"]')).toBeInTheDocument();
    expect(within(dialog).getAllByText(/unknown (?:author|actor)/i).length).toBeGreaterThanOrEqual(2);
    expect(within(dialog).getByText(/history (?:starts|begins)|earlier changes.*(?:not|unavailable)/i)).toBeVisible();
    expect(within(dialog).getByText(/unrecorded changes|gap in/i)).toBeVisible();
    await selectRevision(dialog, 1);
    expect(await within(dialog).findByText("Saved revision 1 body")).toBeVisible();
    expect(within(dialog).queryByText(/created.*2026-10-20/i)).not.toBeInTheDocument();
  });

  it("breaks groups at total span, principal, auth method, channel, operation and capture boundaries", async () => {
    const otherPrincipal = { ...revision(1).actor!, user_id: "another-ana", user_name: OWNER.name };
    const apiPrincipal = { ...otherPrincipal, authentication_method: "api_key", api_key_id: "one-key" };
    const revisions = [
      revision(8, { recorded_at: "2026-10-23T12:06:00Z" }),
      revision(7, { recorded_at: "2026-10-23T12:04:00Z" }),
      revision(6, { recorded_at: "2026-10-23T12:00:00Z" }),
      revision(5, { recorded_at: "2026-10-23T11:59:00Z", actor: otherPrincipal }),
      revision(4, { recorded_at: "2026-10-23T11:58:00Z", actor: apiPrincipal }),
      revision(3, { recorded_at: "2026-10-23T11:57:00Z", actor: apiPrincipal, channel: "mcp_reported" }),
      revision(2, { recorded_at: "2026-10-23T11:56:00Z", actor: apiPrincipal, channel: "mcp_reported", operation: "append" }),
      revision(1, { recorded_at: "2026-10-23T11:55:00Z", actor: null, capture_kind: "baseline", operation: "capture" }),
    ];
    mountHistory({ revisions });
    const { dialog } = await openHistory();
    await within(dialog).findByRole("button", { name: /^Revision 6(?:\D|$)/i });
    const groups = within(dialog).getAllByRole("button", { expanded: false });
    expect(groups).toHaveLength(1);
    for (const sequence of [6, 5, 4, 3, 2, 1]) {
      expect(within(dialog).getByRole("button", { name: new RegExp(`^Revision ${sequence}(?:\\D|$)`, "i") })).toBeVisible();
    }
    expect(within(dialog).queryByRole("button", { name: /^Revision 7(?:\D|$)/i })).not.toBeInTheDocument();
    fireEvent.click(groups[0]!);
    expect(within(dialog).getByRole("button", { name: /^Revision 7(?:\D|$)/i })).toBeVisible();
  });

  it("keeps a dirty title and body mounted while inspecting revisions, then returns focus without saving", async () => {
    const { state, onOpenChange } = mountHistory();
    const title = screen.getByRole("textbox", { name: String(i18n.t("cards.titleLabel")) });
    const body = screen.getByRole("textbox", { name: "Note content editor" });
    fireEvent.change(title, { target: { value: "Unpublished title" } });
    fireEvent.change(body, { target: { value: "<p>Unpublished body</p>" } });
    const { dialog, action } = await openHistory();
    expect(screen.getAllByRole("dialog")).toEqual([dialog]);
    expect(body.closest("[inert]")).not.toBeNull();
    expect(screen.queryByRole("textbox", { name: "Note content editor" })).not.toBeInTheDocument();
    await selectRevision(dialog, 2);
    expect(await within(dialog).findByText("Saved revision 2 body")).toBeVisible();
    expect(title).toBeInTheDocument();
    expect(body).toBeInTheDocument();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /history/i })).not.toBeInTheDocument());

    expect(title).toHaveValue("Unpublished title");
    expect(body).toHaveValue("<p>Unpublished body</p>");
    expect(body.closest("[inert]")).toBeNull();
    expect(screen.getByRole("button", { name: String(i18n.t("common.save")) })).toBeEnabled();
    expect(action).toHaveFocus();
    expect(screen.queryByTestId("unsaved-changes-prompt")).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    expectReadOnly(state);
  });

  it.each([500, 503])("shows loading and an honest %s failure, then retries the history read", async (status) => {
    const { state } = mountHistory({ listStatus: status });
    const gate = deferred();
    state.listGate = gate;
    const { dialog } = await openHistory();
    expect(within(dialog).getByRole("status")).toHaveTextContent(/load/i);
    await act(async () => gate.release());
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/could not|unavailable|failed/i);
    expect(within(dialog).queryByText(/no (?:history|revisions)/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Current saved body")).not.toBeInTheDocument();
    state.listStatus = 200;
    fireEvent.click(within(dialog).getByRole("button", { name: /retry|try again/i }));
    expect((await within(dialog).findAllByText(/Ana Torres/))[0]).toBeVisible();
    expect(state.historyRequests).toHaveLength(2);
    expectReadOnly(state);
  });

  it.each([401, 403, 404])("erases cached snapshots on access/deletion %s and rejects an earlier successful response", async (status) => {
    const secret = "Previously authorized historical secret";
    const selected = revision(2);
    selected.snapshot.content = `<p>${secret}</p>`;
    const { state, client, socket } = mountHistory({ revisions: [revision(3), selected, revision(1)] });
    const { dialog } = await openHistory();
    await selectRevision(dialog, 2);
    expect(await within(dialog).findByText(secret)).toBeVisible();
    const gate = deferred();
    state.detailGate = gate;
    act(() => { void client.invalidateQueries(); });
    await waitFor(() => expect(state.detailGate).toBeNull());
    state.listStatus = status;
    state.detailStatus = status;
    state.compareStatus = status;
    state.membersStatus = status;
    act(() => socket.emit(status === 404 ? "activity.note.deleted" : "activity.member.removed_member",
      status === 404 ? "history-note" : OWNER.id));

    await waitFor(() => expect(within(dialog).queryByText(secret)).not.toBeInTheDocument());
    await act(async () => gate.release());
    await settled(client);
    expect(within(dialog).queryByText(secret)).not.toBeInTheDocument();
    expect(JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(secret);
    expect(within(dialog).getByText(/access.*lost|no longer available|unavailable.*access/i)).toBeVisible();
    expectReadOnly(state);
  });

  it.each(["listStatus", "currentStatus", "compareStatus"] as const)("a definitive denial from %s clears the complete history family", async (deniedRead) => {
    const secret = "Private comparison must leave every history query";
    const selected = revision(2);
    selected.snapshot.content = `<p>${secret}</p>`;
    const { state, client } = mountHistory({ revisions: [revision(3), selected, revision(1)] });
    const { dialog } = await openHistory();
    await selectRevision(dialog, 2);
    expect(await within(dialog).findByText(secret)).toBeVisible();
    state[deniedRead] = 403;
    await act(async () => { await client.invalidateQueries(); });
    await settled(client);
    expect(within(dialog).queryByText(secret)).not.toBeInTheDocument();
    expect(JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(secret);
    expect(within(dialog).getByText(/access.*lost|no longer available|unavailable.*access/i)).toBeVisible();
    expectReadOnly(state);
  });

  it.each(SUPPORTED_LANGUAGES)("uses registered %s copy for history, retention, comparisons and failures", async (language) => {
    await i18n.changeLanguage(language);
    mountHistory();
    const requiredCopy = ["action", "retention", "loading", "loadError", "accessLost", "retry", "loadMore",
      "baseline", "gapBaseline", "unknownActor"];
    for (const key of requiredCopy) {
      expect(i18n.getResource(language, "translation", `notes.history.${key}`), `${language}: ${key}`).toEqual(expect.any(String));
      expect(String(i18n.getResource(language, "translation", `notes.history.${key}`))).not.toBe("");
    }
    for (const key of ["previous", "current", "currentUnrecorded"]) {
      expect(i18n.getResource(language, "translation", `notes.comparison.${key}`), `${language}: ${key}`).toEqual(expect.any(String));
    }
    expect(screen.getByRole("button", { name: historyName() })).toBeVisible();
  });
});
