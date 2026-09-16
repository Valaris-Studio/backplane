// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { HelpCircle, MoreHorizontal, Pencil, ShieldCheck, Tag, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { RichTooltip, useTooltipContent } from "@/components/ui/rich-tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useWorkspaceConfig } from "@/features/agents/hooks/useWorkspaceConfig";
import type { ColumnType } from "@/types/kanban";
import { resolveDoneGate } from "../utils/done-gate";
import { ColumnSortDropdown } from "./ColumnSortDropdown";
import type { ColumnSortMode } from "../hooks/use-column-sort";

interface Props {
  name: string;
  columnType: ColumnType | null;
  cardCount: number;
  slug: string;
  // Counts coming from the board-level filter bar. When `visibleCount` differs
  // from `totalCount`, the badge renders "visible/total" so users see filters
  // are hiding cards from this column. Both default to `cardCount` if absent
  // (i.e. when the column is rendered outside the filtered context).
  visibleCount?: number;
  totalCount?: number;
  onRename: (name: string) => void;
  onTypeChange: (newType: ColumnType | null) => void;
  onDelete: () => void;
  sortMode: ColumnSortMode;
  onSortChange: (next: ColumnSortMode) => void;
  /** When true, the per-column sort dropdown is disabled — board-level sort wins. */
  sortDisabled?: boolean;
  /**
   * The board's `enforce_done_merge_gate` override, threaded down rather than
   * refetched — BoardView already holds the board detail. `null`/absent
   * inherits the workspace flag (see resolveDoneGate).
   */
  doneGateOverride?: boolean | null;
}

const COLUMN_TYPES: ColumnType[] = [
  "backlog",
  "active",
  "review",
  "done",
  "blocked",
];

// Sentinel used only inside the <Select>; the real value surfaced to callers is `null`.
const NONE_VALUE = "__none__";

function serializeType(value: ColumnType | null): string {
  return value ?? NONE_VALUE;
}

function deserializeType(value: string): ColumnType | null {
  return value === NONE_VALUE ? null : (value as ColumnType);
}

