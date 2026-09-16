// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useId, useMemo, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface RoleComboboxProps {
  suggestions: string[];
  selectedRoles: string[];
  onAdd: (role: string) => void;
  onRemove: (role: string) => void;
}

// Tag-input for runner roles: pipeline-role suggestions plus free-text custom
// roles, rendered as dismissible chips. Shared by AddTeamMemberDialog and
// RunnerRoleBindingCard so the role-editing interaction stays identical.
export function RoleCombobox({
  suggestions,
  selectedRoles,
  onAdd,
  onRemove,
}: RoleComboboxProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const normalizedQuery = query.trim();
  const available = useMemo(
    () => suggestions.filter((role) => !selectedRoles.includes(role)),
    [suggestions, selectedRoles],
  );
  // Options render localized labels (reviewer → "Revisor"), so matching must
  // cover slug AND label — a slug-only match sends the label the UI itself
  // shows into the create-custom path, minting a junk literal role.
  const roleLabel = useCallback(
    (role: string) =>
      t(`teams.roles.${role}`, { defaultValue: role }).toLowerCase(),
    [t],
  );
  const filtered = useMemo(() => {
    if (!normalizedQuery) return available;
    const q = normalizedQuery.toLowerCase();
    return available.filter(
      (role) => role.toLowerCase().includes(q) || roleLabel(role).includes(q),
    );
  }, [available, normalizedQuery, roleLabel]);

  const showCustomOption =
    normalizedQuery.length > 0 &&
    !available.some(
      (role) =>
        role.toLowerCase() === normalizedQuery.toLowerCase() ||
        roleLabel(role) === normalizedQuery.toLowerCase(),
    );

  // Anchor the portaled listbox to the input's viewport rect while open.
  // Capture-phase window listeners catch the dialog's *nested* scroll (scroll
  // doesn't bubble, but capture from window reaches it) so the list re-anchors
  // when DialogContent scrolls, not just the page.
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!open) return;
    const updateRect = () => {
      const el = inputRef.current;
      if (el) setAnchorRect(el.getBoundingClientRect());
    };
    updateRect();
    window.addEventListener("scroll", updateRect, true);
    window.addEventListener("resize", updateRect, true);
    return () => {
      window.removeEventListener("scroll", updateRect, true);
      window.removeEventListener("resize", updateRect, true);
    };
  }, [open]);

  const commit = (role: string) => {
    onAdd(role);
    setQuery("");
    // Stay open after a pick: multi-role binding is the common path, and the
    // committed role drops out of `available`, so the list re-renders with the
    // remaining suggestions (and unmounts itself once none are left). The
    // occlusion concern that once closed this on select is handled by the
    // existing escape hatches — Escape, blur, or clicking anywhere else all
    // dismiss the list before the covered footer takes a click.
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[0]) {
        commit(filtered[0]);
      } else if (normalizedQuery) {
        commit(normalizedQuery);
      }
    } else if (e.key === "Backspace" && !query && selectedRoles.length > 0) {
      // Tag-input convention: backspace on empty input pops the last chip.
      onRemove(selectedRoles[selectedRoles.length - 1]!);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="space-y-2">
      {selectedRoles.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedRoles.map((role) => (
            <span
              key={role}
              className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-xs font-medium text-foreground max-w-[16rem]"
            >
              <span className="truncate">
                {t(`teams.roles.${role}`, { defaultValue: role })}
              </span>
              <button
                type="button"
                onClick={() => onRemove(role)}
                aria-label={t("teams.removeRoleChip", { role })}
                className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <Input
          id="role-combobox"
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-label={t("teams.addMember.roleComboboxLabel")}
          placeholder={t("teams.addMember.roleComboboxPlaceholder")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Delay so option clicks register before the list unmounts.
            setTimeout(() => setOpen(false), 120);
          }}
          onKeyDown={handleKeyDown}
        />
        {/* Portal to <body>: every embedding surface puts this combobox inside
            DialogContent (overflow-y-auto), which clips an inline absolute list
            at the dialog edge. Same reasoning as MentionPicker: a transformed
            ancestor would re-root `position: fixed`, so hoist out of the dialog
            entirely; z-60 sits above the dialog overlay's z-50. */}
        {open &&
          (filtered.length > 0 || showCustomOption) &&
          createPortal(
            <div
              style={
                anchorRect
                  ? {
                      position: "fixed",
                      left: anchorRect.left,
                      top: anchorRect.bottom + 4,
                      width: anchorRect.width,
                      zIndex: 60,
                    }
                  : { display: "none" }
              }
            >
              <ul
                id={listboxId}
                role="listbox"
                className={cn(
                  "max-h-56 overflow-y-auto",
                  "rounded-[var(--radius-md)] border border-border/70 bg-popover shadow-soft",
                  "py-1 text-sm",
                )}
              >
                {filtered.map((role) => (
                  <li
                    key={role}
                    role="option"
                    aria-selected={false}
                    tabIndex={-1}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      commit(role);
                    }}
                    className="cursor-pointer px-3 py-1.5 hover:bg-accent hover:text-accent-foreground"
                  >
                    {t(`teams.roles.${role}`, { defaultValue: role })}
                  </li>
                ))}
                {showCustomOption && (
                  <li
                    role="option"
                    aria-selected={false}
                    tabIndex={-1}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      commit(normalizedQuery);
                    }}
                    className="cursor-pointer border-t border-border/50 px-3 py-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  >
                    {t("teams.addMember.useCustomRole", { role: normalizedQuery })}
                  </li>
                )}
              </ul>
            </div>,
            document.body,
          )}
      </div>
    </div>
  );
}
