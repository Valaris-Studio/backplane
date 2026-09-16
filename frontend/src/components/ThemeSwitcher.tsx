// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MonitorCog, MoonStar, SunMedium } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { buttonVariants } from "@/components/ui/button";
import { useTheme, type ThemeMode } from "@/hooks/use-theme";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

const themeIcons = {
  light: SunMedium,
  dark: MoonStar,
  system: MonitorCog,
} as const;

export function ThemeSwitcher() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const Icon = themeIcons[theme];

  // No wrapping RichTooltip — the icon + label make the affordance obvious,
  // and stacking a hover tooltip over the trigger blocked clicks.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-2")}
      >
        <Icon className="h-4 w-4" />
        {t(`theme.${theme}`)}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-44">
        {(["system", "light", "dark"] as ThemeMode[]).map((value) => {
          const ItemIcon = themeIcons[value];
          return (
            <DropdownMenuItem key={value} onClick={() => setTheme(value)}>
              <ItemIcon className="h-4 w-4" />
              {t(`theme.${value}`)}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
