// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Copy, GitBranch, Kanban, Laptop, MoreHorizontal, Trash2 } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { useBoards } from "@/features/kanban/api/use-boards";
import type { AgentSession } from "@/types/agent-session";
import { useCompanionEnabled, useDeleteSession, useSession, useSessionChildren } from "../api/use-sessions";
import { formatClock } from "../utils/format";
import { AgentMark } from "./AgentMark";
import { HidePromptsToggle } from "./HidePromptsToggle";
import { CallContentText, PromptText } from "./PromptText";
import { SessionStateBadge } from "./SessionStateBadge";
import { useSessionTitle, WithheldTitleGlyph } from "./SessionTitle";

interface SessionHeaderProps {
  slug: string;
  session: AgentSession;
}

export function SessionHeader({ slug, session }: SessionHeaderProps) {
  const { t } = useTranslation();
  const title = useSessionTitle(session);
  const boards = useBoards(slug);
  const board = boards.data?.find((candidate) => candidate.id === session.board_id);
  const agent = [session.harness_display_name, session.harness_version].filter(Boolean).join(" ");
  const location = [session.repository, session.branch].filter(Boolean) as string[];

  return (
    <section
      aria-label={t("sessions.detail.label")}
      className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-3 rounded-[var(--radius-cap)] border border-border/70 bg-[color:var(--color-surface-1)] px-[var(--card-padding)] py-4 shadow-panel md:grid-cols-[auto_minmax(0,1fr)_auto]"
    >
      <AgentMark harness={session.harness} displayName={session.harness_display_name} size="lg" />
      <div className="min-w-0">
        {session.parent_session_id ? <ParentLink slug={slug} parentId={session.parent_session_id} /> : null}
        <h1
          className={cn(
            "flex max-w-[52rem] items-center gap-2 text-balance text-[1.55rem] font-bold leading-tight tracking-[-0.03em] max-sm:text-xl",
            title.kind !== "title" && "text-muted-foreground",
          )}
        >
          {title.kind === "withheld" ? <WithheldTitleGlyph /> : null}
          {title.kind === "title" ? <PromptText text={title.text} /> : title.text}
        </h1>
        <ul className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[0.88rem] text-muted-foreground">
          <li>
            <SessionStateBadge session={session} />
          </li>
          <li>{agent}</li>
          {session.model ? <li>{session.model}</li> : null}
          {location.length ? (
            <li className="inline-flex min-w-0 items-center gap-1.5">
              <GitBranch aria-hidden className="size-3.5 shrink-0" />
              <span className="sr-only">{t("sessions.facts.repository")}</span>
              {location.map((part, index) => (
                <span key={part} className={cn("truncate", index > 0 && "before:mr-1.5 before:opacity-50 before:content-['·']")}>
                  {part}
                </span>
              ))}
            </li>
          ) : null}
          {board ? (
            <li className="inline-flex items-center gap-1.5">
              <Kanban aria-hidden className="size-3.5" />
              <span className="sr-only">{t("sessions.facts.board")}</span>
              <Link to={`/${slug}/boards/${board.id}`} className="rounded-[var(--radius-cap)] hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {board.name}
              </Link>
            </li>
          ) : null}
          {session.device_name ? (
            <li className="inline-flex items-center gap-1.5">
              <Laptop aria-hidden className="size-3.5" />
              <span className="sr-only">{t("sessions.facts.device")}</span>
              {/* Device names often carry the owner's name ("Carol's MacBook"). */}
              <CallContentText text={session.device_name} />
            </li>
          ) : null}
          <li>
            <Trans
              i18nKey="sessions.facts.started"
              values={{ time: formatClock(session.started_at) }}
              components={{ time: <time dateTime={session.started_at} /> }}
            />
          </li>
        </ul>
      </div>
      <SessionActions slug={slug} session={session} />
    </section>
  );
}

function ParentLink({ slug, parentId }: { slug: string; parentId: string }) {
  const { t } = useTranslation();
  const enabled = useCompanionEnabled() === true;
  const parent = useSession(slug, parentId, enabled);
  return (
    <p className="mb-1 flex min-w-0 items-center gap-1.5 text-[0.82rem] text-muted-foreground">
      {t("sessions.detail.subagentOf")}
      <Link
        to={`/${slug}/sessions/${parentId}`}
        className="min-w-0 truncate rounded-[var(--radius-cap)] font-semibold text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {parent.data?.title ? <PromptText text={parent.data.title} /> : t("sessions.detail.parentSession")}
      </Link>
    </p>
  );
}

function SessionActions({ slug, session }: SessionHeaderProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const children = useSessionChildren(slug, session.id, true);
  const removeSession = useDeleteSession(slug);
  const childCount = children.data?.items.length ?? 0;

  async function copyLink() {
    const copied = await copyTextToClipboard(`${window.location.origin}/${slug}/sessions/${session.id}`);
    if (copied) toast.success(t("sessions.detail.linkCopied"));
    else toast.error(t("sessions.detail.copyFailed"));
  }

  return (
    <div className="col-span-2 flex flex-wrap items-center gap-2 md:col-span-1 md:justify-end">
      <HidePromptsToggle />
      <Button variant="outline" size="sm" onClick={() => void copyLink()}>
        <Copy aria-hidden />
        {t("sessions.detail.copyLink")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger aria-label={t("sessions.detail.moreActions")} className={buttonVariants({ variant: "ghost", size: "icon", className: "size-8" })}>
          <MoreHorizontal aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            tabIndex={0}
            onClick={() => setConfirming(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setConfirming(true);
              }
            }}
            className="text-[color:var(--color-error-ink)]"
          >
            <Trash2 aria-hidden className="size-4" />
            {t("sessions.detail.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("sessions.detail.deleteTitle")}
        description={
          childCount
            ? t("sessions.detail.deleteBodyChildren", { count: childCount })
            : t("sessions.detail.deleteBody")
        }
        confirmLabel={t("sessions.detail.deleteConfirm")}
        pending={removeSession.isPending}
        onConfirm={() =>
          removeSession.mutate(session.id, {
            onSuccess: () => {
              setConfirming(false);
              toast.success(t("sessions.detail.deleted"));
              navigate(`/${slug}/sessions`);
            },
            onError: () => toast.error(t("sessions.detail.deleteFailed")),
          })
        }
      />
    </div>
  );
}
