// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  renderWithProviders,
  screen,
  waitFor,
  userEvent,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";

// Devops UX round 2 (#2): Archive sat next to Publish/Duplicate and fired
// immediately. It now confirms first and offers Undo (soft archive server-
// side, so Undo is POST /unarchive).

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";
import { ArchiveTemplateDialog } from "../components/ArchiveTemplateDialog";

const SLUG = "acme";
const REF = "11111111-1111-4111-8111-111111111111";
const BASE = `/api/workspaces/${SLUG}/loop-templates/${REF}`;

function renderDialog(onClose = vi.fn()) {
  renderWithProviders(
    <ArchiveTemplateDialog
      slug={SLUG}
      target={{ ref: REF, name: "Docs Sweep" }}
      onClose={onClose}
    />,
  );
  return onClose;
}

beforeEach(() => {
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe("ArchiveTemplateDialog", () => {
  it("does not archive on cancel", async () => {
    const archived = vi.fn();
    server.use(
      http.post(`${BASE}/archive`, () => {
        archived();
        return HttpResponse.json({});
      }),
    );
    const onClose = renderDialog();

    expect(
      await screen.findByText(/keeps serving boards already bound/i),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(onClose).toHaveBeenCalled();
    expect(archived).not.toHaveBeenCalled();
  });

  it("archives on confirm and offers Undo in the toast", async () => {
    const archived = vi.fn();
    server.use(
      http.post(`${BASE}/archive`, () => {
        archived();
        return HttpResponse.json({});
      }),
    );
    const onClose = renderDialog();

    await userEvent.click(
      await screen.findByRole("button", { name: "Archive" }),
    );

    await waitFor(() => expect(archived).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith(
      "Template archived",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Undo" }),
      }),
    );
  });

  it("Undo restores the template via POST /unarchive", async () => {
    const restored = vi.fn();
    server.use(
      http.post(`${BASE}/archive`, () => HttpResponse.json({})),
      http.post(`${BASE}/unarchive`, () => {
        restored();
        return HttpResponse.json({});
      }),
    );
    renderDialog();

    await userEvent.click(
      await screen.findByRole("button", { name: "Archive" }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalled());

    const { action } = vi.mocked(toast.success).mock.calls[0]![1] as unknown as {
      action: { onClick: () => void };
    };
    action.onClick();

    await waitFor(() => expect(restored).toHaveBeenCalledTimes(1));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and surfaces a toast when archiving fails", async () => {
    server.use(
      http.post(`${BASE}/archive`, () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );
    const onClose = renderDialog();

    await userEvent.click(
      await screen.findByRole("button", { name: "Archive" }),
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Could not archive that template. Try again.",
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
