// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach } from "vitest";
import { toast } from "sonner";
import { act, renderWithProviders, screen } from "@/test/test-utils";
import { ThemedToaster } from "@/components/ThemedToaster";

describe("ThemedToaster", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("passes the resolved dark theme through to sonner", async () => {
    localStorage.setItem("valaris-theme", "dark");
    renderWithProviders(<ThemedToaster />);

    act(() => {
      toast("dark mode toast");
    });
    await screen.findByText("dark mode toast");

    const toaster = document.querySelector("[data-sonner-toaster]");
    expect(toaster).not.toBeNull();
    // sonner v2 exposes the resolved theme as data-sonner-theme
    expect(toaster?.getAttribute("data-sonner-theme")).toBe("dark");
  });

  it("styles toasts with popover tokens and renders a close button", async () => {
    localStorage.setItem("valaris-theme", "light");
    renderWithProviders(<ThemedToaster />);

    act(() => {
      toast("token styled toast");
    });
    await screen.findByText("token styled toast");

    // Surface tokens flow through sonner's --normal-* CSS-variable hooks set
    // on the toaster element (the supported theming path for styled toasts).
    const toaster = document.querySelector(
      "[data-sonner-toaster]",
    ) as HTMLElement;
    expect(toaster.style.getPropertyValue("--normal-bg")).toBe(
      "var(--color-popover)",
    );
    expect(toaster.style.getPropertyValue("--normal-text")).toBe(
      "var(--color-popover-foreground)",
    );
    expect(toaster.style.getPropertyValue("--normal-border")).toBe(
      "var(--color-border)",
    );
    expect(toaster.style.getPropertyValue("--border-radius")).toBe(
      "var(--radius-lg)",
    );

    const toastEl = document.querySelector(
      "[data-sonner-toast]",
    ) as HTMLElement;
    expect(toastEl.style.boxShadow).toBe("var(--shadow-panel)");
    expect(toastEl.querySelector("[data-close-button]")).not.toBeNull();
  });

  it("tints success and error toasts via token mixes, not sonner richColors", async () => {
    renderWithProviders(<ThemedToaster />);

    act(() => {
      toast.success("all good");
      toast.error("it broke");
    });
    await screen.findByText("all good");
    await screen.findByText("it broke");

    const successEl = document.querySelector('[data-sonner-toast][data-type="success"]');
    const errorEl = document.querySelector('[data-sonner-toast][data-type="error"]');
    expect(successEl?.className).toContain("var(--color-success)");
    expect(errorEl?.className).toContain("var(--color-destructive)");
    // richColors would swap in sonner's hardcoded palette, bypassing tokens.
    expect(successEl?.getAttribute("data-rich-colors")).not.toBe("true");
  });
});
