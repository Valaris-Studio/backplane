// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useLoopTemplateList } from "@/features/loop-templates/hooks/useLoopTemplateList";
import type { LoopTemplateSummary } from "@/features/loop-templates/api/loop-templates";

interface Props {
  slug: string;
  onPick: (template: LoopTemplateSummary) => void;
  onStartRaw: () => void;
}

/** The first line of `when_to_use` — the chooser card has room for a hint, not
 * a manual, and the author's opening sentence is the hint. */
function firstLine(text: string | undefined): string {
  return (text ?? "").split("\n")[0] ?? "";
}

/**
 * Pick a template for this board.
 *
 * Only PUBLISHED templates are offered: a draft has no published half for the
 * renderer to read, so binding one would 422 at save — offering it would be an
 * invitation to an error the operator cannot act on.
 */
export function TemplateChooser({ slug, onPick, onStartRaw }: Props) {
  const { t } = useTranslation();
  const { data, isLoading } = useLoopTemplateList(slug);

  const templates = (data?.templates ?? []).filter((tpl) => !tpl.is_draft);

  return (
    <div className="space-y-4" data-testid="board-loop-panel-choose">
      <div>
        <h3 className="text-sm font-medium">
          {t("boardLoop.templates.chooser.title")}
        </h3>
        <p className="text-muted-foreground text-sm">
          {t("boardLoop.templates.chooser.subtitle")}
        </p>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground text-sm">
          {t("boardLoop.templates.chooser.loading")}
        </p>
      ) : templates.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t("boardLoop.templates.chooser.empty")}
        </p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {templates.map((tpl) => (
            <li key={`${tpl.source}:${tpl.id}`}>
              {/* A button, not a card with a click handler: the chooser must be
                  reachable and operable from the keyboard. */}
              <button
                type="button"
                onClick={() => onPick(tpl)}
                data-testid={`board-loop-choose-${tpl.id}`}
                className="hover:border-primary focus-visible:ring-ring flex h-full w-full flex-col gap-1 rounded-md border p-3 text-left focus-visible:ring-2 focus-visible:outline-none"
              >
                <span className="flex items-center gap-2">
                  <span aria-hidden="true">{tpl.profile.emoji}</span>
                  <span className="font-medium">{tpl.name}</span>
                  <Badge variant={tpl.is_system ? "secondary" : "outline"}>
                    {tpl.is_system
                      ? t("boardLoop.templates.chooser.system")
                      : t("boardLoop.templates.chooser.mine")}
                  </Badge>
                  <span className="text-muted-foreground text-xs">
                    v{tpl.version}
                  </span>
                </span>
                {tpl.profile.tagline ? (
                  <span className="text-muted-foreground text-sm">
                    {tpl.profile.tagline}
                  </span>
                ) : null}
                {firstLine(tpl.profile.when_to_use) ? (
                  <span className="text-muted-foreground text-xs">
                    {firstLine(tpl.profile.when_to_use)}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between gap-2 border-t pt-3">
        <Button
          type="button"
          variant="ghost"
          onClick={onStartRaw}
          data-testid="board-loop-choose-raw"
        >
          {t("boardLoop.templates.chooser.startRaw")}
        </Button>
        <Link
          to={`/${slug}/runner/loops`}
          className="text-muted-foreground hover:text-foreground text-sm underline"
          data-testid="board-loop-manage-templates"
        >
          {t("boardLoop.templates.chooser.manage")}
        </Link>
      </div>
    </div>
  );
}
