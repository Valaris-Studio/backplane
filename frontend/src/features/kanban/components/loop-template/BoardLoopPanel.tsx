// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useBoardLoop,
  type BoardLoopConfig,
} from "@/features/kanban/api/use-board-loop";
import { UnsavedChangesPrompt } from "@/components/ui/unsaved-changes-prompt";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import type { Board } from "@/types/kanban";
import {
  ENUM_RAIL_NAMES,
  NUMERIC_RAILS,
} from "@/features/loop-templates/lib/rails-catalog";
import { BoardLoopDialog } from "../BoardLoopDialog";
import { TemplateChooser } from "./TemplateChooser";
import { TemplateBindStep } from "./TemplateBindStep";
import { TemplateBoundView } from "./TemplateBoundView";
import { SaveAsTemplateSheet } from "./SaveAsTemplateSheet";

/**
 * The board's rail values, as a template's `rails_defaults` bag.
 *
 * Derived from the rails CATALOG rather than a hand-listed set of keys, so a
 * rail added to the manager cannot silently stop being carried over here.
 */
function railsFromConfig(config: BoardLoopConfig): Record<string, unknown> {
  const names = [...NUMERIC_RAILS, ...ENUM_RAIL_NAMES] as readonly string[];
  return Object.fromEntries(
    names
      .map((name) => [
        name,
        (config as unknown as Record<string, unknown>)[name],
      ])
      .filter(([, value]) => value !== undefined && value !== null),
  );
}

interface Props {
  board: Board;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** What the panel is showing. `raw` delegates wholesale to the existing dialog. */
type PanelState = "raw" | "choose" | "bind" | "bound";

interface Picked {
  ref: string;
  source: "system" | "workspace";
}

/**
 * The loop panel's state machine.
 *
 * It WRAPS BoardLoopDialog rather than growing it: a board with no template
 * binding renders exactly the dialog that shipped, and the template flows
 * (choose → bind → bound) live in their own views. The resolved state comes
 * from GET /loop, so the answer to "is this board template-bound?" has exactly
 * one source of truth.
 */
export function BoardLoopPanel({ board, open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const { slug = "" } = useParams();
  const loopQuery = useBoardLoop(slug, board.id, board.loop_configured);

  // An operator override of the resolved state — "apply a template" from raw,
  // "start from scratch" from choose, "change template" from bound. Null means
  // "whatever the server says", so a save or a WS refresh re-resolves naturally.
  const [override, setOverride] = useState<PanelState | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [savingAs, setSavingAs] = useState(false);
  // The Bind step owns the typing; it has always reported through
  // `onDirtyChange` and nothing ever listened.
  const [bindDirty, setBindDirty] = useState(false);
  // Same signal from the bound view's guardrails editor.
  const [railsDirty, setRailsDirty] = useState(false);

  const config = loopQuery.data;
  const bound = config?.template ?? null;

  // A board that has never been configured (404 → null config) has nothing to
  // edit raw, so the chooser is the honest first screen. A configured board
  // with no binding is raw.
  const resolved: PanelState = bound
    ? "bound"
    : config
      ? "raw"
      : loopQuery.isLoading
        ? "raw"
        : "choose";

  const state: PanelState = override ?? resolved;

  const close = () => {
    setOverride(null);
    setPicked(null);
    setSavingAs(false);
    setBindDirty(false);
    setRailsDirty(false);
    onOpenChange(false);
  };

  const guard = useUnsavedChangesGuard({
    isDirty: bindDirty || railsDirty,
    onClose: close,
    // The Bind step's own Save button is the only path that can validate the
    // required slots and report the failure, so the prompt withholds Save
    // rather than firing a save it cannot report on.
    onSave: () => {},
    canSave: false,
  });

  if (state === "raw") {
    return (
      <>
        <BoardLoopDialog
          board={board}
          open={open}
          onOpenChange={onOpenChange}
          onApplyTemplate={() => setOverride("choose")}
          onSaveAsTemplate={config ? () => setSavingAs(true) : undefined}
        />
        {savingAs && config && (
          <SaveAsTemplateSheet
            slug={slug}
            open
            onOpenChange={(next) => !next && setSavingAs(false)}
            systemPrompt={config.system_prompt}
            loopPrompt={config.loop_prompt}
            tools={config.tools}
            rails={railsFromConfig(config)}
            onBindNow={(ref) => {
              // The board is still raw: Save-as never bound it. This is the
              // explicit second act, so it goes through the same Bind step a
              // chooser pick would.
              setSavingAs(false);
              setPicked({ ref, source: "workspace" });
              setOverride("bind");
            }}
          />
        )}
      </>
    );
  }

  return (
    <>
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Escape, overlay click and the X all arrive here, so wrapping this one
        // prop covers every close affordance.
        if (!next) guard.requestClose();
        else onOpenChange(true);
      }}
    >
      {/* Same resize contract AND stored width as BoardLoopDialog: the raw
          editor and the template flows are one loop-config surface to the
          operator, so they must open at the same width. */}
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
        resizable
        resizeStorageKey="board-loop"
        defaultWidth={896}
        minWidth={672}
        maxWidth={1400}
        resizeHandleLabel={t("boardLoop.resizeHandle")}
      >
        <DialogHeader>
          <DialogTitle>{t("boardLoop.title")}</DialogTitle>
          <DialogDescription>
            {t("boardLoop.templates.subtitle")}
          </DialogDescription>
        </DialogHeader>

        {state === "choose" ? (
          <TemplateChooser
            slug={slug}
            onPick={(template) => {
              setPicked({ ref: template.id, source: template.source });
              setOverride("bind");
            }}
            onStartRaw={() => setOverride("raw")}
          />
        ) : null}

        {state === "bind" && picked ? (
          <TemplateBindStep
            slug={slug}
            boardUuid={board.id}
            templateRef={picked.ref}
            source={picked.source}
            expectedVersion={config?.version}
            onBound={() => {
              setPicked(null);
              // Back to the server's answer: the save just made it `bound`.
              setOverride(null);
            }}
            onCancel={() => setOverride("choose")}
            onDirtyChange={setBindDirty}
          />
        ) : null}

        {state === "bound" && config && bound ? (
          <TemplateBoundView
            slug={slug}
            boardUuid={board.id}
            template={bound}
            config={config}
            expectedVersion={config.version}
            onDetached={() => setOverride(null)}
            onChangeTemplate={() => setOverride("choose")}
            onDirtyChange={setRailsDirty}
          />
        ) : null}
      </DialogContent>
    </Dialog>
    <UnsavedChangesPrompt
      open={guard.guardOpen}
      canSave={guard.canSave}
      onSave={guard.saveAndClose}
      onDiscard={guard.closeAnyway}
      onKeepEditing={guard.dismissGuard}
    />
    </>
  );
}
