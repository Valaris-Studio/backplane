// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Clock, Plus, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import {
  useBulkSetDependencies,
  useCardDependencies,
  useRemoveDependency,
} from "../api/use-dependencies";
import { buildCardLink } from "../utils/card-link";
import { resolveApiErrorMessage } from "@/lib/localized-errors";
import { cn } from "@/lib/utils";
import type { Card, CardDependencyRead, Column } from "@/types/kanban";

interface Props {
  card: Card;
  slug: string;
  boardId: string;
  columns: Column[];
}

function isDependencySatisfied(dep: CardDependencyRead): boolean {
  return dep.satisfied !== undefined ? dep.satisfied : dep.depends_on_column_type === "done";
}

export function DependenciesSection({ card, slug, boardId, columns }: Props) {
  const { t, i18n } = useTranslation();
  const { data } = useCardDependencies(slug, boardId, card.id);
  const dependsOn = data?.depends_on ?? [];
  const blocks = data?.blocks ?? [];

  const removeDependency = useRemoveDependency(slug, boardId);
  const [pendingRemoval, setPendingRemoval] =
    useState<CardDependencyRead | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [mutationError, setMutationError] = useState<unknown>(null);
  const mutationErrorMessage =
    mutationError === null
      ? null
      : resolveApiErrorMessage(mutationError, t, i18n);

  function handleRemoveClick(dep: CardDependencyRead) {
    setMutationError(null);
    if (isDependencySatisfied(dep)) {
      setPendingRemoval(dep);
      return;
    }
    doRemove(dep);
  }

  function doRemove(dep: CardDependencyRead) {
    removeDependency.mutate(
      { cardId: card.id, dependsOnCardId: dep.depends_on_card_id },
      {
        onError: (err) => {
          setMutationError(err);
        },
        onSuccess: () => {
          setPendingRemoval(null);
        },
      },
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t("kanban.dependencies.title")}</h3>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setMutationError(null);
            setPickerOpen(true);
          }}
          aria-label={t("kanban.dependencies.manageDependencies")}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {t("kanban.dependencies.addDependency")}
        </Button>
      </div>

      {/* While the picker is open its own alert owns the message; rendering
          it here too would leave a duplicate hidden behind the backdrop. */}
      {mutationErrorMessage && !pickerOpen ? (
        <p role="alert" className="text-xs text-destructive">
          {mutationErrorMessage}
        </p>
      ) : null}

      <DependencyList
        heading={t("kanban.dependencies.dependsOnHeading", {
          count: dependsOn.length,
        })}
        empty={t("kanban.dependencies.emptyDependsOn")}
        items={dependsOn}
        slug={slug}
        boardId={boardId}
        onRemove={handleRemoveClick}
        removable
      />

      <DependencyList
        heading={t("kanban.dependencies.blocksHeading", {
          count: blocks.length,
        })}
        empty={t("kanban.dependencies.emptyBlocks")}
        items={blocks}
        slug={slug}
        boardId={boardId}
        removable={false}
      />

      <DependencyPicker
        open={pickerOpen}
        onOpenChange={(open) => {
          setPickerOpen(open);
          if (!open) setMutationError(null);
        }}
        card={card}
        columns={columns}
        slug={slug}
        boardId={boardId}
        currentDependsOnIds={dependsOn.map((d) => d.depends_on_card_id)}
        onError={setMutationError}
        errorMessage={mutationErrorMessage}
      />

      <RemoveSatisfiedConfirm
        open={pendingRemoval !== null}
        onCancel={() => setPendingRemoval(null)}
        onConfirm={() => pendingRemoval && doRemove(pendingRemoval)}
        pending={removeDependency.isPending}
      />
    </div>
  );
}

