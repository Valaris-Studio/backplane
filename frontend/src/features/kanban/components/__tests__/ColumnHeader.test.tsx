// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import ptBr from "@/i18n/locales/pt-BR.json";
import { ColumnHeader } from "../ColumnHeader";

const SLUG = "acme";
const CONFIG_URL = `/api/workspaces/${SLUG}/config`;

// Matches WorkspaceConfig — only enforce_done_merge_gate is exercised here;
// the rest are contract-required fields the schema always returns.
function makeWorkspaceConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    max_rework_attempts: 3,
    card_cooldown_hours: 1,
    commit_message_template: "",
    pr_description_template: "",
    pipeline_config: null,
    version: 1,
    enforce_done_merge_gate: true,
    ...overrides,
  };
}

function mockConfig(enforceDoneMergeGate: boolean) {
  server.use(
    http.get(CONFIG_URL, () =>
      HttpResponse.json(
        makeWorkspaceConfig({ enforce_done_merge_gate: enforceDoneMergeGate }),
      ),
    ),
  );
}

function setup(overrides: Partial<React.ComponentProps<typeof ColumnHeader>> = {}) {
  const props = {
    name: "To Do",
    columnType: "backlog" as const,
    cardCount: 0,
    slug: SLUG,
    onRename: vi.fn(),
    onTypeChange: vi.fn(),
    onDelete: vi.fn(),
    sortMode: "position" as const,
    onSortChange: vi.fn(),
    ...overrides,
  };
  return { props, ...renderWithProviders(<ColumnHeader {...props} />) };
}

// Reaches into the raw locale JSON by dot path — same idiom as parity checks
// elsewhere; avoids depending on i18next initialization order in this file.
function getIn(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as object)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

async function openEditor(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /column actions/i }));
  await user.click(screen.getByRole("menuitem", { name: /change column type/i }));
}

describe("ColumnHeader — type badge", () => {
  it("renders the column type badge with the translated label", () => {
    setup({ columnType: "backlog" });
    expect(screen.getByText("Backlog")).toBeInTheDocument();
  });

  it("renders None when columnType is null", () => {
    setup({ columnType: null });
    expect(screen.getByText("None")).toBeInTheDocument();
  });

  it("dropdown trigger exposes an accessible name", () => {
    setup({ columnType: "backlog" });
    expect(
      screen.getByRole("button", { name: /column actions/i }),
    ).toBeInTheDocument();
  });
});

describe("ColumnHeader — type editor", () => {
  it("opens the type editor via the dropdown menu", async () => {
    const user = userEvent.setup();
    setup({ columnType: "backlog" });
    expect(screen.queryByRole("option", { name: "Backlog" })).not.toBeInTheDocument();

    await openEditor(user);
    // The trigger button for the select is now visible.
    // Click the select trigger to open its content and reveal options.
    const triggers = screen.getAllByRole("button");
    const selectTrigger = triggers.find((el) =>
      el.getAttribute("aria-expanded") !== null && el.textContent?.includes("Backlog"),
    );
    expect(selectTrigger).toBeDefined();
    await user.click(selectTrigger!);
    expect(screen.getByRole("option", { name: "Review" })).toBeInTheDocument();
  });

  it("calls onTypeChange when the user picks a new value", async () => {
    const user = userEvent.setup();
    const { props } = setup({ columnType: "backlog" });

    await openEditor(user);
    const selectTrigger = screen.getAllByRole("button").find((el) =>
      el.getAttribute("aria-expanded") !== null && el.textContent?.includes("Backlog"),
    )!;
    await user.click(selectTrigger);
    await user.click(screen.getByRole("option", { name: "Review" }));
    // Confirm via Save button.
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(props.onTypeChange).toHaveBeenCalledWith("review");
  });

  it("shows the change-warning tooltip content when cardCount > 0 and type differs", async () => {
    const user = userEvent.setup();
    setup({ columnType: "backlog", cardCount: 3 });

    await openEditor(user);
    const selectTrigger = screen.getAllByRole("button").find((el) =>
      el.getAttribute("aria-expanded") !== null && el.textContent?.includes("Backlog"),
    )!;
    await user.click(selectTrigger);
    await user.click(screen.getByRole("option", { name: "Review" }));

    expect(
      screen.getByText(/may strand those cards/i),
    ).toBeInTheDocument();
  });

  it("does not show the warning when cardCount is 0", async () => {
    const user = userEvent.setup();
    setup({ columnType: "backlog", cardCount: 0 });

    await openEditor(user);
    const selectTrigger = screen.getAllByRole("button").find((el) =>
      el.getAttribute("aria-expanded") !== null && el.textContent?.includes("Backlog"),
    )!;
    await user.click(selectTrigger);
    await user.click(screen.getByRole("option", { name: "Review" }));

    expect(
      screen.queryByText(/may strand those cards/i),
    ).not.toBeInTheDocument();
  });

  it("closes the editor on Escape and restores the original type", async () => {
    const user = userEvent.setup();
    const { props } = setup({ columnType: "backlog" });

    await openEditor(user);
    const selectTrigger = screen.getAllByRole("button").find((el) =>
      el.getAttribute("aria-expanded") !== null && el.textContent?.includes("Backlog"),
    )!;
    await user.click(selectTrigger);
    await user.click(screen.getByRole("option", { name: "Review" }));

    await user.keyboard("{Escape}");

    expect(props.onTypeChange).not.toHaveBeenCalled();
    // Non-editor view restored: the badge is visible again.
    expect(screen.getByText("Backlog")).toBeInTheDocument();
  });
});

