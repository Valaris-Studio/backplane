// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useTemplateDraftContext } from "../hooks/TemplateDraftProvider";

/**
 * The detail header's name: static text with a pencil, an input once clicked.
 *
 * Writes through the SHELL's draft store rather than PATCHing itself, so the
 * rename shares the one autosave path and the one `expected_updated_at` lock
 * token every other field uses. A direct PATCH would look identical on screen
 * and quietly overwrite a concurrent editor instead of latching `conflict`.
 *
 * The store's `readOnly` already encodes both gates this needs — a system
 * template is code-defined and has no row to PATCH, and a non-admin may not
 * write — so the affordance is absent rather than present-and-failing.
 */
export function LoopTemplateNameField({ name }: { name: string }) {
  const { t } = useTranslation();
  const { draft, setField, readOnly } = useTemplateDraftContext();
  const [editing, setEditing] = useState(false);

  // The draft is the live value once loaded; `name` is the server row, which
  // is all there is during the first fetch.
  const value = draft?.name ?? name;

  // A template swap (or a reload that discards the draft) must not strand the
  // header in an editor bound to the previous row.
  useEffect(() => {
    if (readOnly) setEditing(false);
  }, [readOnly]);

  if (readOnly) return <>{value}</>;

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={t("loopTemplates.detail.rename.edit")}
        data-testid="loop-template-rename"
        className="group inline-flex items-center gap-1.5 rounded-sm text-left hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {value}
        <Pencil className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
      </button>
    );
  }

  return (
    <Input
      autoFocus
      value={value}
      aria-label={t("loopTemplates.detail.rename.label")}
      data-testid="loop-template-name-input"
      className="h-8 w-56 text-lg font-semibold"
      onChange={(event) => setField("name", event.target.value)}
      onBlur={() => setEditing(false)}
      onKeyDown={(event) => {
        // Enter commits by leaving the field; the debounce owns the save, so
        // there is nothing to submit here. Escape does NOT revert — the store
        // is already the source of truth and a local undo would disagree with
        // the autosave that may have fired mid-typing.
        if (event.key === "Enter" || event.key === "Escape") {
          event.currentTarget.blur();
        }
      }}
    />
  );
}
