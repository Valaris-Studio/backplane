// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen } from "@/test/test-utils";
import i18n from "@/i18n/config";
import { RoleCombobox } from "../RoleCombobox";

// Audit r2 finding 2 (card 5d1d82b7): options render localized labels
// (reviewer → "Revisor" in es) but matching ran against the raw slug only, so
// typing the label the UI itself shows fell into the create-custom path and
// minted a junk literal role. The combobox must match slug AND localized label.

function Harness({ onAdd = () => {} }: { onAdd?: (role: string) => void }) {
  const [roles, setRoles] = useState<string[]>([]);
  return (
    <RoleCombobox
      suggestions={["reviewer", "implementer"]}
      selectedRoles={roles}
      onAdd={(role) => {
        onAdd(role);
        setRoles((prev) => [...prev, role]);
      }}
      onRemove={(role) => setRoles((prev) => prev.filter((r) => r !== role))}
    />
  );
}

function typeQuery(value: string) {
  const input = screen.getByRole("combobox");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
}

describe("RoleCombobox localized matching (es)", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("es");
  });
  afterAll(async () => {
    await i18n.changeLanguage("en");
  });

  it('typing the localized label ("Revisor") surfaces the existing suggestion, not the create-custom option', () => {
    renderWithProviders(<Harness />);
    typeQuery("Revisor");

    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toContain("Revisor");
    expect(screen.queryByText(/Usar personalizado/)).not.toBeInTheDocument();
  });

  it("matches a case-insensitive partial found only in the localized label", () => {
    // "visor" appears in the es label "Revisor" but not in the slug "reviewer".
    renderWithProviders(<Harness />);
    typeQuery("visor");

    expect(
      screen.getAllByRole("option").map((o) => o.textContent),
    ).toContain("Revisor");
  });

  it("selecting the label-matched option commits the slug, not the label", () => {
    const onAdd = vi.fn();
    renderWithProviders(<Harness onAdd={onAdd} />);
    typeQuery("Revisor");

    const option = screen
      .getAllByRole("option")
      .find((o) => o.textContent === "Revisor")!;
    fireEvent.mouseDown(option);

    expect(onAdd).toHaveBeenCalledWith("reviewer");
  });

  it("a genuinely novel name still offers the create-custom option", () => {
    renderWithProviders(<Harness />);
    typeQuery("Tester");

    expect(screen.getByText(/Usar personalizado: Tester/)).toBeInTheDocument();
  });
});
