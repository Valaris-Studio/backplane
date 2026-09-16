// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CSSProperties } from "react";
import { Toaster } from "sonner";
import { useTheme } from "@/hooks/use-theme";

// Sonner's default-styled toasts read these custom properties for every toast
// type (richColors stays off — its hardcoded palette would bypass our tokens).
// Redefining them here, and per-type via classNames below, is the supported
// theming hook and avoids specificity fights with sonner's own stylesheet.
const toasterTokenVars = {
  "--normal-bg": "var(--color-popover)",
  "--normal-text": "var(--color-popover-foreground)",
  "--normal-border": "var(--color-border)",
  "--border-radius": "var(--radius-lg)",
} as CSSProperties;

export function ThemedToaster() {
  const { resolvedTheme } = useTheme();

  return (
    <Toaster
      theme={resolvedTheme}
      position="bottom-right"
      closeButton
      style={toasterTokenVars}
      toastOptions={{
        // Sonner hardcodes its toast box-shadow in CSS with attribute-selector
        // specificity; inline style is the only reliable override.
        style: { boxShadow: "var(--shadow-panel)" },
        classNames: {
          toast:
            "bg-popover text-popover-foreground border-border rounded-[var(--radius-lg)]",
          description: "text-muted-foreground",
          success:
            "[--normal-bg:color-mix(in_oklab,var(--color-success)_14%,var(--color-popover))] [--normal-border:color-mix(in_oklab,var(--color-success)_40%,var(--color-border))]",
          error:
            "[--normal-bg:color-mix(in_oklab,var(--color-destructive)_14%,var(--color-popover))] [--normal-border:color-mix(in_oklab,var(--color-destructive)_40%,var(--color-border))]",
        },
      }}
    />
  );
}
