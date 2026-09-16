// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { KeyRound, Plus, Trash2, Users } from "lucide-react";
import { AddMemberDialog } from "./AddMemberDialog";
import { TemporaryPasswordDialog } from "./TemporaryPasswordDialog";
import {
  useMembers,
  useRemoveMember,
  useUpdateMemberRole,
} from "../api/use-members";
import { useAuthModes } from "@/features/auth/api/use-auth-modes";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/layout/EmptyState";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import { Skeleton } from "@/components/ui/skeleton";
import { fadeInUpVisible, staggerChildren } from "@/lib/animations";
import { formatDate } from "@/lib/format";
import { getInitials } from "@/lib/initials";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { useWorkspaceAdmin } from "@/hooks/useWorkspaceAdmin";
import { resolveApiErrorMessage } from "@/lib/localized-errors";
import type { WorkspaceMember, WorkspaceRole } from "@/types/member";

const roleClasses: Record<WorkspaceRole, string> = {
  owner: "bg-[color:color-mix(in_oklab,var(--color-data-5)_18%,transparent)] text-[color:var(--color-data-5)]",
  admin: "bg-info/16 text-[color:var(--color-info-foreground)]",
  member: "bg-secondary text-secondary-foreground",
  viewer: "bg-muted text-muted-foreground",
};

// Rank backs the self-demotion check: any move DOWN this ladder on your own
// row can strip your ability to undo it, so it asks for confirmation first.
const roleRank: Record<WorkspaceRole, number> = {
  owner: 3,
  admin: 2,
  member: 1,
  viewer: 0,
};
const allRoles: WorkspaceRole[] = ["owner", "admin", "member", "viewer"];

