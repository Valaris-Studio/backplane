// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";

interface OverflowSectionProps {
  overflow: Record<string, unknown>;
}

function formatKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function OverflowEntry({ label, value }: { label: string; value: unknown }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-border/60 bg-muted/30">
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm font-medium text-foreground/80"
        onClick={() => setOpen(!open)}
      >
        {label}
        <ChevronDown
          className={`h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {open && (
        <pre className="overflow-x-auto border-t border-border/50 px-4 py-3 text-xs text-muted-foreground">
          {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function OverflowSection({ overflow }: OverflowSectionProps) {
  const { t } = useTranslation();
  const entries = Object.entries(overflow);

  if (entries.length === 0) return null;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {t("definitions.hints.overflow")}
      </p>
      <div className="space-y-2">
        {entries.map(([key, value]) => (
          <OverflowEntry key={key} label={formatKey(key)} value={value} />
        ))}
      </div>
    </div>
  );
}
