// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Check, Kanban, Laptop, Lock, Monitor, MoreHorizontal, Pause, Play } from "lucide-react";
import { EmptyState } from "@/components/layout/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { isApiError } from "@/lib/api-error";
import { formatDate } from "@/lib/format";
import { formatRelative } from "@/lib/date-format";
import { cn } from "@/lib/utils";
import { useBoards } from "@/features/kanban/api/use-boards";
import { useWorkspace } from "@/features/workspaces/api/use-workspace";
import { useDomainSync } from "@/hooks/useDomainSync";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useCurrentUser } from "@/features/notifications/api/use-current-user";
import type { CaptureLevel, CompanionInstallation, CompanionMapping } from "@/types/agent-session";
import { useCompanionEnabled, useRichCaptureEnabled } from "../api/use-sessions";
import { useCompanionDevices } from "../api/use-linked-sessions";
import {
  useDeleteDeviceSessions,
  useRefreshDeviceCounts,
  useDeviceMappings,
  usePauseDevice,
  useRenameDevice,
  useSignOutDevice,
  useUpdateMapping,
} from "../api/use-devices";
import { tildeHome } from "../utils/presenter";
import { AgentMark, harnessName } from "./AgentMark";
import { CompanionGate } from "./CompanionGate";
import { GetCompanion, GetCompanionLink } from "./GetCompanion";
import { HidePromptsToggle } from "./HidePromptsToggle";
import { Segmented, Switch } from "./controls";
import { CallContentText } from "./PromptText";
import { LoadErrorState } from "./SessionStates";
import { SessionsTabs } from "./SessionsTabs";
import { COMPACT_LIST_QUERY } from "./SessionsTable";

// The server calls a device disconnected after this long without a heartbeat
// (backend HEARTBEAT_STALE_AFTER); the page uses the same line.
const HEARTBEAT_STALE_MS = 30 * 60_000;
const LEVELS: CaptureLevel[] = ["metadata", "standard", "full", "rich"];
// Full and Rich send more than most people expect.
const WARNING_LEVELS: ReadonlySet<CaptureLevel> = new Set(["full", "rich"]);

type DeviceState = "capturing" | "paused" | "disconnected" | "signedOut";

export function deviceState(device: CompanionInstallation, now: number): DeviceState {
  if (device.revoked_at) return "signedOut";
  if (device.policy?.paused) return "paused";
  if (!device.last_seen_at || now - Date.parse(device.last_seen_at) > HEARTBEAT_STALE_MS) return "disconnected";
  return "capturing";
}

const STATE_BADGE: Record<DeviceState, "success" | "info" | "secondary" | "outline"> = {
  capturing: "success",
  paused: "info",
  disconnected: "secondary",
  signedOut: "outline",
};

export function DevicesPage() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-[var(--page-section-gap)]">
      <PageHeader
        title={t("sessions.title")}
        description={
          <span className="inline-flex items-center gap-1.5">
            <Lock aria-hidden className="size-3.5 shrink-0" />
            {t("sessions.description")}
          </span>
        }
        actions={<HidePromptsToggle />}
      />
      <CompanionGate>
        <SessionsTabs />
        <DevicesView />
      </CompanionGate>
    </div>
  );
}

function DevicesView() {
  const { t } = useTranslation();
  const { slug = "" } = useParams();
  const enabled = useCompanionEnabled() === true;
  const devices = useCompanionDevices(enabled);
  const workspace = useWorkspace(slug);
  const { data: me } = useCurrentUser();
  // A device change reaches every member's socket with ids only; act on ours.
  useDomainSync("companion_installation", ["companion"], {
    debounceMs: 1000,
    filter: (event) => !!me && event.payload.owner_id === me.id,
  });

  if (devices.isPending) return <Skeleton className="mt-4 h-56 w-full" aria-hidden />;
  if (devices.isError) {
    return (
      <LoadErrorState
        error={devices.error}
        title={t("sessions.devices.loadError")}
        description={t("sessions.loadError.description")}
        onRetry={() => void devices.refetch()}
        retrying={devices.isFetching}
      />
    );
  }

  const now = Date.now();
  const ordered = [...devices.data].sort((a, b) => Number(!!a.revoked_at) - Number(!!b.revoked_at));

  return (
    <div className="mt-4 grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-w-0 flex-col gap-4">
        {ordered.length ? (
          ordered.map((device) => (
            <DevicePanel
              key={device.installation_id}
              slug={slug}
              device={device}
              state={deviceState(device, now)}
              workspaceId={workspace.data?.id}
              workspaceName={workspace.data?.name ?? slug}
            />
          ))
        ) : (
          <EmptyState
            icon={Laptop}
            title={t("sessions.devices.empty.title")}
            description={t("sessions.devices.empty.body")}
            action={<GetCompanion />}
          />
        )}
      </div>
      <aside className="flex flex-col gap-4">
        <AddComputer />
        <LevelsTable />
      </aside>
    </div>
  );
}