function formatMemberDate(joinedAt: string): string {
  return formatDate(joinedAt, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

interface MemberListProps {
  slug: string;
}

export function MemberList({ slug }: MemberListProps) {
  const { t, i18n } = useTranslation();
  const { data: members, isLoading } = useMembers(slug);
  const { data: modes } = useAuthModes();
  const {
    role: viewerRole,
    membership: viewerMembership,
    isLoading: viewerRoleLoading,
  } = useWorkspaceAdmin(slug);
  const removeMember = useRemoveMember(slug);
  const updateMemberRole = useUpdateMemberRole(slug);
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<WorkspaceMember | null>(null);
  const [confirmSelfDemotion, setConfirmSelfDemotion] = useState<{
    userId: string;
    role: WorkspaceRole;
  } | null>(null);
  const [tempPasswordFor, setTempPasswordFor] = useState<WorkspaceMember | null>(null);
  const reducedMotion = useReducedMotion();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isLoading || reducedMotion) return;
    const tween = staggerChildren(
      listRef.current,
      "[data-stagger-item]",
      fadeInUpVisible,
      { stagger: 0.04, duration: 0.18, offset: 12, maxStaggered: 12 },
    );
    // progress(1) BEFORE kill: the entrance starts rows at opacity 0, so a
    // bare mid-flight kill strands them invisible.
    return () => { tween?.progress(1).kill(); };
  }, [isLoading, members?.length, reducedMotion]);

  // The server allows role management only for admins/owners, and any change
  // touching the owner role only for owners — mirror those gates so the UI
  // never offers a control that can only end in a 403.
  const canManageRoles =
    !viewerRoleLoading && (viewerRole === "admin" || viewerRole === "owner");
  const assignableRoles =
    viewerRole === "owner" ? allRoles : allRoles.filter((role) => role !== "owner");

  const canChangeRoleOf = (member: WorkspaceMember) =>
    canManageRoles && (member.role !== "owner" || viewerRole === "owner");

  const submitRoleChange = (userId: string, role: WorkspaceRole) => {
    updateMemberRole.mutate(
      { userId, role },
      {
        onSuccess: () => {
          setConfirmSelfDemotion(null);
          toast.success(t("members.roleChanged"));
        },
        onError: (error) => {
          setConfirmSelfDemotion(null);
          toast.error(
            resolveApiErrorMessage(error, t, i18n, {
              fallbackKey: "members.roleChangeFailed",
            }),
          );
        },
      },
    );
  };

  const handleRoleSelect = (member: WorkspaceMember, nextRole: WorkspaceRole) => {
    if (nextRole === member.role) return;
    // Identity comes from the same membership the role gate resolves (by
    // email), not from /me's raw id — two keys for one decision can diverge
    // and silently skip this confirmation.
    const isSelfDemotion =
      viewerMembership?.user_id === member.user_id &&
      roleRank[nextRole] < roleRank[member.role];
    if (isSelfDemotion) {
      setConfirmSelfDemotion({ userId: member.user_id, role: nextRole });
      return;
    }
    submitRoleChange(member.user_id, nextRole);
  };

  if (isLoading) {
    return (
      <div className="space-y-[var(--page-section-gap)]">
        <Skeleton className="h-32 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.3rem))]" />
        <Skeleton className="h-72 rounded-[min(var(--radius-cap),calc(var(--radius-xl)+0.2rem))]" />
      </div>
    );
  }

  return (
    <div className="space-y-[var(--page-section-gap)]">
      <PageHeader
        title={t("members.title")}
        description={t("members.subtitle")}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            {t("members.addMember")}
          </Button>
        }
      />

      {!members?.length ? (
        <EmptyState
          icon={Users}
          title={t("members.title")}
          description={t("members.empty")}
          action={
            <Button size="lg" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              {t("members.addMember")}
            </Button>
          }
        />
      ) : (
        <Card className="overflow-hidden border-border/75">
          <div ref={listRef} className="divide-y divide-border/70">
            {members.map((member) => (
              <div
                key={member.user_id}
                data-stagger-item
                className="group flex items-center gap-4 px-[var(--card-padding)] py-4 transition-colors duration-200 hover:bg-[color:var(--color-surface-1)]"
              >
                <Avatar className="h-11 w-11">
                  <AvatarFallback>
                    {getInitials(member.name, member.email)}
                  </AvatarFallback>
                </Avatar>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-foreground">
                    {member.name || member.email}
                  </p>
                  <p className="truncate text-xs uppercase tracking-[0.14em] text-muted-foreground">
                    {member.name
                      ? member.email
                      : formatMemberDate(member.joined_at)}
                  </p>
                </div>

                <div
                  data-slot="member-role"
                  className="flex w-36 items-center justify-end"
                >
                  {canChangeRoleOf(member) ? (
                    <Select
                      className="w-full"
                      value={member.role}
                      onValueChange={(next) =>
                        handleRoleSelect(member, next as WorkspaceRole)
                      }
                    >
                      <SelectTrigger
                        className="h-9"
                        aria-label={t("a11y.members.changeRole")}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {assignableRoles.map((role) => (
                          <SelectItem key={role} value={role}>
                            {t(`members.roles.${role}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <RichTooltip i18nKey="workspace.members.roles" side="left">
                      <Pill className={roleClasses[member.role]}>
                        {t(`members.roles.${member.role}`)}
                      </Pill>
                    </RichTooltip>
                  )}
                </div>

                <span className="hidden w-28 text-right text-sm text-muted-foreground lg:inline-block">
                  {formatMemberDate(member.joined_at)}
                </span>

                <div
                  data-slot="member-actions"
                  className="flex w-20 items-center justify-end gap-1"
                >
                  {modes?.password_enabled ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                      onClick={() => setTempPasswordFor(member)}
                      aria-label={t("a11y.members.setTempPassword")}
                    >
                      <KeyRound className="h-4 w-4" />
                    </Button>
                  ) : null}

                  {member.role !== "owner" ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                      onClick={() => setConfirmRemove(member)}
                      aria-label={t("a11y.members.removeMember")}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <AddMemberDialog
        slug={slug}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />

      {confirmSelfDemotion ? (
        // Mounted only while pending: the Dialog exit animation would keep a
        // cancelled confirmation in the accessibility tree for another ~300ms;
        // unmounting removes it the moment the operator backs out.
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirmSelfDemotion(null)}
          title={t("members.selfDemoteTitle")}
          description={t("members.selfDemoteConfirm")}
          confirmLabel={t("members.selfDemoteAction")}
          pending={updateMemberRole.isPending}
          onConfirm={() =>
            submitRoleChange(confirmSelfDemotion.userId, confirmSelfDemotion.role)
          }
        />
      ) : null}

      <TemporaryPasswordDialog
        slug={slug}
        member={tempPasswordFor}
        onOpenChange={(open) => !open && setTempPasswordFor(null)}
      />

      <Dialog
        open={!!confirmRemove}
        onOpenChange={(open) => !open && setConfirmRemove(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("members.removeTitle")}</DialogTitle>
            <DialogDescription>
              {t("members.removeConfirm", {
                name: confirmRemove?.name || confirmRemove?.email,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRemove(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={removeMember.isPending}
              onClick={() => {
                if (!confirmRemove) return;
                removeMember.mutate(confirmRemove.user_id, {
                  onSuccess: () => setConfirmRemove(null),
                });
              }}
            >
              {t("members.remove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
