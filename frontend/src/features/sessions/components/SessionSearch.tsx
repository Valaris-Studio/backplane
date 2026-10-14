// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { MAX_QUERY_LENGTH } from "../hooks/use-session-filters";

const SEARCH_DEBOUNCE_MS = 300;

interface SessionSearchProps {
  value: string;
  onChange: (q: string) => void;
}

// Server-side search over titles, repositories, branches and board names.
// `/` focuses it from anywhere on the page; Escape clears it.
export function SessionSearch({ value, onChange }: SessionSearchProps) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value);
  const debounced = useDebouncedValue(draft, SEARCH_DEBOUNCE_MS);

  // A back/forward or "Clear filters" changes the URL under the input.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (debounced.trim() !== value) onChange(debounced.trim());
    // Only the debounced draft drives the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  useEffect(() => {
    function focusOnSlash(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      input.current?.focus();
    }
    document.addEventListener("keydown", focusOnSlash);
    return () => document.removeEventListener("keydown", focusOnSlash);
  }, []);

  return (
    <label className="relative flex h-9 w-full min-w-0 items-center sm:w-[19rem]">
      <Search aria-hidden className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" />
      <input
        ref={input}
        type="search"
        aria-label={t("sessions.filters.search")}
        placeholder={t("sessions.filters.searchPlaceholder")}
        value={draft}
        maxLength={MAX_QUERY_LENGTH}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !draft) return;
          event.preventDefault();
          setDraft("");
          onChange("");
        }}
        className="h-9 w-full rounded-[var(--radius-cap)] border border-border bg-card pl-8 pr-8 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:hidden"
      />
      {draft ? null : (
        <kbd
          aria-hidden
          className="pointer-events-none absolute right-2 rounded-[var(--radius-cap)] border border-border px-1.5 text-[0.72rem] font-semibold text-muted-foreground"
        >
          /
        </kbd>
      )}
    </label>
  );
}