function DependencyList({
  heading,
  empty,
  items,
  slug,
  boardId,
  onRemove,
  removable,
}: {
  heading: string;
  empty: string;
  items: CardDependencyRead[];
  slug: string;
  boardId: string;
  onRemove?: (dep: CardDependencyRead) => void;
  removable: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {heading}
      </h4>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((dep) => {
            const targetId = removable ? dep.depends_on_card_id : dep.card_id;
            const satisfied = isDependencySatisfied(dep);
            return (
              <li
                key={`${dep.card_id}->${dep.depends_on_card_id}`}
                className="flex items-center justify-between gap-2 rounded-md border border-border/75 px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  {satisfied ? (
                    <CheckCircle2
                      className="h-3.5 w-3.5 shrink-0 text-[color:var(--color-success)]"
                      aria-label={t("completionPolicy.dependencySatisfied")}
                    />
                  ) : (
                    <Clock
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                      aria-label={t("completionPolicy.dependencyUnsatisfied")}
                    />
                  )}
                  {dep.depends_on_column_type ? (
                    <Badge variant="outline" className="text-[0.6rem]">
                      {dep.depends_on_column_type}
                    </Badge>
                  ) : null}
                  {/* Plain anchor (middle-click/new-tab friendly); a normal
                      left-click is intercepted by CardDetailSheet's card-link
                      capture handler and swaps the sheet in place. */}
                  <a
                    href={buildCardLink({ slug, boardId, cardId: targetId })}
                    className="truncate text-sm text-foreground hover:underline"
                  >
                    {dep.depends_on_title ?? targetId}
                  </a>
                </div>
                {removable && onRemove ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => onRemove(dep)}
                    aria-label={t("kanban.dependencies.removeDependency")}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                ) : (
                  <RichTooltip
                    side="left"
                    summary={t("kanban.dependencies.removeBlockTooltip")}
                  >
                    <span className="text-[0.65rem] text-muted-foreground">
                      ↻
                    </span>
                  </RichTooltip>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function DependencyPicker({
  open,
  onOpenChange,
  card,
  columns,
  slug,
  boardId,
  currentDependsOnIds,
  onError,
  errorMessage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  card: Card;
  columns: Column[];
  slug: string;
  boardId: string;
  currentDependsOnIds: string[];
  onError: (error: unknown) => void;
  errorMessage: string | null;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(currentDependsOnIds),
  );
  const bulkSet = useBulkSetDependencies(slug, boardId);

  // Reset local selection whenever the picker opens against the latest set.
  // The dependency list could change while the picker is closed (WS event,
  // sibling-tab edit) — opening fresh avoids stale selections.
  const candidates = useMemo(() => {
    const all = columns.flatMap((col) =>
      col.cards.map((c) => ({ ...c, columnName: col.name })),
    );
    const lowerQuery = query.trim().toLowerCase();
    return all
      .filter((c) => c.id !== card.id)
      .filter((c) => {
        if (!lowerQuery) return true;
        return c.title.toLowerCase().includes(lowerQuery);
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [columns, card.id, query]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSave() {
    bulkSet.mutate(
      { cardId: card.id, dependsOnCardIds: [...selected] },
      {
        onSuccess: () => {
          onOpenChange(false);
          setQuery("");
        },
        onError,
      },
    );
  }

  function handleOpenChange(next: boolean) {
    if (next) {
      setSelected(new Set(currentDependsOnIds));
      setQuery("");
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("kanban.dependencies.manageDependencies")}</DialogTitle>
          <DialogDescription>
            {t("kanban.dependencies.title")}
          </DialogDescription>
        </DialogHeader>
        <Input
          placeholder={t("kanban.dependencies.pickerSearchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <div className="max-h-72 overflow-y-auto">
          {candidates.length === 0 ? (
            <p className="px-1 py-4 text-sm text-muted-foreground">
              {t("kanban.dependencies.pickerEmpty")}
            </p>
          ) : (
            <ul className="space-y-1">
              {candidates.map((c) => {
                const checked = selected.has(c.id);
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => toggle(c.id)}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 rounded-md border border-transparent px-3 py-2 text-left hover:border-border/75 hover:bg-muted/30",
                        checked && "border-primary/30 bg-primary/5",
                      )}
                      aria-pressed={checked}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <input
                          type="checkbox"
                          readOnly
                          checked={checked}
                          aria-hidden
                          className="h-3.5 w-3.5"
                        />
                        <Badge variant="outline" className="text-[0.6rem]">
                          {c.columnName}
                        </Badge>
                        <span className="truncate text-sm">{c.title}</span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {errorMessage ? (
          <p role="alert" className="text-xs text-destructive">
            {errorMessage}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={bulkSet.isPending}
          >
            {t("kanban.dependencies.pickerCancel")}
          </Button>
          <Button onClick={handleSave} disabled={bulkSet.isPending}>
            {bulkSet.isPending
              ? t("common.saving")
              : t("kanban.dependencies.pickerSave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RemoveSatisfiedConfirm({
  open,
  onCancel,
  onConfirm,
  pending,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onCancel())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("kanban.dependencies.removeDependency")}
          </DialogTitle>
          <DialogDescription>
            {t("kanban.dependencies.confirmRemoveSatisfied")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={pending}
          >
            {pending
              ? t("common.saving")
              : t("kanban.dependencies.removeDependency")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