export function ColumnHeader({
  name,
  columnType,
  cardCount,
  slug,
  visibleCount,
  totalCount,
  onRename,
  onTypeChange,
  onDelete,
  sortMode,
  onSortChange,
  sortDisabled = false,
  doneGateOverride,
}: Props) {
  const { t } = useTranslation();
  const warningTooltip = useTooltipContent("columnTypeChangeWarning");
  const { data: workspaceConfig } = useWorkspaceConfig(slug);
  const showDoneGateIndicator =
    columnType === "done" &&
    resolveDoneGate(
      doneGateOverride,
      workspaceConfig?.enforce_done_merge_gate,
    );

  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingType, setEditingType] = useState(false);
  const [nameDraft, setNameDraft] = useState(name);
  const [typeDraft, setTypeDraft] = useState<ColumnType | null>(columnType);

  function handleRenameSubmit() {
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== name) {
      onRename(trimmed);
    }
    setRenaming(false);
  }

  function enterTypeEditor() {
    setTypeDraft(columnType);
    setEditingType(true);
  }

  function cancelTypeEditor() {
    setEditingType(false);
    setTypeDraft(columnType);
  }

  function confirmTypeChange() {
    if (typeDraft !== columnType) {
      onTypeChange(typeDraft);
    }
    setEditingType(false);
  }

  // Document-level Escape cancels the type editor regardless of focus target
  // (Select options unmount on click, leaving focus on document.body — a div-scoped
  // onKeyDown would miss the key event).
  useEffect(() => {
    if (!editingType) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        cancelTypeEditor();
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingType, columnType]);

  function typeLabel(value: ColumnType | null): string {
    return value ? t(`columns.type.${value}`) : t("columns.typeNone");
  }

  if (renaming) {
    return (
      <div className="border-b border-border/70 px-3 py-3">
        <Input
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={handleRenameSubmit}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleRenameSubmit();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          className="h-10 text-sm font-semibold"
        />
      </div>
    );
  }

  if (editingType) {
    const pendingChange =
      typeDraft !== columnType && cardCount > 0;
    return (
      <div
        className="flex flex-col gap-2 border-b border-border/70 bg-card/55 px-3 py-3"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            confirmTypeChange();
          }
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold text-foreground">
            {name}
          </span>
          <RichTooltip i18nKey="kanban.columnType" side="bottom">
            <HelpCircle
              aria-label={t("columns.typeLabel")}
              className="h-4 w-4 text-muted-foreground"
            />
          </RichTooltip>
        </div>
        <Select
          value={serializeType(typeDraft)}
          onValueChange={(raw) => setTypeDraft(deserializeType(raw))}
        >
          <SelectTrigger aria-label={t("columns.typeLabel")} className="h-9 w-full">
            <SelectValue>{typeLabel(typeDraft)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>{t("columns.typeNone")}</SelectItem>
            {COLUMN_TYPES.map((ct) => (
              <SelectItem key={ct} value={ct}>
                {t(`columns.type.${ct}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {pendingChange ? (
          <p
            role="note"
            className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs leading-snug text-muted-foreground"
          >
            {warningTooltip.summary}
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={cancelTypeEditor}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" onClick={confirmTypeChange}>
            {t("common.save")}
          </Button>
        </div>
      </div>
    );
  }

  // Deleting a column cascades to every card in it, permanently and with no
  // activity-log snapshot to restore from — so the count shown must be
  // `totalCount`, the unfiltered truth, never the filtered visible count.
  const destroyedCardCount = totalCount ?? cardCount;

  return (
    <>
    <div
      data-column-header
      // Pinned by structure, not position: the header is a flex sibling ABOVE
      // the column's ScrollArea, so it stays put while cards scroll — provided
      // the board is viewport-bound (see useViewportBoundHeight in
      // BoardLayout). Compact padding reclaims vertical room for cards.
      className="flex items-center justify-between gap-2 border-b border-border/70 bg-card px-3 py-2"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <RichTooltip i18nKey="kanban.columnName" side="bottom">
          <span className="truncate text-sm font-semibold text-foreground">
            {name}
          </span>
        </RichTooltip>
        <RichTooltip i18nKey="kanban.cardCount" side="bottom">
          <Badge variant="outline">
            {visibleCount !== undefined &&
            totalCount !== undefined &&
            visibleCount !== totalCount
              ? `${visibleCount}/${totalCount}`
              : cardCount}
          </Badge>
        </RichTooltip>
        <RichTooltip i18nKey="kanban.columnType" side="bottom">
          <Badge variant="outline" size="sm" aria-label={t("columns.typeLabel")}>
            {typeLabel(columnType)}
          </Badge>
        </RichTooltip>
        {showDoneGateIndicator ? (
          <RichTooltip i18nKey="kanban.doneGateEnforced" side="bottom">
            {/* Icon-only: the text label ("Merge required") wrapped in narrow
                columns and broke the header row height. The tooltip explains
                the gate; the aria-label keeps the badge's accessible name. */}
            <Badge
              data-testid="column-done-gate-indicator"
              variant="outline"
              aria-label={t("columns.doneGateBadge")}
            >
              <ShieldCheck className="h-3 w-3" aria-hidden />
            </Badge>
          </RichTooltip>
        ) : null}
      </div>

      <div className="flex items-center gap-1">
        <ColumnSortDropdown
          value={sortMode}
          onChange={onSortChange}
          disabled={sortDisabled}
        />

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t("a11y.column.more")}
          className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            onClick={() => {
              setNameDraft(name);
              setRenaming(true);
            }}
          >
            <Pencil className="h-4 w-4" />
            {t("common.rename")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={enterTypeEditor}>
            <Tag className="h-4 w-4" />
            {t("columns.editType")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => setConfirmDelete(true)}
            className="text-destructive"
          >
            <Trash2 className="h-4 w-4" />
            {t("common.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      </div>
    </div>

    <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("columns.delete.confirmTitle")}</DialogTitle>
          <DialogDescription>
            {t("columns.delete.confirmBody", {
              name,
              count: destroyedCardCount,
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmDelete(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onDelete();
              setConfirmDelete(false);
            }}
          >
            {t("columns.delete.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
