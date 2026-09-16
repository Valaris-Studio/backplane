// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, describe, expect, it } from "vitest";
import i18n from "@/i18n/config";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test/test-utils";
import { LanguageSwitcher } from "../LanguageSwitcher";

describe("LanguageSwitcher pt-BR support", () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage("en");
    document.documentElement.lang = "en";
  });

  it("offers English, Spanish and Brazilian Portuguese as explicit choices", async () => {
    renderWithProviders(<LanguageSwitcher />);

    const selector = screen.getByRole("combobox", { name: /language/i });
    expect(selector).toHaveValue("en");
    expect(screen.getByRole("option", { name: "EN" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "ES" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "PT-BR" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("selects pt-BR, persists it and updates the document language", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LanguageSwitcher />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: /language/i }),
      "pt-BR",
    );

    await waitFor(() => {
      expect(i18n.language).toBe("pt-BR");
      expect(localStorage.getItem("i18n-lang")).toBe("pt-BR");
      expect(document.documentElement.lang).toBe("pt-BR");
    });
    expect(screen.getByRole("combobox", { name: /idioma/i })).toHaveValue("pt-BR");
  });
});
