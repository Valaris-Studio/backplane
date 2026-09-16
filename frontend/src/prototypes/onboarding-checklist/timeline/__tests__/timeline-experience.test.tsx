// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { StrictMode } from "react";
import { describe, expect, it } from "vitest";
import { renderWithProviders, screen, userEvent, waitFor, within } from "@/test/test-utils";
import { INITIAL_STEPS, usePrototypeChecklist } from "../../model";
import { PrototypeLab } from "../../PrototypeLab";
import { TimelineExperience } from "../TimelineExperience";
import { getTimelineLabel } from "../model";

function Harness() {
  const state = usePrototypeChecklist();
  return <TimelineExperience {...state} />;
}

function stepButton(label: string): HTMLButtonElement {
  const text = screen.getByText(label);
  const button = text.closest("button");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`No button found for timeline step ${label}`);
  }
  return button;
}

describe("timeline onboarding prototype", () => {
  it("renders only the selected essential direction", () => {
    window.history.replaceState(null, "", "/prototypes/onboarding-checklist/");
    renderWithProviders(<PrototypeLab />);

    expect(screen.getByText("Experimento · Rail esencial")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Prototype variants" })).not.toBeInTheDocument();
  });

  it("keeps the essential direction to one six-node line with short labels", () => {
    const { container } = renderWithProviders(<Harness />);

    const list = screen.getByRole("list", { name: /configuración|pasos/i });
    expect(within(list).getAllByRole("listitem")).toHaveLength(6);
    for (const step of INITIAL_STEPS) {
      expect(stepButton(getTimelineLabel(step.id))).toBeEnabled();
      expect(screen.queryByText(step.hint)).not.toBeInTheDocument();
    }

    expect(container.querySelector("input, textarea, select")).toBeNull();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the existing-style detail and form from every node", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    const expectations = [
      ["Tablero", "Lleva el control", "Título de tarjeta"],
      ["Definición", "Cuéntale a Backplane", "Objetivo principal"],
      ["Notas", "Guarda lo que sabes", "Título de la nota"],
      ["Equipo", "Trae a tu equipo", "Correo del miembro 1"],
      ["Canal", "Dale un lugar", "Nombre del canal"],
      ["Git", "Conecta el código", "URL del repositorio"],
    ] as const;

    for (const [label, title, field] of expectations) {
      await user.click(stepButton(label));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(new RegExp(title))).toBeInTheDocument();
      expect(within(dialog).getAllByLabelText(field).length).toBeGreaterThan(0);
      expect(dialog.querySelector("[data-step-illustration]")).not.toBeNull();
      if (label === "Tablero") {
        expect(within(dialog).queryByRole("button", { name: "Retomar" })).not.toBeInTheDocument();
      }
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    }
  });

  it("completes the pending channel from its modal and advances the shared progress", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    expect(screen.getByText("5 de 6")).toBeInTheDocument();
    await user.click(stepButton("Canal"));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByDisplayValue("general")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Crear canal" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("6 de 6")).toBeInTheDocument();
  });

  it("keeps skip and revisit behavior inside the modal instead of the main timeline", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    await user.click(stepButton("Canal"));
    let dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Omitir por ahora" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("6 de 6")).toBeInTheDocument();

    await user.click(stepButton("Canal"));
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Omitido")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Retomar" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("5 de 6")).toBeInTheDocument();
  });

  it("moves focus into the modal, traps Tab and restores the triggering node", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    const trigger = stepButton("Canal");

    await user.click(trigger);
    const dialog = await screen.findByRole("dialog");
    const channelInput = within(dialog).getByDisplayValue("general");
    await waitFor(() => expect(channelInput).toHaveFocus());

    await user.tab({ shift: true });
    expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus();
    await user.tab();
    expect(channelInput).toHaveFocus();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  // Baseline pinned before the dialog's duplicate in-component trap was deleted,
  // so the removal is proven behaviour-preserving rather than assumed.
  //
  // Only the BACKWARD wrap actually exercises the trap. Close renders last in the
  // DOM, so a forward Tab off it returns to the input via jsdom's own document
  // order even with every trap disabled — a forward-wrap assertion here passes
  // vacuously. Shift-Tab off the first element is the one that needs the trap.
  it("wraps Tab backward from the first element to the last", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );

    await user.click(stepButton("Canal"));
    const dialog = await screen.findByRole("dialog");
    const channelInput = within(dialog).getByDisplayValue("general");
    await waitFor(() => expect(channelInput).toHaveFocus());

    // The cycle is input -> "Omitir por ahora" -> "Crear canal" -> Close.
    const close = within(dialog).getByRole("button", { name: "Close" });

    // Backward off the first element wraps to the last.
    await user.tab({ shift: true });
    expect(close).toHaveFocus();

    // And the cycle continues from there rather than escaping the dialog.
    await user.tab();
    expect(channelInput).toHaveFocus();
  });

  // The deferred initial-focus used to fire unconditionally ~50ms after open,
  // yanking focus back from wherever the user had already tabbed to. Under
  // full-suite load a single `user.tab()` outlasts that delay, which is what
  // made the trap assertion above flake.
  it("does not steal focus back once the user has moved it inside the modal", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );

    await user.click(stepButton("Canal"));
    const dialog = await screen.findByRole("dialog");
    const channelInput = within(dialog).getByDisplayValue("general");
    await waitFor(() => expect(channelInput).toHaveFocus());

    await user.tab({ shift: true });
    const close = within(dialog).getByRole("button", { name: "Close" });
    expect(close).toHaveFocus();

    // Outlast the deferred initial-focus timer; focus must stay where the user put it.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(close).toHaveFocus();
  });

  it("removes the progress animation when the user requests reduced motion", () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;

    try {
      const { container, unmount } = renderWithProviders(<Harness />);
      const fill = container.querySelector<HTMLElement>("[data-timeline-progress-fill]");
      expect(fill?.style.transitionDuration).toBe("0ms");
      unmount();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("gives the essential rail a subtle dotted progress indicator", () => {
    const { container } = renderWithProviders(<Harness />);
    const progressbar = screen.getByRole("progressbar", {
      name: "Avance general de configuración",
    });
    const fill = container.querySelector<HTMLElement>("[data-timeline-progress-fill]");
    const clippedPercent = fill?.style.clipPath.match(/^inset\(0 ([\d.]+)% 0 0\)$/)?.[1];

    expect(progressbar).toHaveAttribute("data-timeline-essential-progress");
    expect(progressbar).toHaveAttribute("aria-valuenow", "83");
    expect(progressbar.querySelectorAll(".border-dotted")).toHaveLength(2);
    expect(Number(clippedPercent)).toBeCloseTo(100 / 6);
  });
});
