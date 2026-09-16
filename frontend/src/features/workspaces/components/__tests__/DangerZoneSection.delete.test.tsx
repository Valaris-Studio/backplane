// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
  within,
} from "@/test/test-utils";

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, useNavigate: () => navigate };
});

const deleteMutate = vi.fn();
const usePendingRef = { current: false };
vi.mock("@/features/workspaces/api/use-workspaces", () => ({
  useDeleteWorkspace: () => ({
    mutate: deleteMutate,
    get isPending() {
      return usePendingRef.current;
    },
  }),
}));

import { DangerZoneSection } from "../DangerZoneSection";

const SLUG = "acme";

function renderSection() {
  return renderWithProviders(<DangerZoneSection slug={SLUG} />);
}

beforeEach(() => {
  deleteMutate.mockReset();
  navigate.mockReset();
  usePendingRef.current = false;
});

describe("DangerZoneSection — delete workspace flow", () => {
  // The dialog confirm shares its label with the page trigger, so every query
  // for it must be scoped to the dialog — an unscoped match can resolve the
  // page trigger instead, whose onClick RESETS the typed slug.
  function dialogConfirm(): HTMLElement {
    return within(screen.getByRole("dialog")).getByRole("button", {
      name: /^delete workspace$/i,
    });
  }

  it("exposes the click-opened dialog to role queries", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(
      screen.getByRole("button", { name: /delete workspace/i }),
    );

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("renders the destructive Delete workspace button", () => {
    renderSection();
    expect(
      screen.getByRole("button", { name: /delete workspace/i }),
    ).toBeInTheDocument();
  });

  it("opens the confirmation dialog with the slug interpolated and the confirm button disabled until the slug is typed", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(
      screen.getByRole("button", { name: /delete workspace/i }),
    );

    expect(
      await screen.findByText(/delete workspace\?/i),
    ).toBeInTheDocument();
    // Body mentions the slug in single quotes — appears twice (body + label).
    expect(
      screen.getAllByText(new RegExp(`'${SLUG}'`)).length,
    ).toBeGreaterThan(0);

    await waitFor(() => expect(dialogConfirm()).toBeDisabled());
  });

  it("enables the confirm button only after the user types the slug exactly", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(
      screen.getByRole("button", { name: /delete workspace/i }),
    );

    const input = await screen.findByPlaceholderText(SLUG);
    await user.type(input, "wrong");
    await waitFor(() => expect(dialogConfirm()).toBeDisabled());

    await user.clear(input);
    await user.type(input, SLUG);
    await waitFor(() => expect(dialogConfirm()).toBeEnabled());
  });

  it("calls useDeleteWorkspace.mutate on confirm and navigates home on success", async () => {
    const user = userEvent.setup();
    deleteMutate.mockImplementation((_slug, options) => options?.onSuccess?.());
    renderSection();

    await user.click(
      screen.getByRole("button", { name: /delete workspace/i }),
    );
    const input = await screen.findByPlaceholderText(SLUG);
    await user.type(input, SLUG);

    await waitFor(() => expect(dialogConfirm()).toBeEnabled());
    await user.click(dialogConfirm());

    await waitFor(() => {
      expect(deleteMutate).toHaveBeenCalledWith(SLUG, expect.any(Object));
      expect(navigate).toHaveBeenCalledWith("/", { replace: true });
    });
  });

  it("shows the error message when the delete request fails", async () => {
    const user = userEvent.setup();
    deleteMutate.mockImplementation((_slug, options) =>
      options?.onError?.(new Error("boom")),
    );
    renderSection();

    await user.click(
      screen.getByRole("button", { name: /delete workspace/i }),
    );
    const input = await screen.findByPlaceholderText(SLUG);
    await user.type(input, SLUG);

    await waitFor(() => expect(dialogConfirm()).toBeEnabled());
    await user.click(dialogConfirm());

    await waitFor(() => {
      expect(
        screen.getByText(/couldn't delete workspace/i),
      ).toBeInTheDocument();
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("cancel closes the dialog without firing the mutation", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(
      screen.getByRole("button", { name: /delete workspace/i }),
    );
    const cancelButton = await screen.findByRole("button", { name: /cancel/i });
    await user.click(cancelButton);

    expect(deleteMutate).not.toHaveBeenCalled();
  });
});