interface DevicePanelProps {
  slug: string;
  device: CompanionInstallation;
  state: DeviceState;
  workspaceId: string | undefined;
  workspaceName: string;
}

function DevicePanel({ slug, device, state, workspaceId, workspaceName }: DevicePanelProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const signedOut = state === "signedOut";
  const Icon = device.platform === "linux" ? Monitor : Laptop;
  const facts = signedOut
    ? [
        ...(device.platform ? [platformName(device.platform)] : []),
        t("sessions.devices.facts.signedOutOn", { date: formatDate(device.revoked_at ?? "", { month: "short", day: "numeric" }) }),
        t("sessions.devices.facts.sessionsStay"),
      ]
    : [
        ...(device.platform ? [platformName(device.platform)] : []),
        ...(device.status ? [t("sessions.devices.facts.version", { version: device.status.companion_version })] : []),
        device.last_seen_at
          ? t("sessions.devices.facts.checkedIn", { when: formatRelative(device.last_seen_at) })
          : t("sessions.devices.facts.neverCheckedIn"),
        ...(device.status ? [t("sessions.devices.facts.queue", { count: device.status.queue.pending })] : []),
      ];

  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "overflow-hidden rounded-[var(--radius-cap)] border bg-[color:var(--color-surface-1)]",
        signedOut ? "border-dashed border-border bg-transparent" : "border-border/70 shadow-panel",
      )}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3.5 gap-y-2 px-[var(--card-padding)] py-3.5">
        <span aria-hidden className="grid size-10 place-items-center rounded-[var(--radius-cap)] bg-[color:var(--color-surface-3)]">
          <Icon className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-2.5 font-sans text-[1.05rem] font-bold tracking-[-0.01em]">
            <span id={headingId}>
              <CallContentText text={device.name} />
            </span>
            <Badge variant={STATE_BADGE[state]} className="px-2 py-0.5 text-[0.75rem] tracking-[0.1em]">
              {t(`sessions.devices.states.${state}`)}
            </Badge>
          </h2>
          <p className="mt-0.5 flex flex-wrap gap-x-3.5 gap-y-0.5 text-[0.84rem] text-muted-foreground">
            {facts.map((fact) => (
              <span key={fact}>{fact}</span>
            ))}
          </p>
        </div>
        <DeviceActions slug={slug} device={device} state={state} />
      </div>

      {!signedOut && device.status?.agents.length ? (
        <ul className="flex flex-wrap gap-2 px-[var(--card-padding)] pb-3.5 sm:pl-[calc(var(--card-padding)+3.4rem)]">
          {device.status.agents.map((agent) => (
            <li
              key={agent.harness}
              title={agent.state === "error" && agent.detail ? agent.detail : undefined}
              className="inline-flex h-8 items-center gap-2 rounded-[var(--radius-cap)] border border-border bg-card py-0 pl-1 pr-2.5 text-[0.82rem] font-semibold"
            >
              <AgentMark harness={agent.harness} displayName={harnessName(agent.harness)} size="sm" decorative />
              {harnessName(agent.harness)}
              <span
                className={cn(
                  "font-medium",
                  agent.state === "capturing" ? "text-[color:var(--color-success-foreground)]" : "text-muted-foreground",
                  agent.state === "error" && "text-[color:var(--color-error-ink)]",
                )}
              >
                {t(`sessions.devices.agentStates.${agent.state}`)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {!signedOut ? (
        <>
          <FoldersSection device={device} slug={slug} workspaceId={workspaceId} workspaceName={workspaceName} />
          <PolicyLine device={device} />
        </>
      ) : null}
    </section>
  );
}

function platformName(platform: string): string {
  const names: Record<string, string> = { darwin: "macOS", linux: "Linux", windows: "Windows", win32: "Windows" };
  return names[platform] ?? platform;
}

function DeviceActions({ slug, device, state }: { slug: string; device: CompanionInstallation; state: DeviceState }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState<"sessions" | "signOut" | null>(null);
  const [renaming, setRenaming] = useState(false);
  const pause = usePauseDevice(device.installation_id);
  const signOut = useSignOutDevice(device.installation_id);
  const deleteSessions = useDeleteDeviceSessions(device.installation_id, slug);
  const refreshDeviceCounts = useRefreshDeviceCounts();
  const signedOut = state === "signedOut";
  const paused = !!device.policy?.paused;
  const sessionCount = device.session_count;
  const hasSessions = sessionCount !== 0;
  const fail = () => toast.error(t("sessions.devices.actions.failed"));

  const menuItem = (label: string, onSelect: () => void, destructive = false) => (
    <DropdownMenuItem
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={destructive ? "text-[color:var(--color-error-ink)]" : undefined}
    >
      {label}
    </DropdownMenuItem>
  );

  return (
    <div className="flex items-center gap-1.5">
      {signedOut ? null : (
        <Button variant="outline" size="sm" onClick={() => pause.mutate(!paused, { onError: fail })} disabled={pause.isPending}>
          {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
          {t(paused ? "sessions.devices.actions.resume" : "sessions.devices.actions.pause")}
        </Button>
      )}
      {signedOut && !hasSessions ? null : (
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t("sessions.devices.actions.more", { device: device.name })}
          className={buttonVariants({ variant: "ghost", size: "icon", className: "size-8" })}
        >
          <MoreHorizontal aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {signedOut ? null : menuItem(t("sessions.devices.actions.rename"), () => setRenaming(true))}
          {hasSessions ? menuItem(t("sessions.devices.actions.deleteSessions"), () => {
            refreshDeviceCounts();
            setConfirming("sessions");
          }, true) : null}
          {signedOut ? null : menuItem(t("sessions.devices.actions.signOut"), () => setConfirming("signOut"), true)}
        </DropdownMenuContent>
      </DropdownMenu>
      )}
      <ConfirmDialog
        open={confirming === "sessions"}
        onOpenChange={(open) => setConfirming(open ? "sessions" : null)}
        title={
          sessionCount === undefined
            ? t("sessions.devices.actions.deleteSessionsTitle")
            : t("sessions.devices.actions.deleteSessionsCountTitle", { count: sessionCount })
        }
        description={t("sessions.devices.actions.deleteSessionsBody")}
        confirmLabel={
          sessionCount === undefined
            ? t("sessions.devices.actions.deleteSessionsConfirm")
            : t("sessions.devices.actions.deleteSessionsCountConfirm", { count: sessionCount })
        }
        pending={deleteSessions.isPending}
        onConfirm={() =>
          deleteSessions.mutate(undefined, {
            onSuccess: (result) => {
              setConfirming(null);
              toast.success(t("sessions.devices.actions.deleted", { count: result.deleted }));
            },
            onError: fail,
          })
        }
      />
      <ConfirmDialog
        open={confirming === "signOut"}
        onOpenChange={(open) => setConfirming(open ? "signOut" : null)}
        title={t("sessions.devices.actions.signOutTitle")}
        description={t("sessions.devices.actions.signOutBody")}
        confirmLabel={t("sessions.devices.actions.signOutConfirm")}
        pending={signOut.isPending}
        onConfirm={() => signOut.mutate(undefined, { onSuccess: () => setConfirming(null), onError: fail })}
      />
      {renaming ? <RenameDialog device={device} onClose={() => setRenaming(false)} /> : null}
    </div>
  );
}

function RenameDialog({ device, onClose }: { device: CompanionInstallation; onClose: () => void }) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [name, setName] = useState(device.name);
  const rename = useRenameDevice(device.installation_id);

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    rename.mutate(trimmed, {
      onSuccess: () => {
        toast.success(t("sessions.devices.actions.renamed"));
        onClose();
      },
      onError: () => toast.error(t("sessions.devices.actions.failed")),
    });
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t("sessions.devices.actions.renameTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor={fieldId} className="text-sm font-medium">
              {t("sessions.devices.actions.renameLabel")}
            </label>
            <Input id={fieldId} value={name} maxLength={200} autoFocus onChange={(event) => setName(event.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("sessions.devices.actions.cancel")}
            </Button>
            <Button type="submit" disabled={!name.trim() || rename.isPending}>
              {t("sessions.devices.actions.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface FoldersSectionProps {
  device: CompanionInstallation;
  slug: string;
  workspaceId: string | undefined;
  workspaceName: string;
}

function FoldersSection({ device, slug, workspaceId, workspaceName }: FoldersSectionProps) {
  const { t } = useTranslation();
  const captionId = useId();
  const mappings = useDeviceMappings(device.installation_id, !!workspaceId);
  // A phone stacks each folder; a four-column table would hide the switch.
  const compact = useMediaQuery(COMPACT_LIST_QUERY);
  const boards = useBoards(slug);
  const here = mappings.data?.filter((mapping) => mapping.workspace_id === workspaceId) ?? [];
  const elsewhere = (mappings.data?.length ?? 0) - here.length;
  if (!mappings.data) return null;

  return (
    <div className="border-t border-border bg-[color:var(--color-surface-2)]">
      <div className="flex flex-wrap items-baseline gap-x-3 px-[var(--card-padding)] pb-1 pt-3">
        <h3 id={captionId} className="font-sans text-[0.92rem] font-bold tracking-normal">
          {t("sessions.devices.folders.title", { workspace: workspaceName })}
        </h3>
        {device.policy?.auto_match_repos ? (
          <span className="text-[0.8rem] text-muted-foreground">{t("sessions.devices.folders.autoMatch")}</span>
        ) : null}
        {elsewhere > 0 ? (
          <span className="text-[0.8rem] text-muted-foreground sm:ml-auto">
            {t("sessions.devices.folders.otherWorkspaces", { count: elsewhere })}
          </span>
        ) : null}
      </div>
      {here.length && compact ? (
        <ul aria-labelledby={captionId}>
          {here.map((mapping) => (
            <FolderCard
              key={mapping.id}
              device={device}
              mapping={mapping}
              boardName={boards.data?.find((board) => board.id === mapping.board_id)?.name}
            />
          ))}
        </ul>
      ) : here.length ? (
        <div className="overflow-x-auto">
          <table aria-labelledby={captionId} className="w-full min-w-[40rem] border-collapse text-left text-[0.88rem]">
            <colgroup>
              <col className="w-[42%]" />
              <col />
              <col />
              <col className="w-[4.5rem]" />
            </colgroup>
            <thead>
              <tr className="text-[0.7rem] font-bold uppercase tracking-[0.08em] text-muted-foreground">
                <th scope="col" className="px-[var(--card-padding)] py-1.5">{t("sessions.devices.folders.folder")}</th>
                <th scope="col" className="py-1.5 pr-4">{t("sessions.devices.folders.board")}</th>
                <th scope="col" className="py-1.5 pr-4">{t("sessions.devices.folders.sent")}</th>
                <th scope="col" className="py-1.5 pr-[var(--card-padding)]">{t("sessions.devices.folders.on")}</th>
              </tr>
            </thead>
            <tbody>
              {here.map((mapping) => (
                <FolderRow
                  key={mapping.id}
                  device={device}
                  mapping={mapping}
                  boardName={boards.data?.find((board) => board.id === mapping.board_id)?.name}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="px-[var(--card-padding)] pb-3 text-[0.85rem] text-muted-foreground">{t("sessions.devices.folders.none")}</p>
      )}
    </div>
  );
}

interface FolderProps {
  device: CompanionInstallation;
  mapping: CompanionMapping;
  boardName?: string;
}

// One folder's controls, shared by the desktop row and the phone card.
function useFolder({ device, mapping }: FolderProps) {
  const { t } = useTranslation();
  const update = useUpdateMapping(device.installation_id);
  const richCaptureEnabled = useRichCaptureEnabled();
  const folder = mapping.root_path ? tildeHome(mapping.root_path) : t("sessions.devices.folders.autoRepo");
  const fail = (error?: unknown) =>
    toast.error(
      isApiError(error) && error.errorCode === "rich_capture_unavailable"
        ? t("sessions.devices.folders.richUnavailable")
        : t("sessions.devices.actions.failed"),
    );
  const detail = [
    mapping.repo_url_normalized?.split("/").slice(-2).join("/") ?? t("sessions.devices.folders.noRepo"),
    t(`sessions.devices.folders.origin.${mapping.origin}`),
  ].join(" · ");
  const level = (
    <Segmented
      label={t("sessions.devices.folders.levelLabel", { folder })}
      value={mapping.content_level}
      onChange={(content_level) =>
        update.mutate(
          { mappingId: mapping.id, patch: { content_level } },
          { onSuccess: () => toast.success(t("sessions.devices.folders.levelChanged")), onError: fail },
        )
      }
      options={LEVELS.map((value) => ({
        value,
        label: t(`sessions.rail.captured.levels.${value}`),
        ...(WARNING_LEVELS.has(value) ? { tone: "warning" as const } : {}),
        disabled: value === "rich" && richCaptureEnabled === false,
      }))}
    />
  );
  const captureReason = mapping.capture?.reason;
  const fallback = captureReason ? t(`sessions.devices.folders.capture.${captureReason}`) : null;
  const toggle = (
    <Switch
      label={t("sessions.devices.folders.toggle", { folder })}
      hideLabel
      checked={mapping.enabled}
      onChange={(enabled) => update.mutate({ mappingId: mapping.id, patch: { enabled } }, { onError: fail })}
    />
  );
  return { folder, detail, level, toggle, fallback };
}

function BoardCell({ boardName }: { boardName?: string }) {
  const { t } = useTranslation();
  return boardName ? (
    <span className="inline-flex items-center gap-1.5 font-semibold">
      <Kanban aria-hidden className="size-3.5 text-muted-foreground" />
      {boardName}
    </span>
  ) : (
    <span className="text-muted-foreground">{t("sessions.devices.folders.noBoard")}</span>
  );
}

function FolderRow(props: FolderProps) {
  const { folder, detail, level, toggle, fallback } = useFolder(props);
  return (
    <tr className="border-t border-border/60 align-middle">
      <td className="px-[var(--card-padding)] py-2">
        <span className="block break-all font-mono text-[0.84rem] font-semibold" title={folder}>
          {folder}
        </span>
        <small className="block text-[0.76rem] text-muted-foreground">{detail}</small>
      </td>
      <td className="py-2 pr-4">
        <BoardCell boardName={props.boardName} />
      </td>
      <td className="py-2 pr-4">
        {level}
        {fallback ? <small className="mt-1 block max-w-[22rem] text-[0.76rem] leading-snug text-muted-foreground">{fallback}</small> : null}
      </td>
      <td className="py-2 pr-[var(--card-padding)]">{toggle}</td>
    </tr>
  );
}

function FolderCard(props: FolderProps) {
  const { folder, detail, level, toggle, fallback } = useFolder(props);
  return (
    <li className="grid gap-2 border-t border-border/60 px-[var(--card-padding)] py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="block break-all font-mono text-[0.84rem] font-semibold">{folder}</span>
          <small className="block text-[0.76rem] text-muted-foreground">{detail}</small>
        </div>
        {toggle}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[0.85rem]">
        <BoardCell boardName={props.boardName} />
        {level}
      </div>
      {fallback ? <small className="text-[0.76rem] leading-snug text-muted-foreground">{fallback}</small> : null}
    </li>
  );
}

function PolicyLine({ device }: { device: CompanionInstallation }) {
  const { t } = useTranslation();
  const policy = device.policy;
  if (!policy) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-border px-[var(--card-padding)] py-2.5 text-[0.85rem] text-muted-foreground">
      <span>
        {policy.retention_days
          ? t("sessions.devices.policy.retention", { count: policy.retention_days })
          : t("sessions.devices.policy.retentionForever")}
      </span>
      {policy.exclude_globs.length ? (
        <span>
          <Trans
            i18nKey="sessions.devices.policy.excludes"
            values={{ globs: policy.exclude_globs.join(", ") }}
            components={{ globs: <span className="font-mono text-[0.8rem] font-semibold text-foreground" /> }}
          />
        </span>
      ) : null}
    </p>
  );
}

function AddComputer() {
  const { t } = useTranslation();
  return (
    <section className="rounded-[var(--radius-cap)] border border-border/70 bg-[color:var(--color-surface-1)] px-[var(--card-padding)] py-3.5 shadow-panel">
      <h2 className="mb-2 text-[0.98rem] font-bold">{t("sessions.devices.addComputer.title")}</h2>
      <ol className="grid list-decimal gap-1 pl-5 text-[0.86rem] leading-relaxed text-muted-foreground">
        <li>{t("sessions.devices.addComputer.install")}</li>
        <li>{t("sessions.devices.addComputer.signIn")}</li>
        <li>{t("sessions.devices.addComputer.approve")}</li>
      </ol>
      <p className="mt-2.5 text-[0.86rem]">
        <GetCompanionLink />
      </p>
    </section>
  );
}

type LevelCell = "sent" | "size" | "none";

// What each content level sends, per kind of content (DK-13 §0/§1; Rich: contract §2).
const LEVEL_ROWS: { key: string; cells: Record<CaptureLevel, LevelCell> }[] = [
  { key: "counts", cells: { metadata: "sent", standard: "sent", full: "sent", rich: "sent" } },
  { key: "names", cells: { metadata: "sent", standard: "sent", full: "sent", rich: "sent" } },
  { key: "prompts", cells: { metadata: "size", standard: "sent", full: "sent", rich: "sent" } },
  { key: "output", cells: { metadata: "size", standard: "size", full: "sent", rich: "sent" } },
  { key: "attachments", cells: { metadata: "none", standard: "none", full: "none", rich: "sent" } },
];

function LevelCellView({ cell }: { cell: LevelCell }) {
  const { t } = useTranslation();
  if (cell === "sent") {
    return <Check role="img" aria-label={t("sessions.devices.levels.sent")} className="mx-auto size-3.5 text-[color:var(--color-success-foreground)]" />;
  }
  if (cell === "size") return <span className="font-semibold text-muted-foreground">{t("sessions.devices.levels.sizeOnly")}</span>;
  return (
    <>
      <span aria-hidden className="text-muted-foreground">
        —
      </span>
      <span className="sr-only">{t("sessions.devices.levels.notSent")}</span>
    </>
  );
}

function LevelsTable() {
  const { t } = useTranslation();
  const richCaptureEnabled = useRichCaptureEnabled();
  const captionId = useId();
  return (
    <section className="rounded-[var(--radius-cap)] border border-border/70 bg-[color:var(--color-surface-1)] px-[var(--card-padding)] py-3.5 shadow-panel">
      <h2 id={captionId} className="mb-2 text-[0.98rem] font-bold">
        {t("sessions.devices.levels.title")}
      </h2>
      <table aria-labelledby={captionId} className="w-full border-collapse text-[0.8rem]">
        <thead>
          <tr className="text-muted-foreground">
            <th scope="col" className="py-1.5 text-left font-semibold">
              <span className="sr-only">{t("sessions.devices.levels.kind")}</span>
            </th>
            {LEVELS.map((level) => (
              <th key={level} scope="col" className="px-1 py-1.5 text-center font-bold">
                {t(`sessions.rail.captured.levels.${level}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {LEVEL_ROWS.map((row) => (
            <tr key={row.key} className="border-t border-border/60">
              <th scope="row" className="py-1.5 pr-2 text-left font-normal text-foreground">
                {t(`sessions.devices.levels.${row.key}`)}
              </th>
              {LEVELS.map((level) => (
                <td key={level} className="px-1 py-1.5 text-center">
                  <LevelCellView cell={row.cells[level]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[0.82rem] leading-snug text-muted-foreground">{t("sessions.devices.levels.footer")}</p>
      {richCaptureEnabled === false ? (
        <p className="mt-1.5 text-[0.82rem] leading-snug text-muted-foreground">{t("sessions.devices.folders.richUnavailable")}</p>
      ) : null}
    </section>
  );
}