// Locked design: the done-gate indicator is driven ENTIRELY by the backend's
// enforce_done_merge_gate flag (GET /workspaces/{slug}/config) — no
// hardcoded frontend policy — and only ever appears on the done column type.
describe("ColumnHeader — done gate indicator", () => {
  it("shows the gate indicator on a done column when the backend enforces the gate", async () => {
    mockConfig(true);
    setup({ columnType: "done" });

    expect(
      await screen.findByTestId("column-done-gate-indicator"),
    ).toBeInTheDocument();
  });

  it("hides the gate indicator on a done column when the backend does not enforce the gate", async () => {
    mockConfig(false);
    setup({ columnType: "done" });

    // Give the query a tick to resolve, then assert absence — not just "not
    // yet rendered".
    await waitFor(() => {
      expect(screen.queryByTestId("column-done-gate-indicator")).not.toBeInTheDocument();
    });
  });

  it("never shows the gate indicator on a non-done column, even when the gate is enforced", async () => {
    mockConfig(true);
    setup({ columnType: "backlog" });

    await waitFor(() => {
      expect(screen.queryByTestId("column-done-gate-indicator")).not.toBeInTheDocument();
    });
  });

  it("shows no indicator while the workspace config is still loading (no flash, no crash)", () => {
    server.use(
      http.get(CONFIG_URL, () => new Promise(() => {})), // never resolves
    );
    expect(() => setup({ columnType: "done" })).not.toThrow();

    expect(screen.queryByTestId("column-done-gate-indicator")).not.toBeInTheDocument();
  });

  it("shows no indicator when the workspace config request errors (no crash)", async () => {
    server.use(http.get(CONFIG_URL, () => HttpResponse.json({ detail: "boom" }, { status: 500 })));
    expect(() => setup({ columnType: "done" })).not.toThrow();

    await waitFor(() => {
      expect(screen.queryByTestId("column-done-gate-indicator")).not.toBeInTheDocument();
    });
  });

  it("is icon-only: no visible label text, meaning carried by aria-label + tooltip", async () => {
    // The two-word label ("Merge required") wrapped inside narrow columns and
    // broke the header row height — the glyph + tooltip carry the meaning now.
    mockConfig(true);
    setup({ columnType: "done" });

    const indicator = await screen.findByTestId("column-done-gate-indicator");
    expect(indicator).not.toHaveTextContent(/\S/);
    expect(indicator).toHaveAttribute("aria-label", en.columns.doneGateBadge);
  });

  it("exposes a RichTooltip explaining the gate, reusing the existing tooltip idiom", async () => {
    mockConfig(true);
    setup({ columnType: "done" });

    const indicator = await screen.findByTestId("column-done-gate-indicator");
    // RichTooltip's trigger idiom: role="button" wrapping the visible content,
    // with aria-describedby wiring the (portal-rendered) tooltip/panel node.
    const trigger = indicator.closest("[role='button']") ?? indicator;
    expect(trigger).toHaveAttribute("aria-describedby");
  });
});

describe("ColumnHeader — done gate i18n parity", () => {
  // The gate badge/tooltip strings the implementer introduces. Pinning the
  // exact keys here means a missing translation fails this test instead of
  // silently shipping fallback copy to users.
  const NEW_KEYS = ["ui.tooltips.kanban.doneGateEnforced.summary"];

  it.each(NEW_KEYS)("%s exists in every locale catalog", (path) => {
    expect(getIn(en, path), `en.json missing "${path}"`).toEqual(
      expect.any(String),
    );
    expect(getIn(es, path), `es.json missing "${path}"`).toEqual(
      expect.any(String),
    );
    expect(getIn(ptBr, path), `pt-BR.json missing "${path}"`).toEqual(
      expect.any(String),
    );
  });
});
